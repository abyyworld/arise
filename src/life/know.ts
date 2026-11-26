// What the Player says about the facts on What Arise knows, without the database: pure, so it's
// tested on its own (know.test.ts).
//
//   - "Never send to an AI": the fact stays on the device and on screen, and is left out of
//     everything any AI reads (the coach's profile, the memory's prompts, me links and AI apps),
//     whatever the settings (memory.ts, me.ts).
//   - "Check again on" a day: on that day, A quick one on Today asks if it's still true.
//   - "Imported, not confirmed": a fact learned from a day that came mostly from imports, until
//     they say it's right.
//   - Possible duplicates (two facts that say the same thing: merge them) and facts that disagree
//     (Arise asks which is right). Both worked out here, with no AI.
// The flags sync in the memory's pack, sealed like the rest of the memory (packs.ts).

import { cleanLifeFactFlag, type LifeFact, type LifeFactFlag, type LifeWipe } from '../lib/validate';
import type { LifeEvent, LifeTier } from './types';
import { keyWords } from './fixes';

export const MAX_FLAGS = 5000;
export const MAX_PAIRS = 20;

export const cleanFlags = (v: unknown): LifeFactFlag[] => (Array.isArray(v) ? v.map(cleanLifeFactFlag).filter((f): f is LifeFactFlag => !!f) : []);
export const flagMap = (list: readonly LifeFactFlag[]) => new Map(list.map((f) => [f.id, f]));

// ---------- the flags

export interface FlagPatch {
  noAI?: boolean;
  check?: string | null; // a day, or null to take it off
  ok?: boolean;
  apart?: string; // another fact they said is different
}

// A flag with a change made now. Each part keeps the time it changed.
export function patchFlag(was: LifeFactFlag | undefined, id: string, p: FlagPatch, now: number): LifeFactFlag {
  const out: LifeFactFlag = { ...(was || { id }), id, at: now };
  if (p.noAI !== undefined) {
    if (p.noAI) out.noAI = true;
    else delete out.noAI;
    out.ta = now;
  }
  if (p.check !== undefined) {
    if (p.check) out.check = p.check;
    else delete out.check;
    out.tc = now;
  }
  if (p.ok !== undefined) {
    if (p.ok) out.ok = true;
    else delete out.ok;
    out.to = now;
  }
  if (p.apart && p.apart !== id) out.apart = [...new Set([...(out.apart || []), p.apart])].sort().slice(0, 50);
  return cleanLifeFactFlag(out) || { id, at: now };
}

// Two copies of one fact's flags: each part from the copy that changed it last. On a tie, the
// more careful one wins: kept from AIs, and asked about sooner.
export function combineFlags(a: LifeFactFlag, b: LifeFactFlag): LifeFactFlag {
  const out: LifeFactFlag = { id: a.id, at: Math.max(a.at, b.at) };
  const ta = a.ta || 0;
  const tb = b.ta || 0;
  const noAI = ta === tb ? !!(a.noAI || b.noAI) : ta > tb ? !!a.noAI : !!b.noAI;
  if (noAI) out.noAI = true;
  if (ta || tb) out.ta = Math.max(ta, tb);
  const ca = a.tc || 0;
  const cb = b.tc || 0;
  const check = ca === cb ? [a.check, b.check].filter((x): x is string => !!x).sort()[0] : ca > cb ? a.check : b.check;
  if (check) out.check = check;
  if (ca || cb) out.tc = Math.max(ca, cb);
  const oa = a.to || 0;
  const ob = b.to || 0;
  const ok = oa === ob ? !!(a.ok || b.ok) : oa > ob ? !!a.ok : !!b.ok;
  if (ok) out.ok = true;
  if (oa || ob) out.to = Math.max(oa, ob);
  const apart = [...new Set([...(a.apart || []), ...(b.apart || [])])].sort().slice(0, 50);
  if (apart.length) out.apart = apart;
  return out;
}

// Two lists together. "Delete everything" and "Forget what Arise learned" (wipes) take the ones
// from before them, as they take the facts.
export function mergeFlags(a: readonly LifeFactFlag[], b: readonly LifeFactFlag[], wipes: readonly LifeWipe[] = []): LifeFactFlag[] {
  const m = new Map<string, LifeFactFlag>();
  for (const f of [...a, ...b]) {
    const was = m.get(f.id);
    m.set(f.id, was ? combineFlags(was, f) : f);
  }
  const gone = wipes.filter((w) => w.what === 'all' || w.what === 'memory');
  return [...m.values()]
    .filter((f) => !gone.some((w) => w.at >= f.at))
    .sort((x, y) => (x.id < y.id ? -1 : 1))
    .slice(-MAX_FLAGS);
}

