// More from the Android app for the life log, next to android-sense.ts:
//
//   sms          text messages: who and when, and what they said only with "Include what they
//                say" on (the same switch as notifications)
//   photos       photos taken with the camera: when, and where if the photo says so. Never the photo
//   connections  Bluetooth devices connecting ("Connected to Car") and Wi-Fi networks joined
//   unlocks      how many times the phone was unlocked each day, and when it was first and last used
//
// Each is off until the Player turns it on, with Android's own permission too. The native side is
// MoreReaders.kt. Everything goes to the life log through lifeStore(), with stable ids, and nothing
// from a pause (pause.ts). Kept in localStorage on this phone only, like android-sense.ts.

import type { LifeEvent } from './types';
import { hasLifeStore, lifeStore } from './store-port';
import * as A from './android-sense';
import * as LOC from './location';
import { isPaused, unpaused } from './pause';

export type More = 'sms' | 'photos' | 'connections' | 'unlocks';
export const MORE: More[] = ['sms', 'photos', 'connections', 'unlocks'];

const KEY = 'arise-android-more';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BACK = { sms: 30 * DAY, photos: 30 * DAY, unlocks: 7 * DAY };

interface Cap {
  nativePromise: (plugin: string, method: string, options?: object) => Promise<Record<string, unknown>>;
}
const call = <T = Record<string, unknown>>(method: string, options: object = {}) => (globalThis as { Capacitor?: Cap }).Capacitor!.nativePromise('AriseLife', method, options) as Promise<T>;

interface Last {
  at: number;
  added: number;
  error?: string;
}

export interface MoreState {
  on: Record<More, boolean>;
  sms?: number; // read up to this time
  photos?: number; // and photos up to this hour
  unlocksDay?: string; // and unlocks up to (not including) this day
  last: Partial<Record<More, Last>>;
}

const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.floor(v) : undefined);
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

export function cleanState(raw: unknown): MoreState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const on = (r.on && typeof r.on === 'object' ? r.on : {}) as Record<string, unknown>;
  const lastIn = (r.last && typeof r.last === 'object' ? r.last : {}) as Record<string, unknown>;
  const st: MoreState = { on: Object.fromEntries(MORE.map((m) => [m, on[m] === true])) as Record<More, boolean>, last: {} };
  for (const m of MORE) {
    const l = lastIn[m] as Record<string, unknown> | undefined;
    const at = time(l?.at);
    if (!l || !at) continue;
    st.last[m] = { at, added: Math.max(0, Math.floor(Number(l.added) || 0)) };
    if (typeof l.error === 'string' && l.error) st.last[m]!.error = l.error.slice(0, 200);
  }
  for (const k of ['sms', 'photos'] as const) {
    const t = time(r[k]);
    if (t) st[k] = t;
  }
  if (isDay(r.unlocksDay)) st.unlocksDay = r.unlocksDay;
  return st;
}

