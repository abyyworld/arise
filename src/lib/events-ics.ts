// Your own events in and out of a calendar file (.ics, RFC 5545): read with the calendar-by-link
// parser (connect/ics.ts) into events of your own, and written back out for any calendar app.
//
// Reading keeps a repeat as a repeat when Arise's own repeats can say it (every day, week on some
// days, month or year, until a day or so many times), with its days left out and times changed on
// their own. A repeat Arise can't say (the last Friday of each month, say) comes in as its times
// from a year back to a year ahead, each on its own. A time zone the device knows stays with the
// event; one only the file describes is turned into this device's.

import { AHEAD, BACK, eventId, instantToWall, intlZone, parseDuration, parseIcs, parseRule, parseWhen, prop, props, readCalendar, unescape, wallToInstant, zoneName, zones, NotACalendar, type Comp, type Rule, type When } from '../connect/ics';
import { hash } from '../connect/sink';
import { cleanEvent, COLORS, deviceZone, localDay, localWall, wallOf, wallText, ALL_DAY_REMIND_AT, type CalEvent, type CalEvents, type Change, type Color, type Repeat } from './events';

const DAY = 86_400_000;
const MIN = 60_000;

export { NotACalendar };

// ---------- writing

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const compact = (s: string) => s.replace(/[-:]/g, ''); // 2026-11-20T09:00 -> 20261120T0900
const utcStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Lines longer than 75 bytes are folded: a line break and a space (by whole characters).
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
      size = 0;
    }
    cur += ch;
    size += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

// DTSTART and the like for a wall time of an event.
function when(name: string, e: Pick<CalEvent, 'tz'>, value: string, allDay: boolean): string {
  if (allDay) return `${name};VALUE=DATE:${compact(value)}`;
  const v = `${compact(value)}00`;
  return e.tz ? `${name};TZID=${e.tz}:${v}` : `${name}:${v}`;
}
const dayAfter = (day: string) => wallText(wallOf(day) + DAY, true);

// A reminder as a VALARM trigger. A whole day's counts from 9:00 that day; the file's from midnight.
function trigger(min: number, allDay: boolean): string {
  const after = allDay ? ALL_DAY_REMIND_AT - min : -min;
  return after < 0 ? `-PT${-after}M` : `PT${after}M`;
}

function rrule(e: CalEvent, r: Repeat): string {
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.every && r.every > 1) parts.push(`INTERVAL=${r.every}`);
  if (r.freq === 'weekly' && r.days?.length) parts.push(`BYDAY=${r.days.map((d) => WD[d]).join(',')}`);
  if (r.until) {
    if (e.allDay) parts.push(`UNTIL=${compact(r.until)}`);
    else if (e.tz) parts.push(`UNTIL=${utcStamp(wallToInstant(wallOf(r.until) + DAY - 1000, intlZone(e.tz)))}`);
    else parts.push(`UNTIL=${compact(r.until)}T235959`);
  } else if (r.count) parts.push(`COUNT=${r.count}`);
  return `RRULE:${parts.join(';')}`;
}

function details(out: string[], d: { title: string; location?: string; notes?: string }) {
  out.push(`SUMMARY:${esc(d.title)}`);
  if (d.location) out.push(`LOCATION:${esc(d.location)}`);
  if (d.notes) out.push(`DESCRIPTION:${esc(d.notes)}`);
}

