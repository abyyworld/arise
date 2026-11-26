// Look back: a day, a month or a year of the Player's life, worked out on this device with no AI.
// What happened (how many of each kind of thing, the busiest days, the places, people and sites
// that came up most) and what Arise knew about them then (the snapshot kept nearest before, with
// what changed since: fixes.ts). Nothing here leaves the device.

import type { LifeKnew } from '../lib/validate';
import { addDays, dayEnd, dayKey, dayStart } from './dates';
import { siteOf } from './diary';
import { open } from './db';
import { fromRow } from './log';
import { personName, personOf } from './signals';
import { knewDiff, knewOn, type KnewChange } from './fixes';
import type { LifeEvent, LifeKind } from './types';

export type Span = 'day' | 'month' | 'year';

// ---------- which days

const pad = (n: number) => String(n).padStart(2, '0');

// The key of the day, month or year a day is in: '2026-10-16', '2026-10', '2026'.
export const keyOf = (span: Span, day: string) => (span === 'day' ? day : span === 'month' ? day.slice(0, 7) : day.slice(0, 4));

// Its first and last days.
export function daysOf(span: Span, key: string): { first: string; last: string } {
  if (span === 'day') return { first: key, last: key };
  if (span === 'year') return { first: `${key}-01-01`, last: `${key}-12-31` };
  const [y, m] = key.split('-').map(Number);
  return { first: `${key}-01`, last: `${key}-${pad(new Date(y, m, 0).getDate())}` };
}

// Its span of time, [from, to), in local time.
export function rangeOf(span: Span, key: string): [number, number] {
  const { first, last } = daysOf(span, key);
  return [dayStart(first), dayEnd(last)];
}

// The one before or after (`n`: -1 or 1).
export function step(span: Span, key: string, n: number): string {
  if (span === 'day') return addDays(key, n);
  if (span === 'year') return String(Number(key) + n);
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// ---------- what happened

export interface Tally {
  total: number;
  kinds: [LifeKind, number][]; // the most first
  days: [string, number][]; // the busiest days, the most first
  places: [string, number][];
  people: [string, number][];
  sites: [string, number][];
  goals: string[]; // goals set then, oldest first
  milestones: string[]; // milestones reached then, oldest first
}

const TOP = 5;
const GENERIC_PLACE = /^(where you were|a place|somewhere|wi-fi)$/i;

// A place's name from an event, or '' (a point with no name, "Left somewhere").
export function placeOf(e: Pick<LifeEvent, 'kind' | 'title' | 'meta'>): string {
  if (e.kind !== 'place') return '';
  const named = ['place', 'name'].map((k) => e.meta?.[k]).find((v): v is string => typeof v === 'string' && !!v.trim());
  const name = (named || e.title.replace(/^(at|arrived at|left|visited|stayed at|wi-fi:)\s+/i, ''))
    .trim()
    .slice(0, 80);
  return !name || GENERIC_PLACE.test(name) || /^a place for /i.test(name) ? '' : name;
}

// How a person is shown: by a name when the source kept one ("Sam", not "07700 900111").
export const nameOf = (e: LifeEvent) => (typeof e.meta?.name === 'string' && e.meta.name.trim() ? e.meta.name.trim().slice(0, 60) : personName(e));
export const isName = (t: string) => /\p{L}/u.test(t) && !t.includes('@');

const bump = (m: Map<string, number>, k: string) => {
  if (k) m.set(k, (m.get(k) || 0) + 1);
};
const top = <K extends string>(m: Map<K, number>, n = TOP): [K, number][] => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);

const oldest = (xs: [number, string][]) => [...new Set([...xs].sort((a, b) => a[0] - b[0]).map(([, t]) => t).filter(Boolean))].slice(0, 20);

// Counts what's in a list of events (pure; tally() reads the log a little at a time instead).
export class Counter {
  total = 0;
  private kinds = new Map<LifeKind, number>();
  private days = new Map<string, number>();
  private places = new Map<string, number>();
  private people = new Map<string, number>();
  private names = new Map<string, string>(); // a person's key -> how they're shown
  private sites = new Map<string, number>();
  private goals: [number, string][] = [];
  private milestones: [number, string][] = [];

