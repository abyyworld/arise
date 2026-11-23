// Location on a timer in the phone apps (the logic is in location.ts). One setting on each phone:
// off, places only, or a point every so many minutes, exact or to about 1 km, and places never to
// note.
//
//   Android  Arise's plugin (LocationReader.kt) wakes every 15 minutes or more with a background
//            job, or keeps a small service with a notification for less than that. It needs
//            Location "Allow all the time". Points wait in a file (LifeQueue, queue "places") until
//            the app opens. Places only: a point every 15 minutes, which this side turns into stays.
//   iPhone   iOS can't wake an app on a timer. With Location "Always", Arise keeps low-power
//            location updates on and keeps one point per interval (ArisePlaces in AriseInbox.swift).
//            Points come in through the inbox with the visits (sense.ts). Places only is iOS's own
//            visits, the Places switch in Settings, Your life.
//
// Points go to the life log as tier 3 (sensitive) Maps events.

import type { LifeEvent } from './types';
import { hasLifeStore, lifeStore } from './store-port';
import * as LOC from './location';
import type { LocationMode, NeverPlace } from './location';
import * as ANDROID from './android-sense';
import * as SENSE from './sense';
import { onPauseChange, pausedUntil, unpaused } from './pause';

interface Cap {
  nativePromise: (plugin: string, method: string, options?: object) => Promise<Record<string, unknown>>;
}
const cap = () => (globalThis as { Capacitor?: Cap }).Capacitor;

export type Platform = 'android' | 'iphone' | null;
export function platform(): Platform {
  if (ANDROID.supported()) return 'android';
  if (SENSE.supported()) return 'iphone';
  return null;
}
const plugin = () => (platform() === 'android' ? 'AriseLife' : 'AriseSense');
const call = <T = Record<string, unknown>>(method: string, options: object = {}) => cap()!.nativePromise(plugin(), method, options) as Promise<T>;

export const read = LOC.loadState;

// What's on: on iPhone, places only is the Places switch, so that switch decides.
export function mode(): LocationMode {
  const m = read().prefs.mode;
  if (platform() === 'iphone') return SENSE.read().on.places ? (m === 'interval' ? 'interval' : 'places') : 'off';
  return m;
}

// ---------- what the phone allows

export interface LocationStatus {
  ready: boolean;
  sdk: number;
  location: string; // Android: 'granted', 'denied', 'prompt'
  background: string; // Android: "Allow all the time"
  places: string; // iPhone: always, whenInUse, denied, restricted, prompt
}
export const status: LocationStatus = { ready: false, sdk: 0, location: '', background: '', places: '' };

const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 30) : '');

export async function refreshStatus(): Promise<LocationStatus> {
  const p = platform();
  if (!p) return status;
  try {
    if (p === 'android') {
      const s = await call('status');
      const perms = await call('checkPermissions');
      status.sdk = typeof s.sdk === 'number' ? s.sdk : 0;
      status.location = str(perms.location);
      // Before Android 10 there's no separate "all the time": allowed is allowed.
      status.background = status.sdk && status.sdk < 29 ? status.location : str(perms.backgroundLocation);
    } else {
      status.places = str((await call('placesStatus')).status);
    }
    status.ready = true;
  } catch {}
  return status;
}

// What's in the way while it's on ('' when nothing).
export function blocked(): '' | 'denied' | 'background' {
  if (!status.ready || mode() === 'off') return '';
  if (platform() === 'android') {
    if (status.location !== 'granted') return 'denied';
    return status.background === 'granted' ? '' : 'background';
  }
  if (status.places === 'denied' || status.places === 'restricted') return 'denied';
  return status.places === 'whenInUse' && mode() === 'interval' ? 'background' : '';
}

let running: Promise<number> | null = null;

// ---------- the setting, sent to the phone

export function nativeConfig() {
  const st = read();
  const m = mode();
  return { mode: m, every: st.prefs.every, exact: st.prefs.exact, never: st.prefs.never.map((n) => ({ lat: n.lat, lon: n.lon, radius: n.radius })), pausedUntil: pausedUntil() };
}

// Tells the phone what to do now. Quietly: a phone without the newest app just doesn't know it.
export async function push(): Promise<void> {
  const p = platform();
  if (!p) return;
  try {
    await call(p === 'android' ? 'setLocation' : 'locationSet', nativeConfig());
  } catch {}
}

function change(fn: (st: LOC.LocationState) => void) {
  const st = read();
  fn(st);
  LOC.saveState(st);
  return st;
}

const NEED_ALWAYS_ANDROID = 'To note where you are while Arise is closed, Android needs Location set to Allow all the time: App info, Permissions, Location.';
const NEED_ALWAYS_IPHONE = "To note where you are while Arise is closed, choose Always: Settings app, Arise, Location.";