function vevent(e: CalEvent, stamp: number): string[] {
  const allDay = !!e.allDay;
  const out = ['BEGIN:VEVENT', `UID:${e.id}@arise`, `DTSTAMP:${utcStamp(stamp)}`, when('DTSTART', e, e.start, allDay)];
  out.push(allDay ? when('DTEND', e, dayAfter(e.end || e.start), true) : when('DTEND', e, e.end || e.start, false));
  details(out, e);
  if (e.color) out.push(`COLOR:${e.color}`);
  if (e.repeat) {
    out.push(rrule(e, e.repeat));
    const head = allDay ? 'EXDATE;VALUE=DATE' : e.tz ? `EXDATE;TZID=${e.tz}` : 'EXDATE';
    if (e.skip?.length) out.push(`${head}:${e.skip.map((k) => (allDay ? compact(k) : `${compact(k)}00`)).join(',')}`);
  }
  for (const min of e.remind || []) out.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, `TRIGGER:${trigger(min, allDay)}`, 'END:VALARM');
  out.push('END:VEVENT');
  // Times changed on their own.
  for (const [key, c] of Object.entries(e.changes || {})) {
    const cAll = !!c.allDay;
    out.push('BEGIN:VEVENT', `UID:${e.id}@arise`, `DTSTAMP:${utcStamp(stamp)}`, when('RECURRENCE-ID', e, key, allDay), when('DTSTART', e, c.start, cAll));
    out.push(cAll ? when('DTEND', e, dayAfter(c.end || c.start), true) : when('DTEND', e, c.end || c.start, false));
    details(out, { title: c.title || e.title, location: c.location, notes: c.notes });
    out.push('END:VEVENT');
  }
  return out;
}

// Your own events (not deleted ones) as a calendar file.
export function toIcs(events: CalEvents, now = Date.now()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Arise//Calendar//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Arise'];
  const live = Object.values(events)
    .filter((e) => !e.gone)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1));
  for (const e of live) lines.push(...vevent(e, now));
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ---------- reading

export interface Imported {
  events: CalEvent[];
  name: string; // the calendar's own name, if it has one
}

// A rule Arise's own repeats can say, or null.
function ownRepeat(rule: Rule, start: When): Repeat | null {
  if (rule.bySetPos.length || (rule.byMonth.length && !(rule.freq === 'YEARLY' && rule.byMonth.length === 1 && rule.byMonth[0] === new Date(start.wall).getUTCMonth() + 1))) return null;
  const day = new Date(start.wall).getUTCDate();
  if (rule.byMonthDay.length && !(rule.byMonthDay.length === 1 && rule.byMonthDay[0] === day && rule.freq !== 'WEEKLY')) return null;
  if (rule.byDay.length && (rule.freq !== 'WEEKLY' || rule.byDay.some((d) => d.n !== 0))) return null;
  const r: Repeat = { freq: rule.freq.toLowerCase() as Repeat['freq'] };
  if (rule.interval > 1) r.every = Math.min(rule.interval, 99);
  if (rule.byDay.length) r.days = [...new Set(rule.byDay.map((d) => d.wd))].sort();
  if (rule.count) r.count = Math.min(rule.count, 999);
  return r;
}

// An id for an event read from a file: its own again for a file Arise wrote, else from its UID,
// so the same file read twice changes the events it made instead of adding them again.
const idFor = (uid: string) => /^([A-Za-z0-9_-]{1,64})@arise$/.exec(uid)?.[1] || `i${hash(uid)}`;

