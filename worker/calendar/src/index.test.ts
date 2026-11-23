// The calendar helper: fetches a calendar's link for Arise's web address only, passes back only
// calendars, follows a few redirects but never to a private network, and keeps nothing.

import { describe, expect, it, vi } from 'vitest';
import { handle, MAX_BYTES, publicUrl, type Env } from './index';

const ORIGIN = 'https://abyyworld.github.io';
const CAL = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const env = (ok = true): Env => ({ ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`, PER_IP: { limit: async () => ({ success: ok }) } });
const ask = (body: unknown, origin = ORIGIN, method = 'POST') =>
  new Request('https://arise-calendar.example.workers.dev/fetch', { method, headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: method === 'POST' ? JSON.stringify(body) : undefined });

describe('the calendar helper', () => {
  it('fetches a calendar for the Arise web app and passes it back', async () => {
    const fetch = vi.fn(async () => new Response(CAL, { status: 200, headers: { 'content-type': 'text/calendar' } }));
    const res = await handle(ask({ url: 'webcal://cal.example.com/a/secret.ics' }), env(), { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CAL);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe('https://cal.example.com/a/secret.ics');
  });

  it('answers only Arise, and only POST /fetch', async () => {
    const fetch = vi.fn();
    const deps = { fetch: fetch as unknown as typeof globalThis.fetch };
    expect((await handle(ask({ url: 'https://cal.example.com/a.ics' }, 'https://evil.example'), env(), deps)).status).toBe(403);
    expect((await handle(new Request('https://x.workers.dev/fetch', { method: 'OPTIONS', headers: { origin: ORIGIN } }), env(), deps)).status).toBe(204);
    expect((await handle(new Request('https://x.workers.dev/fetch', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env(), deps)).status).toBe(403);
    expect((await handle(ask(null, ORIGIN, 'GET'), env(), deps)).status).toBe(405);
    expect((await handle(new Request('https://x.workers.dev/other'), env(), deps)).status).toBe(404);
    const health = await handle(new Request('https://x.workers.dev/health'), env(), deps);
    expect(await health.json()).toEqual({ ok: true, name: 'arise-calendar' });
    expect((await handle(ask({ url: 'https://cal.example.com/a.ics' }), env(false), deps)).status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never fetches this machine or a private network', () => {
    for (const bad of ['http://localhost/a.ics', 'http://127.0.0.1/a.ics', 'http://10.0.0.5/a', 'http://192.168.1.2/a', 'http://172.20.0.1/a', 'http://169.254.169.254/latest', 'http://[::1]/a', 'http://printer.local/a', 'ftp://example.com/a', 'https://me:pw@example.com/a', 'https://example.com:8080/a', 'http://2130706433/a', 'http://0x7f000001/a', 42]) {
      expect(publicUrl(bad)).toBeNull();
    }
    expect(publicUrl('https://calendar.google.com/calendar/ical/x/private-y/basic.ics')?.hostname).toBe('calendar.google.com');
  });

  it('follows a redirect to another public address, but not to a private one', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes('first') ? new Response(null, { status: 302, headers: { location: 'https://second.example.com/cal.ics' } }) : url.includes('second') ? new Response(CAL) : new Response('no', { status: 500 }),
    );
    const ok = await handle(ask({ url: 'https://first.example.com/cal.ics' }), env(), { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(ok.status).toBe(200);
    const sneaky = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }));
    const res = await handle(ask({ url: 'https://first.example.com/cal.ics' }), env(), { fetch: sneaky as unknown as typeof globalThis.fetch });
    expect(res.status).toBe(502);
    expect(sneaky).toHaveBeenCalledTimes(1);
  });

  it("passes on the server's no, and refuses what isn't a calendar or is too big", async () => {
    const run = (r: Response) => handle(ask({ url: 'https://cal.example.com/a.ics' }), env(), { fetch: (async () => r) as unknown as typeof globalThis.fetch });
    expect((await run(new Response('gone', { status: 404 }))).status).toBe(404);
    expect((await run(new Response('<html>Sign in</html>'))).status).toBe(422);
    expect((await run(new Response(`${CAL}${'X'.repeat(MAX_BYTES)}`))).status).toBe(413);
    expect((await run(new Response(`﻿${CAL}`))).status).toBe(200);
  });

  it('takes the link only in the body, and refuses a bad body', async () => {
    const fetch = vi.fn();
    const deps = { fetch: fetch as unknown as typeof globalThis.fetch };
    expect((await handle(ask({ url: 'not a link' }), env(), deps)).status).toBe(400);
    const raw = new Request('https://x.workers.dev/fetch', { method: 'POST', headers: { origin: ORIGIN }, body: '{oops' });
    expect((await handle(raw, env(), deps)).status).toBe(400);
    expect((await handle(ask({ url: `https://cal.example.com/${'a'.repeat(5000)}` }), env(), deps)).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
});
