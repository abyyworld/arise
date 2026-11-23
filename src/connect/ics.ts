// Calendars by link (ICS, also called webcal): the iCalendar text a calendar app gives out at a
// private address (RFC 5545), read into life events like the other calendars.
//
// What it understands: events (VEVENT) with a time, a time in a named time zone, or a whole day;
// time zones by their usual names (Europe/London), by the Windows names Outlook uses, or from the
// file's own VTIMEZONE; repeats (RRULE) every day, week, month or year, with INTERVAL, COUNT,
// UNTIL, BYDAY (like 2MO or -1FR), BYMONTHDAY, BYMONTH and BYSETPOS; days left out (EXDATE),
// extra days (RDATE), one day of a repeat moved or changed (RECURRENCE-ID), and cancelled events.
// Repeats every hour or minute only count their first time.
//
// Pure: no network, no storage. ics-feeds.ts fetches the text and hands the events over.

import type { LifeEvent } from '../life/types';
import { text as clip } from './http';
import { hash } from './sink';

const DAY = 86_400_000;
export const BACK = 365 * DAY; // like Google Calendar's sync (google.ts)
export const AHEAD = 400 * DAY;
export const MAX_EVENTS = 5000; // per calendar
const MAX_PER_SERIES = 2000;
const MAX_PERIODS = 20_000;

// ---------- the text

export interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}
export interface Comp {
  type: string;
  props: Prop[];
  comps: Comp[];
}

// Long lines are folded: a line break followed by a space or a tab carries on the line before.
export function unfold(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((l) => l.trim());
}

// NAME;PARAM=value;PARAM="quoted: value":the value
export function parseLine(line: string): Prop | null {
  const n = line.length;
  let i = 0;
  while (i < n && line[i] !== ';' && line[i] !== ':') i++;
  const name = line.slice(0, i).trim().toUpperCase();
  const params: Record<string, string> = {};
  while (i < n && line[i] === ';') {
    i++;
    const k0 = i;
    while (i < n && line[i] !== '=' && line[i] !== ';' && line[i] !== ':') i++;
    const key = line.slice(k0, i).trim().toUpperCase();
    let val = '';
    if (line[i] === '=') {
      i++;
      while (i < n && line[i] !== ';' && line[i] !== ':') {
        if (line[i] === '"') {
          const end = line.indexOf('"', i + 1);
          if (end < 0) return null;
          val += line.slice(i + 1, end);
          i = end + 1;
        } else val += line[i++];
      }
    }
    if (key) params[key] = val;
  }
  if (line[i] !== ':' || !name) return null;
  return { name: name.replace(/^[^.]*\./, ''), params, value: line.slice(i + 1) };
}

export function parseIcs(text: string): Comp {
  const root: Comp = { type: 'ROOT', props: [], comps: [] };
  const stack = [root];
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    const top = stack[stack.length - 1];
    if (p.name === 'BEGIN') {
      const c: Comp = { type: p.value.trim().toUpperCase(), props: [], comps: [] };
      top.comps.push(c);
      if (stack.length < 12) stack.push(c);
    } else if (p.name === 'END') {
      if (stack.length > 1 && stack[stack.length - 1].type === p.value.trim().toUpperCase()) stack.pop();
    } else top.props.push(p);
  }
  return root;
}

export const prop = (c: Comp, name: string) => c.props.find((p) => p.name === name);
export const props = (c: Comp, name: string) => c.props.filter((p) => p.name === name);

// TEXT values: \n is a new line; \, \; and \\ are themselves.
export const unescape = (v: string) => v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

// ---------- times
//
// A "wall" time is the clock on the wall in the event's own time zone, kept as if it were UTC
// (Date.UTC of its fields). Repeats are worked out on the wall clock, so a 9:00 meeting stays at
// 9:00 when the clocks change; each one is then turned into the real moment.

export interface When {
  wall: number;
  date: boolean; // a whole day, no time
  utc: boolean; // ends in Z
  tz: string; // TZID, if any
}

export function parseWhen(value: string, params: Record<string, string> = {}): When | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] || 0));
  if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const date = !m[4] || params.VALUE === 'DATE';
  const wall = date ? Date.UTC(y, mo - 1, d) : Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59));
  return { wall, date, utc: !date && !!m[7], tz: date || m[7] ? '' : (params.TZID || '').trim() };
}

