// Visits to Your website (opt-in, less private): how many times each page was opened, per day,
// from the small counter in worker/visits. The published pages tell it the site's public id and
// the page's name (lib/site.ts counterScript); it keeps counts only, no cookies and no IP
// addresses. Reading the counts back takes the site's private read key, which stays on this
// device: never synced, never in a backup.

import { VISITS } from './visits-config';

const KEY = 'arise-site-visits';
const SITE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const READ_KEY = /^[A-Za-z0-9_-]{32,128}$/;

export interface Count {
  day: string; // YYYY-MM-DD (UTC)
  page: string;
  n: number;
}
export class VisitsError extends Error {}

export const server = () => VISITS.server.replace(/\/+$/, '');
export const available = () => /^https:\/\//.test(server());

export function local(): { site: string; key: string } | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || 'null');
    return r && SITE_ID.test(r.site) && READ_KEY.test(r.key) ? { site: r.site, key: r.key } : null;
  } catch {
    return null;
  }
}
function keep(v: { site: string; key: string } | null) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {}
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  if (!available()) throw new VisitsError("The visit counter isn't set up yet.");
  let res: Response;
  try {
    res = await fetch(`${server()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
  } catch {
    throw new VisitsError("Couldn't reach the visit counter. Check your internet connection.");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 429) throw new VisitsError('The visit counter is busy. Try again in a minute.');
  if (!res.ok) throw new VisitsError(typeof (data.error as { message?: unknown })?.message === 'string' ? String((data.error as { message: string }).message) : "The visit counter said no. Try again later.");
  return data;
}

// A new site id and read key from the counter. The id goes into the published pages; the key
// stays here.
export async function start(): Promise<string> {
  const have = local();
  if (have) return have.site;
  const d = await post('/v1/sites', {});
  const site = String(d.site || '');
  const key = String(d.key || '');
  if (!SITE_ID.test(site) || !READ_KEY.test(key)) throw new VisitsError('The visit counter sent an answer Arise does not understand.');
  keep({ site, key });
  return site;
}

// The counts of the last `days` days, oldest first.
export async function counts(days = 30): Promise<Count[]> {
  const have = local();
  if (!have) return [];
  const d = await post('/v1/read', { site: have.site, key: have.key, days });
  return (Array.isArray(d.counts) ? d.counts : [])
    .map((c: Record<string, unknown>) => ({ day: String(c.day || ''), page: String(c.page || ''), n: Number(c.n) || 0 }))
    .filter((c: Count) => /^\d{4}-\d{2}-\d{2}$/.test(c.day) && c.page && c.n > 0)
    .sort((a: Count, b: Count) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// Off: the counter forgets the site and its counts, and the key goes from this device.
export async function stop() {
  const have = local();
  keep(null);
  if (have && available()) await post('/v1/forget', have).catch(() => {});
}

// Per day (every day of the last `days`, zero where none) and per page, for the chart.
export function summarize(list: Count[], days = 30, now = Date.now()): { days: { day: string; n: number }[]; pages: { page: string; n: number }[]; total: number } {
  const byDay = new Map<string, number>();
  const byPage = new Map<string, number>();
  for (const c of list) {
    byDay.set(c.day, (byDay.get(c.day) || 0) + c.n);
    byPage.set(c.page, (byPage.get(c.page) || 0) + c.n);
  }
  const out: { day: string; n: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, n: byDay.get(day) || 0 });
  }
  const pages = [...byPage].map(([page, n]) => ({ page, n })).sort((a, b) => b.n - a.n || (a.page < b.page ? -1 : 1));
  return { days: out, pages, total: out.reduce((s, d) => s + d.n, 0) };
}
