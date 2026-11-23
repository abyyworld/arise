// @vitest-environment jsdom
// Location on a timer in the phone apps (location-sense.ts, and the iPhone's inbox in sense.ts):
// Android asked for Location and "Allow all the time", the setting sent to the phone, points
// taken from the phone's queue into the life log, places never to note, stays for places only,
// and on iPhone the points that came in with the visits. The phones and the life log are
// simulated in memory.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

type Opts = Record<string, unknown>;
const MIN = 60_000;
const NOW = new Date(2026, 10, 20, 12, 0).getTime();
const HOME = { lat: 41.3111, lon: 69.2797 };

function fakeLog() {
  const events = new Map<string, LifeEvent>();
  return {
    events,
    async addEvents(list: LifeEvent[]) {
      let n = 0;
      for (const e of list) {
        if (events.has(e.id)) continue;
        events.set(e.id, e);
        n++;
      }
      return n;
    },
  };
}

function fakeAndroid() {
  const p = {
    sdk: 34,
    perms: { location: 'prompt', backgroundLocation: 'prompt' } as Record<string, string>,
    answer: { location: 'granted', backgroundLocation: 'granted' } as Record<string, string>,
    places: [] as Opts[],
    seq: 0,
    config: null as Opts | null,
    here: { lat: HOME.lat, lon: HOME.lon, acc: 8 } as Opts | null,
    log: [] as { method: string; options: Opts }[],
  };
  const handlers: Record<string, (o: Opts) => unknown> = {
    status: () => ({ sdk: p.sdk, notificationAccess: false, queued: 0, usageAccess: false, health: 'unsupported', healthGranted: [] }),
    checkPermissions: () => ({ ...p.perms }),
    requestPermissions: (o) => {
      for (const a of o.permissions as string[]) p.perms[a] = p.answer[a];
      return { ...p.perms };
    },
    setLocation: (o) => {
      p.config = o;
      if (o.mode === 'off') p.places = [];
      return { mode: o.mode };
    },
    readQueue: (o) => {
      const items = o.queue === 'places' ? p.places.slice(0, Number(o.max)) : [];
      return { items, last: items.length ? Number(items[items.length - 1].seq) : 0 };
    },
    ackQueue: (o) => {
      p.places = p.places.filter((x) => Number(x.seq) > Number(o.upTo));
    },
    locationNow: () => {
      if (!p.here) throw new Error("Couldn't find where this phone is.");
      return p.here;
    },
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    PluginHeaders: [{ name: 'AriseLife' }],
    nativePromise: async (plugin: string, method: string, options: Opts = {}) => {
      if (plugin !== 'AriseLife') throw new Error(`${plugin} isn't simulated`);
      p.log.push({ method, options });
      const fn = handlers[method];
      if (!fn) throw new Error(`${method} isn't simulated`);
      return fn(options);
    },
  };
  const queue = (at: number, lat: number, lon: number) => p.places.push({ at, lat, lon, acc: 15, seq: ++p.seq });
  return { p, queue };
}

let lifeLog = fakeLog();

async function load() {
  vi.resetModules();
  (await import('./store-port')).setLifeStore(lifeLog);
  return import('./location-sense');
}

