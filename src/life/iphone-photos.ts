// Photos taken, in the iPhone app: when, and where if the photo says so, from PhotoKit (the photos
// method in AriseSense.swift). Never the photos themselves. Off until the Player turns it on in
// Settings, Your life, which asks iOS for Photos. One event per hour ("Took 3 photos"), made the
// same way as on Android (photoEvents in android-more.ts): nothing from inside a place never to
// note, rounded to about 1 km unless Location is exact, and nothing from a pause.
//
// Kept in localStorage on this iPhone only.

import { hasLifeStore, lifeStore } from './store-port';
import * as SENSE from './sense';
import * as LOC from './location';
import { photoEvents } from './android-more';
import { isPaused, unpaused } from './pause';

const KEY = 'arise-iphone-photos';
const HOUR = 3_600_000;
const BACK = 30 * 24 * HOUR;

interface Cap {
  nativePromise: (plugin: string, method: string, options?: object) => Promise<Record<string, unknown>>;
}
const sense = (method: string, options: object = {}) => (globalThis as { Capacitor?: Cap }).Capacitor!.nativePromise('AriseSense', method, options);

export interface PhotosState {
  on: boolean;
  cursor?: number; // read up to this hour
  last?: { at: number; added: number; error?: string };
}

const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.floor(v) : undefined);

export function cleanState(raw: unknown): PhotosState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const st: PhotosState = { on: o.on === true };
  const cursor = time(o.cursor);
  if (cursor) st.cursor = cursor;
  const l = (o.last && typeof o.last === 'object' ? o.last : null) as Record<string, unknown> | null;
  const at = time(l?.at);
  if (l && at) {
    st.last = { at, added: Math.max(0, Math.floor(Number(l.added) || 0)) };
    if (typeof l.error === 'string' && l.error) st.last.error = l.error.slice(0, 200);
  }
  return st;
}

export function read(): PhotosState {
  try {
    return cleanState(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return cleanState({});
  }
}

function write(st: PhotosState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {}
}

export const status = { photos: '' };

export async function refreshStatus() {
  if (!SENSE.supported()) return;
  try {
    status.photos = String((await sense('photosStatus')).status || '');
  } catch {}
}

// Asks iOS for Photos and turns it on. The answer is something to tell the Player ('' if nothing).
export async function turnOn(): Promise<string> {
  if (!SENSE.supported()) return '';
  try {
    status.photos = String((await sense('photosAccess')).status || '');
  } catch (err) {
    return `That didn't work: ${(err as Error)?.message || err}`;
  }
  if (status.photos !== 'granted' && status.photos !== 'limited') return 'Photos are off for Arise. In the Settings app, open Arise, then Photos, and choose Full Access.';
  write({ on: true });
  void collect();
  return status.photos === 'limited' ? 'Arise sees only the photos you picked for it. For all of them, choose Full Access: Settings app, Arise, Photos.' : '';
}

export function turnOff() {
  write({ on: false });
}

export function forget() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

const floorHour = (ms: number) => {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

let running: Promise<number> | null = null;

export function collect(now = () => Date.now()): Promise<number> {
  if (!SENSE.supported() || !hasLifeStore() || !read().on || isPaused()) return Promise.resolve(0);
  if (!running) running = collectNow(now).finally(() => (running = null));
  return running;
}

async function collectNow(now: () => number): Promise<number> {
  const st = read();
  // Whole hours only, so an hour's count is never noted half-way through.
  const to = floorHour(now());
  const from = st.cursor ?? floorHour(now() - BACK);
  if (to <= from) return 0;
  const store = await lifeStore();
  try {
    const r = await sense('photos', { from, to });
    const events = unpaused(photoEvents(Array.isArray(r.photos) ? r.photos : [], LOC.loadState().prefs, 'iphone'));
    const added = events.length ? await store.addEvents(events) : 0;
    write({ on: true, cursor: to, last: { at: now(), added } });
    return added;
  } catch (err) {
    write({ ...read(), last: { at: now(), added: 0, error: (err as Error)?.message || "Couldn't read it." } });
    return 0;
  }
}

export function initPhotos(changed: () => void = () => {}) {
  if (!SENSE.supported() || !hasLifeStore()) return;
  const go = () => {
    if (!read().on) return;
    void refreshStatus();
    collect().then(changed, () => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') go();
  });
  go();
}
