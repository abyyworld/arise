// Names the Player gives places ("Home", "Lab", "Mosque"), kept in the main state and synced end-to-end
// encrypted with the rest. Each name is keyed by where the place is, rounded to 3 decimals (about
// 100 m), so the key says no more than the life log already does.
//
// Like to-dos (lib/todos.ts): each name keeps the time it last changed (`at`), and a removed one
// stays as a tombstone (`gone`) for a while, so a copy on another device that still has it can't
// bring it back. Two copies merge per place: the later change wins.

import { distance } from '../life/location';
import type { LifeEvent } from '../life/types';

export interface PlaceName {
  name: string; // '' when gone
  at: number; // when it last changed
  gone?: true;
}
export type PlaceNames = Record<string, PlaceName>;

export const MAX_PLACE_NAMES = 300;
export const PLACE_NAME_MAX = 40;
// A name belongs to anything this close to its spot (the phone's visits move about a little).
export const NAME_NEAR = 200; // meters
const KEEP_GONE = 180 * 86_400_000;

const KEY = /^-?\d{1,2}\.\d{3},-?\d{1,3}\.\d{3}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const three = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return (r === 0 ? 0 : r).toFixed(3); // never "-0.000"
};

// The key for a spot: "41.311,69.280".
export const placeKey = (lat: number, lon: number) => `${three(lat)},${three(lon)}`;

// The spot a key stands for, or null if it isn't one.
export function keySpot(k: string): { lat: number; lon: number } | null {
  if (!KEY.test(k)) return null;
  const [lat, lon] = k.split(',').map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export function cleanPlaceName(raw: unknown): PlaceName | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isTime(r.at)) return null;
  if (r.gone === true) return { name: '', at: r.at, gone: true };
  const name = line(r.name, PLACE_NAME_MAX);
  return name ? { name, at: r.at } : null;
}

// Old tombstones go; then, past the most kept, the oldest changes go first (names and removals each
// on their own, so many names never push out a removal). In a fixed order, so the same names
// always save the same.
export function cleanPlaceNames(raw: unknown, now = Date.now()): PlaceNames {
  const out: [string, PlaceName][] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!keySpot(k)) continue;
      const p = cleanPlaceName(v);
      if (!p || (p.gone && now - p.at > KEEP_GONE)) continue;
      out.push([k, p]);
    }
  }
  const newest = (list: [string, PlaceName][]) => list.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_PLACE_NAMES);
  const kept = [...newest(out.filter(([, p]) => !p.gone)), ...newest(out.filter(([, p]) => p.gone))];
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(kept);
}

// Each place's name from whichever copy changed it last (a removal is a change too).
export function mergePlaceNames(a: PlaceNames, b: PlaceNames, now = Date.now()): PlaceNames {
  const out: PlaceNames = { ...a };
  for (const [k, p] of Object.entries(b || {})) if (!out[k] || p.at > out[k].at) out[k] = p;
  return cleanPlaceNames(out, now);
}

// Sets (or, with no name, removes) the name at a key. A new copy; null if the key isn't one.
export function setPlaceName(names: PlaceNames, key: string, name: string, now = Date.now()): PlaceNames | null {
  if (!keySpot(key)) return null;
  const n = line(name, PLACE_NAME_MAX);
  if (!n && !names[key]) return names;
  const at = Math.max(now, (names[key]?.at || 0) + 1);
  return cleanPlaceNames({ ...names, [key]: n ? { name: n, at } : { name: '', at, gone: true } }, now);
}

export const liveNames = (names: PlaceNames) => Object.entries(names || {}).filter(([, p]) => !p.gone);

// The closest name within `near` meters of a spot.
export function nameNear(names: PlaceNames, lat: number, lon: number, near = NAME_NEAR): { key: string; name: string } | null {
  let best: { key: string; name: string; d: number } | null = null;
  for (const [key, p] of liveNames(names)) {
    const s = keySpot(key);
    if (!s) continue;
    const d = distance(s, { lat, lon });
    if (d <= near && (!best || d < best.d)) best = { key, name: p.name, d };
  }
  return best && { key: best.key, name: best.name };
}

// Where a life event was, from its own spot (Google's import says lng, the phones lon).
export function spotOf(e: Pick<LifeEvent, 'meta'>): { lat: number; lon: number } | null {
  const lat = e.meta?.lat;
  const lon = e.meta?.lon ?? e.meta?.lng;
  return typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// A place's title with the Player's name for it: "At a place for 2 h" becomes "At Home for 2 h",
// "Where you were" becomes "At Home", and another title gets the name after it.
export function namedTitle(e: Pick<LifeEvent, 'kind' | 'title' | 'meta'>, names: PlaceNames): string {
  if (e.kind !== 'place' || !names) return e.title;
  const s = spotOf(e);
  const n = s && nameNear(names, s.lat, s.lon);
  if (!n) return e.title;
  if (/\ba place\b/.test(e.title)) return e.title.replace(/\ba place\b/, n.name);
  if (e.title === 'Where you were') return `At ${n.name}`;
  return e.title.toLowerCase().includes(n.name.toLowerCase()) ? e.title : `${e.title} (${n.name})`;
}

// The same events with the names in their titles (copies only where a title changed).
export function withPlaceNames<T extends Pick<LifeEvent, 'kind' | 'title' | 'meta'>>(events: readonly T[], names: PlaceNames): T[] {
  if (!liveNames(names).length) return [...events];
  return events.map((e) => {
    const t = namedTitle(e, names);
    return t === e.title ? e : { ...e, title: t };
  });
}