  add(e: LifeEvent) {
    this.total++;
    if (e.source === 'arise' && e.id.startsWith('arise:goal:')) this.goals.push([e.at, e.title.replace(/^New goal:\s*/i, '').trim()]);
    if (e.source === 'arise' && e.id.startsWith('arise:milestone:')) this.milestones.push([e.at, e.title.replace(/^Milestone reached:\s*/i, '').trim()]);
    this.kinds.set(e.kind, (this.kinds.get(e.kind) || 0) + 1);
    bump(this.days, dayKey(e.at));
    bump(this.places, placeOf(e));
    const who = personOf(e);
    if (who) {
      bump(this.people, who);
      const had = this.names.get(who);
      if (!had || (!isName(had) && isName(nameOf(e)))) this.names.set(who, nameOf(e) || who);
    }
    if (e.kind === 'visit' && (e.url || typeof e.meta?.site === 'string')) bump(this.sites, typeof e.meta?.site === 'string' && !e.url ? e.meta.site : siteOf(e));
  }

  result(): Tally {
    return {
      total: this.total,
      kinds: top(this.kinds, 30),
      days: top(this.days),
      places: top(this.places),
      people: top(this.people).map(([k, n]) => [this.names.get(k) || k, n]),
      sites: top(this.sites),
      goals: oldest(this.goals),
      milestones: oldest(this.milestones),
    };
  }
}

export function tallyOf(events: Iterable<LifeEvent>): Tally {
  const c = new Counter();
  for (const e of events) c.add(e);
  return c.result();
}

// What the log holds in [from, to), counted as it's read, so a year of browser history is never
// held in memory at once.
export async function tally(from: number, to: number): Promise<Tally> {
  const c = new Counter();
  if (!(to > from)) return c.result();
  const db = await open();
  const index = db.transaction('events').objectStore('events').index('at');
  await new Promise<void>((resolve, reject) => {
    const cur = index.openCursor(IDBKeyRange.bound(from, to, false, true));
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const x = cur.result;
      if (!x) return resolve();
      const e = fromRow(x.value);
      if (e) c.add(e);
      x.continue();
    };
  });
  return c.result();
}

// ---------- what Arise knew then

export interface KnewThen {
  knew: LifeKnew | null; // the snapshot that stood then (on or before the last day)
  first: string | null; // when Arise started keeping them (null: not yet)
  changes: KnewChange | null; // between then and now
}

// What Arise knew at the end of a day, month or year, and what changed since, from the snapshots
// (`list`) and what it knows now (`now`).
export function knewThen(list: readonly LifeKnew[], span: Span, key: string, now: readonly { id: string; text: string }[]): KnewThen {
  const { last } = daysOf(span, key);
  const { knew, first } = knewOn(list, last);
  return { knew, first, changes: knew ? knewDiff(knew.facts, now) : null };
}

// ---------- words

const KIND_WORDS: Record<LifeKind, [string, string]> = {
  search: ['search', 'searches'],
  visit: ['page visited', 'pages visited'],
  watch: ['thing watched', 'things watched'],
  listen: ['thing listened to', 'things listened to'],
  play: ['game played', 'games played'],
  place: ['place', 'places'],
  trip: ['trip', 'trips'],
  workout: ['workout', 'workouts'],
  sleep: ['sleep', 'sleeps'],
  steps: ['step count', 'step counts'],
  health: ['health reading', 'health readings'],
  event: ['calendar event', 'calendar events'],
  call: ['call', 'calls'],
  message: ['chat or message', 'chats and messages'],
  notification: ['notification', 'notifications'],
  app: ['app used', 'apps used'],
  purchase: ['purchase', 'purchases'],
  note: ['note', 'notes'],
  quest: ['quest', 'quests'],
  mood: ['mood', 'moods'],
  other: ['other thing', 'other things'],
};

// "12 calls", "1 note".
export const kindText = (kind: LifeKind, n: number) => `${n.toLocaleString()} ${KIND_WORDS[kind]?.[n === 1 ? 0 : 1] || 'things'}`;
