// Reminders in the browser, the extension's side: what's taken from Arise (sealed for this
// extension only, checked field by field), when each one is due, the quiet hours, the count on the
// button, and that turning them off deletes what's kept.

import { describe, expect, it } from 'vitest';
import * as Rm from './remind';
import { sealBatch } from './seal';
import { savedEvent, savedUrl } from './events';

const NOW = new Date(2026, 10, 25, 14, 0).getTime();
const MIN = 60_000;
const LINK = 'L'.repeat(22);

function kv(): Rm.KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    remove: async (keys) => {
      for (const k of keys) data.delete(k);
    },
  };
}

const item = (id: string, at: number, title = 'Something on your to-do list') => ({ id, at, title, body: 'Open Arise to see it.' });
const pack = (items: unknown[], quiet = ['22:00', '08:00']) => ({ v: 1, made: NOW, items, quietFrom: quiet[0], quietTo: quiet[1] });
const box = (pub: string, p: unknown, link = LINK) => sealBatch(pub, link, { id: 'B'.repeat(22), from: NOW, to: NOW, n: 1 }, p);

describe('what Arise sends', () => {
  it('keeps only well-formed reminders in the next week, soonest first, in plain text', () => {
    const p = Rm.parsePack(
      pack([
        item('todo-b', NOW + 60 * MIN),
        item('todo-a', NOW + 5 * MIN),
        item('todo-a', NOW + 6 * MIN), // the same id again
        { id: 'bad id!', at: NOW + MIN, title: 'x' },
        { id: 'far', at: NOW + 30 * 24 * 60 * MIN, title: 'Too far' },
        { id: 'no-title', at: NOW + MIN, title: '   ' },
        { id: 'ctl', at: NOW + 2 * MIN, title: 'Line\u0000one\nand two', body: 42 },
      ]),
      NOW,
    )!;
    expect(p.items.map((r) => r.id)).toEqual(['ctl', 'todo-a', 'todo-b']);
    expect(p.items[0]).toEqual({ id: 'ctl', at: NOW + 2 * MIN, title: 'Line one and two', body: '' });
    expect(p.quietFrom).toBe('22:00');
    expect(Rm.parsePack({ v: 2, items: [] }, NOW)).toBeNull();
    expect(Rm.parsePack(pack([], ['25:00', 'x']), NOW)).toMatchObject({ quietFrom: '', quietTo: '' });
  });

  it('opens only with this extension\'s own key, and only while reminders are on', async () => {
    const store = kv();
    const pub0 = await Rm.publicKey(kv());
    expect(await Rm.take(store, LINK, await box(pub0, pack([item('todo-a', NOW + MIN)])), NOW)).toEqual({ ok: false, error: 'off' });
    await Rm.setOn(store, true);
    const pub = await Rm.publicKey(store);
    expect(pub).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(await Rm.publicKey(store)).toBe(pub); // made once
    // Sealed for another key, or for another link: not opened.
    expect(await Rm.take(store, LINK, await box(pub0, pack([item('todo-a', NOW + MIN)])), NOW)).toEqual({ ok: false, error: 'bad' });
    expect(await Rm.take(store, LINK, await box(pub, pack([item('todo-a', NOW + MIN)]), 'M'.repeat(22)), NOW)).toEqual({ ok: false, error: 'bad' });
    expect(await Rm.take(store, LINK, { nonsense: true }, NOW)).toEqual({ ok: false, error: 'bad' });
    expect(await Rm.take(store, LINK, await box(pub, pack([item('todo-a', NOW + MIN), item('todo-b', NOW + 9 * MIN)])), NOW)).toEqual({ ok: true, n: 2 });
    expect(Rm.alarmsFor((await Rm.kept(store)).pack, NOW)).toEqual([
      { name: 'remind:todo-a', when: NOW + MIN },
      { name: 'remind:todo-b', when: NOW + 9 * MIN },
    ]);
  });

  it('forgets everything, the key too, when turned off', async () => {
    const store = kv();
    await Rm.setOn(store, true);
    const pub = await Rm.publicKey(store);
    await Rm.take(store, LINK, await box(pub, pack([item('todo-a', NOW - MIN)])), NOW);
    await Rm.fire(store, [item('todo-a', NOW - MIN)]);
    expect(store.data.size).toBeGreaterThan(2);
    await Rm.setOn(store, false);
    expect([...store.data.keys()]).toEqual([]);
    expect(await Rm.isOn(store)).toBe(false);
  });
});

