// The people who matter to the Player, as they set it in Arise: who to keep in touch with and how
// often, birthdays and other yearly dates, and who to hide for good. Kept in the main state and
// synced end-to-end encrypted with the rest. Each person is keyed like the life log keys them
// (life/signals.ts personOf: a name in small letters, a phone number's last digits, an address),
// so what the calls and messages say lines up with what was set here.
//
// Like names for places (lib/place-names.ts): each person keeps the time it last changed (`at`),
// a removed one stays as a tombstone (`gone`) for a while, and two copies merge per person, the
// later change winning.
//
// Pure: no store, no life log, no network. When they were last in touch comes in from outside
// (src/people.ts reads it from the life log on this device).

export type Often = 'week' | '2weeks' | 'month';
export const OFTEN: Often[] = ['week', '2weeks', 'month'];
export const OFTEN_DAYS: Record<Often, number> = { week: 7, '2weeks': 14, month: 30 };
export const OFTEN_TEXT: Record<Often, string> = { week: 'Every week', '2weeks': 'Every 2 weeks', month: 'Every month' };

export interface PersonDate {
  label: string; // "Birthday", "Anniversary"
  md: string; // month and day, "03-14"
}

export interface Person {
  name: string; // '' when gone
  at: number; // when it last changed
  close?: Often; // keep in touch this often
  since?: number; // when they were marked close (the count starts here when nothing else is known)
  last?: number; // when they said they were in touch ("Done")
  until?: string; // no nudge before this day (YYYY-MM-DD): "Later"
  dates?: PersonDate[];
  hidden?: true; // hidden for good
  own?: true; // added by hand in Arise (not from the life log)
  gone?: true;
}
export type People = Record<string, Person>;

export const MAX_PEOPLE = 500;
export const MAX_DATES = 5;
export const NAME_MAX = 60;
export const LABEL_MAX = 30;
const KEY_MAX = 100;
const KEEP_GONE = 180 * 86_400_000;
const DAY_MS = 86_400_000;
const MIN = 60_000;

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// A key as the life log makes one, or as Arise makes one from a name typed in.
export const isKey = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length <= KEY_MAX && k === k.trim() && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(k) && !BAD_KEYS.has(k);
export const keyFor = (name: string) => line(name, NAME_MAX).toLowerCase();

// ---------- dates in the year

const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function isMonthDay(md: unknown): md is string {
  if (typeof md !== 'string' || !/^\d{2}-\d{2}$/.test(md)) return false;
  const [m, d] = md.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= DAYS_IN[m - 1];
}
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// The day it falls on in a year: 29 February is kept on the 28th in other years.
export const onYear = (md: string, y: number) => `${y}-${md === '02-29' && !leap(y) ? '02-28' : md}`;

// The next time it comes round, from today (today counts).
export function nextDate(md: string, today: string): string {
  const y = +today.slice(0, 4);
  const k = onYear(md, y);
  return k >= today ? k : onYear(md, y + 1);
}

const utc = (k: string) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
export const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / DAY_MS);
export const addDays = (k: string, n: number) => new Date(utc(k) + n * DAY_MS).toISOString().slice(0, 10);
export const mdOf = (k: string) => k.slice(5, 10);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const mdText = (md: string) => `${+md.slice(3, 5)} ${MONTHS[+md.slice(0, 2) - 1]}`;

// "Mum's birthday", "Anniversary (Sam)".
export const dateName = (name: string, label: string) => (/^birthday$/i.test(label) ? `${name}'s birthday` : `${label} (${name})`);

// "today", "tomorrow", "in 5 days".
export const whenText = (days: number) => (days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);

// ---------- cleaning and merging

function cleanDates(raw: unknown): PersonDate[] {
  if (!Array.isArray(raw)) return [];
  const out: PersonDate[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    if (!isMonthDay(r.md)) continue;
    const label = line(r.label, LABEL_MAX) || 'Birthday';
    if (out.some((x) => x.md === r.md && x.label.toLowerCase() === label.toLowerCase())) continue;
    out.push({ label, md: r.md });
    if (out.length >= MAX_DATES) break;
  }
  return out;
}

export function cleanPerson(raw: unknown): Person | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isTime(r.at)) return null;
  if (r.gone === true) return { name: '', at: r.at, gone: true };
  const name = line(r.name, NAME_MAX);
  if (!name) return null;
  const p: Person = { name, at: r.at };
  if (typeof r.close === 'string' && (OFTEN as string[]).includes(r.close)) p.close = r.close as Often;
  if (p.close && isTime(r.since)) p.since = r.since;
  if (isTime(r.last)) p.last = r.last;
  if (p.close && isDay(r.until)) p.until = r.until;
  const dates = cleanDates(r.dates);
  if (dates.length) p.dates = dates;
  if (r.hidden === true) p.hidden = true;
  if (r.own === true) p.own = true;
  return p;
}

