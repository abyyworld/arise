// Habits that learn: what most often came with the Player's good days over the last 8 weeks, and
// one small habit to try. Worked out on the device with no AI.
//
// A day counts when it says how it went: energy or mood in a check-in, or quests due. Each thing
// (asleep before midnight, a walk, a workout, being in touch with someone, less time on screens,
// an early start) splits those days in two, and the share of good days on each side is compared,
// for each way a day can be good (high energy, a good mood, the quests done, or any of those). The
// best way is kept for each thing, and the top two things are shown, with how many days they rest
// on. Simple counts, never proof: the words say "came with", never "made" or "because".
//
// Each finding carries the highest tier of what it was made from (src/life/types.ts), so the coach
// only gets the ones its AI may read (src/life/habits.ts).
//
// Pure: the days come from src/life/signals.ts (DaySignals has every field used here).

import type { LifeTier } from '../life/types';
import type { Schedule } from './goals';
import { addDays } from '../life/dates';
import { duration } from '../life/diary';

export const HABIT_DAYS = 56; // 8 weeks
export const MIN_CHECKINS = 14;
const MIN_YES = 5; // days with the thing
const MIN_NO = 3; // days without it
const MIN_GAP = 0.2; // the share of good days must be this much higher with it
const TOP = 2;

// One day, as signals.ts has it. A missing field is unknown.
export interface HabitDay {
  day: string;
  e?: number; // energy 1 to 5, from their check-in
  m?: number; // mood 1 to 5, from their check-in
  due?: number; // quests due that day
  done?: number;
  bedtime?: number; // minutes after this day's midnight they fell asleep (-60 is 23:00 the night before)
  wake?: number; // minutes after midnight they woke (420 is 07:00)
  steps?: number;
  trained?: boolean;
  talked?: boolean; // a call or a message with someone
  screenMin?: number;
  tier?: Partial<Record<string, LifeTier>>;
}

export type HabitId = 'sleepEarly' | 'walk' | 'workout' | 'people' | 'lessPhone' | 'early';
export type Outcome = 'energy' | 'mood' | 'quests' | 'good';
export type Sure = 'strong' | 'some' | 'early';

export interface Finding {
  id: HabitId;
  outcome: Outcome;
  text: string; // "On days you walked 8,000 steps or more, your energy was high 7 times out of 9."
  other: string; // "On other days, 3 times out of 10."
  sure: Sure;
  sureText: string; // "Fairly sure: it rests on 34 days."
  days: number; // the days it rests on
  good: number; // good days with the thing
  n: number; // days with the thing
  goodNo: number;
  nNo: number;
  score: number;
  tier: LifeTier;
  try: string; // "Try a 20 minute walk on weekdays?"
  quest: { title: string; schedule: Schedule };
}

export interface HabitResult {
  checkins: number; // days with a check-in (energy or mood) in the 8 weeks
  ready: boolean; // enough check-ins to look
  findings: Finding[]; // strongest first, at most 2, none put away
}

