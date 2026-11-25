// @vitest-environment jsdom
// Reminders in a linked browser and pages saved from it, end to end: Arise's side (browser-remind.ts,
// browser-link.ts) with the real extension logic (extension/src/lib/recorder.ts, remind.ts) behind
// a pretend content script. The switch is one, kept in the extension; the list goes sealed for the
// extension's own key, in plain words unless details are on, with the quiet hours; turning it off
// deletes what the extension kept; a saved page lands in the life log as a saved link.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';
import type { LifeStore } from './store-port';
import type { Incoming, Transport } from './browser-link';
import * as R from '../../extension/src/lib/recorder';
import * as Rm from '../../extension/src/lib/remind';
import { parseRequest } from '../../extension/src/lib/pairing';

const st = vi.hoisted(() => ({
  state: {
    settings: { notifyDetails: false, quietFrom: '22:00', quietTo: '08:00' },
    todos: {} as Record<string, { id: string; title: string; day?: string; time?: string; done?: boolean; gone?: boolean }>,
    events: {} as Record<string, unknown>,
  },
  saves: [] as (() => void)[],
}));
vi.mock('../store', () => ({ state: st.state, onSave: (fn: () => void) => st.saves.push(fn) }));

const ARISE = 'https://abyyworld.github.io/arise/';
const ORIGIN = 'https://abyyworld.github.io';
const START = new Date(2026, 10, 25, 14, 5).getTime();
const MIN = 60_000;

function kv(): R.KV & { data: Map<string, unknown> } {
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

let now = START;
let env: R.Env;
let local: ReturnType<typeof kv>;
let reminded = 0;
let asked: string[] = [];
const listeners: ((p: Incoming) => void)[] = [];
const events = new Map<string, LifeEvent>();
const log: LifeStore = { addEvents: async (list) => list.filter((e) => !events.has(e.id) && events.set(e.id, e)).length };

const transport: Transport = {
  async ask(msg) {
    const req = parseRequest(structuredClone(msg));
    if (req) asked.push(req.t);
    return req ? structuredClone(await R.pageRequest(env, req, ORIGIN)) : { ok: false, error: 'bad' };
  },
  onPush: (fn) => void listeners.push(fn),
};

let BL: typeof import('./browser-link');
let BR: typeof import('./browser-remind');

async function boot({ link = true } = {}) {
  vi.resetModules();
  BL = await import('./browser-link');
  BR = await import('./browser-remind');
  (await import('./store-port')).setLifeStore(log);
  await BL.initBrowserLink({ transport, accountKey: async () => null, now: () => now });
  BR.initBrowserRemind({ now: () => now, brief: (t) => [{ at: t + 20 * 60 * MIN, title: 'Your morning brief', body: 'Your day: 2 events.', tag: 'brief-2026-11-26' }] });
  if (!link) return;
  await BL.startLink();
  const s = (await R.popupRequest(env, { t: 'state' })) as R.PopupState;
  await R.popupRequest(env, { t: 'confirm', link: s.pairing!.link });
  await vi.waitFor(() => expect(BL.here()).not.toBeNull());
}

beforeEach(() => {
  now = START;
  reminded = 0;
  asked = [];
  listeners.length = 0;
  events.clear();
  st.saves.length = 0;
  st.state.settings = { notifyDetails: false, quietFrom: '22:00', quietTo: '08:00' };
  st.state.todos = {
    a: { id: 'a', title: 'Call the dentist', day: '2026-11-25', time: '15:30' },
    b: { id: 'b', title: 'Done already', day: '2026-11-25', time: '16:00', done: true },
    c: { id: 'c', title: 'No time', day: '2026-11-25' },
    d: { id: 'd', title: 'Too far', day: '2026-12-20', time: '09:00' },
  };
  st.state.events = { e1: { id: 'e1', title: 'Team lunch', start: '2026-11-26T12:30', end: '2026-11-26T13:30', remind: [15], created: 1, at: 1 } };
  local = kv();
  env = {
    now: () => now,
    local,
    session: kv(),
    history: { search: async () => [], getVisits: async () => [] },
    browser: 'Chrome on macOS',
    version: '1.1.0',
    arise: [ARISE],
    allowed: (o) => o === ORIGIN,
    push: async (p) => {
      for (const fn of listeners) fn(structuredClone(p));
    },
    openConfirm: async () => {},
    reminded: async () => void reminded++,
  };
});

describe('reminders in the browser', () => {
  it('lists the next days in plain words, unless details are on', async () => {
    await boot({ link: false });
    const plain = BR.upcoming(START);
    expect(plain.map((r) => r.id)).toEqual(['todo-a', 'brief-2026-11-26', 'ev-e1-2026-11-26T12:30-15']);
    expect(plain[0]).toEqual({ id: 'todo-a', at: new Date(2026, 10, 25, 15, 30).getTime(), title: 'Something on your to-do list', body: 'Open Arise to see it.' });
    expect(plain[2]).toMatchObject({ at: new Date(2026, 10, 26, 12, 15).getTime(), title: 'Something in your calendar' });
    expect(JSON.stringify(plain)).not.toContain('dentist');
    expect(JSON.stringify(plain)).not.toContain('Team lunch');
    st.state.settings.notifyDetails = true;
    const full = BR.upcoming(START);
    expect(full[0].title).toBe('Call the dentist');
    expect(full[2]).toMatchObject({ title: 'Team lunch' });
    expect(full[2].body).toContain('12:30');
    expect(BR.pack(START)).toMatchObject({ v: 1, quietFrom: '22:00', quietTo: '08:00' });
  });

  it('sends nothing until the switch is on, then hands the extension the list sealed for it', async () => {
    await boot();
    expect(await BR.check()).toEqual({ on: false });
    expect(await BR.send()).toBe(0);
    expect(asked).not.toContain('remind');
    expect(await BR.setOn(true)).toBe(true);
    expect(BR.status).toMatchObject({ on: true, known: true, error: '' });
    const kept = await Rm.kept(local);
    expect(kept.pack!.items.map((r) => r.title)).toEqual(['Something on your to-do list', 'Your morning brief', 'Something in your calendar']);
    expect(kept.pack).toMatchObject({ quietFrom: '22:00', quietTo: '08:00' });
    expect(reminded).toBeGreaterThan(0);
    // Sealed on the way: nothing readable in what went over the page.
    const s = (await transport.ask({ t: 'status', link: BL.here()!.id })) as { rkey?: string };
    expect(s.rkey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    // The extension's menu shows the same switch, and what's next.
    const p = (await R.popupRequest(env, { t: 'state' })) as R.PopupState;
    expect(p).toMatchObject({ remind: true, next: { id: 'todo-a' } });
  });

  it('goes again when Arise saves, and the extension shows each one at its time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval'] });
    try {
      await boot();
      await BR.setOn(true);
      st.state.todos.a.time = '14:30';
      for (const fn of st.saves) fn();
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(async () => expect((await Rm.kept(local)).pack!.items[0].at).toBe(new Date(2026, 10, 25, 14, 30).getTime()));
    const due = Rm.dueNow(await Rm.kept(local), new Date(2026, 10, 25, 14, 31).getTime());
    expect(due).toMatchObject({ quiet: false, show: [{ id: 'todo-a' }] });
  });

  it('turned off in Arise, the extension deletes what it kept', async () => {
    await boot();
    await BR.setOn(true);
    expect(local.data.has('remind:pack')).toBe(true);
    await BR.setOn(false);
    expect([...local.data.keys()].filter((k) => k.startsWith('remind:'))).toEqual([]);
    expect(BR.status.on).toBe(false);
    // Unlinking deletes it too.
    await R.popupRequest(env, { t: 'remind', on: true });
    await BR.send();
    expect(local.data.has('remind:pack')).toBe(true);
    await BL.unlink(BL.here()!.id);
    expect([...local.data.keys()].filter((k) => k.startsWith('remind:'))).toEqual([]);
  });

  it("has its switch in Arise's browser panel", async () => {
    await boot();
    const UI = await import('./browser-ui.js');
    document.body.innerHTML = '<div id="toast"></div><div id="sheet" hidden><div class="sheet-body"></div></div>';
    await BR.check();
    const box = document.createElement('div');
    box.innerHTML = UI.browserPanel();
    const sw = box.querySelector<HTMLButtonElement>('[data-act="bl-remind"]')!;
    expect(sw.textContent).toBe('Off');
    expect(box.textContent).toContain('kept only in this browser');
    expect(box.textContent).toContain('quiet hours');
    expect(await UI.handleAction('bl-remind', sw)).toBe(true);
    expect(await Rm.isOn(local)).toBe(true);
    box.innerHTML = UI.browserPanel();
    expect(box.querySelector('[data-act="bl-remind"]')!.textContent).toBe('On');
    expect(box.textContent).toContain('Save this page to Arise');
  });

  it('is never told to an Arise the browser is not linked with', async () => {
    await boot({ link: false });
    expect(BL.here()).toBeNull();
    expect(await BR.setOn(true)).toBe(false);
    expect(await BR.send()).toBe(0);
    expect(await R.pageRequest(env, { t: 'remindOn', link: 'X'.repeat(22), on: true }, ORIGIN)).toEqual({ ok: false, error: 'not-linked' });
    expect(await Rm.isOn(local)).toBe(false);
  });
});

