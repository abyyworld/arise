// The visit counter: counts per site, page and day, keeps nothing about who visited, and only
// gives the counts back with the site's read key.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as entry from './index';
import worker, { Visits, type Env } from './index';
import { fakeStorage } from './test/helpers';

const ARISE = 'https://abyyworld.github.io';
const SITE_ORIGIN = 'https://sam.github.io';
const IP = '203.0.113.77';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) TestBrowser/1.0';
const REF = 'https://search.example.com/?q=sam';

function server(over: Partial<Env> = {}) {
  const storage = fakeStorage();
  const object = new Visits(storage, { MAX_SITES: over.MAX_SITES });
  const busy = new Set<string>();
  const env: Env = {
    ALLOWED_ORIGINS: `${ARISE}, http://localhost:5173`,
    PER_SITE: { limit: async ({ key }) => ({ success: !busy.has(key) }) },
    NEW_SITES: { limit: async () => ({ success: !busy.has('new') }) },
    VISITS: { idFromName: (n) => n, get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }) },
    ...over,
  };
  const call = async (path: string, body?: unknown, { origin = ARISE, method = body === undefined ? 'GET' : 'POST', raw, type = 'application/json' }: { origin?: string; method?: string; raw?: string; type?: string } = {}) => {
    const headers: Record<string, string> = { 'cf-connecting-ip': IP, 'user-agent': UA, referer: REF, 'content-type': type, cookie: 'id=visitor-cookie' };
    if (origin) headers.origin = origin;
    const res = await worker.fetch(new Request(`https://arise-visits.example.workers.dev${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  // A visit, as a published page sends it (lib/site.ts counterScript): text/plain, from the site.
  const visit = (s: string, p: string) => call('/v1/hit', { s, p }, { origin: SITE_ORIGIN, type: 'text/plain' });
  const newSite = async () => (await call('/v1/sites', {})).body as { site: string; key: string };
  return { env, call, visit, newSite, storage, busy };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

it('exports only what the Workers runtime can start with: handlers and classes', () => {
  for (const [name, v] of Object.entries(entry)) expect(name === 'default' || typeof v === 'function', name).toBe(true);
  expect(Object.keys(entry).sort()).toEqual(['Visits', 'default']);
});

describe('counting', () => {
  it('adds one per page opened, per site, page and day', async () => {
    const s = server();
    const a = await s.newSite();
    const b = await s.newSite();
    expect(a.site).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.site).not.toBe(b.site);
    for (const p of ['index', 'index', 'about', 'writing/first-post']) expect((await s.visit(a.site, p)).status).toBe(204);
    await s.visit(b.site, 'index');
    vi.setSystemTime(new Date('2026-11-21T09:00:00Z'));
    await s.visit(a.site, 'index');
    const read = await s.call('/v1/read', { site: a.site, key: a.key, days: 30 });
    expect(read.status).toBe(200);
    expect(read.body.counts).toEqual([
      { day: '2026-11-20', page: 'about', n: 1 },
      { day: '2026-11-20', page: 'index', n: 2 },
      { day: '2026-11-20', page: 'writing/first-post', n: 1 },
      { day: '2026-11-21', page: 'index', n: 1 },
    ]);
    // The other site's visit is its own.
    expect((await s.call('/v1/read', { site: b.site, key: b.key })).body.counts).toEqual([{ day: '2026-11-20', page: 'index', n: 1 }]);
  });

  it('takes a visit from any website, with no cookies either way', async () => {
    const s = server();
    const a = await s.newSite();
    const res = await s.visit(a.site, 'index');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    const pre = await s.call('/v1/hit', undefined, { origin: 'https://anyone.example', method: 'OPTIONS' });
    expect(pre.status).toBe(204);
  });

  it('keeps no IP address, browser, referrer or cookie: only the site, page, day and count', async () => {
    const s = server();
    const a = await s.newSite();
    await s.visit(a.site, 'about');
    await s.visit(a.site, 'about');
    const kept = s.storage.dump();
    for (const bit of [IP, UA, REF, 'search.example.com', 'visitor-cookie', SITE_ORIGIN, 'sam.github.io', 'Mozilla']) expect(kept).not.toContain(bit);
    // Nor do they reach the database at all, in any statement.
    const sent = JSON.stringify(s.storage.queries);
    for (const bit of [IP, UA, REF, 'visitor-cookie', SITE_ORIGIN]) expect(sent).not.toContain(bit);
    // And never the read key itself: only its SHA-256.
    expect(kept).not.toContain(a.key);
    expect(sent).not.toContain(a.key);
  });

  it('ignores what isn\'t a visit: an unknown site, an odd page name, too much data, a site sending too many', async () => {
    const s = server();
    const a = await s.newSite();
    expect((await s.visit('A'.repeat(22), 'index')).status).toBe(204); // no such site: nothing kept
    for (const p of ['../etc', 'About', 'a b', '<script>', 'x/y/z', 'a'.repeat(121), '']) expect((await s.visit(a.site, p)).status).toBe(204);
    expect((await s.call('/v1/hit', null, { origin: SITE_ORIGIN, raw: JSON.stringify({ s: a.site, p: 'index', pad: 'x'.repeat(2000) }) })).status).toBe(413);
    expect((await s.call('/v1/hit', null, { origin: SITE_ORIGIN, raw: 'not json' })).status).toBe(400);
    s.busy.add(a.site);
    await s.visit(a.site, 'index');
    s.busy.delete(a.site);
    expect((await s.call('/v1/read', { site: a.site, key: a.key })).body.counts).toEqual([]);
    expect(s.storage.dump()).not.toContain('AAAAAAAAAAAAAAAAAAAAAA');
  });

  it('counts at most 200 different pages a day for one site', async () => {
    const s = server();
    const a = await s.newSite();
    for (let i = 0; i < 205; i++) await s.visit(a.site, `p${i}`);
    await s.visit(a.site, 'p1');
    const counts = (await s.call('/v1/read', { site: a.site, key: a.key })).body.counts as { page: string; n: number }[];
    expect(counts.length).toBe(200);
    expect(counts.find((c) => c.page === 'p1')!.n).toBe(2);
  });

  it('lets counts older than 400 days go', async () => {
    const s = server();
    const a = await s.newSite();
    await s.visit(a.site, 'index');
    vi.setSystemTime(new Date('2028-01-10T10:00:00Z'));
    await s.visit(a.site, 'about');
    expect((await s.call('/v1/read', { site: a.site, key: a.key, days: 400 })).body.counts).toEqual([{ day: '2028-01-10', page: 'about', n: 1 }]);
    expect(s.storage.dump()).not.toContain('2026-11-20","page"');
  });
});

describe('the read key', () => {
  it('gives the counts back only with the right key, and only to Arise', async () => {
    const s = server();
    const a = await s.newSite();
    await s.visit(a.site, 'index');
    const wrong = `${a.key.slice(0, -1)}${a.key.endsWith('A') ? 'B' : 'A'}`;
    expect((await s.call('/v1/read', { site: a.site, key: wrong })).status).toBe(404);
    expect((await s.call('/v1/read', { site: a.site })).status).toBe(400);
    expect((await s.call('/v1/read', { site: a.site, key: a.key }, { origin: SITE_ORIGIN })).status).toBe(403);
    expect((await s.call('/v1/read', { site: a.site, key: a.key }, { origin: '' })).status).toBe(403);
    expect((await s.call('/v1/sites', {}, { origin: SITE_ORIGIN })).status).toBe(403);
    const ok = await s.call('/v1/read', { site: a.site, key: a.key });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ARISE);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });

  it('forgets a site and every count with its key', async () => {
    const s = server();
    const a = await s.newSite();
    await s.visit(a.site, 'index');
    expect((await s.call('/v1/forget', { site: a.site, key: 'x'.repeat(43) })).status).toBe(404);
    expect((await s.call('/v1/forget', { site: a.site, key: a.key })).body).toEqual({ ok: true });
    expect((await s.call('/v1/read', { site: a.site, key: a.key })).status).toBe(404);
    expect(s.storage.dump()).not.toContain(a.site);
    await s.visit(a.site, 'index'); // a page still out there counts nothing now
    expect(s.storage.dump()).not.toContain(a.site);
  });

  it('makes at most MAX_SITES sites, and new ones only so fast', async () => {
    const s = server({ MAX_SITES: '2' });
    await s.newSite();
    const b = await s.newSite();
    expect((await s.call('/v1/sites', {})).status).toBe(503);
    await s.call('/v1/forget', b);
    expect((await s.call('/v1/sites', {})).status).toBe(200);
    s.busy.add('new');
    expect((await s.call('/v1/sites', {})).status).toBe(429);
  });

  it('answers only its own routes', async () => {
    const s = server();
    expect((await s.call('/health')).body).toEqual({ ok: true, name: 'arise-visits' });
    expect((await s.call('/v1/other', {})).status).toBe(404);
    expect((await s.call('/v1/read')).status).toBe(405);
    expect((await s.call('/v1/read', undefined, { origin: SITE_ORIGIN, method: 'OPTIONS' })).status).toBe(403);
  });
});
