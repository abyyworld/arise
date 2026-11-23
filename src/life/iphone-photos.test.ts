// @vitest-environment jsdom
// Photos taken in the iPhone app (iphone-photos.ts, and its switch in sense-ui.ts): iOS asked
// first, whole hours read from where the last read stopped, the place kept private, nothing while
// paused; and the short how-to for three Shortcuts automations.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

type Opts = Record<string, unknown>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 10, 20, 12, 30).getTime();

function fakeIPhone(answer = 'granted', photos: Opts[] = []) {
  const calls: { method: string; options: Opts }[] = [];
  const all: Record<string, (o: Opts) => unknown> = {
    'AriseSense.photosStatus': () => ({ status: answer }),
    'AriseSense.photosAccess': () => ({ status: answer }),
    'AriseSense.photos': (o) => ({ photos: photos.filter((p) => Number(p.at) >= Number(o.from) && Number(p.at) < Number(o.to)) }),
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    PluginHeaders: [{ name: 'AriseSense' }],
    nativePromise: async (plugin: string, method: string, options: Opts = {}) => {
      const key = `${plugin}.${method}`;
      calls.push({ method: key, options });
      const fn = all[key];
      if (!fn) throw new Error(`${key} isn't simulated`);
      return fn(options);
    },
  };
  return calls;
}

const events = new Map<string, LifeEvent>();
async function load() {
  vi.resetModules();
  (await import('./store-port')).setLifeStore({
    async addEvents(list: LifeEvent[]) {
      let n = 0;
      for (const e of list) if (!events.has(e.id) && events.set(e.id, e)) n++;
      return n;
    },
  });
  return import('./iphone-photos');
}

beforeEach(() => {
  localStorage.clear();
  events.clear();
  document.body.innerHTML = '<div id="app"></div><div id="toast"></div>';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('photos taken on iPhone', () => {
  it('asks iOS, then reads whole hours into the life log, once', async () => {
    const h = new Date(2026, 10, 20, 10).getTime();
    fakeIPhone('granted', [
      { id: 'A', at: h + 5 * MIN, lat: 41.35, lon: 69.3 },
      { id: 'B', at: h + 20 * MIN },
      { id: 'C', at: NOW - 10 * MIN }, // this hour isn't over
    ]);
    const P = await load();
    expect(P.read().on).toBe(false);
    expect(await P.turnOn()).toBe('');
    expect(P.read().on).toBe(true);
    await P.collect();
    expect([...events.values()].map((e) => [e.id, e.source, e.title, e.tier])).toEqual([[`other:iphone-photos:${h}`, 'other', 'Took 2 photos', 3]]);
    expect(await P.collect()).toBe(0);
    expect(P.read().cursor).toBe(new Date(2026, 10, 20, 12).getTime());
  });

  it("stays off when iOS says no, and says when it sees only some photos", async () => {
    fakeIPhone('denied');
    let P = await load();
    expect(await P.turnOn()).toMatch(/Full Access/);
    expect(P.read().on).toBe(false);
    fakeIPhone('limited');
    P = await load();
    expect(await P.turnOn()).toMatch(/only the photos you picked/);
    expect(P.read().on).toBe(true);
  });

  it('reads nothing while paused', async () => {
    const calls = fakeIPhone('granted', [{ id: 'A', at: NOW - 2 * HOUR }]);
    localStorage.setItem('arise-iphone-photos', JSON.stringify({ on: true }));
    const P = await load();
    (await import('./pause')).pause(HOUR);
    expect(await P.collect()).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('in Settings, Your life', () => {
  it('has a Photos taken switch and three automations to start with', async () => {
    fakeIPhone('granted');
    const UI = await import('./sense-ui');
    document.getElementById('app')!.innerHTML = UI.settingsPanel();
    const row = document.querySelector<HTMLElement>('[data-act="life-photos"]')!;
    expect(row.textContent).toContain('Never the photos themselves.');
    expect(row.getAttribute('aria-pressed')).toBe('false');
    const quick = document.querySelector('#lifePanel details')!.textContent!;
    for (const words of ['An app is opened', 'Arrived home', 'A message came in', 'Log to Arise', 'Run Immediately']) expect(quick).toContain(words);
    expect(await UI.handleAction('life-photos', row)).toBe(true);
    expect(document.querySelector('[data-act="life-photos"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});