const rating = (v: unknown) => (typeof v === 'number' && v >= 1 && v <= 5 ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
function median(xs: readonly number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
// 420 -> "7:00", 450 -> "7:30".
const clock = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const times = (k: number, n: number) => `${k} ${k === 1 ? 'time' : 'times'} out of ${n}`;

// Whether a day was good, for each way a day can be (null: that day doesn't say).
export function outcomeOf(d: HabitDay, o: Outcome): boolean | null {
  const e = rating(d.e);
  const m = rating(d.m);
  const q = d.due && d.due > 0 ? (d.done || 0) >= d.due : null;
  if (o === 'energy') return e == null ? null : e >= 4;
  if (o === 'mood') return m == null ? null : m >= 4;
  if (o === 'quests') return q;
  if (e == null && m == null && q == null) return null;
  return (e != null && e >= 4) || (m != null && m >= 4) || q === true;
}

// A good day: high energy or a good mood in the check-in, or every quest done.
export const goodDay = (d: HabitDay) => outcomeOf(d, 'good');

export const checkinDays = (days: readonly HabitDay[]) => days.filter((d) => rating(d.e) != null || rating(d.m) != null).length;

interface Thing {
  id: HabitId;
  field: string; // its tier's key in DaySignals
  base: LifeTier; // its tier when the day doesn't say
  side: (d: HabitDay) => boolean | null;
  when: string; // "On days you walked 8,000 steps or more"
  try: string;
  quest: { title: string; schedule: Schedule };
}

const WEEKDAYS: Schedule = { kind: 'days', days: [0, 1, 2, 3, 4] };

// The things, with thresholds from the person's own days where it matters (their usual steps,
// time on screens and waking time), not a number from a book.
function things(win: readonly HabitDay[]): Thing[] {
  const out: Thing[] = [
    {
      id: 'sleepEarly',
      field: 'bedtime',
      base: 3,
      side: (d) => (num(d.bedtime) == null ? null : d.bedtime! <= 0),
      when: 'On days after you were asleep before midnight',
      try: 'Try being in bed before midnight most nights?',
      quest: { title: 'In bed before midnight', schedule: { kind: 'daily' } },
    },
  ];
  const steps = Math.max(4000, roundTo(median(win.map((d) => num(d.steps)).filter((n): n is number => n != null && n > 0)), 500));
  out.push({
    id: 'walk',
    field: 'steps',
    base: 2,
    side: (d) => (num(d.steps) == null ? null : d.steps! >= steps),
    when: `On days you walked ${steps.toLocaleString('en-GB')} steps or more`,
    try: 'Try a 20 minute walk on weekdays?',
    quest: { title: '20 minute walk', schedule: WEEKDAYS },
  });
  if (win.some((d) => d.trained)) {
    out.push({
      id: 'workout',
      field: 'trained',
      base: 1,
      side: (d) => !!d.trained,
      when: 'On days you worked out',
      try: 'Try a short workout 3 times a week?',
      quest: { title: 'Short workout', schedule: { kind: 'weekly', times: 3 } },
    });
  }
  out.push({
    id: 'people',
    field: 'people',
    base: 3,
    side: (d) => (typeof d.talked === 'boolean' ? d.talked : null),
    when: 'On days you talked with someone (a call or messages)',
    try: 'Try reaching out to one person each day?',
    quest: { title: 'Call or message someone', schedule: { kind: 'daily' } },
  });
  const screen = Math.max(60, roundTo(median(win.map((d) => num(d.screenMin)).filter((n): n is number => n != null && n > 0)), 30));
  out.push({
    id: 'lessPhone',
    field: 'screenMin',
    base: 2,
    side: (d) => (num(d.screenMin) == null || !(d.screenMin! > 0) ? null : d.screenMin! < screen),
    when: `On days with under ${duration(screen)} on screens`,
    try: 'Try a phone-free hour each evening?',
    quest: { title: 'A phone-free hour', schedule: { kind: 'daily' } },
  });
  const wakes = win.map((d) => num(d.wake)).filter((n): n is number => n != null && n > 0);
  const up = Math.min(540, Math.max(300, roundTo(median(wakes), 30)));
  if (wakes.length) {
    out.push({
      id: 'early',
      field: 'wake',
      base: 3,
      side: (d) => (num(d.wake) == null ? null : d.wake! <= up),
      when: `On days you were up by ${clock(up)}`,
      try: `Try getting up by ${clock(up)} on weekdays?`,
      quest: { title: `Up by ${clock(up)}`, schedule: WEEKDAYS },
    });
  }
  return out;
}

const SAID: Record<Outcome, string> = {
  energy: 'your energy was high',
  mood: 'your mood was good',
  quests: 'you finished your quests',
  good: 'you had a good day',
};

// How sure, from how many days it rests on and how clear the gap is.
export function sureOf(days: number, least: number, gap: number): Sure {
  if (days >= 30 && least >= 8 && gap >= 0.3) return 'strong';
  if (days >= 20 && least >= 5) return 'some';
  return 'early';
}
export function sureText(s: Sure, days: number): string {
  if (s === 'strong') return `Fairly sure: it rests on ${days} days.`;
  if (s === 'some') return `Somewhat sure: it rests on ${days} days.`;
  return `An early sign: it rests on only ${days} days.`;
}

// What came with the good days in the 8 weeks before `today` (today left out, it isn't over).
// `put`: the things put away ("Not for me", or made a quest already), never shown again.
export function findHabits(days: readonly HabitDay[], today: string, put: ReadonlySet<string> = new Set()): HabitResult {
  const from = addDays(today, -HABIT_DAYS);
  const win = days.filter((d) => d.day >= from && d.day < today);
  const checkins = checkinDays(win);
  if (checkins < MIN_CHECKINS) return { checkins, ready: false, findings: [] };
  const found: Finding[] = [];
  for (const t of things(win)) {
    if (put.has(t.id)) continue;
    let best: Finding | null = null;
    for (const o of ['energy', 'mood', 'quests', 'good'] as Outcome[]) {
      let good = 0;
      let n = 0;
      let goodNo = 0;
      let nNo = 0;
      let tier: LifeTier = 1;
      for (const d of win) {
        const g = outcomeOf(d, o);
        const s = g == null ? null : t.side(d);
        if (g == null || s == null) continue;
        if (s) {
          n++;
          if (g) good++;
        } else {
          nNo++;
          if (g) goodNo++;
        }
        const ft = d.tier?.[t.field] || t.base;
        if (ft > tier) tier = ft;
      }
      if (n < MIN_YES || nNo < MIN_NO) continue;
      const a = good / n;
      const b = goodNo / nNo;
      const gap = a - b;
      if (gap + 1e-9 < MIN_GAP || a < 0.5) continue;
      const score = gap * Math.sqrt(Math.min(n, nNo));
      if (best && best.score >= score) continue;
      const total = n + nNo;
      const sure = sureOf(total, Math.min(n, nNo), gap);
      best = {
        id: t.id,
        outcome: o,
        text: `${t.when}, ${SAID[o]} ${times(good, n)}.`,
        other: `On other days, ${times(goodNo, nNo)}.`,
        sure,
        sureText: sureText(sure, total),
        days: total,
        good,
        n,
        goodNo,
        nNo,
        score,
        tier,
        try: t.try,
        quest: t.quest,
      };
    }
    if (best) found.push(best);
  }
  found.sort((x, y) => y.score - x.score);
  return { checkins, ready: true, findings: found.slice(0, TOP) };
}

const HEAD = "## What came with the Player's good days (their own last 8 weeks, worked out on this device; what goes together, not proof)";
const LEFT_OUT = 'Some of these use parts of the life log this AI may not read, so they are left out.';

// For the coach: only the findings this AI may read (`cap`), one for a small model (`compact`).
export function habitsText(r: HabitResult | null, cap: number, compact = false): { text: string; tier: LifeTier } {
  if (!r?.findings.length) return { text: '', tier: 1 };
  const ok = r.findings.filter((f) => f.tier <= cap);
  const shown = ok.slice(0, compact ? 1 : TOP);
  if (!shown.length) return { text: `${HEAD}\n${LEFT_OUT}`, tier: 1 };
  const lines = [HEAD, ...shown.map((f) => `- ${f.text} ${f.other} (${f.days} days). Arise suggested: ${f.try}`)];
  if (ok.length < r.findings.length) lines.push(LEFT_OUT);
  return { text: lines.join('\n'), tier: shown.reduce<LifeTier>((t, f) => (f.tier > t ? f.tier : t), 1) };
}