// Several values in one property (EXDATE:20261101T090000,20261108T090000).
const whens = (p: Prop): When[] => p.value.split(',').map((v) => parseWhen(v, p.params)).filter((w): w is When => !!w);

// How far a zone's wall clock is ahead of UTC at a moment, in ms.
export type Offset = (instant: number) => number;

const formats = new Map<string, Intl.DateTimeFormat | null>();
export function intlZone(name: string): Offset | null {
  if (!name || name.length > 80) return null;
  let f = formats.get(name);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch {
      f = null;
    }
    formats.set(name, f);
  }
  const fmt = f;
  if (!fmt) return null;
  return (t) => {
    const at = Math.floor(t / 1000) * 1000;
    const parts: Record<string, number> = {};
    for (const p of fmt.formatToParts(new Date(at))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - at;
  };
}

// The Windows names Outlook and Exchange put in TZID, for the most used zones.
const WINDOWS: Record<string, string> = {
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Eastern Standard Time': 'America/New_York',
  'Atlantic Standard Time': 'America/Halifax',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'SA Pacific Standard Time': 'America/Bogota',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Russian Standard Time': 'Europe/Moscow',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
};

// One part of a VTIMEZONE: from its start (and then by its rule), the clock is `to` ahead of UTC.
interface Observance {
  from: number;
  to: number;
  start: number; // wall time, on the clock as it was before
  rule: Rule | null;
  extra: number[]; // RDATE, wall times
}

const offsetValue = (v: string) => {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim());
  return m ? (m[1] === '-' ? -1 : 1) * ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] || 0)) * 1000 : null;
};

function vtimezone(c: Comp): Offset | null {
  const obs: Observance[] = [];
  for (const o of c.comps) {
    if (o.type !== 'STANDARD' && o.type !== 'DAYLIGHT') continue;
    const from = offsetValue(prop(o, 'TZOFFSETFROM')?.value || '');
    const to = offsetValue(prop(o, 'TZOFFSETTO')?.value || '');
    const start = parseWhen(prop(o, 'DTSTART')?.value || '');
    if (from === null || to === null || !start) continue;
    const r = prop(o, 'RRULE');
    obs.push({ from, to, start: start.wall, rule: r ? parseRule(r.value) : null, extra: props(o, 'RDATE').flatMap(whens).map((w) => w.wall) });
  }
  if (!obs.length) return null;
  const byYear = new Map<number, { at: number; to: number }[]>();
  const changes = (y: number) => {
    let list = byYear.get(y);
    if (!list) {
      const from = Date.UTC(y, 0, 1);
      const to = Date.UTC(y + 1, 0, 1);
      list = [];
      for (const o of obs) {
        const walls = [...(o.rule ? expand(o.rule, o.start, from - DAY, to + DAY) : [o.start]), ...o.extra];
        for (const w of walls) list.push({ at: w - o.from, to: o.to });
      }
      byYear.set(y, list);
    }
    return list;
  };
  const first = [...obs].sort((a, b) => a.start - b.start)[0];
  return (t) => {
    const y = new Date(t).getUTCFullYear();
    let best = -Infinity;
    let off = first.from;
    for (const yy of [y - 1, y]) {
      for (const ch of changes(yy)) {
        if (ch.at <= t && ch.at > best) {
          best = ch.at;
          off = ch.to;
        }
      }
    }
    // Before any change in the last two years, for a zone without rules: the latest one before.
    if (best === -Infinity) {
      for (const o of obs) {
        const at = o.start - o.from;
        if (!o.rule && at <= t && at > best) {
          best = at;
          off = o.to;
        }
      }
    }
    return off;
  };
}

export interface Zones {
  get(tzid: string): Offset | null; // null: the device's own clock (floating)
}

export function zones(cal: Comp): Zones {
  const own = new Map<string, Comp>();
  for (const c of cal.comps) if (c.type === 'VTIMEZONE') {
    const id = (prop(c, 'TZID')?.value || '').trim();
    if (id) own.set(id, c);
  }
  const cache = new Map<string, Offset | null>();
  return {
    get(tzid) {
      if (!tzid) return null;
      if (cache.has(tzid)) return cache.get(tzid)!;
      const tail = tzid.replace(/^\/+/, '').split('/');
      // "/mozilla.org/20050126_1/Europe/London" and the like end with the zone's usual name.
      const names = [tzid, tail.slice(-3).join('/'), tail.slice(-2).join('/')].filter((x) => /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$|^UTC$/.test(x));
      let found: Offset | null = null;
      for (const n of names) if ((found = intlZone(n))) break;
      if (!found && own.has(tzid)) found = vtimezone(own.get(tzid)!);
      if (!found && WINDOWS[tzid]) found = intlZone(WINDOWS[tzid]);
      cache.set(tzid, found);
      return found;
    },
  };
}