export function read(): MoreState {
  try {
    return cleanState(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return cleanState({});
  }
}

function update(change: (st: MoreState) => void) {
  const st = read();
  change(st);
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {}
  return st;
}

// ---------- rows from the phone, as life events

const ANDROID = { device: 'android' } as const;
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Android's text message types (Telephony.Sms.TYPE): 1 received, 2 sent; the rest are drafts,
// waiting or failed, which aren't noted.
export function smsEvent(raw: unknown, withText: boolean): LifeEvent | null {
  const r = (raw || {}) as Record<string, unknown>;
  const at = time(r.date);
  const id = num(r.id);
  const type = num(r.type);
  if (!at || !Number.isInteger(id) || (type !== 1 && type !== 2)) return null;
  const name = str(r.name, 120);
  const number = str(r.address, 60);
  const who = name || number || 'someone';
  const e: LifeEvent = {
    id: `android:sms:${id}-${at}`,
    source: 'android',
    kind: 'message',
    at,
    title: type === 2 ? `Texted ${who}` : `Text from ${who}`,
    tier: 3,
    meta: { ...ANDROID, via: 'sms', direction: type === 2 ? 'out' : 'in' },
  };
  if (name) e.meta!.name = name;
  if (number) e.meta!.number = number;
  const body = withText ? str(r.body, 1000) : '';
  if (body) e.detail = body;
  return e;
}

const floorHour = (ms: number) => {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

// Photos taken, one event per hour ("Took 3 photos"), with where the first one with a place was
// taken: nothing from inside a place never to note, and to about 1 km unless Location is exact.
// Also for the iPhone (iphone-photos.ts), which has no source of its own in the life log.
export function photoEvents(rows: readonly unknown[], prefs: LOC.LocationPrefs, device: 'android' | 'iphone' = 'android'): LifeEvent[] {
  const hours = new Map<number, { n: number; spot?: { lat: number; lon: number } }>();
  for (const raw of rows) {
    const r = (raw || {}) as Record<string, unknown>;
    const at = time(r.at);
    if (!at) continue;
    const h = floorHour(at);
    const cur = hours.get(h) ?? { n: 0 };
    cur.n++;
    const lat = num(r.lat);
    const lon = num(r.lon);
    if (!cur.spot && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !LOC.inNever({ lat, lon }, prefs.never)) cur.spot = prefs.exact ? { lat, lon } : LOC.roundSpot(lat, lon);
    hours.set(h, cur);
  }
  return [...hours.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([h, { n, spot }]) => {
      const e: LifeEvent = {
        id: device === 'android' ? `android:photos:${h}` : `other:iphone-photos:${h}`,
        source: device === 'android' ? 'android' : 'other',
        kind: 'other',
        at: h,
        end: h + HOUR,
        title: n === 1 ? 'Took a photo' : `Took ${n} photos`,
        value: n,
        unit: 'photos',
        tier: spot ? 3 : 2,
        meta: { device, via: 'photos' },
      };
      if (spot) {
        e.meta!.lat = Math.round(spot.lat * 1e5) / 1e5;
        e.meta!.lon = Math.round(spot.lon * 1e5) / 1e5;
        e.detail = `Where: ${spot.lat.toFixed(prefs.exact ? 4 : 2)}, ${spot.lon.toFixed(prefs.exact ? 4 : 2)}`;
      }
      return e;
    });
}

// A Bluetooth device or a Wi-Fi network (ConnectionWatch in MoreReaders.kt).
export function connectionEvent(raw: unknown): LifeEvent | null {
  const r = (raw || {}) as Record<string, unknown>;
  const at = time(r.at);
  const type = r.type;
  const on = r.state === 'connected';
  if (!at || (type !== 'bluetooth' && type !== 'wifi') || (!on && r.state !== 'disconnected')) return null;
  const name = str(r.name, 80);
  const kind = str(r.kind, 20);
  if (type === 'wifi') {
    return {
      id: `android:wifi:${Math.round(at / 1000)}`,
      source: 'android',
      kind: 'place', // a network's name often says where (home, work)
      at,
      title: name ? `Joined Wi-Fi ${name}` : 'Joined a Wi-Fi network',
      tier: 3,
      meta: { ...ANDROID, via: 'wifi', ...(name ? { name } : {}) },
    };
  }
  const what = name || (kind === 'car' ? 'the car' : kind === 'audio' ? 'headphones' : kind === 'watch' ? 'a watch' : 'a Bluetooth device');
  return {
    id: `android:bt:${Math.round(at / 1000)}-${on ? 'on' : 'off'}`,
    source: 'android',
    kind: 'other',
    at,
    title: on ? `Connected to ${what}` : `Disconnected from ${what}`,
    tier: 2,
    meta: { ...ANDROID, via: 'bluetooth', state: on ? 'connected' : 'disconnected', ...(name ? { name } : {}), ...(kind ? { what: kind } : {}) },
  };
}

// A day's unlocks, and first and last use (UnlockReader in MoreReaders.kt).
export function unlockEvent(raw: unknown): LifeEvent | null {
  const r = (raw || {}) as Record<string, unknown>;
  if (!isDay(r.day)) return null;
  const [y, m, d] = r.day.split('-').map(Number);
  const at = new Date(y, m - 1, d).getTime();
  const end = new Date(y, m - 1, d + 1).getTime();
  const n = Math.max(0, Math.floor(num(r.unlocks) || 0));
  const first = time(r.first);
  const last = time(r.last);
  if (!n && !first) return null;
  const parts = [n === 1 ? 'Unlocked the phone once' : `Unlocked the phone ${n} times`];
  if (first) parts.push(`first used at ${hhmm(first)}`);
  if (last && last >= (first ?? 0)) parts.push(`last at ${hhmm(last)}`);
  return {
    id: `android:unlocks:${r.day}`,
    source: 'android',
    kind: 'app',
    at,
    end,
    title: parts.join(', '),
    value: n,
    unit: 'unlocks',
    tier: 2,
    meta: { ...ANDROID, via: 'unlocks', ...(first ? { first } : {}), ...(last ? { last } : {}) },
  };
}

// ---------- what the phone allows

export interface MoreStatus {
  ready: boolean;
  sdk: number;
  sms: string;
  photos: string;
  mediaLocation: string;
  bluetooth: string;
  location: string;
  usageAccess: boolean;
}
export const status: MoreStatus = { ready: false, sdk: 0, sms: '', photos: '', mediaLocation: '', bluetooth: '', location: '', usageAccess: false };

export async function refreshStatus(): Promise<MoreStatus> {
  if (!A.supported()) return status;
  try {
    const s = await call('status');
    const p = await call('checkPermissions');
    const sdk = num(s.sdk) || 0;
    Object.assign(status, {
      ready: true,
      sdk,
      sms: str(p.sms, 30),
      photos: str(sdk >= 33 ? p.photos : p.storage, 30),
      mediaLocation: sdk && sdk < 29 ? 'granted' : str(p.mediaLocation, 30),
      bluetooth: sdk && sdk < 31 ? 'granted' : str(p.bluetooth, 30),
      location: str(p.location, 30),
      usageAccess: s.usageAccess === true,
    });
  } catch {}
  return status;
}

export function blocked(m: More): '' | 'permission' | 'access' {
  if (!status.ready) return '';
  if (m === 'sms') return status.sms === 'granted' ? '' : 'permission';
  if (m === 'photos') return status.photos === 'granted' ? '' : 'permission';
  if (m === 'unlocks') return status.usageAccess ? '' : 'access';
  return '';
}

// ---------- on and off

export async function turnOn(m: More): Promise<A.TurnOn> {
  if (!A.supported()) return 'unsupported';
  let result: A.TurnOn = 'on';
  try {
    await refreshStatus();
    if (m === 'sms') {
      const p = await call('requestPermissions', { permissions: ['sms'] });
      if (p.sms !== 'granted') result = 'denied';
    } else if (m === 'photos') {
      const p = await call('requestPermissions', { permissions: [status.sdk >= 33 ? 'photos' : 'storage'] });
      if ((status.sdk >= 33 ? p.photos : p.storage) !== 'granted') result = 'denied';
      // Where each was taken: asked too, but the photos are read without it.
      else if (status.sdk >= 29) await call('requestPermissions', { permissions: ['mediaLocation'] }).catch(() => ({}));
    } else if (m === 'connections') {
      if (status.sdk >= 31) await call('requestPermissions', { permissions: ['bluetooth'] }).catch(() => ({}));
      await call('setConnections', { on: true });
    } else if (m === 'unlocks') {
      if (!status.usageAccess) {
        await call('openSettings', { screen: 'usage' });
        result = 'settings';
      }
    }
  } catch {
    return 'error';
  }
  if (result !== 'denied') {
    update((st) => {
      st.on[m] = true;
      delete st.last[m];
    });
  }
  await refreshStatus();
  return result;
}

export async function turnOff(m: More) {
  update((st) => {
    st.on[m] = false;
    delete st.last[m];
    if (m === 'sms') delete st.sms;
    if (m === 'photos') delete st.photos;
    if (m === 'unlocks') delete st.unlocksDay;
  });
  if (!A.supported()) return;
  try {
    if (m === 'connections') await call('setConnections', { on: false });
    else if (m === 'sms' || m === 'photos') await call('forget', { what: m });
  } catch {}
}

export async function forgetAll() {
  for (const m of MORE) if (read().on[m]) await turnOff(m);
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

// ---------- reading

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let running: Promise<number> | null = null;

export function collect(now = () => Date.now()): Promise<number> {
  if (!A.supported() || !hasLifeStore()) return Promise.resolve(0);
  if (!running) running = collectAll(now).finally(() => (running = null));
  return running;
}

async function collectAll(now: () => number): Promise<number> {
  const st = read();
  if (!MORE.some((m) => st.on[m]) || isPaused()) return 0;
  const store = await lifeStore();
  await refreshStatus();
  let total = 0;
  const add = (events: (LifeEvent | null)[]) => {
    const list = unpaused(events.filter((e): e is LifeEvent => !!e));
    return list.length ? store.addEvents(list) : Promise.resolve(0);
  };
  const note = (m: More, added: number, error?: string) => {
    update((s) => {
      s.last[m] = error ? { at: now(), added, error } : { at: now(), added };
    });
    total += added;
  };
  for (const m of MORE) {
    const cur = read();
    if (!cur.on[m] || blocked(m)) continue;
    try {
      if (m === 'sms') {
        const since = cur.sms ?? now() - BACK.sms;
        const { sms } = await call<{ sms: unknown[] }>('readSms', { since, max: 2000, text: A.read().text });
        const rows = Array.isArray(sms) ? sms : [];
        const added = await add(rows.map((r) => smsEvent(r, A.read().text)));
        const latest = Math.max(since, ...rows.map((r) => time((r as Record<string, unknown>)?.date) || 0));
        update((s) => {
          s.sms = latest;
        });
        note(m, added);
      } else if (m === 'photos') {
        // Whole hours only, so an hour's count is never noted half-way through.
        const to = floorHour(now());
        const from = cur.photos ?? floorHour(now() - BACK.photos);
        if (to > from) {
          const { photos } = await call<{ photos: unknown[] }>('readPhotos', { from, to, max: 5000 });
          const added = await add(photoEvents(Array.isArray(photos) ? photos : [], LOC.loadState().prefs));
          update((s) => {
            s.photos = to;
          });
          note(m, added);
        }
      } else if (m === 'connections') {
        let added = 0;
        for (let i = 0; i < 20; i++) {
          const { items, last } = await call<{ items: unknown[]; last: number }>('readQueue', { queue: 'connections', max: 500 });
          if (!Array.isArray(items) || !items.length || !(last > 0)) break;
          added += await add(items.map(connectionEvent));
          await call('ackQueue', { queue: 'connections', upTo: last });
        }
        note(m, added);
      } else if (m === 'unlocks') {
        // Whole days, up to yesterday.
        const toDay = dayKey(now());
        const fromDay = cur.unlocksDay ?? dayKey(now() - BACK.unlocks);
        if (toDay > fromDay) {
          const { days } = await call<{ days: unknown[] }>('readUnlocks', { fromDay, toDay });
          const added = await add((Array.isArray(days) ? days : []).map(unlockEvent));
          update((s) => {
            s.unlocksDay = toDay;
          });
          note(m, added);
        }
      }
    } catch (err) {
      note(m, 0, (err as { code?: string })?.code === 'denied' ? "Android doesn't allow it any more." : (err as Error)?.message || "Couldn't read it.");
    }
  }
  return total;
}

// When the app opens and each time it comes back to the front.
export function initMore(changed: () => void = () => {}) {
  if (!A.supported() || !hasLifeStore()) return;
  const go = () => {
    if (!MORE.some((m) => read().on[m])) return;
    collect().then(changed, () => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') go();
  });
  go();
}
