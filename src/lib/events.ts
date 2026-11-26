// Your own calendar events: made in Arise (or brought in from a calendar file), with a day or a
// start and end time, a place, notes, a colour, a repeat and reminders. Synced end-to-end
// encrypted with the rest, like to-dos (lib/todos.ts): each event keeps the time it last changed
// (`at`), a deleted one stays as a tombstone (`gone`) for a while, and two copies merge per event,
// the later change winning.
//
// Times are "wall" times, the clock on the wall where the event was made ('2026-11-20T09:00'), with
// that place's time zone (`tz`), so a 9:00 meeting stays at 9:00 there when the clocks change, and
// shows at the right moment on a device in another time zone. A whole-day event has days only
// ('2026-11-20'), the same days everywhere. Repeats are worked out on the wall clock with the
// calendar-by-link parser's own rules (connect/ics.ts `expand`).
//
// One time of a repeating event is named by when it was first meant to start (its `key`, in the
// same form as `start`): `skip` leaves some out, and `changes` holds the ones changed on their own.

import { expand, instantToWall, intlZone, wallToInstant, type Offset, type Rule } from '../connect/ics';
import { cleanEventPlan, type EventPlan } from './plan-link';

export const COLORS = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'gray'] as const;
export type Color = (typeof COLORS)[number];
export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly';
export const FREQS: Freq[] = ['daily', 'weekly', 'monthly', 'yearly'];

export interface Repeat {
  freq: Freq;
  every?: number; // every 2 weeks: 2 (none: 1)
  days?: number[]; // weekly: which weekdays, 0 Sunday to 6 Saturday (none: the start's)
  until?: string; // YYYY-MM-DD, the last day it may happen on
  count?: number; // how many times in all
}

// One time of a repeat, changed on its own.
export interface Change {
  start: string;
  end?: string;
  allDay?: true;
  title?: string;
  location?: string;
  notes?: string;
}

export interface CalEvent {
  id: string;
  title: string;
  start: string; // YYYY-MM-DD for a whole day, else YYYY-MM-DDTHH:MM
  end?: string; // the same form: a whole day's last day, or the end time
  allDay?: true;
  tz?: string; // the time zone of the wall times (none: this device's)
  location?: string;
  notes?: string;
  color?: Color;
  repeat?: Repeat;
  skip?: string[];
  changes?: Record<string, Change>;
  remind?: number[]; // minutes before (0: at the time); a whole day's count from 9:00 that day
  from?: string; // the app that added it, if not the Player
  guests?: string[]; // who's invited: email addresses or names (since SCHEMA 14)
  plan?: EventPlan; // planned with someone through a private link (lib/plan-link.ts, lib/plans.ts)
  created: number;
  at: number; // when it last changed
  gone?: true;
}
export type CalEvents = Record<string, CalEvent>;

export const MAX_EVENTS = 3000;
export const TITLE_MAX = 200;
export const PLACE_MAX = 200;
export const NOTES_MAX = 2000;
export const MAX_REMIND = 5;
export const MAX_GUESTS = 30;
export const isEmail = (s: string) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s);
// Who's coming, from what was typed: commas, semicolons or new lines between them.
export const guestsFrom = (text: string) => [...new Set(text.split(/[,;\n]+/).map((s) => s.replace(/^.*<([^>]+)>.*$/, '$1').trim()).filter(Boolean))].slice(0, MAX_GUESTS);
export const REMIND_CHOICES = [0, 5, 10, 30, 60, 1440];
const MAX_SKIP = 500;
const MAX_CHANGES = 200;
const KEEP_GONE = 180 * 86_400_000;
const DAY = 86_400_000;
const MIN = 60_000;
export const ALL_DAY_REMIND_AT = 9 * 60; // whole-day reminders count from 9:00 on the day

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TZ = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
// Notes keep their lines (and nothing else of control characters).
const lines = (v: unknown, max: number) =>
  typeof v === 'string'
    ? v
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max)
    : '';

// ---------- wall times

const pad = (n: number) => String(n).padStart(2, '0');
export const isDay = (v: unknown): v is string => typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
export const isWallTime = (v: unknown): v is string => typeof v === 'string' && TIME_RE.test(v) && isDay(v.slice(0, 10));