// The usual name (Europe/London) a TZID stands for, when the device knows it; '' when it doesn't
// (a zone only the file's own VTIMEZONE describes). For importing a file into Arise's own events.
export function zoneName(tzid: string): string {
  if (!tzid) return '';
  const tail = tzid.replace(/^\/+/, '').split('/');
  const names = [tzid, tail.slice(-3).join('/'), tail.slice(-2).join('/'), WINDOWS[tzid] || ''].filter((x) => /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$|^UTC$/.test(x));
  return names.find((n) => intlZone(n)) || '';
}

// The real moment of a wall time, in a zone (or on this device's clock).
export function wallToInstant(wall: number, off: Offset | null): number {
  if (!off) {
    const d = new Date(wall);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime();
  }
  const a = off(wall);
  let t = wall - a;
  const b = off(t);
  if (b !== a) t = wall - b;
  return t;
}

export function instantToWall(t: number, off: Offset | null): number {
  if (!off) {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  }
  return t + off(t);
}

// ---------- repeats (RRULE)

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface Rule {
  freq: Freq;
  interval: number;
  count: number; // 0: no count
  until: When | null;
  byDay: { n: number; wd: number }[];
  byMonthDay: number[];
  byMonth: number[]; // 1-12
  bySetPos: number[];
  wkst: number;
}

const ints = (v: string | undefined, lo: number, hi: number) =>
  (v || '')
    .split(',')
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x !== 0 && Math.abs(x) >= lo && Math.abs(x) <= hi);

// The rule, or null when it repeats in a way this doesn't follow (then only the first time counts).
export function parseRule(value: string): Rule | null {
  const parts: Record<string, string> = {};
  for (const kv of value.trim().split(';')) {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) parts[k.trim().toUpperCase()] = v.trim().toUpperCase();
  }
  const freq = parts.FREQ as Freq;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  if (parts.BYWEEKNO || parts.BYYEARDAY || parts.BYHOUR || parts.BYMINUTE || parts.BYSECOND) return null;
  const byDay: Rule['byDay'] = [];
  for (const d of (parts.BYDAY || '').split(',').filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
    if (!m) return null;
    byDay.push({ n: Number(m[1] || 0), wd: WEEKDAYS.indexOf(m[2]) });
  }
  const interval = Number(parts.INTERVAL || 1);
  const count = Number(parts.COUNT || 0);
  return {
    freq,
    interval: Number.isInteger(interval) && interval > 0 && interval < 1000 ? interval : 1,
    count: Number.isInteger(count) && count > 0 ? Math.min(count, 100_000) : 0,
    until: parts.UNTIL ? parseWhen(parts.UNTIL) : null,
    byDay,
    byMonthDay: ints(parts.BYMONTHDAY, 1, 31),
    byMonth: ints(parts.BYMONTH, 1, 12).filter((x) => x > 0),
    bySetPos: ints(parts.BYSETPOS, 1, 366),
    wkst: Math.max(0, WEEKDAYS.indexOf(parts.WKST || 'MO')),
  };
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).getUTCDay();

// The days of one month a MONTHLY (or YEARLY, by month) rule picks.
function monthDays(rule: Rule, y: number, m: number, startDay: number): number[] {
  const n = daysIn(y, m);
  let days: number[] | null = null;
  if (rule.byMonthDay.length) days = rule.byMonthDay.map((d) => (d > 0 ? d : n + d + 1)).filter((d) => d >= 1 && d <= n);
  if (rule.byDay.length) {
    const picked: number[] = [];
    for (const { n: ord, wd } of rule.byDay) {
      const all: number[] = [];
      for (let d = 1; d <= n; d++) if (weekday(y, m, d) === wd) all.push(d);
      if (!ord) picked.push(...all);
      else {
        const d = ord > 0 ? all[ord - 1] : all[all.length + ord];
        if (d) picked.push(d);
      }
    }
    days = days ? days.filter((d) => picked.includes(d)) : picked;
  }
  if (!days) days = startDay <= n ? [startDay] : [];
  return [...new Set(days)].sort((a, b) => a - b);
}

