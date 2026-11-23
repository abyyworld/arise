// Location on a timer, for both phone apps: the setting (off, places only, or a point every so
// many minutes), how exact it is, the places never to note, and turning what the phone found into
// life events. Plain functions with no device access, so they're easy to test; location-sense.ts
// does the asking.
//
// The phone applies the places never to note and the rounding before it keeps anything (Kotlin in
// LocationReader.kt, Swift in AriseInbox.swift). This side applies them again as things come in,
// so a point from an older build, or one noted just before a place was added, is still dropped.
//
// The setting belongs to this phone: it's kept in localStorage, never synced and never in backups.

import type { LifeEvent } from './types';

export type LocationMode = 'off' | 'places' | 'interval';
export const MODES: LocationMode[] = ['off', 'places', 'interval'];

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// Minutes between points: the ready-made choices, the one we suggest, and what can be typed.
export const EVERY_CHOICES = [5, 15, 30, 60];
export const SUGGESTED_EVERY = 30;
export const MIN_EVERY = 1;
export const MAX_EVERY = 720;
// Android can wake an app on a timer only every 15 minutes or more. Under that, a small service
// with a notification keeps running.
export const ANDROID_JOB_MIN = 15;

// Sizes for a place never to note, in meters.
export const RADII = [100, 250, 500, 1000];
export const DEFAULT_RADIUS = 250;
const MAX_NEVER = 50;

export interface NeverPlace {
  lat: number;
  lon: number;
  radius: number; // meters
  name: string;
}

export interface LocationPrefs {
  mode: LocationMode;
  every: number; // minutes, for 'interval'
  exact: boolean; // false: rounded to about 1 km
  never: NeverPlace[];
}

export const defaultPrefs = (): LocationPrefs => ({ mode: 'off', every: SUGGESTED_EVERY, exact: true, never: [] });

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const okLat = (v: unknown) => num(v) !== undefined && Math.abs(v as number) <= 90;
const okLon = (v: unknown) => num(v) !== undefined && Math.abs(v as number) <= 180;
const fix = (n: number, places = 5) => Math.round(n * 10 ** places) / 10 ** places;

// Minutes between points: a whole number from 1 to 720, or the suggested 30.
export function cleanEvery(v: unknown): number {
  const n = typeof v === 'string' ? Number(v.trim()) : num(v);
  if (n === undefined || !Number.isFinite(n)) return SUGGESTED_EVERY;
  const m = Math.round(n);
  return m >= MIN_EVERY && m <= MAX_EVERY ? m : SUGGESTED_EVERY;
}

// What the Player typed: a whole number of minutes, or null if it isn't one Arise can use.
export function parseEvery(text: unknown): number | null {
  const s = String(text ?? '').trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_EVERY && n <= MAX_EVERY ? n : null;
}

export function cleanRadius(v: unknown): number {
  const n = num(v);
  return n !== undefined && n >= 50 && n <= 5000 ? Math.round(n) : DEFAULT_RADIUS;
}

export function cleanNever(raw: unknown): NeverPlace[] {
  const out: NeverPlace[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (!okLat(o.lat) || !okLon(o.lon)) continue;
    const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    out.push({ lat: fix(o.lat as number), lon: fix(o.lon as number), radius: cleanRadius(o.radius), name });
    if (out.length >= MAX_NEVER) break;
  }
  return out;
}

export function cleanLocationPrefs(raw: unknown): LocationPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    mode: MODES.includes(o.mode as LocationMode) ? (o.mode as LocationMode) : 'off',
    every: cleanEvery(o.every),
    exact: o.exact !== false,
    never: cleanNever(o.never),
  };
}

// ---------- where

// Rounded to a grid of about 1 km: 0.01 degrees north to south (1.1 km), and as wide east to west
// wherever on Earth it is.
export function roundSpot(lat: number, lon: number): { lat: number; lon: number } {
  const step = 0.01;
  const rlat = Math.round(lat / step) * step;
  // (From the rounded latitude, so every spot in a cell lands on the same point.)
  const wide = Math.min(1, step / Math.max(0.01, Math.cos((rlat * Math.PI) / 180)));
  return { lat: fix(rlat), lon: fix(Math.max(-180, Math.min(180, Math.round(lon / wide) * wide))) };
}

// Meters between two spots (the haversine formula).
export function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Inside one of the places never to note.
export const inNever = (p: { lat: number; lon: number }, never: readonly NeverPlace[]) => never.some((n) => distance(p, n) <= n.radius);

// ---------- points

export interface Point {
  at: number;
  lat: number;
  lon: number;
  acc?: number; // meters
}

export function cleanPoint(raw: unknown): Point | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const at = num(o.at);
  if (!at || at <= 0 || at > 8.64e15 || !okLat(o.lat) || !okLon(o.lon)) return null;
  const p: Point = { at: Math.round(at), lat: o.lat as number, lon: o.lon as number };
  const acc = num(o.acc);
  if (acc !== undefined && acc >= 0 && acc < 1e6) p.acc = Math.round(acc);
  return p;
}

// One point per interval: a point is kept once `every` minutes (less a little, since a phone
// never wakes on the dot) have passed since the last one kept.
export function thin(points: readonly Point[], every: number, after = 0): Point[] {
  const gap = cleanEvery(every) * MIN * 0.8;
  const out: Point[] = [];
  let last = after;
  for (const p of [...points].sort((a, b) => a.at - b.at)) {
    if (last && p.at - last < gap) continue;
    out.push(p);
    last = p.at;
  }
  return out;
}