export function fromIcs(text: string, now = Date.now(), tzHere = deviceZone()): Imported {
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4000))) throw new NotACalendar('not a calendar');
  const root = parseIcs(text);
  const cal = root.comps.find((c) => c.type === 'VCALENDAR') || root;
  const tzs = zones(cal);
  const name = unescape(prop(cal, 'X-WR-CALNAME')?.value || '').trim().slice(0, 80);
  const vevents = cal.comps.filter((c) => c.type === 'VEVENT');
  const uidOf = (c: Comp) => (prop(c, 'UID')?.value || '').trim().slice(0, 400) || `${prop(c, 'SUMMARY')?.value || ''}|${prop(c, 'DTSTART')?.value || ''}`;
  const cancelled = (c: Comp) => /^CANCELLED$/i.test((prop(c, 'STATUS')?.value || '').trim());
  const txt = (c: Comp, n: string) => unescape(prop(c, n)?.value || '');
  const momentOf = (w: When) => (w.utc ? w.wall : wallToInstant(w.wall, w.tz ? tzs.get(w.tz) : null));

  // The frame an event's times are kept in: whole days, a named zone, or this device's clock.
  interface Frame {
    allDay: boolean;
    tz: string; // '' : this device's clock (a file's "floating" times too)
    wall(w: When): number;
  }
  const frameOf = (start: When): Frame => {
    if (start.date) return { allDay: true, tz: '', wall: (w) => (w.date ? w.wall : localWall(momentOf(w))) };
    const named = start.utc ? '' : zoneName(start.tz);
    const tz = start.utc ? tzHere : start.tz ? named || tzHere : '';
    const off = tz ? intlZone(tz) : null;
    return {
      allDay: false,
      tz,
      wall: (w) => (w.date ? w.wall : named && w.tz === start.tz && !w.utc ? w.wall : !start.utc && !start.tz && !w.utc && !w.tz ? w.wall : instantToWall(momentOf(w), off)),
    };
  };
  const endOf = (c: Comp, start: When, f: Frame): string | undefined => {
    const ep = prop(c, 'DTEND');
    const end = ep ? parseWhen(ep.value, ep.params) : null;
    let endWall: number | null = null;
    if (end && end.date === start.date) endWall = f.wall(end);
    else {
      const dur = parseDuration(prop(c, 'DURATION')?.value || '');
      if (dur !== null && dur >= 0) endWall = f.wall(start) + dur;
    }
    if (endWall === null) return undefined;
    // A whole day's end in the file is the day after; Arise keeps the last day.
    if (f.allDay) return endWall - DAY > f.wall(start) ? wallText(endWall - DAY, true) : undefined;
    return endWall > f.wall(start) ? wallText(endWall, false) : undefined;
  };
  const remindOf = (c: Comp, allDay: boolean): number[] => {
    const out: number[] = [];
    for (const a of c.comps.filter((x) => x.type === 'VALARM')) {
      const t = prop(a, 'TRIGGER');
      if (!t || (t.params.VALUE || '').toUpperCase() === 'DATE-TIME') continue;
      const d = parseDuration(t.value);
      if (d === null) continue;
      const min = allDay ? ALL_DAY_REMIND_AT - Math.round(d / MIN) : -Math.round(d / MIN);
      // (One after a timed event starts can't be said; a whole day's after 9:00 comes at 9:00.)
      if (allDay || min >= 0) out.push(Math.max(0, min));
    }
    return out;
  };
  const colorOf = (c: Comp): Color | undefined => {
    const v = (prop(c, 'COLOR')?.value || '').trim().toLowerCase();
    return COLORS.includes(v as Color) ? (v as Color) : undefined;
  };

  const overrides = new Map<string, Comp[]>();
  const masters: Comp[] = [];
  for (const c of vevents) {
    if (prop(c, 'RECURRENCE-ID')) {
      const uid = uidOf(c);
      if (!overrides.has(uid)) overrides.set(uid, []);
      overrides.get(uid)!.push(c);
    } else masters.push(c);
  }
  const withMaster = new Set(masters.map(uidOf));

  const out: CalEvent[] = [];
  const base = (c: Comp, id: string, start: When, f: Frame): Record<string, unknown> => ({
    id,
    title: txt(c, 'SUMMARY').trim() || 'Busy',
    start: wallText(f.wall(start), f.allDay),
    end: endOf(c, start, f),
    ...(f.allDay ? { allDay: true } : f.tz ? { tz: f.tz } : {}),
    location: txt(c, 'LOCATION'),
    notes: txt(c, 'DESCRIPTION'),
    color: colorOf(c),
    remind: remindOf(c, f.allDay),
    created: now,
    at: now,
  });
  let unsaid: Set<string> | null = null; // UIDs of repeats Arise can't say

  for (const c of masters) {
    const sp = prop(c, 'DTSTART');
    const start = sp ? parseWhen(sp.value, sp.params) : null;
    if (!start || cancelled(c)) continue;
    const uid = uidOf(c);
    const f = frameOf(start);
    const raw = base(c, idFor(uid), start, f);
    const rr = prop(c, 'RRULE');
    if (rr) {
      const rule = parseRule(rr.value);
      const own = rule && !props(c, 'RDATE').length ? ownRepeat(rule, start) : null;
      if (!rule || !own) {
        (unsaid ||= new Set()).add(uid);
        continue;
      }
      if (rule.until) own.until = rule.until.date ? wallText(rule.until.wall, true) : wallText(f.wall(rule.until), true);
      if (own.until) delete own.count;
      raw.repeat = own;
      const skip: string[] = [];
      for (const p of props(c, 'EXDATE')) for (const v of p.value.split(',')) {
        const w = parseWhen(v, p.params);
        if (w) skip.push(wallText(f.wall(w), f.allDay));
      }
      const changes: Record<string, Change> = {};
      for (const o of overrides.get(uid) || []) {
        const rid = prop(o, 'RECURRENCE-ID')!;
        const rw = parseWhen(rid.value, rid.params);
        const os = prop(o, 'DTSTART');
        const ow = os ? parseWhen(os.value, os.params) : null;
        if (!rw) continue;
        const key = wallText(f.wall(rw), f.allDay);
        if (cancelled(o) || !ow) {
          skip.push(key);
          continue;
        }
        const of = { ...f, allDay: ow.date };
        changes[key] = { start: wallText(f.wall(ow), ow.date), end: endOf(o, ow, of), ...(ow.date ? { allDay: true as const } : {}), title: txt(o, 'SUMMARY').trim() || undefined, location: txt(o, 'LOCATION') || undefined, notes: txt(o, 'DESCRIPTION') || undefined };
      }
      if (skip.length) raw.skip = skip;
      if (Object.keys(changes).length) raw.changes = changes;
    }
    const e = cleanEvent(raw);
    if (e) out.push(e);
  }

  // Changed times whose repeat isn't in the file: events on their own.
  for (const [uid, list] of overrides) {
    if (withMaster.has(uid)) continue;
    for (const c of list) {
      const sp = prop(c, 'DTSTART');
      const start = sp ? parseWhen(sp.value, sp.params) : null;
      if (!start || cancelled(c)) continue;
      const e = cleanEvent(base(c, `i${hash(`${uid}|${prop(c, 'RECURRENCE-ID')!.value}`)}`, start, frameOf(start)));
      if (e) out.push(e);
    }
  }

  // Repeats Arise can't say: each of their times from a year back to a year ahead.
  if (unsaid) {
    const keep = unsaid;
    const prefixes = new Map([...keep].map((uid) => [eventId('f', uid, 0).replace(/0$/, ''), uid]));
    const { events } = readCalendar(text, { id: 'f', name: name || 'Calendar' }, now);
    for (const le of events) {
      const pre = le.id.slice(0, le.id.lastIndexOf(':') + 1);
      if (!prefixes.has(pre) || le.at < now - BACK || le.at > now + AHEAD) continue;
      const allDay = le.meta?.allDay === true;
      const tz = allDay ? '' : tzHere;
      const off = tz ? intlZone(tz) : null;
      const toWall = (t: number) => wallText(allDay ? wallOf(localDay(t)) : instantToWall(t, off), allDay);
      const end = le.end && le.end > le.at ? (allDay ? toWall(le.end - 1) : toWall(le.end)) : undefined;
      const e = cleanEvent({ id: `i${hash(`${prefixes.get(pre)}|${le.at}`)}`, title: le.title, start: toWall(le.at), end, ...(allDay ? { allDay: true } : tz ? { tz } : {}), location: typeof le.meta?.location === 'string' ? le.meta.location : '', created: now, at: now });
      if (e) out.push(e);
    }
  }
  return { events: out, name };
}
