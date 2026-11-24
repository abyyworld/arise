// The Player's corrections, and what Arise knew on each day, without the database: pure, so they're
// tested on their own (fixes.test.ts).
//
// A correction (LifeFix in lib/validate.ts) wins everywhere it could be undone:
//   - an event they fixed or deleted ("Not quite? Fix it") stays that way when an importer brings
//     the same event in again (log.ts), and when another device sends its older copy (packs.ts);
//   - something Arise knew that they said isn't right ("This isn't right, teach it") is never
//     learned again in other words (memory.ts applyOps), and a part of life they corrected shows
//     their words for 4 weeks (insight.ts).
// The corrections and the snapshots of what Arise knew sync in the memory's pack, sealed like the
// rest of the memory.

import { cleanLifeEvent, cleanLifeFix, cleanLifeKnew, type LifeFix, type LifeKnew, type LifeWipe } from '../lib/validate';
import type { LifeEvent } from './types';

export const MAX_FIXES = 5000;
export const AREA_FIX_DAYS = 28;

export const isEventFix = (f: LifeFix) => !/^(fact|area):/.test(f.id);
export const cleanFixes = (v: unknown): LifeFix[] => (Array.isArray(v) ? v.map(cleanLifeFix).filter((f): f is LifeFix => !!f) : []);
export const cleanKnew = (v: unknown): LifeKnew[] => (Array.isArray(v) ? v.map(cleanLifeKnew).filter((k): k is LifeKnew => !!k) : []);

// ---------- events

// An event as the Player corrected it, or null when they deleted it. Its length stays the same
// when its time moves. Checked again, so a new kind can only make it more private.
export function applyFix<T extends LifeEvent>(e: T, f: LifeFix | undefined): T | null {
  if (!f) return e;
  if (f.gone) return null;
  const out: LifeEvent = { ...e };
  if (f.title) out.title = f.title;
  if (f.kind) out.kind = f.kind;
  if (f.start) {
    if (e.end !== undefined) out.end = f.start + (e.end - e.at);
    out.at = f.start;
  }
  const clean = cleanLifeEvent(out);
  if (!clean) return e;
  const extra = 'm' in e ? { m: (e as { m: number }).m } : {};
  return { ...clean, ...extra } as T;
}

// Whether a correction changes this event (a fix already applied changes nothing).
export function changes(e: LifeEvent, f: LifeFix | undefined): boolean {
  if (!f) return false;
  const next = applyFix(e, f);
  return !next || JSON.stringify(next) !== JSON.stringify(e);
}

export const fixMap = (list: readonly LifeFix[]) => new Map(list.filter(isEventFix).map((f) => [f.id, f]));

// Two lists of corrections together: for each thing, the newest. "Delete everything" (a wipe of
// all) takes the ones made before it.
export function mergeFixes(a: readonly LifeFix[], b: readonly LifeFix[], wipes: readonly LifeWipe[] = []): LifeFix[] {
  const m = new Map<string, LifeFix>();
  for (const f of [...a, ...b]) {
    const was = m.get(f.id);
    if (!was || f.at > was.at || (f.at === was.at && JSON.stringify(f) > JSON.stringify(was))) m.set(f.id, f);
  }
  const all = wipes.filter((w) => w.what === 'all');
  const out = [...m.values()].filter((f) => !all.some((w) => w.at >= f.at));
  return out.sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).slice(-MAX_FIXES);
}

// A correction made on top of an earlier one of the same thing keeps what the earlier one said.
export function combine(was: LifeFix | undefined, next: LifeFix): LifeFix {
  if (!was || next.gone || was.gone) return next;
  return { ...was, ...next };
}

// ---------- what Arise knew

// A light trim, so "running" and "runs" are "run".
function stem(w: string) {
  let x = w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
  if (x.length > 5 && x.endsWith('ing')) x = x.slice(0, -3);
  else if (x.length > 4 && x.endsWith('ed')) x = x.slice(0, -2);
  return x.length > 3 && x.at(-1) === x.at(-2) ? x.slice(0, -1) : x;
}

// Words that say something, for telling whether two facts say the same.
const STOP = new Set('you your the a an and or of to in on at for with is are was were be been it its that this they them their he she his her have has had do does did not no very really often usually every each most some about from by as up out'.split(' '));
const keyWords = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map(stem),
  );

