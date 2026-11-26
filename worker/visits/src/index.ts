// Arise's visit counter (a Cloudflare Worker) for Your website. A published page tells it "this
// site, this page was opened", and it adds one to that page's count for the day. That's all it
// keeps: the site's public id, the page's name, the day (UTC) and a number. It never reads or
// keeps an IP address, a user agent, a referrer or a cookie, and sets no cookies, so it can't
// tell one visitor from another or follow anyone between pages or sites.
//
// Arise (and only Arise's own addresses) makes a site: a public id that goes into the published
// pages, and a private read key that stays on the Player's device (only its SHA-256 is kept
// here). The counts are read back, or forgotten, with that key.
//
// POST /v1/hit     {"s": site id, "p": page}  from any address  →  204
// POST /v1/sites   {}                         Arise only        →  {"site", "key"}
// POST /v1/read    {"site", "key", "days"}    Arise only        →  {"counts": [{day, page, n}]}
// POST /v1/forget  {"site", "key"}            Arise only        →  {"ok": true}
// GET /health  →  {"ok":true,"name":"arise-visits"}

export interface Env {
  ALLOWED_ORIGINS: string; // comma-separated
  MAX_SITES?: string; // default 10000
  PER_SITE?: RateLimiter;
  NEW_SITES?: RateLimiter;
  VISITS: DurableObjectNamespaceLike;
}
// Minimal shapes of the Cloudflare bindings used here, so this file needs no extra type package.
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export interface SqlLike {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}
export interface StateLike {
  storage: { sql: SqlLike };
}

type Op = { op: 'hit'; site: string; page: string } | { op: 'site' } | { op: 'read'; site: string; key: string; days: number } | { op: 'forget'; site: string; key: string };

const SITE = /^[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
// A page's name as Arise writes it: "index", "about", "writing/my-first-post".
const PAGE = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)?$/;
const MAX_BODY = 1024;
const MAX_PAGES_A_DAY = 200; // different pages counted per site per day
const KEEP_DAYS = 400;
const DAY = 86_400_000;

const te = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n: number) => b64url(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const hash = async (s: string) => b64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', te.encode(s))));
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

function json(status: number, body: unknown, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

// The body as text, or null once it's over MAX_BODY.
async function readBody(req: Request): Promise<string | null> {
  if (Number(req.headers.get('content-length')) > MAX_BODY) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

const ARISE_ROUTES = new Set(['/v1/sites', '/v1/read', '/v1/forget']);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    const origin = req.headers.get('origin') || '';
    const arise = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
    // A visit may come from any website; everything else only from Arise.
    const cors: Record<string, string> =
      path === '/v1/hit'
        ? { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }
        : arise
          ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }
          : { vary: 'origin' };
    if (req.method === 'OPTIONS') return new Response(null, { status: path === '/v1/hit' || arise ? 204 : 403, headers: cors });
    if (path === '/health' && req.method === 'GET') return json(200, { ok: true, name: 'arise-visits' }, cors);
    if (path !== '/v1/hit' && !ARISE_ROUTES.has(path)) return json(404, { error: { message: 'Not here.' } }, cors);
    if (req.method !== 'POST') return json(405, { error: { message: 'Use POST.' } }, { allow: 'POST, OPTIONS', ...cors });
    if (path !== '/v1/hit' && !arise) return json(403, { error: { message: 'Only the Arise app may use this.' } }, cors);

    const text = await readBody(req);
    if (text === null) return json(413, { error: { message: 'Too much data.' } }, cors);
    let body: Record<string, unknown> = {};
    try {
      const v = text ? JSON.parse(text) : {};
      body = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return json(400, { error: { message: 'Bad request.' } }, cors);
    }
    const store = env.VISITS.get(env.VISITS.idFromName('all'));
    const run = async (op: Op) => {
      const res = await store.fetch('https://visits/', { method: 'POST', body: JSON.stringify(op) });
      return json(res.status, await res.json(), cors);
    };

    if (path === '/v1/hit') {
      // Only the site and the page are read from a visit: nothing about the visitor.
      const site = typeof body.s === 'string' && SITE.test(body.s) ? body.s : '';
      const page = typeof body.p === 'string' && body.p.length <= 120 && PAGE.test(body.p) ? body.p : '';
      if (!site || !page) return new Response(null, { status: 204, headers: cors });
      if (env.PER_SITE && !(await env.PER_SITE.limit({ key: site })).success) return new Response(null, { status: 204, headers: cors });
      await store.fetch('https://visits/', { method: 'POST', body: JSON.stringify({ op: 'hit', site, page } satisfies Op) });
      return new Response(null, { status: 204, headers: cors });
    }
    if (path === '/v1/sites') {
      if (env.NEW_SITES && !(await env.NEW_SITES.limit({ key: 'all' })).success) return json(429, { error: { message: 'Too many new sites right now. Try again in a minute.' } }, { 'retry-after': '60', ...cors });
      return run({ op: 'site' });
    }
    const site = typeof body.site === 'string' && SITE.test(body.site) ? body.site : '';
    const key = typeof body.key === 'string' && KEY.test(body.key) ? body.key : '';
    if (!site || !key) return json(400, { error: { message: 'Send the site and its read key.' } }, cors);
    if (path === '/v1/read') {
      const days = Math.max(1, Math.min(KEEP_DAYS, Math.round(Number(body.days) || 30)));
      return run({ op: 'read', site, key, days });
    }
    return run({ op: 'forget', site, key });
  },
};