// Ready to keep: nothing inside a place never to note, and rounded unless the Player wants it exact.
export function prepare(points: readonly unknown[], prefs: LocationPrefs): Point[] {
  const out: Point[] = [];
  for (const raw of points) {
    const p = cleanPoint(raw);
    if (!p || inNever(p, prefs.never)) continue;
    if (prefs.exact) out.push(p);
    else out.push({ at: p.at, ...roundSpot(p.lat, p.lon), acc: Math.max(p.acc ?? 0, 1000) });
  }
  return out.sort((a, b) => a.at - b.at);
}

export type Device = 'android' | 'iphone';

const where = (p: { lat: number; lon: number; acc?: number }, exact: boolean) =>
  `${p.lat.toFixed(exact ? 4 : 2)}, ${p.lon.toFixed(exact ? 4 : 2)}${exact ? (p.acc ? `, within about ${p.acc} m` : '') : ', to about 1 km'}`;

// A point noted on the timer.
export function pointEvent(p: Point, device: Device, exact: boolean): LifeEvent {
  return {
    id: `maps:point:${device}:${Math.round(p.at / 1000)}`,
    source: 'maps',
    kind: 'place',
    at: p.at,
    title: 'Where you were',
    detail: where(p, exact),
    tier: 3,
    meta: { lat: fix(p.lat, exact ? 5 : 2), lon: fix(p.lon, exact ? 5 : 2), via: 'point', device, ...(exact ? {} : { rounded: true }), ...(exact && p.acc !== undefined ? { acc: p.acc } : {}) },
  };
}

// ---------- places only, on Android: stays made from a point every 15 minutes

export interface Stay {
  arrive: number;
  depart: number;
  lat: number;
  lon: number;
}

const STAY_RADIUS = 200; // meters from where the stay began
const STAY_MIN = 10 * MIN;
const HOLD = 3 * DAY;

// Points close together for a while are a stay: from the first to the last of them. The points
// of a stay that may still be going are handed back (`held`) to wait for the next read, unless
// the stay has gone on for 3 days, when it's noted as it is.
export function stays(points: readonly Point[], now: number, opts: { radius?: number; minStay?: number } = {}): { stays: Stay[]; held: Point[] } {
  const radius = opts.radius ?? STAY_RADIUS;
  const minStay = opts.minStay ?? STAY_MIN;
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const out: Stay[] = [];
  let group: Point[] = [];
  const finish = () => {
    if (group.length >= 2 && group[group.length - 1].at - group[0].at >= minStay) {
      const lat = group.reduce((s, p) => s + p.lat, 0) / group.length;
      const lon = group.reduce((s, p) => s + p.lon, 0) / group.length;
      out.push({ arrive: group[0].at, depart: group[group.length - 1].at, lat, lon });
    }
    group = [];
  };
  for (const p of sorted) {
    if (group.length && distance(group[0], p) > radius) finish();
    group.push(p);
  }
  if (group.length && now - group[0].at > HOLD) finish();
  return { stays: out, held: group };
}

export function stayEvent(s: Stay, device: Device, exact: boolean): LifeEvent {
  const spot = exact ? { lat: s.lat, lon: s.lon } : roundSpot(s.lat, s.lon);
  const mins = Math.max(1, Math.round((s.depart - s.arrive) / MIN));
  const long = mins < 60 ? `${mins} min` : mins % 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins / 60} h`;
  return {
    id: `maps:stay:${device}:${Math.round(s.arrive / 1000)}`,
    source: 'maps',
    kind: 'place',
    at: s.arrive,
    end: s.depart,
    title: `At a place for ${long}`,
    detail: where(spot, exact),
    value: mins,
    unit: 'min',
    tier: 3,
    meta: { lat: fix(spot.lat, exact ? 5 : 2), lon: fix(spot.lon, exact ? 5 : 2), via: 'stay', device, ...(exact ? {} : { rounded: true }) },
  };
}

// Something on a map: a point, a stay or a visit (anything from Maps with a spot).
export const hasSpot = (e: Pick<LifeEvent, 'source' | 'meta'>) => e.source === 'maps' && typeof e.meta?.lat === 'number' && typeof e.meta?.lon === 'number';

// ---------- this phone's setting

const KEY = 'arise-location';

export interface LocationState {
  prefs: LocationPrefs;
  held: Point[]; // Android, places only: the points of a stay that may still be going
  last?: { at: number; added: number; error?: string };
}

export function cleanState(raw: unknown): LocationState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const st: LocationState = {
    prefs: cleanLocationPrefs(o.prefs),
    held: (Array.isArray(o.held) ? o.held : [])
      .map(cleanPoint)
      .filter((p): p is Point => !!p)
      .slice(-500),
  };
  const l = (o.last && typeof o.last === 'object' ? o.last : null) as Record<string, unknown> | null;
  const at = num(l?.at);
  if (l && at && at > 0) {
    st.last = { at, added: Math.max(0, Math.floor(num(l.added) ?? 0)) };
    if (typeof l.error === 'string' && l.error) st.last.error = l.error.slice(0, 200);
  }
  return st;
}

export function loadState(): LocationState {
  try {
    return cleanState(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return cleanState({});
  }
}

export function saveState(st: LocationState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {}
}

export function forgetState() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

// In words, for the setting.
export function everyText(every: number): string {
  if (every % 60 === 0) return every === 60 ? 'every hour' : `every ${every / 60} hours`;
  return every === 1 ? 'every minute' : `every ${every} minutes`;
}
