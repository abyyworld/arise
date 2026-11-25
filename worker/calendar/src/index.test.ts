// The calendar helper: fetches a calendar's link for Arise's web address only, passes back only
// calendars, follows a few redirects but never to a private network, and keeps nothing.

import { describe, expect, it, vi } from 'vitest';
import { handle, MAX_BYTES, MAX_PAGE_BYTES, publicUrl, type Env } from './index';

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

  describe('POST /page (Keep a copy on Your links)', () => {
    const askPage = (body: unknown, origin = ORIGIN) =>
      new Request('https://arise-calendar.example.workers.dev/page', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify(body) });
    const HTML = '<!doctype html><title>Hi</title><p>Hello there</p>';
    const run = (r: Response, url = 'https://news.example.com/a') => handle(askPage({ url }), env(), { fetch: (async () => r) as unknown as typeof globalThis.fetch });

    it('fetches one HTML page and passes it back inside JSON, with no cookies either way', async () => {
      const fetch = vi.fn(async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'id=1' } }));
      const res = await handle(askPage({ url: 'https://news.example.com/a?b=1' }), env(), { fetch: fetch as unknown as typeof globalThis.fetch });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ url: 'https://news.example.com/a?b=1', html: HTML });
      const init = (fetch.mock.calls[0] as unknown[])[1] as RequestInit;
      const sent = new Headers(init.headers);
      expect(sent.get('cookie')).toBeNull();
      expect(sent.get('accept')).toBe('text/html');
      expect(init.method).toBe('GET');
    });

    it('reads the character set the page names', async () => {
      const bytes = new Uint8Array([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]); // <p>café</p> in latin-1
      const res = await run(new Response(bytes, { headers: { 'content-type': 'text/html; charset=ISO-8859-1' } }));
      expect(((await res.json()) as { html: string }).html).toBe('<p>café</p>');
    });

    it('passes back only HTML, at most 2 MB', async () => {
      expect((await run(new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }))).status).toBe(415);
      expect((await run(new Response('plain', { headers: { 'content-type': 'text/plain' } }))).status).toBe(415);
      expect((await run(new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }))).status).toBe(415);
      expect((await run(new Response(HTML, { headers: { 'content-type': 'text/htmlx' } }))).status).toBe(415);
      expect((await run(new Response(`<p>${'x'.repeat(MAX_PAGE_BYTES)}</p>`, { headers: { 'content-type': 'text/html' } }))).status).toBe(413);
      expect((await run(new Response('gone', { status: 404 }))).status).toBe(404);
    });

    it('never fetches this machine, a private network, or anything but http and https', async () => {
      const fetch = vi.fn();
      const deps = { fetch: fetch as unknown as typeof globalThis.fetch };
      for (const url of ['http://127.0.0.1/', 'http://192.168.1.1/admin', 'http://localhost/', 'webcal://news.example.com/a', 'ftp://example.com/', 'javascript:alert(1)', 'file:///etc/passwd']) {
        expect((await handle(askPage({ url }), env(), deps)).status).toBe(400);
      }
      expect(fetch).not.toHaveBeenCalled();
      const sneaky = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'http://10.0.0.1/' } }));
      expect((await handle(askPage({ url: 'https://news.example.com/a' }), env(), { fetch: sneaky as unknown as typeof globalThis.fetch })).status).toBe(502);
      expect(sneaky).toHaveBeenCalledTimes(1);
    });

    it('follows a redirect and says where the page ended up', async () => {
      const fetch = vi.fn(async (url: string) => (url.includes('short') ? new Response(null, { status: 302, headers: { location: 'https://news.example.com/long' } }) : new Response(HTML, { headers: { 'content-type': 'text/html' } })));
      const res = await handle(askPage({ url: 'https://short.example.com/x' }), env(), { fetch: fetch as unknown as typeof globalThis.fetch });
      expect(((await res.json()) as { url: string }).url).toBe('https://news.example.com/long');
    });

    it('answers only Arise, and counts toward the same limit', async () => {
      const fetch = vi.fn();
      const deps = { fetch: fetch as unknown as typeof globalThis.fetch };
      expect((await handle(askPage({ url: 'https://news.example.com/a' }, 'https://evil.example'), env(), deps)).status).toBe(403);
      expect((await handle(askPage({ url: 'https://news.example.com/a' }), env(false), deps)).status).toBe(429);
      expect(fetch).not.toHaveBeenCalled();
    });
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