// '2026-11-20T09:00' or '2026-11-20' as Date.UTC of its fields.
export function wallOf(s: string): number {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  const [h, min] = s.length > 10 ? s.slice(11, 16).split(':').map(Number) : [0, 0];
  return Date.UTC(y, m - 1, d, h, min);
}
export function wallText(w: number, allDay: boolean): string {
  const d = new Date(w);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return allDay ? day : `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
// The day of a moment on this device's clock.
export const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const localWall = (ms: number) => instantToWall(ms, null);
const midnight = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

export const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
};
const zone = (tz?: string): Offset | null => (tz ? intlZone(tz) : null);

// ---------- checking what comes in

function cleanRepeat(raw: unknown): Repeat | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!FREQS.includes(r.freq as Freq)) return undefined;
  const out: Repeat = { freq: r.freq as Freq };
  if (Number.isInteger(r.every) && (r.every as number) > 1 && (r.every as number) < 100) out.every = r.every as number;
  if (out.freq === 'weekly' && Array.isArray(r.days)) {
    const days = [...new Set(r.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (days.length) out.days = days;
  }
  if (isDay(r.until)) out.until = r.until;
  else if (Number.isInteger(r.count) && (r.count as number) > 0) out.count = Math.min(r.count as number, 999);
  return out;
}

// A start and an end of the same kind, the end not before the start. Null when the start isn't right.
function times(start: unknown, end: unknown, allDay: boolean): { start: string; end?: string } | null {
  if (allDay ? !isDay(start) : !isWallTime(start)) return null;
  const out: { start: string; end?: string } = { start: start as string };
  if ((allDay ? isDay(end) : isWallTime(end)) && wallOf(end as string) >= wallOf(out.start) && end !== start) out.end = end as string;
  return out;
}

function cleanChange(raw: unknown): Change | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const allDay = r.allDay === true;
  const t = times(r.start, r.end, allDay);
  if (!t) return null;
  const out: Change = { ...t };
  if (allDay) out.allDay = true;
  const title = line(r.title, TITLE_MAX);
  if (title) out.title = title;
  const location = line(r.location, PLACE_MAX);
  if (location) out.location = location;
  const notes = lines(r.notes, NOTES_MAX);
  if (notes) out.notes = notes;
  return out;
}

const isKey = (k: unknown, allDay: boolean): k is string => (allDay ? isDay(k) : isWallTime(k));

export function cleanEvent(raw: unknown): CalEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id) || !isTime(r.at)) return null;
  const created = isTime(r.created) ? r.created : r.at;
  if (r.gone === true) return { id: r.id, title: '', start: '', created, at: r.at, gone: true };
  const title = line(r.title, TITLE_MAX);
  const allDay = r.allDay === true;
  const t = times(r.start, r.end, allDay);
  if (!title || !t) return null;
  const out: CalEvent = { id: r.id, title, ...t, created, at: r.at };
  if (allDay) out.allDay = true;
  if (!allDay && typeof r.tz === 'string' && r.tz.length <= 64 && TZ.test(r.tz)) out.tz = r.tz;
  const location = line(r.location, PLACE_MAX);
  if (location) out.location = location;
  const notes = lines(r.notes, NOTES_MAX);
  if (notes) out.notes = notes;
  if (COLORS.includes(r.color as Color)) out.color = r.color as Color;
  const repeat = cleanRepeat(r.repeat);
  if (repeat) {
    out.repeat = repeat;
    if (Array.isArray(r.skip)) {
      const skip = [...new Set(r.skip.filter((k) => isKey(k, allDay)))].sort().slice(-MAX_SKIP);
      if (skip.length) out.skip = skip;
    }
    if (r.changes && typeof r.changes === 'object' && !Array.isArray(r.changes)) {
      const changes: Record<string, Change> = {};
      for (const [k, v] of Object.entries(r.changes as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-MAX_CHANGES)) {
        const c = isKey(k, allDay) ? cleanChange(v) : null;
        if (c) changes[k] = c;
      }
      if (Object.keys(changes).length) out.changes = changes;
    }
  }
  if (Array.isArray(r.remind)) {
    const remind = [...new Set(r.remind.filter((m): m is number => Number.isInteger(m) && m >= 0 && m <= 40_320))].sort((a, b) => a - b).slice(0, MAX_REMIND);
    if (remind.length) out.remind = remind;
  }
  const from = line(r.from, 40);
  if (from) out.from = from;
  if (Array.isArray(r.guests)) {
    const guests = [...new Set(r.guests.map((g) => line(g, 120)).filter(Boolean))].slice(0, MAX_GUESTS);
    if (guests.length) out.guests = guests;
  }
  const plan = cleanEventPlan(r.plan);
  if (plan) out.plan = plan;
  return out;
}

// Old tombstones go; then, past the most kept, the oldest changes go first (events and deletions
// each on their own, as with to-dos). In a fixed order (by id), so the same events save the same.
export function cleanEvents(raw: unknown, now = Date.now()): CalEvents {
  const out: CalEvent[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const e = cleanEvent(v);
      if (!e || e.id !== k) continue;
      if (e.gone && now - e.at > KEEP_GONE) continue;
      out.push(e);
    }
  }
  const newest = (list: CalEvent[]) => list.sort((a, b) => b.at - a.at).slice(0, MAX_EVENTS);
  const kept = [...newest(out.filter((e) => !e.gone)), ...newest(out.filter((e) => e.gone))];
  kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.fromEntries(kept.map((e) => [e.id, e]));
}

// Each event from whichever copy changed it last (a deletion is a change too).
export function mergeEvents(a: CalEvents, b: CalEvents, now = Date.now()): CalEvents {
  const out: CalEvents = { ...a };
  for (const [id, e] of Object.entries(b)) if (!out[id] || e.at > out[id].at) out[id] = e;
  return cleanEvents(out, now);
}

export const liveEvents = (events: CalEvents) => Object.values(events).filter((e) => !e.gone);

// ---------- the times an event happens

export interface Occurrence {
  id: string; // the event's
  key: string; // which time of it (its first-meant start)
  start: number; // moments
  end: number;
  allDay: boolean;
  day: string; // the day it starts on, on this device
  lastDay: string; // the day it ends on (the same for most)
  title: string;
  location?: string;
  notes?: string;
  color: Color;
  remind: number[];
  repeats: boolean;
  changed: boolean;
  from?: string;
}

function ruleOf(r: Repeat): Rule {
  return {
    freq: r.freq.toUpperCase() as Rule['freq'],
    interval: r.every || 1,
    count: r.count || 0,
    until: null,
    byDay: r.freq === 'weekly' && r.days?.length ? r.days.map((wd) => ({ n: 0, wd })) : [],
    byMonthDay: [],
    byMonth: [],
    bySetPos: [],
    wkst: 1,
  };
}
const untilWall = (r: Repeat) => (r.until ? wallOf(r.until) + DAY - 1 : null);

// The moments of a wall start and end.
function span(start: string, end: string | undefined, allDay: boolean, off: Offset | null): [number, number] {
  if (allDay) {
    const s = midnight(start);
    const last = end && end > start ? end : start;
    return [s, midnight(wallText(wallOf(last) + DAY, true))];
  }
  const s = wallToInstant(wallOf(start), off);
  const e = end ? wallToInstant(wallOf(end), off) : s;
  return [s, Math.max(s, e)];
}

function occurrence(e: CalEvent, key: string, start: string, end: string | undefined, allDay: boolean, change?: Change): Occurrence {
  const [s, en] = span(start, end, allDay, allDay ? null : zone(e.tz));
  const out: Occurrence = {
    id: e.id,
    key,
    start: s,
    end: en,
    allDay,
    day: localDay(s),
    lastDay: localDay(allDay ? en - 1 : Math.max(s, en - 1)),
    title: change?.title || e.title,
    color: e.color || 'blue',
    remind: e.remind || [],
    repeats: !!e.repeat,
    changed: !!change,
  };
  const location = change ? change.location : e.location;
  const notes = change ? change.notes : e.notes;
  if (location) out.location = location;
  if (notes) out.notes = notes;
  if (e.from) out.from = e.from;
  return out;
}

// Is `key` one of the times this repeat gives?
export function isTimeOf(e: CalEvent, key: string): boolean {
  if (!e.repeat) return key === e.start;
  const allDay = !!e.allDay;
  if (!isKey(key, allDay)) return false;
  const w = wallOf(key);
  return expand(ruleOf(e.repeat), wallOf(e.start), w, w, untilWall(e.repeat), 1).includes(w);
}

const MAX_PER_EVENT = 1500;

// Every time of these events that overlaps from..to (moments), soonest first.
export function occurrences(events: CalEvents, from: number, to: number): Occurrence[] {
  const out: Occurrence[] = [];
  const overlaps = (o: Occurrence) => (o.end > o.start ? o.start < to && o.end > from : o.start >= from && o.start < to);
  for (const e of liveEvents(events)) {
    const allDay = !!e.allDay;
    const s0 = wallOf(e.start);
    const len = e.end ? wallOf(e.end) - s0 : 0;
    if (!e.repeat) {
      const o = occurrence(e, e.start, e.start, e.end, allDay);
      if (overlaps(o)) out.push(o);
      continue;
    }
    const off = allDay ? null : zone(e.tz);
    // The window on the event's own wall clock, wide enough for any time zone and for its length.
    const fromWall = (allDay ? localWall(from) : instantToWall(from, off)) - len - 2 * DAY;
    const toWall = (allDay ? localWall(to) : instantToWall(to, off)) + 2 * DAY;
    const skip = new Set(e.skip || []);
    const changes = e.changes || {};
    for (const w of expand(ruleOf(e.repeat), s0, fromWall, toWall, untilWall(e.repeat), MAX_PER_EVENT)) {
      const key = wallText(w, allDay);
      if (skip.has(key) || changes[key]) continue;
      const o = occurrence(e, key, key, len ? wallText(w + len, allDay) : undefined, allDay);
      if (overlaps(o)) out.push(o);
    }
    // Times changed on their own may have moved anywhere.
    for (const [key, c] of Object.entries(changes)) {
      if (skip.has(key) || !isTimeOf(e, key)) continue;
      const o = occurrence(e, key, c.start, c.end, !!c.allDay, c);
      if (overlaps(o)) out.push(o);
    }
  }
  return out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title));
}

// The times on a day (YYYY-MM-DD, this device's clock), whole-day ones first.
export function onDay(events: CalEvents, day: string): Occurrence[] {
  const from = midnight(day);
  const to = midnight(wallText(wallOf(day) + DAY, true));
  return occurrences(events, from, to).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
}

// The first time of an event at or after a moment (for "what's next"), or null.
export function nextTime(e: CalEvent, after: number): Occurrence | null {
  return occurrences({ [e.id]: e }, after, after + 800 * DAY)[0] || null;
}

// ---------- reminders

export interface Reminder {
  id: string;
  key: string;
  min: number;
  at: number; // when to remind
  title: string;
  start: number;
  allDay: boolean;
  location?: string;
  tag: string; // one per reminder, the same every time it's planned
}

// Reminders due after `now` and up to `until` (moments), soonest first.
export function reminders(events: CalEvents, now: number, until: number): Reminder[] {
  const live = liveEvents(events).filter((e) => e.remind?.length);
  if (!live.length) return [];
  const most = Math.max(...live.flatMap((e) => e.remind!));
  const out: Reminder[] = [];
  const pool = Object.fromEntries(live.map((e) => [e.id, e]));
  for (const o of occurrences(pool, now - DAY, until + most * MIN + DAY)) {
    for (const min of o.remind) {
      // A whole day's: 9:00 on the day, or that long before on the clock (one day: 9:00 the day
      // before, even when the clocks change that night).
      const at = o.allDay ? new Date(o.start).setHours(0, ALL_DAY_REMIND_AT - min, 0, 0) : o.start - min * MIN;
      if (at <= now || at > until) continue;
      const r: Reminder = { id: o.id, key: o.key, min, at, title: o.title, start: o.start, allDay: o.allDay, tag: `ev-${o.id}-${o.key}-${min}` };
      if (o.location) r.location = o.location;
      out.push(r);
    }
  }
  return out.sort((a, b) => a.at - b.at || a.tag.localeCompare(b.tag));
}

// What a reminder says. Plain on the lock screen unless the Player turned on details.
export function reminderText(r: Reminder, details: boolean): { title: string; body: string } {
  if (!details) return { title: 'Something in your calendar', body: 'Open Arise to see it.' };
  const clock = (ms: number) => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const sameDay = localDay(r.at) === localDay(r.start);
  const dayText = new Date(r.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  let when: string;
  if (r.allDay) when = sameDay ? 'All day today' : `All day on ${dayText}`;
  else if (r.min === 0) when = `Now, at ${clock(r.start)}`;
  else when = sameDay ? `At ${clock(r.start)}` : `On ${dayText} at ${clock(r.start)}`;
  return { title: r.title, body: `${when}${r.location ? `, ${r.location}` : ''}.` };
}

// "10 minutes before" and the like, for the editor and the sheet.
export function remindLabel(min: number): string {
  if (min === 0) return 'At the time';
  if (min % 1440 === 0) return min === 1440 ? '1 day before' : `${min / 1440} days before`;
  if (min % 60 === 0) return min === 60 ? '1 hour before' : `${min / 60} hours before`;
  return `${min} minutes before`;
}

// "Every week on Mon, Wed" and the like.
export function repeatLabel(r: Repeat | undefined): string {
  if (!r) return '';
  const n = r.every || 1;
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq];
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (r.freq === 'weekly' && r.days?.length) s += ` on ${r.days.map((d) => new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })).join(', ')}`;
  if (r.until) s += `, until ${new Date(`${r.until}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
  else if (r.count) s += `, ${r.count} ${r.count === 1 ? 'time' : 'times'}`;
  return s;
}

// A new id for an event made here.
export const newEventId = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
