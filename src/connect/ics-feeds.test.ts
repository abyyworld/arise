// @vitest-environment jsdom
// Calendars added by their link: kept on this device, read every hour (straight from the phone
// apps; on the web straight, or through the helper when the person allowed it), their events
// into the life log, and the ones that went taken back out.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR } from '../calendar-config';
import { fakeNet, useNative, useWeb, type Net } from '../test/fake-http';
import { fakeLife } from '../test/fake-life';
import * as F from './ics-feeds';
import * as IDS from './ids';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const URL1 = 'https://cal.example.com/private/abc123secret/basic.ics';
let net: Net;
let life: ReturnType<typeof fakeLife>;

const ev = (uid: string, start: string, summary: string, more: string[] = []) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${start}`, `SUMMARY:${summary}`, ...more, 'END:VEVENT'];
const ics = (...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Family', ...events.flat(), 'END:VCALENDAR'].join('\r\n');

beforeEach(() => {
  localStorage.clear();
  IDS.resetForTests();
  life = fakeLife();
  net = fakeNet();
  CALENDAR.server = '';
});
afterEach(() => {
  CALENDAR.server = '';
});

describe('the list of calendars', () => {
  it('takes https, http and webcal links, and never one with a password in it', () => {
    expect(F.feedUrl(' webcal://p01-calendars.icloud.com/published/2/xyz ')).toBe('https://p01-calendars.icloud.com/published/2/xyz');
    expect(F.feedUrl('http://example.com/a.ics')).toBe('http://example.com/a.ics');
    expect(F.feedUrl('ftp://example.com/a.ics')).toBe('');
    expect(F.feedUrl('https://me:pw@example.com/a.ics')).toBe('');
    expect(F.feedUrl('not a link')).toBe('');
    expect(F.hostOf(URL1)).toBe('cal.example.com');
  });

  it('keeps each one on this device, once, and refuses a bad one', () => {
    const f = F.addFeed({ name: ' Work ', url: URL1 }, NOW);
    expect(f).toMatchObject({ name: 'Work', named: true, url: URL1, helper: false, added: NOW });
    expect(F.feeds()).toEqual([f]);
    expect(() => F.addFeed({ name: '', url: URL1.replace('https', 'webcal') })).toThrow('already here');
    expect(() => F.addFeed({ name: 'x', url: 'mailto:sam@example.com' })).toThrow("isn't a calendar link");
    localStorage.setItem('arise-connect-ics', JSON.stringify([{ id: 'BAD ID', url: URL1 }, { id: 'abcd', url: 'javascript:alert(1)' }, 'junk']));
    expect(F.feeds()).toEqual([]);
  });

  it('reads again every hour, and waits longer after each problem', () => {
    const f = F.addFeed({ name: 'Work', url: URL1 }, NOW);
    expect(F.due(f, NOW)).toBe(true);
    expect(F.due({ ...f, last: NOW - 30 * 60_000 }, NOW)).toBe(false);
    expect(F.due({ ...f, last: NOW - 61 * 60_000 }, NOW)).toBe(true);
    expect(F.due({ ...f, last: 0, next: NOW + 1000 }, NOW)).toBe(false);
    expect([1, 2, 3, 6, 20].map((n) => F.backoff(n) / 60_000)).toEqual([15, 30, 60, 360, 360]);
  });
});

describe('reading a calendar', () => {
  it('in the phone apps: straight from its server, events into the life log, named after the calendar', async () => {
    useNative(net);
    net.on(/cal\.example\.com/, { body: ics(ev('a', '20261124T090000Z', 'Dentist'), ev('b', '20261125T180000Z', 'Football')), headers: { 'content-type': 'text/calendar' } });
    const f = F.addFeed({ name: '', url: URL1 }, NOW);
    await F.syncFeed(f.id, { now: NOW });
    expect(life.titles()).toEqual(['Dentist', 'Football']);
    expect(life.list()[0]).toMatchObject({ source: 'calendar', kind: 'event', meta: { app: 'ics', calendar: 'Family', feed: f.id } });
    const after = F.get(f.id)!;
    expect(after).toMatchObject({ name: 'Family', count: 2, error: '', fails: 0 });
    expect(after.last).toBeGreaterThan(0);
    expect(net.calls.map((c) => c.url)).toEqual([URL1]);
  });

  it('takes out events the calendar no longer has, but keeps the ones from before the year it reads', async () => {
    useNative(net);
    let body = ics(ev('old', '20250101T090000Z', 'Long ago'), ev('a', '20261124T090000Z', 'Dentist'), ev('b', '20261125T180000Z', 'Football'));
    net.on(/cal\.example\.com/, () => ({ body }));
    const f = F.addFeed({ name: 'Family', url: URL1 }, NOW);
    // A year ago, "Long ago" was in the window.
    await F.syncFeed(f.id, { now: Date.parse('2025-06-01T12:00:00Z') });
    await F.syncFeed(f.id, { now: NOW });
    expect(life.titles()).toEqual(['Long ago', 'Dentist', 'Football']);
    body = ics(ev('a', '20261124T090000Z', 'Dentist (moved)', ['DTEND:20261124T100000Z']));
    await F.syncFeed(f.id, { now: NOW + 3600_000 });
    expect(life.titles()).toEqual(['Long ago', 'Dentist (moved)']);
    expect(F.get(f.id)!.count).toBe(2);
  });

  it('on the web, straight from the server when it allows web pages', async () => {
    useWeb(net);
    net.on(/cal\.example\.com/, { body: ics(ev('a', '20261124T090000Z', 'Dentist')) });
    const f = F.addFeed({ name: 'Family', url: URL1 }, NOW);
    await F.syncFeed(f.id, { now: NOW });
    expect(life.titles()).toEqual(['Dentist']);
  });

  it("on the web, a server that blocks web pages needs the helper; without it, it says so and waits", async () => {
    useWeb(net);
    net.on(/cal\.example\.com/, () => {
      throw new TypeError('Failed to fetch');
    });
    const f = F.addFeed({ name: 'Family', url: URL1 }, NOW);
    await F.syncFeed(f.id, { now: NOW });
    const after = F.get(f.id)!;
    expect(after.error).toBe(F.BLOCKED);
    expect(after.error).not.toContain('abc123secret');
    expect(after.fails).toBe(1);
    expect(after.next).toBe(NOW + 15 * 60_000);
    expect(life.list()).toEqual([]);

    F.setHelper(f.id, true);
    await F.syncFeed(f.id, { now: NOW });
    expect(F.get(f.id)!.error).toBe(F.NO_HELPER);
  });

  it('through the helper when allowed: the link only in the body, never in its address', async () => {
    useWeb(net);
    CALENDAR.server = 'https://arise-calendar.example.workers.dev';
    net.on(/cal\.example\.com/, () => {
      throw new TypeError('Failed to fetch');
    });
    net.on(/arise-calendar\.example\.workers\.dev\/fetch$/, (c) => {
      expect(c.method).toBe('POST');
      expect(JSON.parse(c.body)).toEqual({ url: URL1 });
      return { body: ics(ev('a', '20261124T090000Z', 'Dentist')), headers: { 'content-type': 'text/calendar' } };
    });
    const f = F.addFeed({ name: 'Family', url: URL1, helper: true }, NOW);
    expect(F.helperReady()).toBe(true);
    await F.syncFeed(f.id, { now: NOW });
    expect(life.titles()).toEqual(['Dentist']);
    const helperCall = net.calls.find((c) => /workers\.dev/.test(c.url))!;
    expect(helperCall.url).not.toContain('abc123secret');
  });

  it('says plainly when the link is wrong, or is not a calendar', async () => {
    useNative(net);
    net.on(/cal\.example\.com/, { status: 404, body: 'Not found' });
    const f = F.addFeed({ name: 'Family', url: URL1 }, NOW);
    await F.syncFeed(f.id, { now: NOW });
    expect(F.get(f.id)!.error).toMatch(/doesn't work any more/);
    net.on(/cal\.example\.com/, { body: '<html>Sign in</html>' });
    await F.syncFeed(f.id, { now: NOW });
    expect(F.get(f.id)!.error).toMatch(/isn't a calendar/);
    expect(F.get(f.id)!.fails).toBe(2);
  });

  it('a new name goes onto its events; removing it takes them out', async () => {
    useNative(net);
    net.on(/cal\.example\.com/, { body: ics(ev('a', '20261124T090000Z', 'Dentist')) });
    const f = F.addFeed({ name: 'Family', url: URL1 }, NOW);
    await F.syncFeed(f.id, { now: NOW });
    expect(F.renameFeed(f.id, 'Home')).toBe(true);
    expect(F.renameFeed(f.id, '   ')).toBe(false);
    await F.syncFeed(f.id, { now: NOW });
    expect(life.list()[0].meta?.calendar).toBe('Home');
    await F.removeFeed(f.id);
    expect(F.feeds()).toEqual([]);
    expect(life.list()).toEqual([]);
  });

  it('syncs only the calendars whose turn it is', async () => {
    useNative(net);
    net.on(/example\.com/, { body: ics(ev('a', '20261124T090000Z', 'Dentist')) });
    const a = F.addFeed({ name: 'A', url: URL1 }, NOW);
    const b = F.addFeed({ name: 'B', url: 'https://other.example.com/b.ics' }, NOW);
    localStorage.setItem('arise-connect-ics', JSON.stringify(F.feeds().map((f) => (f.id === b.id ? { ...f, last: NOW } : f))));
    F.syncDue(NOW);
    await new Promise((r) => setTimeout(r, 50));
    expect(net.calls.map((c) => c.url)).toEqual([URL1]);
    expect(F.get(a.id)!.count).toBe(1);
  });

  it('"Erase all data" forgets every link', async () => {
    F.addFeed({ name: 'A', url: URL1 }, NOW);
    await F.forgetAll();
    expect(localStorage.getItem('arise-connect-ics')).toBeNull();
  });
});