// The facts that never go to an AI.
export const heldIds = (flags: ReadonlyMap<string, LifeFactFlag>) => new Set([...flags.values()].filter((f) => f.noAI).map((f) => f.id));
export const sendable = <T extends { id: string }>(list: readonly T[], flags: ReadonlyMap<string, LifeFactFlag>): T[] => list.filter((f) => !flags.get(f.id)?.noAI);

// Came mostly from imports and they haven't said it's right yet.
export const unconfirmed = (f: LifeFact, flags: ReadonlyMap<string, LifeFactFlag>) => !!f.imp && !flags.get(f.id)?.ok;

// The facts whose day to check has come, the earliest first.
export function dueChecks(facts: readonly LifeFact[], flags: ReadonlyMap<string, LifeFactFlag>, today: string): { id: string; text: string; due: string }[] {
  const out: { id: string; text: string; due: string }[] = [];
  for (const f of facts) {
    const c = flags.get(f.id)?.check;
    if (!f.until && c && c <= today) out.push({ id: f.id, text: f.text, due: c });
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.id < b.id ? -1 : 1));
}

// ---------- where a day's facts came from

// An event from an import (a file the Player brought in), not from their own devices or Arise.
export function fromImport(e: Pick<LifeEvent, 'source' | 'id'>): boolean {
  switch (e.source) {
    case 'arise':
    case 'manual':
    case 'mac':
    case 'browser':
    case 'health':
    case 'android':
    case 'shortcut':
    case 'calendar':
      return false;
    case 'maps':
      return !/^maps:(motion|visit):/.test(e.id);
    default:
      return true;
  }
}

// A day whose events came mostly from imports: what's learned from it is "Imported, not confirmed".
export const mostlyImported = (events: readonly Pick<LifeEvent, 'source' | 'id'>[]) => events.length > 0 && events.filter(fromImport).length * 2 > events.length;

// ---------- duplicates and disagreements