// Picks off, places only or a point on the timer, asking the phone for what it needs. The answer
// is something to tell the Player ('' when there's nothing to add).
export async function setMode(next: LocationMode, every?: number): Promise<string> {
  const p = platform();
  if (!p) return '';
  let note = '';
  if (next !== 'off' && p === 'android') {
    try {
      let perms = await call('requestPermissions', { permissions: ['location'] });
      if (perms.location !== 'granted') {
        await refreshStatus();
        return "Android didn't allow Location, so it stays off. You can allow it in App info, under Permissions.";
      }
      await refreshStatus();
      if (status.background !== 'granted') {
        perms = await call('requestPermissions', { permissions: ['backgroundLocation'] }).catch(() => ({}) as Record<string, unknown>);
        await refreshStatus();
        if (status.background !== 'granted') note = NEED_ALWAYS_ANDROID;
      }
    } catch {
      return "That didn't work. Try again.";
    }
  }
  if (p === 'iphone') {
    if (next === 'off') await SENSE.turnOff('places');
    else if (!SENSE.read().on.places) {
      const said = await SENSE.turnOn('places');
      if (!SENSE.read().on.places) return said;
      note = said;
    }
    await refreshStatus();
    if (next === 'interval' && status.places === 'whenInUse') note = NEED_ALWAYS_IPHONE;
  }
  change((st) => {
    st.prefs.mode = next;
    if (every !== undefined) st.prefs.every = LOC.cleanEvery(every);
    if (next === 'off') st.held = [];
    delete st.last;
  });
  await push();
  if (next !== 'off') void collect();
  return note;
}

export async function setExact(exact: boolean) {
  change((st) => {
    st.prefs.exact = exact;
  });
  await push();
}

// Where the phone is right now (to add as a place never to note), or null.
export async function here(): Promise<{ lat: number; lon: number } | null> {
  if (!platform()) return null;
  try {
    if (platform() === 'android') {
      const perms = await call('checkPermissions');
      if (perms.location !== 'granted' && (await call('requestPermissions', { permissions: ['location'] })).location !== 'granted') return null;
    }
    const r = await call('locationNow');
    return typeof r.lat === 'number' && typeof r.lon === 'number' ? { lat: r.lat, lon: r.lon } : null;
  } catch {
    return null;
  }
}

// Adds where the phone is now as a place never to note. Points already kept from inside it stay
// in the life log until the Player deletes them (Days, or Delete a date range).
export async function addNeverHere(radius: number, name: string): Promise<NeverPlace | null> {
  const spot = await here();
  if (!spot) return null;
  return addNever({ ...spot, radius, name });
}

export async function addNever(place: { lat: number; lon: number; radius: number; name?: string }): Promise<NeverPlace | null> {
  const [clean] = LOC.cleanNever([place]);
  if (!clean) return null;
  change((st) => {
    st.prefs.never = LOC.cleanNever([...st.prefs.never, clean]);
    st.held = st.held.filter((p) => !LOC.inNever(p, st.prefs.never));
  });
  await push();
  return clean;
}

export async function removeNever(i: number) {
  change((st) => {
    st.prefs.never = st.prefs.never.filter((_, k) => k !== i);
  });
  await push();
}

// Everything off and forgotten (Erase all data).
export async function forget() {
  if (running) await running.catch(() => 0);
  LOC.forgetState();
  if (platform() === 'android') await push();
  else if (platform() === 'iphone') {
    try {
      await call('locationSet', { mode: 'off' });
    } catch {}
  }
}

// ---------- reading (Android: points wait in the app's queue; iPhone: see sense.ts)

export function collect(now = () => Date.now()): Promise<number> {
  if (platform() !== 'android' || !hasLifeStore()) return Promise.resolve(0);
  if (!running) running = collectAndroid(now).finally(() => (running = null));
  return running;
}

async function collectAndroid(now: () => number): Promise<number> {
  const store = await lifeStore();
  let added = 0;
  try {
    for (let i = 0; i < 20; i++) {
      const { items, last } = await call<{ items: unknown[]; last: number }>('readQueue', { queue: 'places', max: 500 });
      if (!Array.isArray(items) || !items.length || !(last > 0)) break;
      const st = read();
      const m = st.prefs.mode;
      // Taken when the setting is off: dropped, never kept.
      const points = m === 'off' ? [] : unpaused(LOC.prepare(items, st.prefs));
      let events: LifeEvent[] = [];
      if (m === 'interval') events = LOC.thin(points, st.prefs.every).map((p) => LOC.pointEvent(p, 'android', st.prefs.exact));
      else if (m === 'places') {
        const r = LOC.stays([...st.held, ...points], now());
        events = r.stays.map((s) => LOC.stayEvent(s, 'android', st.prefs.exact));
        change((x) => {
          x.held = r.held;
        });
      }
      if (events.length) added += await store.addEvents(events);
      await call('ackQueue', { queue: 'places', upTo: last });
    }
    change((st) => {
      st.last = { at: now(), added };
    });
  } catch (err) {
    change((st) => {
      st.last = { at: now(), added, error: (err as Error)?.message || "Couldn't read it." };
    });
  }
  return added;
}

// ---------- start

// When the app opens and each time it comes back: the phone gets the setting again (a pause may
// have started on another device), and on Android what waited is read.
export function initLocation(changed: () => void = () => {}) {
  if (!platform() || !hasLifeStore()) return;
  const go = () => {
    if (mode() === 'off' && !read().prefs.never.length) return;
    void refreshStatus().then(changed, () => {});
    void push();
    collect().then(changed, () => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') go();
  });
  // A pause started or ended here: the phone hears it straight away.
  onPauseChange(() => {
    if (mode() !== 'off') void push();
  });
  go();
}
