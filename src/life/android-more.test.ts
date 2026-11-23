// @vitest-environment jsdom
// More from the Android app (android-more.ts): texts with words only under the notifications'
// rule, photos per hour with their place kept private, Bluetooth and Wi-Fi as events, unlocks per
// day, Android asked first, and nothing read while paused. The phone and the life log are simulated.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

type Opts = Record<string, unknown>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 10, 20, 12, 30).getTime();

function fakePhone() {
  const p = {
    sdk: 34,
    perms: { sms: 'prompt', photos: 'prompt', mediaLocation: 'prompt', bluetooth: 'prompt', location: 'prompt', contacts: 'prompt' } as Record<string, string>,
    answer: { sms: 'granted', photos: 'granted', mediaLocation: 'granted', bluetooth: 'granted' } as Record<string, string>,
    usageAccess: false,
    sms: [] as Opts[],
    photos: [] as Opts[],
    connections: [] as Opts[],
    days: [] as Opts[],
    connectionsOn: false,
    log: [] as { method: string; options: Opts }[],
  };
  const handlers: Record<string, (o: Opts) => unknown> = {
    status: () => ({ sdk: p.sdk, usageAccess: p.usageAccess }),
    checkPermissions: () => ({ ...p.perms }),
    requestPermissions: (o) => {
      for (const a of o.permissions as string[]) p.perms[a] = p.answer[a] ?? 'denied';
      return { ...p.perms };
    },
    readSms: (o) => ({ sms: p.sms.filter((s) => Number(s.date) >= Number(o.since)).map((s) => (o.text ? s : { ...s, body: undefined })) }),
    readPhotos: (o) => ({ photos: p.photos.filter((x) => Number(x.at) >= Number(o.from) && Number(x.at) < Number(o.to)) }),
    readQueue: (o) => {
      const items = o.queue === 'connections' ? p.connections : [];
      return { items, last: items.length ? Number(items[items.length - 1].seq) : 0 };
    },
    ackQueue: (o) => {
      p.connections = p.connections.filter((x) => Number(x.seq) > Number(o.upTo));
    },
    readUnlocks: (o) => ({ days: p.days.filter((d) => String(d.day) >= String(o.fromDay) && String(d.day) < String(o.toDay)) }),
    setConnections: (o) => {
      p.connectionsOn = o.on === true;
      return { on: p.connectionsOn };
    },
    openSettings: () => ({}),
    forget: () => ({}),
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    PluginHeaders: [{ name: 'AriseLife' }],
    nativePromise: async (_plugin: string, method: string, options: Opts = {}) => {
      p.log.push({ method, options });
      const fn = handlers[method];
      if (!fn) throw new Error(`${method} isn't simulated`);
      return fn(options);
    },
  };
  return p;
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
  return import('./android-more');
}