// YEARLY with BYDAY and no BYMONTH: the nth weekday of the whole year.
function yearDays(rule: Rule, y: number): number[] {
  const out: number[] = [];
  const jan1 = Date.UTC(y, 0, 1);
  const len = (Date.UTC(y + 1, 0, 1) - jan1) / DAY;
  for (const { n: ord, wd } of rule.byDay) {
    const all: number[] = [];
    for (let i = 0; i < len; i++) if (new Date(jan1 + i * DAY).getUTCDay() === wd) all.push(jan1 + i * DAY);
    if (!ord) out.push(...all);
    else {
      const d = ord > 0 ? all[ord - 1] : all[all.length + ord];
      if (d !== undefined) out.push(d);
    }
  }
  return out;
}

const setPos = (list: number[], pos: number[]) => (pos.length ? [...new Set(pos.map((p) => (p > 0 ? list[p - 1] : list[list.length + p])).filter((x) => x !== undefined))].sort((a, b) => a - b) : list);

// The wall times a rule gives between `from` and `to` (wall times too), DTSTART first. COUNT counts
// from DTSTART, so times before `from` are counted but not given. `until`: a wall time.
export function expand(rule: Rule, start: number, from: number, to: number, until: number | null = null, max = MAX_PER_SERIES): number[] {
  const d0 = new Date(start);
  const [y0, m0, day0] = [d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()];
  const time = start - Date.UTC(y0, m0, day0);
  const startDate = Date.UTC(y0, m0, day0);
  const iv = rule.interval;
  const inMonth = (w: number) => !rule.byMonth.length || rule.byMonth.includes(new Date(w).getUTCMonth() + 1);
  const weekStart = startDate - ((new Date(startDate).getUTCDay() - rule.wkst + 7) % 7) * DAY;

  // Where period k begins, and its days (as wall dates at midnight).
  const begins = (k: number): number => {
    if (rule.freq === 'DAILY') return startDate + k * iv * DAY;
    if (rule.freq === 'WEEKLY') return weekStart + k * 7 * iv * DAY;
    if (rule.freq === 'MONTHLY') return Date.UTC(y0, m0 + k * iv, 1);
    return Date.UTC(y0 + k * iv, 0, 1);
  };
  const days = (k: number): number[] => {
    const b = begins(k);
    if (rule.freq === 'DAILY') {
      const d = new Date(b);
      const ok = inMonth(b) && (!rule.byDay.length || rule.byDay.some((x) => x.wd === d.getUTCDay())) && (!rule.byMonthDay.length || monthDays({ ...rule, byDay: [] }, d.getUTCFullYear(), d.getUTCMonth(), 0).includes(d.getUTCDate()));
      return ok ? [b] : [];
    }
    if (rule.freq === 'WEEKLY') {
      const wds = rule.byDay.length ? rule.byDay.map((x) => x.wd) : [new Date(startDate).getUTCDay()];
      return setPos([...new Set(wds.map((wd) => b + ((wd - rule.wkst + 7) % 7) * DAY))].sort((a, z) => a - z).filter(inMonth), rule.bySetPos);
    }
    if (rule.freq === 'MONTHLY') {
      const d = new Date(b);
      const [y, m] = [d.getUTCFullYear(), d.getUTCMonth()];
      if (rule.byMonth.length && !rule.byMonth.includes(m + 1)) return [];
      return setPos(monthDays(rule, y, m, day0).map((x) => Date.UTC(y, m, x)), rule.bySetPos);
    }
    const y = new Date(b).getUTCFullYear();
    if (!rule.byMonth.length && rule.byDay.length && !rule.byMonthDay.length) return setPos(yearDays(rule, y), rule.bySetPos);
    const months = rule.byMonth.length ? rule.byMonth.map((x) => x - 1) : [m0];
    const list = months.flatMap((m) => monthDays(rule, y, m, day0).map((x) => Date.UTC(y, m, x)));
    return setPos([...new Set(list)].sort((a, z) => a - z), rule.bySetPos);
  };

  // With no COUNT, start near `from` (nothing before it needs counting).
  let k0 = 0;
  if (!rule.count && from > start) {
    const span = rule.freq === 'DAILY' ? iv * DAY : rule.freq === 'WEEKLY' ? 7 * iv * DAY : rule.freq === 'MONTHLY' ? 28 * iv * DAY : 365 * iv * DAY;
    k0 = Math.max(0, Math.floor((from - start) / span) - 2);
  }
  const out: number[] = [];
  let given = 0;
  const take = (w: number): boolean => {
    if (until !== null && w > until) return false;
    if (rule.count && given >= rule.count) return false;
    given++;
    if (w >= from && w <= to) out.push(w);
    return out.length < max;
  };
  // DTSTART is always the first time, even when the rule wouldn't pick it.
  if (k0 === 0 && !days(0).map((x) => x + time).includes(start) && !take(start)) return out;
  for (let k = k0; k < k0 + MAX_PERIODS; k++) {
    if (begins(k) > to || (until !== null && begins(k) > until)) break;
    for (const d of days(k)) {
      const w = d + time;
      if (w < start) continue;
      if (!take(w)) return out;
    }
  }
  return out;
}

