// Arise's calendar helper (a Cloudflare Worker): fetches a calendar's private link for the Arise
// web app, whose browser can't read most calendar servers itself. It keeps nothing: no storage,
// no request logs (wrangler.toml), no cookies. Only Arise's own web address may call it, and it
// only passes back text that is a calendar, so it can't be used to read other pages.
//
// POST /fetch  {"url": "https://…"}  →  200 text/calendar, or the calendar server's own status.
// GET /health  →  {"ok":true,"name":"arise-calendar"}

export interface Env {
  ALLOWED_ORIGINS: string; // comma-separated
  PER_IP?: RateLimiter;
}
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
export interface Deps {
  fetch?: typeof fetch;
}

export const MAX_BYTES = 5 * 1024 * 1024;
const MAX_BODY = 4096;
const HOPS = 4;
const TIMEOUT = 20_000;

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

function cors(req: Request, env: Env): { ok: boolean; headers: Record<string, string> } {
  const origin = req.headers.get('origin') || '';
  const ok = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  return {
    ok,
    headers: ok
      ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }
      : { vary: 'origin' },
  };
}

// Only public web addresses: never this machine or a private network.
export function publicUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.') || host.startsWith('[')) return null; // (no IPv6 literals)
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa)$/.test(host)) return null;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
  } else if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) return null; // other ways to write an IP
  return u;
}

// Reads at most `max` bytes; null when there's more.
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export async function handle(req: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const path = new URL(req.url).pathname;
  const c = cors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
  if (path === '/health' && req.method === 'GET') return json({ ok: true, name: 'arise-calendar' }, 200, c.headers);
  if (path !== '/fetch') return json({ error: 'Not here.' }, 404, c.headers);
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, { allow: 'POST, OPTIONS', ...c.headers });
  if (!c.ok) return json({ error: 'Only the Arise app may use this.' }, 403, c.headers);
  const ip = req.headers.get('cf-connecting-ip') || '';
  if (ip && env.PER_IP && !(await env.PER_IP.limit({ key: ip })).success) return json({ error: 'Too many. Try again in a minute.' }, 429, { 'retry-after': '60', ...c.headers });

  const body = await req.text();
  if (body.length > MAX_BODY) return json({ error: 'Too big.' }, 413, c.headers);
  let asked: unknown;
  try {
    asked = (JSON.parse(body) as { url?: unknown }).url;
  } catch {
    return json({ error: 'Send {"url": "…"}.' }, 400, c.headers);
  }
  let target = publicUrl(asked);
  if (!target) return json({ error: "That isn't a calendar link Arise can read." }, 400, c.headers);

  const get = deps.fetch || fetch;
  let res: Response | null = null;
  for (let hop = 0; hop <= HOPS; hop++) {
    try {
      res = await get(target.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1', 'user-agent': 'Arise calendar helper (fetch only)' },
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch {
      return json({ error: "The calendar's server didn't answer." }, 502, c.headers);
    }
    if (res.status < 300 || res.status >= 400) break;
    const next = publicUrl(new URL(res.headers.get('location') || '', target).href);
    if (!next || hop === HOPS) return json({ error: "The calendar's link goes somewhere Arise can't follow." }, 502, c.headers);
    target = next;
  }
  if (!res) return json({ error: "The calendar's server didn't answer." }, 502, c.headers);
  // The server's own "no" (404, 401…), passed on so the app can say what to do.
  if (!res.ok) return json({ error: "The calendar's server said no." }, res.status >= 400 && res.status < 600 ? res.status : 502, c.headers);
  const bytes = await readCapped(res, MAX_BYTES);
  if (!bytes) return json({ error: 'This calendar is too big.' }, 413, c.headers);
  const text = new TextDecoder().decode(bytes);
  if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(text)) return json({ error: "That link isn't a calendar." }, 422, c.headers);
  return new Response(text, { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store', ...c.headers } });
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};