// Old tombstones go; then, past the most kept, the oldest changes go first (people and removals
// each on their own). In a fixed order, so the same people always save the same.
export function cleanPeople(raw: unknown, now = Date.now()): People {
  const out: [string, Person][] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!isKey(k)) continue;
      const p = cleanPerson(v);
      if (!p || (p.gone && now - p.at > KEEP_GONE)) continue;
      out.push([k, p]);
    }
  }
  const newest = (list: [string, Person][]) => list.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_PEOPLE);
  const kept = [...newest(out.filter(([, p]) => !p.gone)), ...newest(out.filter(([, p]) => p.gone))];
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(kept);
}

// Each person from whichever copy changed them last (a removal is a change too).
export function mergePeople(a: People, b: People, now = Date.now()): People {
  const out = new Map<string, Person>(Object.entries(a || {}));
  for (const [k, p] of Object.entries(b || {})) {
    const mine = out.get(k);
    if (!mine || p.at > mine.at) out.set(k, p);
  }
  return cleanPeople(Object.fromEntries(out), now);
}

export type Change = { [F in Exclude<keyof Person, 'at' | 'gone'>]?: Person[F] | null };

// Changes one person (made if new, with `name`). A new copy; null if the key isn't one or a new
// person has no name. A null in the change takes that field away.
export function setPerson(people: People, key: string, change: Change, now = Date.now()): People | null {
  if (!isKey(key)) return null;
  const old = people[key] && !people[key].gone ? people[key] : null;
  const next: Record<string, unknown> = { ...(old || {}), at: Math.max(now, (people[key]?.at || 0) + 1) };
  for (const [f, v] of Object.entries(change)) {
    if (v === null || v === undefined) delete next[f];
    else next[f] = v;
  }
  if (!line(next.name, NAME_MAX)) return null;
  if (!next.close) {
    delete next.since;
    delete next.until;
  } else if (!old?.close && !isTime(next.since)) next.since = now;
  const p = cleanPerson(next);
  if (!p) return null;
  return cleanPeople({ ...people, [key]: p }, now);
}

// Takes someone away (a tombstone, so another device can't bring them back).
export function removePerson(people: People, key: string, now = Date.now()): People {
  if (!people[key] || people[key].gone) return people;
  return cleanPeople({ ...people, [key]: { name: '', at: Math.max(now, people[key].at + 1), gone: true } }, now);
}

export const livePeople = (people: People) => Object.entries(people || {}).filter(([, p]) => !p.gone);

// ---------- keeping in touch

const keyOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The last time they were in touch: what the life log saw, or "Done" in Arise, the later.
export const lastTouch = (p: Pick<Person, 'last'> | undefined, seen: number | undefined) => Math.max(p?.last || 0, seen || 0) || 0;

// Days since they were last in touch with a close person, when it's been longer than they wanted
// and they didn't say "Later". Null otherwise.
export function overdueDays(p: Person | undefined, seen: number | undefined, now: number): number | null {
  if (!p || p.gone || p.hidden || !p.close) return null;
  const today = keyOf(now);
  if (p.until && p.until > today) return null;
  const from = Math.max(lastTouch(p, seen), p.since || 0);
  if (!from) return null;
  const days = daysBetween(keyOf(from), today);
  return days > OFTEN_DAYS[p.close] ? days : null;
}

// "5 days", "3 weeks", "2 months".
export function sinceText(days: number): string {
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  const m = Math.round(days / 30);
  return m < 24 ? `${m} months` : `${Math.round(days / 365)} years`;
}

// "Today", "Yesterday", "5 days ago".
export function agoText(t: number, now: number): string {
  if (!t) return 'Not seen yet';
  const d = daysBetween(keyOf(t), keyOf(now));
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : `${sinceText(d)} ago`;
}

// How often, from the days they were in touch over `windowDays`.
export function oftenText(days: number, windowDays = 90): string {
  if (!days) return '';
  const perWeek = (days * 7) / windowDays;
  if (perWeek >= 4.5) return 'Most days';
  if (perWeek >= 1.5) return `About ${Math.round(perWeek)} times a week`;
  if (perWeek >= 0.75) return 'About once a week';
  if (perWeek >= 0.3) return 'A few times a month';
  return 'Now and then';
}

export const nudgeText = (name: string, days: number) => `You haven't been in touch with ${name} for ${sinceText(days)}. Call or message?`;

// ---------- what the screen lists

export interface Seen {
  name: string;
  last: number; // the last time in touch
  days: number; // days in touch in the window
  calls: number; // calls and messages
  named: number; // calendar events and notes that name them
}

export interface Row {
  key: string;
  name: string;
  last: number;
  days: number;
  close?: Often;
  overdue: number | null;
  dates: PersonDate[];
  hidden: boolean;
  own: boolean;
  seen: boolean;
  score: number; // the higher, the more they might want to reach out
}