beforeEach(() => {
  localStorage.clear();
  events.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('the events', () => {
  it('notes texts both ways, with the words only when asked', async () => {
    const M = await load();
    const row = { id: 7, address: '+998901234567', name: 'Mum', date: NOW - HOUR, type: 1, body: 'Call me' };
    expect(M.smsEvent(row, false)).toEqual({
      id: `android:sms:7-${NOW - HOUR}`,
      source: 'android',
      kind: 'message',
      at: NOW - HOUR,
      title: 'Text from Mum',
      tier: 3,
      meta: { device: 'android', via: 'sms', direction: 'in', name: 'Mum', number: '+998901234567' },
    });
    expect(M.smsEvent(row, true)?.detail).toBe('Call me');
    expect(M.smsEvent({ ...row, type: 2, name: '' }, false)?.title).toBe('Texted +998901234567');
    expect(M.smsEvent({ ...row, type: 3 }, false)).toBeNull(); // a draft
    expect(M.smsEvent({ ...row, id: 'x' }, false)).toBeNull();
  });

  it('counts photos per hour, with a place only outside places never to note, and rounded if asked', async () => {
    const M = await load();
    const LOC = await import('./location');
    const h = new Date(2026, 10, 20, 9).getTime();
    const prefs = { ...LOC.defaultPrefs(), never: [{ lat: 41.3111, lon: 69.2797, radius: 300, name: 'Home' }] };
    const rows = [
      { id: 1, at: h + 5 * MIN, lat: 41.3112, lon: 69.2798 }, // at home
      { id: 2, at: h + 9 * MIN, lat: 41.35, lon: 69.3 },
      { id: 3, at: h + HOUR + MIN },
      { id: 4, at: 'soon' },
    ];
    const list = M.photoEvents(rows, prefs);
    expect(list.map((e) => [e.id, e.title, e.tier, e.meta?.lat])).toEqual([
      [`android:photos:${h}`, 'Took 2 photos', 3, 41.35],
      [`android:photos:${h + HOUR}`, 'Took a photo', 2, undefined],
    ]);
    expect(M.photoEvents(rows.slice(1, 2), { ...prefs, exact: false })[0].meta?.lat).toBe(LOC.roundSpot(41.35, 69.3).lat);
  });

  it('notes Bluetooth and Wi-Fi connections in plain words', async () => {
    const M = await load();
    expect(M.connectionEvent({ at: NOW, type: 'bluetooth', state: 'connected', name: 'Car Multimedia', kind: 'car' })).toMatchObject({ title: 'Connected to Car Multimedia', kind: 'other', tier: 2 });
    expect(M.connectionEvent({ at: NOW, type: 'bluetooth', state: 'disconnected', name: '', kind: 'car' })?.title).toBe('Disconnected from the car');
    expect(M.connectionEvent({ at: NOW, type: 'bluetooth', state: 'connected', name: '', kind: '' })?.title).toBe('Connected to a Bluetooth device');
    expect(M.connectionEvent({ at: NOW, type: 'wifi', state: 'connected', name: 'Home WiFi' })).toMatchObject({ title: 'Joined Wi-Fi Home WiFi', kind: 'place', tier: 3 });
    expect(M.connectionEvent({ at: NOW, type: 'wifi', state: 'connected', name: '' })?.title).toBe('Joined a Wi-Fi network');
    expect(M.connectionEvent({ at: NOW, type: 'nfc', state: 'connected' })).toBeNull();
  });

  it('says how many times the phone was unlocked, and when it was first and last used', async () => {
    const M = await load();
    const first = new Date(2026, 10, 19, 7, 5).getTime();
    const last = new Date(2026, 10, 19, 23, 40).getTime();
    expect(M.unlockEvent({ day: '2026-11-19', unlocks: 54, first, last })).toMatchObject({
      id: 'android:unlocks:2026-11-19',
      title: 'Unlocked the phone 54 times, first used at 07:05, last at 23:40',
      value: 54,
      tier: 2,
    });
    expect(M.unlockEvent({ day: '2026-11-19', unlocks: 1 })?.title).toBe('Unlocked the phone once');
    expect(M.unlockEvent({ day: '2026-11-19', unlocks: 0 })).toBeNull();
    expect(M.unlockEvent({ day: 'yesterday', unlocks: 3 })).toBeNull();
  });
});

describe('turning them on and reading', () => {
  it('starts with everything off, and reads nothing', async () => {
    const p = fakePhone();
    const M = await load();
    expect(M.read().on).toEqual({ sms: false, photos: false, connections: false, unlocks: false });
    expect(await M.collect()).toBe(0);
    expect(p.log).toEqual([]);
  });

  it('asks Android first, and stays off when it says no', async () => {
    const p = fakePhone();
    p.answer.sms = 'denied';
    const M = await load();
    expect(await M.turnOn('sms')).toBe('denied');
    expect(M.read().on.sms).toBe(false);
    expect(await M.turnOn('photos')).toBe('on');
    expect(p.log.filter((l) => l.method === 'requestPermissions').map((l) => l.options.permissions)).toEqual([['sms'], ['photos'], ['mediaLocation']]);
    expect(await M.turnOn('connections')).toBe('on');
    expect(p.connectionsOn).toBe(true);
    expect(await M.turnOn('unlocks')).toBe('settings');
    await M.turnOff('connections');
    expect(p.connectionsOn).toBe(false);
  });

  it('reads texts, photos, connections and unlocks into the life log', async () => {
    const p = fakePhone();
    p.usageAccess = true;
    const M = await load();
    for (const m of ['sms', 'photos', 'connections', 'unlocks'] as const) await M.turnOn(m);
    p.sms = [{ id: 1, address: '+1', name: 'Sam', date: NOW - HOUR, type: 1, body: 'hi' }];
    p.photos = [{ id: 9, at: NOW - 2 * HOUR }];
    p.connections = [{ at: NOW - 3 * HOUR, type: 'bluetooth', state: 'connected', name: 'Car', kind: 'car', seq: 1 }];
    p.days = [{ day: '2026-11-19', unlocks: 40, first: new Date(2026, 10, 19, 7).getTime() }];
    expect(await M.collect()).toBe(4);
    expect([...events.values()].map((e) => e.title).sort()).toEqual(['Connected to Car', 'Text from Sam', 'Took a photo', 'Unlocked the phone 40 times, first used at 07:00']);
    expect([...events.values()].find((e) => e.kind === 'message')?.detail).toBeUndefined(); // no words: the switch is off
    expect(p.connections).toEqual([]);
    expect(M.read().unlocksDay).toBe('2026-11-20');
    // Again: nothing new.
    expect(await M.collect()).toBe(0);
  });

  it('reads nothing while paused', async () => {
    const p = fakePhone();
    const M = await load();
    await M.turnOn('connections');
    p.connections = [{ at: NOW, type: 'wifi', state: 'connected', name: 'Home', seq: 1 }];
    (await import('./pause')).pause(HOUR);
    p.log.length = 0;
    expect(await M.collect()).toBe(0);
    expect(p.log).toEqual([]);
  });
});