// P1D, PT1H30M, -PT15M, P2W
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m || v.trim() === 'P' || /T$/.test(v.trim())) return null;
  const ms = (((Number(m[2] || 0) * 7 + Number(m[3] || 0)) * 24 + Number(m[4] || 0)) * 60 + Number(m[5] || 0)) * 60_000 + Number(m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ---------- events

export interface FeedInfo {
  id: string; // the calendar's own short id in Arise (letters and digits)
  name: string;
}

export interface Parsed {
  events: LifeEvent[];
  name: string; // the calendar's own name (X-WR-CALNAME), if it has one
  from: number; // the window read, as moments
  to: number;
}

export class NotACalendar extends Error {}

// The id of one time of an event: the calendar, the event's UID, and when it was first meant to
// start. The last part is that moment (base 36), so ics-feeds.ts can tell which ids fall in the
// window it reads.
export const eventId = (feed: string, uid: string, at: number) => `calendar:ics:${feed}:${hash(uid)}:${at.toString(36)}`;
export function timeOfId(id: string): number {
  const n = parseInt(id.slice(id.lastIndexOf(':') + 1), 36);
  return Number.isFinite(n) ? n : 0;
}

const dayStartLocal = (wall: number) => {
  const d = new Date(wall);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
};

export function readCalendar(text: string, feed: FeedInfo, now = Date.now()): Parsed {
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4000))) throw new NotACalendar('not a calendar');
  const root = parseIcs(text);
  const cal = root.comps.find((c) => c.type === 'VCALENDAR') || root;
  const tz = zones(cal);
  const from = now - BACK;
  const to = now + AHEAD;
  const name = clip(unescape(prop(cal, 'X-WR-CALNAME')?.value || ''), 80);
  const vevents = cal.comps.filter((c) => c.type === 'VEVENT');

  const zoneOf = (w: When) => (w.date || w.utc ? null : tz.get(w.tz));
  const moment = (w: When) => (w.date ? dayStartLocal(w.wall) : w.utc ? w.wall : wallToInstant(w.wall, zoneOf(w)));
  const uidOf = (c: Comp) => clip(prop(c, 'UID')?.value || '', 400) || `${prop(c, 'SUMMARY')?.value || ''}|${prop(c, 'DTSTART')?.value || ''}`;
  const cancelled = (c: Comp) => /^CANCELLED$/i.test((prop(c, 'STATUS')?.value || '').trim());

  // Changed or moved times of a repeat, by UID and the moment they were first meant to be.
  // (`id`: the moment for the event's id; for a whole day, the day itself, so the id doesn't
  // change with the device's time zone.)
  const moved = new Map<string, Map<number, { c: Comp; id: number }>>();
  const masters: Comp[] = [];
  for (const c of vevents) {
    const rid = prop(c, 'RECURRENCE-ID');
    if (!rid) {
      masters.push(c);
      continue;
    }
    const w = parseWhen(rid.value, rid.params);
    if (!w) continue;
    const uid = uidOf(c);
    if (!moved.has(uid)) moved.set(uid, new Map());
    moved.get(uid)!.set(moment(w), { c, id: w.date ? w.wall : moment(w) });
  }

  const out = new Map<string, LifeEvent>();
  const make = (c: Comp, uid: string, at: number, end: number | null, allDay: boolean, idAt: number) => {
    if (at < from || at > to || at <= 0) return;
    const title = clip(unescape(prop(c, 'SUMMARY')?.value || ''), 200) || 'Busy';
    const place = clip(unescape(prop(c, 'LOCATION')?.value || ''), 200);
    const meta: Record<string, string | number | boolean> = { app: 'ics', calendar: feed.name, feed: feed.id };
    const e: LifeEvent = { id: eventId(feed.id, uid, idAt), source: 'calendar', kind: 'event', at, title, tier: 2, meta };
    if (end !== null && end >= at) e.end = end;
    if (place) {
      e.detail = `At ${place}`;
      meta.location = place;
    }
    if (allDay) meta.allDay = true;
    const url = (prop(c, 'URL')?.value || '').trim();
    if (/^https:\/\/[^\s"'<>`]{1,1500}$/.test(url)) e.url = url;
    out.set(e.id, e);
  };

  // How long it lasts, on the wall clock (so a whole day stays a whole day).
  const lasts = (c: Comp, start: When): number => {
    const endP = prop(c, 'DTEND');
    const end = endP ? parseWhen(endP.value, endP.params) : null;
    if (end && end.date === start.date) {
      const d = end.tz === start.tz && end.utc === start.utc ? end.wall - start.wall : moment(end) - moment(start);
      if (d >= 0) return d;
    }
    const dur = parseDuration(prop(c, 'DURATION')?.value || '');
    if (dur !== null && dur >= 0) return dur;
    return start.date ? DAY : 0;
  };
  const endOf = (wall: number, dur: number, start: When) => {
    if (!dur) return null;
    if (start.date) return dayStartLocal(wall + dur);
    return start.utc ? wall + dur : wallToInstant(wall + dur, zoneOf(start));
  };

  for (const c of masters) {
    const sp = prop(c, 'DTSTART');
    const start = sp ? parseWhen(sp.value, sp.params) : null;
    if (!start || cancelled(c)) continue;
    const uid = uidOf(c);
    const dur = lasts(c, start);
    const off = zoneOf(start);
    const toWall = (t: number) => (start.date ? Date.UTC(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()) : start.utc ? t : instantToWall(t, off));
    const fromWall = toWall(from) - 2 * DAY;
    const toWallEnd = toWall(to) + 2 * DAY;
    const rr = prop(c, 'RRULE');
    const rule = rr ? parseRule(rr.value) : null;
    let walls: number[];
    if (rule) {
      let until: number | null = null;
      if (rule.until) until = rule.until.date ? rule.until.wall + DAY - 1 : rule.until.utc ? toWall(rule.until.wall) : rule.until.wall;
      walls = expand(rule, start.wall, fromWall, toWallEnd, until);
    } else walls = [start.wall];
    for (const p of props(c, 'RDATE')) {
      if ((p.params.VALUE || '').toUpperCase() === 'PERIOD') continue;
      for (const w of whens(p)) walls.push(w.date === start.date && w.tz === start.tz && w.utc === start.utc ? w.wall : toWall(moment(w)));
    }
    const skip = new Set<number>();
    const skipDays = new Set<number>();
    for (const p of props(c, 'EXDATE')) for (const w of whens(p)) {
      skip.add(moment(w));
      if (w.date) skipDays.add(w.wall);
    }
    const changed = moved.get(uid);
    for (const wall of [...new Set(walls)].slice(0, MAX_PER_SERIES)) {
      const at = start.date ? dayStartLocal(wall) : start.utc ? wall : wallToInstant(wall, off);
      if (skip.has(at) || skipDays.has(Date.UTC(new Date(wall).getUTCFullYear(), new Date(wall).getUTCMonth(), new Date(wall).getUTCDate()))) continue;
      if (changed?.has(at)) continue; // its own VEVENT says what became of it
      make(c, uid, at, endOf(wall, dur, start), start.date, start.date ? wall : at);
    }
  }

  // The changed times themselves (a moved meeting), unless they were cancelled.
  for (const [uid, list] of moved) {
    for (const { c, id } of list.values()) {
      if (cancelled(c)) continue;
      const sp = prop(c, 'DTSTART');
      const start = sp ? parseWhen(sp.value, sp.params) : null;
      if (!start) continue;
      const at = moment(start);
      const end = endOf(start.wall, lasts(c, start), start);
      make(c, uid, at, end, start.date, id);
    }
  }

  let events = [...out.values()];
  if (events.length > MAX_EVENTS) events = events.sort((a, b) => Math.abs(a.at - now) - Math.abs(b.at - now)).slice(0, MAX_EVENTS);
  events.sort((a, b) => a.at - b.at);
  return { events, name, from, to };
}