const NEG = /\b(not|no|never|none|nobody|nothing|nowhere|neither|nor)\b/;
// "don't", "isn't", "can't" -> "do not", "is not", "ca not".
const plainNot = (t: string) => t.toLowerCase().replace(/[’']/g, "'").replace(/n't\b/g, ' not');
const negated = (t: string) => NEG.test(plainNot(t));
const words = (t: string) => new Set([...keyWords(plainNot(t).replace(new RegExp(NEG.source, 'g'), ' '))].filter((w) => !/^\d/.test(w)));
const numbers = (t: string) => new Set((t.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.')));
const jaccard = (x: ReadonlySet<string>, y: ReadonlySet<string>) => {
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
};
const sameSet = (x: ReadonlySet<string>, y: ReadonlySet<string>) => x.size === y.size && [...x].every((w) => y.has(w));

// Things that have one answer at a time: where you live, where you work...
const FRAMES: readonly [string, RegExp][] = [
  ['live', /^you (?:live|are living|now live) in (.+)$/],
  ['work', /^you work (?:at|for) (.+)$/],
  ['job', /^you work as (?:an? )?(.+)$/],
  ['study', /^you study (?:at|in) (.+)$/],
  ['born', /^you (?:were|are) born (?:in|on) (.+)$/],
  ['status', /^you (?:are|re) (married|single|engaged|divorced|widowed|in a relationship)\b/],
  ['fav', /^your (?:favourite|favorite) (\w+(?: \w+)?) is (.+)$/],
];
const tidy = (t: string) =>
  plainNot(t)
    .replace(/[.!?]+$/, '')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/'/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
function frameOf(t: string): { k: string; v: Set<string> } | null {
  const s = tidy(t);
  for (const [k, re] of FRAMES) {
    const m = re.exec(s);
    if (!m) continue;
    if (k === 'fav') return { k: `fav:${m[1]}`, v: words(m[2]) };
    return { k, v: words(m[1]) };
  }
  return null;
}
const subset = (x: ReadonlySet<string>, y: ReadonlySet<string>) => [...x].every((w) => y.has(w));

interface Shape {
  f: LifeFact;
  w: Set<string>;
  n: Set<string>;
  neg: boolean;
  frame: { k: string; v: Set<string> } | null;
}
const shape = (f: LifeFact): Shape => ({ f, w: words(f.text), n: numbers(f.text), neg: negated(f.text), frame: frameOf(f.text) });

// Whether two facts can't both be true: one says not what the other says, the same thing with
// another number, or another answer to something with one answer at a time.
function clash(a: Shape, b: Shape): boolean {
  if (a.w.size && sameSet(a.w, b.w)) {
    if (a.neg !== b.neg) return true;
    if (a.n.size && b.n.size && !sameSet(a.n, b.n)) return true;
  }
  if (a.neg !== b.neg && jaccard(a.w, b.w) >= 0.75) return true;
  if (a.frame && b.frame && a.frame.k === b.frame.k && a.frame.v.size && b.frame.v.size && !subset(a.frame.v, b.frame.v) && !subset(b.frame.v, a.frame.v)) return true;
  return false;
}

// The same thing in the same or close words (and no number or "not" that tells them apart).
function same(a: Shape, b: Shape): boolean {
  if (a.neg !== b.neg) return false;
  if (!sameSet(a.n, b.n)) return false;
  if (!a.w.size || !b.w.size) return a.f.text.trim().toLowerCase() === b.f.text.trim().toLowerCase();
  return jaccard(a.w, b.w) >= 0.5;
}

export const disagree = (a: LifeFact, b: LifeFact) => clash(shape(a), shape(b));
export const sameFact = (a: LifeFact, b: LifeFact) => !clash(shape(a), shape(b)) && same(shape(a), shape(b));

const apart = (a: string, b: string, flags: ReadonlyMap<string, LifeFactFlag>) => !!flags.get(a)?.apart?.includes(b) || !!flags.get(b)?.apart?.includes(a);

export interface Pair {
  a: LifeFact;
  b: LifeFact;
}

// Pairs among the facts still true, each fact in one pair at most, at most MAX_PAIRS: `dupes`
// that say the same thing, `clashes` that can't both be true. Pairs they put away don't come back.
export function pairs(facts: readonly LifeFact[], flags: ReadonlyMap<string, LifeFactFlag>): { dupes: Pair[]; clashes: Pair[] } {
  const live = facts.filter((f) => !f.until).map(shape);
  const used = new Set<string>();
  const dupes: Pair[] = [];
  const clashes: Pair[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (used.has(a.f.id) || used.has(b.f.id) || apart(a.f.id, b.f.id, flags)) continue;
      // Either one of them is wrong, or they're the same: the Player's own words first.
      const [x, y] = b.f.from === 'you' && a.f.from !== 'you' ? [b.f, a.f] : [a.f, b.f];
      if (clash(a, b)) {
        if (clashes.length < MAX_PAIRS) clashes.push({ a: x, b: y });
      } else if (same(a, b)) {
        if (dupes.length < MAX_PAIRS) dupes.push({ a: x, b: y });
      } else continue;
      used.add(a.f.id);
      used.add(b.f.id);
    }
  }
  return { dupes, clashes };
}

// Two facts that say the same thing, as one: the words of `keep`, the days of both, the more
// private tier of the two. The Player chose the words, so the AI never changes them.
export function mergedFact(keep: LifeFact, drop: LifeFact, now: number, shareOf: (f: LifeFact) => LifeTier): LifeFact {
  const out: LifeFact = {
    ...keep,
    since: keep.since < drop.since ? keep.since : drop.since,
    sources: [...new Set([...keep.sources, ...drop.sources])].sort().slice(-60),
    from: 'you',
    tier: Math.max(keep.tier, drop.tier) as LifeTier,
    share: Math.max(shareOf(keep), shareOf(drop)) as LifeTier,
    at: now,
  };
  delete out.by;
  delete out.until;
  if (keep.pinned || drop.pinned) out.pinned = true;
  if (!(keep.imp && drop.imp)) delete out.imp;
  return out;
}

// The flags of the two, for the one kept: never to an AI if either was, the sooner check.
export function mergedFlags(keep: LifeFactFlag | undefined, drop: LifeFactFlag | undefined): FlagPatch | null {
  const p: FlagPatch = {};
  if (drop?.noAI && !keep?.noAI) p.noAI = true;
  if (drop?.check && (!keep?.check || drop.check < keep.check)) p.check = drop.check;
  if (drop?.ok && !keep?.ok) p.ok = true;
  return Object.keys(p).length ? p : null;
}