beforeEach(() => {
  localStorage.clear();
  lifeLog = fakeLog();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('Location on Android', () => {
  it('asks for Location, then for all the time, and tells the phone', async () => {
    const { p } = fakeAndroid();
    const LS = await load();
    expect(LS.platform()).toBe('android');
    expect(LS.mode()).toBe('off');
    expect(await LS.setMode('interval', 15)).toBe('');
    expect(p.log.filter((l) => l.method === 'requestPermissions').map((l) => l.options.permissions)).toEqual([['location'], ['backgroundLocation']]);
    expect(LS.mode()).toBe('interval');
    expect(p.config).toEqual({ mode: 'interval', every: 15, exact: true, never: [], pausedUntil: 0 });
  });

  it("stays off when Android doesn't allow Location", async () => {
    const { p } = fakeAndroid();
    p.answer.location = 'denied';
    const LS = await load();
    expect(await LS.setMode('interval', 30)).toMatch(/didn't allow Location/);
    expect(LS.mode()).toBe('off');
    expect(p.config).toBeNull();
  });

  it('says how to allow it all the time when only "while using" is allowed', async () => {
    const { p } = fakeAndroid();
    p.answer.backgroundLocation = 'denied';
    const LS = await load();
    expect(await LS.setMode('places')).toMatch(/Allow all the time/);
    expect(LS.mode()).toBe('places');
    await LS.refreshStatus();
    expect(LS.blocked()).toBe('background');
  });

  it('takes the points that waited, one per interval, leaving out a place never to note', async () => {
    const { p, queue } = fakeAndroid();
    const LS = await load();
    await LS.setMode('interval', 30);
    await LS.addNever({ ...HOME, radius: 250, name: 'Home' });
    expect(p.config?.never).toEqual([{ ...HOME, radius: 250 }]);
    queue(NOW - 90 * MIN, 41.35, 69.3);
    queue(NOW - 80 * MIN, 41.351, 69.3); // too soon after the one before
    queue(NOW - 60 * MIN, HOME.lat + 0.0005, HOME.lon); // at home
    queue(NOW - 30 * MIN, 41.36, 69.31);
    expect(await LS.collect()).toBe(2);
    expect([...lifeLog.events.values()].map((e) => [e.at, e.source, e.kind, e.tier])).toEqual([
      [NOW - 90 * MIN, 'maps', 'place', 3],
      [NOW - 30 * MIN, 'maps', 'place', 3],
    ]);
    expect(p.places).toEqual([]);
    expect(LS.read().last).toEqual({ at: NOW, added: 2 });
  });

  it('rounds to about 1 km when asked', async () => {
    const { queue } = fakeAndroid();
    const LS = await load();
    await LS.setMode('interval', 30);
    await LS.setExact(false);
    queue(NOW - 10 * MIN, 41.35123, 69.30456);
    await LS.collect();
    const [e] = [...lifeLog.events.values()];
    expect(e.meta).toMatchObject({ lat: 41.35, rounded: true });
    expect(e.detail).toMatch(/to about 1 km/);
  });

  it('turns points into stays for places only, holding the one still going', async () => {
    const { queue } = fakeAndroid();
    const LS = await load();
    await LS.setMode('places');
    for (const m of [120, 105, 90]) queue(NOW - m * MIN, 41.311, 69.28);
    queue(NOW - 75 * MIN, 41.5, 69.28);
    queue(NOW - 60 * MIN, 41.5001, 69.28);
    expect(await LS.collect()).toBe(1);
    expect([...lifeLog.events.values()].map((e) => e.title)).toEqual(['At a place for 30 min']);
    expect(LS.read().held.map((x) => x.at)).toEqual([NOW - 75 * MIN, NOW - 60 * MIN]);
  });

  it('drops what waited while the setting was off', async () => {
    const { p, queue } = fakeAndroid();
    const LS = await load();
    queue(NOW - 10 * MIN, 41.35, 69.3);
    expect(await LS.collect()).toBe(0);
    expect(p.places).toEqual([]);
    expect(lifeLog.events.size).toBe(0);
  });

  it('adds where the phone is now as a place never to note', async () => {
    const { p } = fakeAndroid();
    const LS = await load();
    expect(await LS.addNeverHere(500, 'Clinic')).toEqual({ ...HOME, radius: 500, name: 'Clinic' });
    expect(LS.read().prefs.never).toEqual([{ ...HOME, radius: 500, name: 'Clinic' }]);
    await LS.removeNever(0);
    expect(LS.read().prefs.never).toEqual([]);
    p.here = null;
    expect(await LS.addNeverHere(500, 'Clinic')).toBeNull();
  });

  it('forgets everything when the device is erased', async () => {
    const { p } = fakeAndroid();
    const LS = await load();
    await LS.setMode('interval', 5);
    await LS.forget();
    expect(localStorage.getItem('arise-location')).toBeNull();
    expect(p.config?.mode).toBe('off');
  });
});

describe('Location on iPhone', () => {
  function fakeIPhone(text: string) {
    const calls: { method: string; options: Opts }[] = [];
    const all: Record<string, (o: Opts) => unknown> = {
      'AriseSense.info': () => ({ version: 1 }),
      'AriseSense.motionStatus': () => ({ status: 'prompt' }),
      'AriseSense.calendarStatus': () => ({ status: 'prompt' }),
      'AriseSense.placesStatus': () => ({ status: 'always', on: true }),
      'AriseSense.placesStart': () => ({ status: 'always', on: true }),
      'AriseSense.placesStop': () => ({ status: 'always', on: false }),
      'AriseSense.locationSet': (o) => ({ status: 'always', on: true, mode: o.mode }),
      'AriseSense.placeName': () => ({ name: 'Gym One', street: '1 High St', area: 'Chilonzor', city: 'Tashkent' }),
      'AriseSense.inboxTake': () => ({ text }),
      'AriseSense.inboxClear': () => ({}),
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
  const line = (o: Opts) => JSON.stringify(o);

  it('turns on Places with the timer, and adds the points that came in, leaving out home', async () => {
    const text = [
      line({ type: 'point', id: 'P1', at: NOW - 60 * MIN, lat: 41.35, lon: 69.3, acc: 30 }),
      line({ type: 'point', id: 'P2', at: NOW - 30 * MIN, lat: HOME.lat, lon: HOME.lon, acc: 30 }),
      line({ type: 'visit', id: 'V1', lat: HOME.lat, lon: HOME.lon, arrive: NOW - 5 * 60 * MIN, depart: NOW - 4 * 60 * MIN }),
      line({ type: 'visit', id: 'V2', lat: 41.36, lon: 69.31, arrive: NOW - 3 * 60 * MIN, depart: NOW - 2 * 60 * MIN }),
    ].join('\n');
    const calls = fakeIPhone(text);
    const LS = await load();
    const SENSE = await import('./sense');
    expect(LS.platform()).toBe('iphone');
    // (Set first: turning Places on reads the inbox straight away.)
    await LS.addNever({ ...HOME, radius: 200, name: 'Home' });
    await LS.setMode('interval', 15);
    expect(SENSE.read().on.places).toBe(true);
    expect(LS.mode()).toBe('interval');
    expect(calls.filter((c) => c.method === 'AriseSense.locationSet').pop()?.options).toMatchObject({ mode: 'interval', every: 15, never: [{ ...HOME, radius: 200 }] });
    await SENSE.collect(true);
    expect([...lifeLog.events.values()].map((e) => e.id).sort()).toEqual([`maps:point:iphone:${(NOW - 60 * MIN) / 1000}`, `maps:visit:${(NOW - 3 * 60 * MIN) / 1000}`]);
  });

  it('keeps only the area of a visit when it should be to about 1 km, and no points with places only', async () => {
    fakeIPhone([line({ type: 'point', id: 'P1', at: NOW - 60 * MIN, lat: 41.35, lon: 69.3 }), line({ type: 'visit', id: 'V2', lat: 41.36123, lon: 69.31, arrive: NOW - 3 * 60 * MIN, depart: NOW - 2 * 60 * MIN })].join('\n'));
    const LS = await load();
    const SENSE = await import('./sense');
    await LS.setExact(false);
    await LS.setMode('places');
    await SENSE.collect(true);
    const list = [...lifeLog.events.values()];
    expect(list.map((e) => e.title)).toEqual(['At Chilonzor']);
    expect(list[0].meta).toEqual({ lat: 41.36, lon: expect.any(Number) });
  });

  it('turning Location off turns Places off', async () => {
    fakeIPhone('');
    const LS = await load();
    const SENSE = await import('./sense');
    await LS.setMode('interval', 30);
    await LS.setMode('off');
    expect(SENSE.read().on.places).toBe(false);
    expect(LS.mode()).toBe('off');
  });
});
