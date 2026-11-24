// Where the Player's time goes, from the places in the life log: every place event with a spot
// (location points, stays, the iPhone's visits, Google Maps Timeline), the time each one counts
// for, and the spots close together put together as one place, with the Player's name for it.
// Pure: no store, no log, no network. The map (map-ui.js) and Your world (world-ui.js) use it.

import { inNever, type NeverPlace } from './location';
import { liveNames, nameNear, NAME_NEAR, placeKey, spotOf, type PlaceNames } from '../lib/place-names';
import type { LifeEvent } from './types';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// A point on a timer counts until the next one, up to an hour; the last one, a quarter of an hour.
const POINT_MAX = 60;
const POINT_LAST = 15;
// Spots this close are one place.
export const NEAR = 150; // meters

export type Range = 'week' | 'month' | 'year' | 'all';
export const RANGES: [Range, string][] = [
  ['week', 'Last 7 days'],
  ['month', 'Last 30 days'],
  ['year', 'Last year'],
  ['all', 'All'],
];
export const isRange = (v: unknown): v is Range => RANGES.some(([r]) => r === v);

// The times a range covers, [from, to).
export function rangeTimes(r: Range, now = Date.now()): { from: number; to: number } {
  const days = r === 'week' ? 7 : r === 'month' ? 30 : r === 'year' ? 365 : 0;
  return { from: days ? now - days * DAY : 1, to: now + 1 };
}

export interface Spot {
  id: string;
  at: number;
  end?: number;
  lat: number;
  lon: number;
  min: number; // the minutes it counts for, inside the range
  rounded: boolean; // kept only to about 1 km
  title: string;
}

// The place events with a spot, in time order, with the minutes each counts for inside [from, to).
// Anything inside a place never to note is left out, even if it was kept before that place was added.
export function spotsOf(events: readonly LifeEvent[], { from = 0, to = Infinity, never = [] as readonly NeverPlace[] } = {}): Spot[] {
  const list: (Spot & { point: boolean })[] = [];
  for (const e of events) {
    if (e.kind !== 'place') continue;
    const s = spotOf(e);
    if (!s || inNever(s, never)) continue;
    const end = typeof e.end === 'number' && e.end > e.at ? e.end : undefined;
    if ((end ?? e.at) < from || e.at >= to) continue;
    list.push({ id: e.id, at: e.at, end, lat: s.lat, lon: s.lon, min: 0, rounded: e.meta?.rounded === true, title: e.title, point: e.meta?.via === 'point' });
  }
  list.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const out: Spot[] = [];
  list.forEach((s, i) => {
    const { point, ...spot } = s;
    if (s.end) spot.min = Math.max(0, (Math.min(s.end, to) - Math.max(s.at, from)) / MIN);
    else if (point) {
      const next = list.slice(i + 1).find((n) => n.point);
      spot.min = next ? Math.min(POINT_MAX, (next.at - s.at) / MIN) : POINT_LAST;
    }
    spot.min = Math.round(spot.min);
    out.push(spot);
  });
  return out;
}

export interface Place {
  key: string; // its spot as a name key (lib/place-names.ts)
  lat: number;
  lon: number;
  min: number;
  visits: Spot[]; // newest first
  rounded: boolean; // every spot in it kept only to about 1 km
  name?: string;
  nameKey?: string; // the key its name is kept under
}

// Spots within `near` meters of a place's first spot are that place. Places with the same name are
// one place too. Most time first.
export function groupPlaces(spots: readonly Spot[], names: PlaceNames = {}, near = NEAR): Place[] {
  const STEP = 0.002; // about 220 m north to south, more than `near`
  const lonStep = (row: number) => STEP / Math.max(0.05, Math.cos((row * STEP * Math.PI) / 180));
  const cells = new Map<string, Place[]>();
  const all: Place[] = [];
  const first = new Map<Place, { lat: number; lon: number }>();
  const close = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
    const dy = (b.lat - a.lat) * 110_540;
    const dx = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    return Math.hypot(dx, dy) <= near;
  };
  for (const s of spots) {
    const row = Math.floor(s.lat / STEP);
    let found: Place | undefined;
    for (let r = row - 1; r <= row + 1 && !found; r++) {
      const col = Math.floor(s.lon / lonStep(r));
      for (let c = col - 1; c <= col + 1 && !found; c++) found = cells.get(`${r},${c}`)?.find((p) => close(first.get(p)!, s));
    }
    if (found) {
      found.visits.push(s);
      continue;
    }
    const p: Place = { key: '', lat: s.lat, lon: s.lon, min: 0, visits: [s], rounded: true };
    first.set(p, { lat: s.lat, lon: s.lon });
    all.push(p);
    const k = `${row},${Math.floor(s.lon / lonStep(row))}`;
    cells.set(k, [...(cells.get(k) || []), p]);
  }
  // Each place in the middle of its spots, weighted by time (a point with no time counts a little).
  const settle = (p: Place) => {
    const w = (s: Spot) => Math.max(1, s.min);
    const sum = p.visits.reduce((n, s) => n + w(s), 0);
    p.lat = p.visits.reduce((n, s) => n + s.lat * w(s), 0) / sum;
    p.lon = p.visits.reduce((n, s) => n + s.lon * w(s), 0) / sum;
    p.min = p.visits.reduce((n, s) => n + s.min, 0);
    p.rounded = p.visits.every((s) => s.rounded);
    p.visits.sort((a, b) => b.at - a.at);
  };
  all.forEach(settle);
  // The names, and places with the same one together.
  const byName = new Map<string, Place>();
  const out: Place[] = [];
  const named = liveNames(names).length > 0;
  for (const p of all) {
    const n = named ? nameNear(names, p.lat, p.lon, Math.max(NAME_NEAR, p.rounded ? 800 : 0)) : null;
    if (n) {
      const same = byName.get(n.key);
      if (same) {
        same.visits.push(...p.visits);
        continue;
      }
      p.name = n.name;
      p.nameKey = n.key;
      byName.set(n.key, p);
    }
    out.push(p);
  }
  for (const p of out) {
    settle(p);
    p.key = p.nameKey || placeKey(p.lat, p.lon);
  }
  return out.sort((a, b) => b.min - a.min || b.visits.length - a.visits.length);
}

// "2 h 5 min", "45 min", "3 days 4 h".
export function timeText(min: number): string {
  const m = Math.round(min);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
  const d = Math.floor(m / (24 * 60));
  const h = Math.round((m - d * 24 * 60) / 60);
  return h ? `${d} days ${h} h` : `${d} days`;
}

// What to call a place: its name, else what its visits say ("At Starbucks"), else its spot.
export function placeTitle(p: Pick<Place, 'name' | 'visits' | 'lat' | 'lon' | 'rounded'>): string {
  if (p.name) return p.name;
  const own = p.visits.map((v) => /^(?:At|Arrived at|Left)\s+(.+)$/i.exec(v.title)?.[1]?.trim() || '').find((t) => t && !/^a place\b/i.test(t));
  if (own) {
    const t = own.replace(/\s+for\s+\d.*$/i, '');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  const d = p.rounded ? 2 : 3;
  return `Near ${p.lat.toFixed(d)}, ${p.lon.toFixed(d)}`;
}
