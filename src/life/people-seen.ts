// Who the Player was in touch with, and when, from the life log on this device: calls and messages
// with someone (signals.ts personOf), and calendar events and notes that name someone they know
// (by first name, like Your world does for goals). Birthdays in calendars ("Mum's birthday") are
// picked up too. Pure: the events come in, nothing is read or sent.

import { birthdayIn, keyFor, mdOf, type Seen } from '../lib/people';
import { personName, personOf } from './signals';
import type { LifeEvent } from './types';

const DAY_MS = 86_400_000;

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const plain = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const firstName = (name: string) => plain(name).split(/[\s@.]+/)[0] || '';
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A word match for a first name, or null when the name can't be told apart (too short, a number).
function nameRe(name: string): RegExp | null {
  const first = firstName(name);
  if (first.length < 3 || /^\+?\d/.test(first)) return null;
  return new RegExp(`(^|[^\\p{L}])${escRe(first)}([^\\p{L}]|$)`, 'u');
}

export interface FoundDate {
  key: string;
  name: string;
  md: string;
}

// `talk`: calls and messages. `other`: calendar events and notes. `known`: people set in Arise
// (key to name), whose names are looked for too. Only what happened before `now` counts, and how
// often only within `windowDays`.
export function seenFrom(talk: readonly LifeEvent[], other: readonly LifeEvent[], known: ReadonlyMap<string, string>, now: number, windowDays = 90): Map<string, Seen> {
  const from = now - windowDays * DAY_MS;
  const by = new Map<string, Seen & { dayset: Set<string> }>();
  const get = (key: string, name: string) => {
    let s = by.get(key);
    if (!s) by.set(key, (s = { name, last: 0, days: 0, calls: 0, named: 0, dayset: new Set() }));
    return s;
  };
  const touch = (s: Seen & { dayset: Set<string> }, at: number) => {
    s.last = Math.max(s.last, at);
    if (at >= from) s.dayset.add(dayKey(at));
  };
  for (const e of talk) {
    if (e.at > now) continue;
    const key = personOf(e);
    if (!key) continue;
    const s = get(key, personName(e) || known.get(key) || key);
    if (e.at >= s.last) s.name = personName(e) || s.name;
    s.calls++;
    touch(s, e.at);
  }
  // Calendar events and notes that name someone: their first name, as a word.
  const names = new Map<string, string>(known);
  for (const [k, s] of by) if (!names.has(k)) names.set(k, s.name);
  const res = [...names].map(([key, name]) => ({ key, name, re: nameRe(name) })).filter((x) => x.re);
  for (const e of other) {
    if (e.at > now || e.at < from || e.source === 'arise') continue;
    if (e.kind === 'event' && birthdayIn(e.title)) continue;
    const text = plain(`${e.title} ${e.kind === 'note' ? e.detail || '' : ''}`);
    for (const r of res) {
      if (!r.re!.test(text)) continue;
      const s = get(r.key, r.name);
      s.named++;
      touch(s, e.at);
    }
  }
  const out = new Map<string, Seen>();
  for (const [k, s] of by) out.set(k, { name: s.name, last: s.last, days: s.dayset.size, calls: s.calls, named: s.named });
  return out;
}

// Birthdays in calendar events, one a person (the latest event wins).
export function birthdaysFrom(events: readonly LifeEvent[]): FoundDate[] {
  const by = new Map<string, FoundDate & { at: number }>();
  for (const e of events) {
    if (e.kind !== 'event') continue;
    const name = birthdayIn(e.title);
    const key = name && keyFor(name);
    if (!key) continue;
    const old = by.get(key);
    // An all-day event may be kept at midnight here or at midnight in UTC: midday says which day.
    const day = dayKey(e.meta?.allDay === true ? e.at + DAY_MS / 2 : e.at);
    if (!old || e.at > old.at) by.set(key, { key, name, md: mdOf(day), at: e.at });
  }
  return [...by.values()].map(({ key, name, md }) => ({ key, name, md }));
}