// ---------- the Durable Object: every site's counts

export class Visits {
  private sql: SqlLike;
  private pruned = '';

  constructor(
    state: StateLike,
    private env: Pick<Env, 'MAX_SITES'>,
  ) {
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, key TEXT NOT NULL, made TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS counts (site TEXT NOT NULL, day TEXT NOT NULL, page TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (site, day, page))');
    this.sql.exec('CREATE INDEX IF NOT EXISTS counts_day ON counts (day)');
    // How many sites there are, kept as they come and go, so a new one doesn't read every row.
    this.sql.exec('CREATE TABLE IF NOT EXISTS total (n INTEGER NOT NULL)');
    if (!this.sql.exec('SELECT n FROM total').toArray().length) this.sql.exec('INSERT INTO total (n) SELECT COUNT(*) FROM sites');
  }

  async fetch(req: Request): Promise<Response> {
    let out: { status: number; body: unknown };
    try {
      out = await this.handle((await req.json()) as Op);
    } catch {
      out = { status: 500, body: { error: { message: 'Something went wrong. Try again later.' } } };
    }
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
  }

  private async handle(op: Op): Promise<{ status: number; body: unknown }> {
    const now = Date.now();
    const day = today(now);
    // Counts older than KEEP_DAYS go, once a day.
    if (this.pruned !== day) {
      this.sql.exec('DELETE FROM counts WHERE day < ?', today(now - KEEP_DAYS * DAY));
      this.pruned = day;
    }
    if (op.op === 'hit') {
      if (!this.sql.exec('SELECT 1 AS x FROM sites WHERE id = ?', op.site).toArray().length) return { status: 200, body: { ok: true } };
      const had = this.sql.exec('SELECT n FROM counts WHERE site = ? AND day = ? AND page = ?', op.site, day, op.page).toArray().length > 0;
      if (had) this.sql.exec('UPDATE counts SET n = n + 1 WHERE site = ? AND day = ? AND page = ?', op.site, day, op.page);
      else if (Number(this.sql.exec('SELECT COUNT(*) AS c FROM counts WHERE site = ? AND day = ?', op.site, day).toArray()[0]?.c) < MAX_PAGES_A_DAY) {
        this.sql.exec('INSERT INTO counts (site, day, page, n) VALUES (?, ?, ?, 1)', op.site, day, op.page);
      }
      return { status: 200, body: { ok: true } };
    }
    if (op.op === 'site') {
      const total = Number(this.sql.exec('SELECT n FROM total').toArray()[0]?.n) || 0;
      if (total >= (Number(this.env.MAX_SITES) || 10_000)) return { status: 503, body: { error: { message: 'The visit counter is full right now. Try again another day.' } } };
      const site = random(16);
      const key = random(32);
      this.sql.exec('INSERT INTO sites (id, key, made) VALUES (?, ?, ?)', site, await hash(key), day);
      this.sql.exec('UPDATE total SET n = n + 1');
      return { status: 200, body: { site, key } };
    }
    const row = this.sql.exec('SELECT key FROM sites WHERE id = ?', op.site).toArray()[0];
    if (!row || row.key !== (await hash(op.key))) return { status: 404, body: { error: { message: 'No site with that id and key.' } } };
    if (op.op === 'read') {
      const counts = this.sql.exec('SELECT day, page, n FROM counts WHERE site = ? AND day >= ? ORDER BY day, page', op.site, today(now - (op.days - 1) * DAY)).toArray();
      return { status: 200, body: { counts } };
    }
    this.sql.exec('DELETE FROM counts WHERE site = ?', op.site);
    this.sql.exec('DELETE FROM sites WHERE id = ?', op.site);
    this.sql.exec('UPDATE total SET n = MAX(0, n - 1)');
    return { status: 200, body: { ok: true } };
  }
}