// Everyone, from what was set here and what the life log saw, the ones to reach out to first:
// close people who are overdue (longest past their time first), then close people, then those
// usually in touch who have gone quietest.
export function rows(people: People, seen: ReadonlyMap<string, Seen>, now: number, windowDays = 90): Row[] {
  const out: Row[] = [];
  const keys = new Set<string>([...livePeople(people).map(([k]) => k), ...seen.keys()]);
  const today = keyOf(now);
  for (const key of keys) {
    const p = people[key] && !people[key].gone ? people[key] : undefined;
    const s = seen.get(key);
    const name = p?.name || s?.name || '';
    if (!name) continue;
    const last = lastTouch(p, s?.last);
    const overdue = overdueDays(p, s?.last, now);
    const quiet = last ? daysBetween(keyOf(last), today) : windowDays;
    const gap = s?.days ? windowDays / s.days : windowDays;
    let score = quiet / Math.max(1, gap);
    if (p?.close) score = 100 + (overdue != null ? 1000 + overdue / OFTEN_DAYS[p.close] : quiet / OFTEN_DAYS[p.close]);
    out.push({ key, name, last, days: s?.days || 0, ...(p?.close ? { close: p.close } : {}), overdue, dates: p?.dates || [], hidden: !!p?.hidden, own: !!p?.own, seen: !!s, score });
  }
  return out.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
}

// ---------- birthdays and dates

export interface Coming {
  key: string;
  name: string;
  label: string;
  md: string;
  day: string; // its next day, YYYY-MM-DD
  in: number; // days from today
}

// The dates coming up, soonest first, within `within` days.
export function coming(people: People, today: string, within = 366): Coming[] {
  const out: Coming[] = [];
  for (const [key, p] of livePeople(people)) {
    if (p.hidden) continue;
    for (const d of p.dates || []) {
      const day = nextDate(d.md, today);
      const n = daysBetween(today, day);
      if (n <= within) out.push({ key, name: p.name, label: d.label, md: d.md, day, in: n });
    }
  }
  return out.sort((a, b) => a.in - b.in || (a.name < b.name ? -1 : 1));
}

// A calendar event's title that names someone's birthday: "Mum's birthday", "Birthday: Sam",
// "Sam Birthday". The name, or ''.
export function birthdayIn(title: string): string {
  const t = line(title, 120).replace(/[!🎂🎉🎁]+/gu, '').trim();
  const m = /^(.+?)(?:['’]s?)?(?:\s+\d{1,3}(?:st|nd|rd|th))?\s+(?:birthday|bday|b-day)$/i.exec(t) || /^(?:birthday|bday|b-day)\s*(?:[:\-–]|\s+of\s)\s*(.+)$/i.exec(t);
  const name = line(m?.[1] || '', NAME_MAX);
  return name && !/^(my|your|a|the|happy|our|his|her|their)$/i.test(name) ? name : '';
}

export interface DateRules {
  quietFrom: string; // HH:MM
  quietTo: string;
  details: boolean; // what it's about may show on the lock screen
}

export interface DateNudge {
  at: number;
  title: string;
  body: string;
  tag: string;
}

const mins = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
function quiet(m: number, r: DateRules) {
  const a = mins(r.quietFrom);
  const b = mins(r.quietTo);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

// Reminders for the dates: the evening before (18:00) and on the day (09:00), never in the quiet
// hours (the day's one moves to just after they end; the evening's to an hour before they start).
// From `now` for `days` days. Plain words on the lock screen unless details are on.
export function dateNudges(people: People, { now, days, rules, midnight }: { now: number; days: number; rules: DateRules; midnight: (day: string) => number }): DateNudge[] {
  const today = keyOf(now);
  const end = now + days * DAY_MS;
  const out: DateNudge[] = [];
  const at = (day: string, m: number) => midnight(day) + m * MIN;
  const onDay = Math.max(9 * 60, quiet(9 * 60, rules) ? mins(rules.quietTo) + 30 : 0);
  const evening = quiet(18 * 60, rules) ? Math.max(12 * 60, mins(rules.quietFrom) - 60) : 18 * 60;
  for (const c of coming(people, today, days + 1)) {
    const what = dateName(c.name, c.label);
    const plain = { body: 'Open Arise to see it.' };
    const the = [
      { at: at(addDays(c.day, -1), evening), title: rules.details ? `${what} is tomorrow` : 'A date coming up', body: rules.details ? 'A good time to plan a message or a call.' : plain.body, tag: `date-${c.key}-${c.md}-${c.day}-before` },
      { at: at(c.day, onDay), title: rules.details ? `${what} is today` : 'A date today', body: rules.details ? 'Send a message or call?' : plain.body, tag: `date-${c.key}-${c.md}-${c.day}-on` },
    ];
    for (const n of the) if (n.at > now && n.at <= end) out.push(n);
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------- for the coach (names and dates only)

export function coachText(people: People, today: string, compact = false): string {
  const close = livePeople(people)
    .filter(([, p]) => p.close && !p.hidden)
    .map(([, p]) => p.name)
    .sort()
    .slice(0, compact ? 8 : 20);
  const soon = coming(people, today, 45).slice(0, compact ? 4 : 10);
  if (!close.length && !soon.length) return '';
  const out = ['## People they keep in touch with (set by them in Arise)'];
  if (close.length) out.push(`Close people they want to keep in touch with: ${close.join(', ')}.`);
  for (const c of soon) out.push(`- ${dateName(c.name, c.label)}: ${mdText(c.md)} (${whenText(c.in)}, ${c.day})`);
  return out.join('\n');
}
