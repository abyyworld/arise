// People (lib/people.ts), gathered on this device: who the Player set as close, their dates, and
// when they were last in touch from the life log (life/people-seen.ts: calls, messages, calendar
// events and notes that name them), read now and then and kept in memory. Birthdays in calendars
// are picked up to add. Reminders for the dates go to the phone's own reminders (native.js) and,
// on the web while open, todo-alerts.js; never to the reminders server. The coach gets the close
// people and the dates coming up (names and dates only) when its AI may read people (tier 3).

import * as S from './store';
import * as AI from './ai.js';
import * as P from './lib/people';
import * as L from './life/log';
import { seenFrom, birthdaysFrom, type FoundDate } from './life/people-seen';
import { hasLifeStore } from './life/store-port';

const MIN = 60_000;
const DAY_MS = 86_400_000;
export const WINDOW = 90; // days, for how often
const LOOK_BACK = 365; // days, for when last in touch

let seen = new Map<string, P.Seen>();
let found: FoundDate[] = [];
let readAt = 0;
let reading: Promise<void> | null = null;
const listeners: (() => void)[] = [];
export const onPeopleChange = (fn: () => void) => listeners.push(fn);

export const people = (): P.People => S.state.people || {};
const known = () => new Map(P.livePeople(people()).map(([k, p]) => [k, p.name]));

// What the life log saw, as last read.
export const seenNow = () => seen;

// Reads the life log again when older than `maxAge`. Quietly does nothing without the life log.
export async function refresh({ maxAge = 15 * MIN }: { maxAge?: number } = {}): Promise<void> {
  if (!hasLifeStore() || Date.now() - readAt < maxAge) return;
  if (reading) return reading;
  reading = (async () => {
    const now = Date.now();
    try {
      const talk = await L.eventsBetween(now - LOOK_BACK * DAY_MS, now + MIN, { kinds: ['call', 'message'], limit: 50000, newest: true });
      const other = await L.eventsBetween(now - WINDOW * DAY_MS, now + MIN, { kinds: ['event', 'note'], limit: 10000, newest: true });
      seen = seenFrom(talk, other, known(), now, WINDOW);
      const cal = await L.eventsBetween(now - 366 * DAY_MS, now + 366 * DAY_MS, { kinds: ['event'], limit: 20000 });
      found = birthdaysFrom(cal);
      readAt = Date.now();
    } catch {}
    listeners.forEach((fn) => fn());
  })().finally(() => (reading = null));
  return reading;
}

// ---------- what the screens use

export const rows = (now = Date.now()) => P.rows(people(), seen, now, WINDOW);
export const shown = (now = Date.now()) => rows(now).filter((r) => !r.hidden);
export const hiddenRows = (now = Date.now()) => rows(now).filter((r) => r.hidden);
export const coming = (within = 366) => P.coming(people(), S.todayKey(), within);

// Close people past their time, the longest first.
export function overdue(now = Date.now()) {
  return rows(now)
    .filter((r) => r.overdue != null && !r.hidden)
    .sort((a, b) => b.overdue! / P.OFTEN_DAYS[b.close!] - a.overdue! / P.OFTEN_DAYS[a.close!]);
}

// Birthdays in calendars (the life log's, and your own events) not yet kept with that person.
export function foundDates(now = Date.now()): FoundDate[] {
  const out = new Map<string, FoundDate>();
  for (const f of found) out.set(f.key, f);
  for (const o of S.eventsBetween(now - DAY_MS, now + 366 * DAY_MS)) {
    const name = P.birthdayIn(o.title);
    const key = name && P.keyFor(name);
    if (key && !out.has(key)) out.set(key, { key, name, md: P.mdOf(o.day) });
  }
  const ps = people();
  return [...out.values()].filter((f) => {
    const p = ps[f.key];
    return !(p && !p.gone && (p.hidden || (p.dates || []).some((d) => d.md === f.md)));
  });
}

// ---------- changes (each saved and synced)

function change(key: string, c: P.Change): boolean {
  const ps = people();
  const name = ps[key] && !ps[key].gone ? ps[key].name : seen.get(key)?.name || c.name;
  const next = P.setPerson(ps, key, { name, ...c });
  if (!next) return false;
  S.state.people = next;
  S.save();
  return true;
}

export const nameOf = (key: string) => (people()[key] && !people()[key].gone ? people()[key].name : seen.get(key)?.name || '');

export const setClose = (key: string, often: P.Often | null) => change(key, { close: often, ...(often ? {} : { until: null }) });
export const hide = (key: string) => change(key, { hidden: true, close: null });
export const unhide = (key: string) => change(key, { hidden: null });
// "Done": in touch today.
export const touched = (key: string, now = Date.now()) => change(key, { last: now, until: null });
// "Later": not before a week from today.
export const later = (key: string, days = 7) => change(key, { until: S.addDays(S.todayKey(), days) });

export function addDate(key: string, label: string, md: string): boolean {
  if (!P.isMonthDay(md)) return false;
  const p = people()[key];
  const dates = [...(p && !p.gone ? p.dates || [] : []), { label: label.trim() || 'Birthday', md }];
  return change(key, { dates });
}
export function removeDate(key: string, i: number): boolean {
  const p = people()[key];
  if (!p || p.gone || !p.dates?.[i]) return false;
  const dates = p.dates.filter((_, j) => j !== i);
  return change(key, { dates: dates.length ? dates : null });
}

// Someone added by hand: by name. Their key, or '' if no name.
export function addPerson(name: string, extra: P.Change = {}): string {
  const key = P.keyFor(name);
  if (!key || !P.isKey(key)) return '';
  const ps = people();
  const exists = (ps[key] && !ps[key].gone) || seen.has(key);
  const ok = change(key, { ...(exists ? {} : { name: name.trim(), own: true }), ...extra });
  return ok ? key : '';
}

// Takes away someone added by hand.
export function remove(key: string): boolean {
  const ps = people();
  if (!ps[key] || ps[key].gone) return false;
  S.state.people = P.removePerson(ps, key);
  S.save();
  return true;
}

// ---------- reminders and the coach

// Reminders for the dates, from `now` for `days` days: the evening before and on the day.
export function nudges(now = Date.now(), days = 3): P.DateNudge[] {
  const st = S.state.settings;
  return P.dateNudges(people(), { now, days, rules: { quietFrom: st.quietFrom, quietTo: st.quietTo, details: !!st.notifyDetails }, midnight: (day) => S.parseKey(day).getTime() });
}

// For the coach: close people and the dates coming up, only when this AI may read people.
export function contextFor(cap: number, compact = false): { text: string; tier: number } {
  if (cap < 3) return { text: '', tier: 1 };
  const text = P.coachText(people(), S.todayKey(), compact);
  return { text, tier: text ? 3 : 1 };
}

let started = false;
export function initPeople() {
  if (started) return;
  started = true;
  AI.usePeople((cap: number, compact: boolean) => contextFor(cap, compact));
  setTimeout(() => void refresh({ maxAge: 0 }), 5000);
  L.onChange(() => void refresh({ maxAge: 5 * MIN }));
}