// Whether two facts say the same thing, in the same or close words.
export function sameClaim(a: string, b: string): boolean {
  const x = keyWords(a);
  const y = keyWords(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.5;
}

// The words the Player said weren't right, which the memory must never learn again.
export const wrongs = (list: readonly LifeFix[]) => list.filter((f) => f.id.startsWith('fact:') && f.wrong).map((f) => f.wrong as string);
export const isWrong = (text: string, list: readonly string[]) => list.some((w) => sameClaim(text, w));

// ---------- the parts of life (areas.ts)

interface AreaLike {
  id: string;
  score: number | null;
  reason: string;
  trend: string | null;
  tier: number;
  help?: string;
}

// A part of life the Player said wasn't right shows their words instead, for 4 weeks after they said it.
export function withAreaFixes<T extends AreaLike>(areas: readonly T[], list: readonly LifeFix[], now: number): T[] {
  return areas.map((a) => {
    const f = list.find((x) => x.id === `area:${a.id}`);
    if (!f || now - f.at > AREA_FIX_DAYS * 864e5) return a;
    const { help: _h, ...rest } = a;
    return { ...rest, score: null, trend: null, reason: f.right ? `You said: ${f.right}` : "You said this wasn't right, so it's left out for now.", tier: Math.max(a.tier, f.tier || 2), fixed: true } as unknown as T;
  });
}

// ---------- snapshots of what Arise knew

export const KNEW_DAILY = 14; // the last two weeks: one a day
export const KNEW_MAX = 40; // and then one a month, at most this many in all

// Keeps every one from the last two weeks, then the last of each month, and always the first (so
// it can say when Arise started keeping them). At most KNEW_MAX, oldest first.
export function thinKnew(list: readonly LifeKnew[], today: string): LifeKnew[] {
  const by = new Map<string, LifeKnew>();
  for (const k of list) {
    const was = by.get(k.day);
    if (!was || k.at > was.at || (k.at === was.at && JSON.stringify(k) > JSON.stringify(was))) by.set(k.day, k);
  }
  const sorted = [...by.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  if (!sorted.length) return [];
  const recent = shiftDay(today, -KNEW_DAILY);
  const lastOfMonth = new Map<string, string>();
  for (const k of sorted) lastOfMonth.set(k.day.slice(0, 7), k.day);
  const kept = sorted.filter((k, i) => i === 0 || k.day > recent || lastOfMonth.get(k.day.slice(0, 7)) === k.day);
  return kept.length > KNEW_MAX ? [kept[0], ...kept.slice(-(KNEW_MAX - 1))] : kept;
}

function shiftDay(k: string, n: number) {
  const [y, m, d] = k.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// Two lists together, thinned the same way on every device. "Delete everything" and "Forget what
// Arise learned" (wipes) take the ones from before them.
export function mergeKnew(a: readonly LifeKnew[], b: readonly LifeKnew[], now: number, wipes: readonly LifeWipe[] = []): LifeKnew[] {
  const gone = wipes.filter((w) => w.what === 'all' || w.what === 'memory');
  const today = new Date(now).toISOString().slice(0, 10);
  return thinKnew(
    [...a, ...b].filter((k) => !gone.some((w) => w.at >= k.at)),
    today,
  );
}

// What Arise knew on a day: the latest snapshot on or before it. `before`: there's none that old,
// and when the first one was kept.
export function knewOn(list: readonly LifeKnew[], day: string): { knew: LifeKnew | null; first: string | null } {
  const sorted = [...list].sort((a, b) => (a.day < b.day ? -1 : 1));
  let knew: LifeKnew | null = null;
  for (const k of sorted) if (k.day <= day) knew = k;
  return { knew, first: sorted[0]?.day || null };
}

export interface KnewChange {
  added: string[]; // known now, not then
  changed: { was: string; now: string }[];
  dropped: string[]; // known then, not now
}

// What changed between what Arise knew then and what it knows now.
export function knewDiff(then: readonly { id: string; text: string }[], now: readonly { id: string; text: string }[]): KnewChange {
  const was = new Map(then.map((f) => [f.id, f.text]));
  const is = new Map(now.map((f) => [f.id, f.text]));
  const out: KnewChange = { added: [], changed: [], dropped: [] };
  for (const [id, text] of is) {
    if (!was.has(id)) out.added.push(text);
    else if (was.get(id) !== text) out.changed.push({ was: was.get(id)!, now: text });
  }
  for (const [id, text] of was) if (!is.has(id)) out.dropped.push(text);
  // A fact that came back under a new id (learned again) isn't new, nor dropped.
  out.added = out.added.filter((t) => {
    const i = out.dropped.indexOf(t);
    if (i < 0) return true;
    out.dropped.splice(i, 1);
    return false;
  });
  return out;
}