describe('a page saved in the browser', () => {
  it('lands in the life log as a saved link, also while recording is paused', async () => {
    await boot();
    await R.popupRequest(env, { t: 'pause' });
    const r = await R.popupRequest(env, { t: 'save', url: 'https://news.example.com/story?id=7&utm_source=x', title: 'A good story' });
    expect(r).toMatchObject({ linked: true });
    expect(await R.savePage(env, { url: 'https://blog.example.com/post', title: 'A post', selection: 'Words I picked', time: now })).toEqual({ ok: true });
    expect(await R.savePage(env, { url: ARISE, title: 'Arise', time: now })).toMatchObject({ ok: false });
    await BL.deliver();
    const saved = [...events.values()];
    expect(saved.map((e) => [e.kind, e.url, e.title, e.meta?.saved])).toEqual([
      ['note', 'https://news.example.com/story?id=7', 'A good story', true],
      ['note', 'https://blog.example.com/post', 'A post', true],
    ]);
    expect(saved[1]).toMatchObject({ source: 'browser', detail: '"Words I picked"', tier: 3 });
  });

  it("refuses a note from a browser that isn't a saved page", async () => {
    await boot({ link: false });
    const base = { id: 'browser:abcdefgh12', source: 'browser', at: START, title: 'x', url: 'https://a.example.com/' };
    expect(BL.cleanEvent({ ...base, kind: 'note' }, START)).toBeNull();
    expect(BL.cleanEvent({ ...base, kind: 'note', meta: { saved: true } }, START)).toMatchObject({ kind: 'note', tier: 3 });
    expect(BL.cleanEvent({ ...base, kind: 'note', url: undefined, meta: { saved: true } }, START)).toBeNull();
  });
});