describe('when they show', () => {
  it('shows what is due once, lets go of what is over an hour late, and counts what is unread', async () => {
    const store = kv();
    await Rm.setOn(store, true);
    const pub = await Rm.publicKey(store);
    await Rm.take(store, LINK, await box(pub, pack([item('old', NOW - 2 * 60 * MIN), item('now', NOW - MIN), item('later', NOW + 10 * MIN)], ['', ''])), NOW);
    const due = Rm.dueNow(await Rm.kept(store), NOW);
    expect(due.show.map((r) => r.id)).toEqual(['now']);
    expect(due.skip).toEqual(['old']);
    expect(due.quiet).toBe(false);
    const k = await Rm.fire(store, due.show, due.skip);
    expect(k.unread.map((r) => r.id)).toEqual(['now']);
    expect(Rm.dueNow(k, NOW)).toMatchObject({ show: [], skip: [] });
    expect(Rm.badgeText(k.unread.length, false)).toBe('1');
    // The same list again from Arise: what was shown isn't shown again.
    await Rm.take(store, LINK, await box(pub, pack([item('now', NOW - MIN), item('later', NOW + 10 * MIN)], ['', ''])), NOW);
    expect(Rm.dueNow(await Rm.kept(store), NOW + 11 * MIN).show.map((r) => r.id)).toEqual(['later']);
    expect(await Rm.markRead(store)).toEqual([]);
    expect(Rm.badgeText(0, false)).toBe('');
    expect(Rm.badgeText(0, true)).toBe('off');
    expect(Rm.badgeText(120, false)).toBe('99+');
  });

  it('keeps quiet in the quiet hours, also across midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 25, h, m).getTime();
    expect(Rm.isQuiet(at(23), '22:00', '08:00')).toBe(true);
    expect(Rm.isQuiet(at(7, 59), '22:00', '08:00')).toBe(true);
    expect(Rm.isQuiet(at(8), '22:00', '08:00')).toBe(false);
    expect(Rm.isQuiet(at(13), '12:00', '14:00')).toBe(true);
    expect(Rm.isQuiet(at(15), '12:00', '14:00')).toBe(false);
    expect(Rm.isQuiet(at(3), '', '')).toBe(false);
    expect(Rm.isQuiet(at(3), '09:00', '09:00')).toBe(false);
    const k: Rm.Kept = { pack: Rm.parsePack(pack([item('a', at(23) - MIN)]), at(23))!, fired: [], unread: [] };
    expect(Rm.dueNow(k, at(23))).toMatchObject({ quiet: true, show: [{ id: 'a' }] });
  });
});

describe('a saved page', () => {
  const ctx = { arise: ['https://abyyworld.github.io/arise/'], browser: 'Chrome on macOS' };

  it('keeps the address as it is, without tracking ids or the part after #', async () => {
    expect(savedUrl('https://news.example.com/story?id=7&utm_source=x&fbclid=y#comments')).toBe('https://news.example.com/story?id=7');
    expect(savedUrl('https://www.youtube.com/watch?v=abc')).toBe('https://www.youtube.com/watch?v=abc');
    expect(savedUrl('https://me:pw@example.com/a')).toBeNull();
    expect(savedUrl('chrome://settings')).toBeNull();
    const e = (await savedEvent({ url: 'https://news.example.com/story?id=7&utm_medium=email', title: '  A   good story ', selection: 'The words I picked', time: NOW }, ctx))!;
    expect(e).toMatchObject({ source: 'browser', kind: 'note', at: NOW, title: 'A good story', url: 'https://news.example.com/story?id=7', detail: '"The words I picked"', tier: 3, meta: { saved: true, site: 'news.example.com', browser: 'Chrome on macOS' } });
    expect(e.id).toMatch(/^browser:[A-Za-z0-9_-]{22}$/);
    const long = (await savedEvent({ url: 'https://a.example.com/', selection: 'word '.repeat(200), time: NOW }, ctx))!;
    expect(long.detail!.length).toBeLessThanOrEqual(300);
    expect(long.title).toBe('a.example.com');
  });

  it("is never one of Arise's own pages or a page on this computer", async () => {
    expect(await savedEvent({ url: 'https://abyyworld.github.io/arise/#today', time: NOW }, ctx)).toBeNull();
    expect(await savedEvent({ url: 'http://localhost:3000/admin', time: NOW }, ctx)).toBeNull();
    expect(await savedEvent({ url: 'http://192.168.1.1/', time: NOW }, ctx)).toBeNull();
  });
});
