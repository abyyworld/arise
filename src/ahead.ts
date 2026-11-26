// What the plan, the early warnings and the next-step messages (lib/ahead.ts) are worked out from,
// gathered on this device: goals and quests, to-dos, the workout plan, your own calendar events and
// the life log's calendar events, your sleep and wake times (life/insight.ts), and who you're
// usually in touch with (calls and messages in the life log). Nothing here goes anywhere: the coach
// gets the plan as text only when it answers (ai.js useAhead), and the lock screen gets plain
// words unless details are on.

import * as S from './store';
import * as AI from './ai.js';
import * as A from './lib/ahead';
import * as PR from './lib/priorities';
import { leftOf, money } from './lib/everyday';
import * as G from './lib/goals';
import * as INS from './life/insight';
import * as L from './life/log';
import { personOf, personName } from './life/signals';
import { hasLifeStore } from './life/store-port';

const MIN = 60_000;
const DAY_MS = 86_400_000;
const HARD: ReadonlySet<string> = new Set(['learning', 'career', 'creative', 'money']);
const SEEN = 'arise-plan-seen'; // the plan as it was when the Player last looked (this device only)

// ---------- from the life log (read now and then, kept in memory)

let people: A.Person[] = [];
let logBusy: A.Busy[] = [];
// The life log's calendar events between two moments (the morning brief, src/brief.ts).
export const logEvents = (from: number, to: number) => logBusy.filter((b) => b.start >= from && b.start < to);
let readAt = 0;
let reading: Promise<void> | null = null;
const listeners: (() => void)[] = [];
export const onAheadChange = (fn: () => void) => listeners.push(fn);

const weekIdx = (t: number, now: number) => Math.floor((now - t) / (7 * DAY_MS));

// Who they talk to most weeks, and when they last did: from the calls and messages of the last 10
// weeks. A person counts when they were in touch on at least 4 of the 7 weeks before the last 3.
export function peopleFrom(events: readonly L.LifeEvent[], now: number): A.Person[] {
  const by = new Map<string, { name: string; last: number; weeks: Set<number> }>();
  for (const e of events) {
    const who = personOf(e);
    if (!who) continue;
    const p = by.get(who) || { name: '', last: 0, weeks: new Set<number>() };
    if (!p.name || e.at > p.last) p.name = personName(e) || p.name;
    p.last = Math.max(p.last, e.at);
    const w = weekIdx(e.at, now);
    if (w >= 3 && w < 10) p.weeks.add(w);
    by.set(who, p);
  }
  return [...by.entries()]
    .filter(([, p]) => p.weeks.size >= 4 && p.name)
    .map(([who, p]) => ({ who, name: p.name, last: S.keyOf(new Date(p.last)), weeks: p.weeks.size }))
    .sort((a, b) => b.weeks - a.weeks)
    .slice(0, 30);
}

// Reads them again when older than `maxAge`. Quietly does nothing in a build without the life log.
export async function refresh({ maxAge = 15 * MIN }: { maxAge?: number } = {}): Promise<void> {
  if (!hasLifeStore() || Date.now() - readAt < maxAge) return;
  if (reading) return reading;
  reading = (async () => {
    const now = Date.now();
    try {
      const talk = await L.eventsBetween(now - 70 * DAY_MS, now + MIN, { kinds: ['call', 'message'], limit: 50000 });
      people = peopleFrom(talk, now);
      const mid = S.parseKey(S.todayKey()).getTime();
      const cal = await L.eventsBetween(mid - DAY_MS, mid + 8 * DAY_MS, { kinds: ['event'], limit: 2000 });
      logBusy = cal
        .filter((e) => e.source !== 'arise' && typeof e.end === 'number' && e.end > e.at && e.end - e.at < 16 * 3600_000)
        .map((e) => ({ start: e.at, end: e.end!, title: e.title.slice(0, 80) }));
      readAt = Date.now();
    } catch {}
    listeners.forEach((fn) => fn());
  })().finally(() => (reading = null));
  return reading;
}

// ---------- the input

const minutesOf = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);
function usual(field: 'wake' | 'bedtime'): number | undefined {
  const days = (INS.peek()?.signals || []).slice(-14);
  const xs = days.map((d) => minutesOf(d[field])).filter((v): v is number => v != null);
  if (xs.length < 3) return undefined;
  xs.sort((a, b) => a - b);
  const mid = xs[Math.floor(xs.length / 2)];
  return field === 'bedtime' ? (mid < 12 * 60 ? mid + 24 * 60 : mid) : mid;
}

const atTime = (day: string, hhmm: string) => {
  const d = S.parseKey(day);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
};

// `cap`: the most private tier of the life log that may go in (life/policy.ts): calendars from the
// life log need 2, sleep and people 3. On this device's own screens, everything.
export function gather(now = Date.now(), { cap = 3 }: { cap?: number } = {}): A.AheadInput {
  const today = S.keyOf(new Date(now));
  const st = S.state;
  const tasks: A.Task[] = [];
  const weekTasks: A.Task[] = [];
  // Quests due today, not done yet.
  for (const { goal, quest, done } of S.questsFor(today)) {
    if (done) continue;
    const min = quest.amount && /^(min|mins|minutes?)$/i.test(quest.amount.unit) ? Math.max(10, Math.min(180, quest.amount.target)) : quest.amount && /^(h|hours?)$/i.test(quest.amount.unit) ? Math.min(240, quest.amount.target * 60) : 30;
    tasks.push({ id: `q:${quest.id}`, title: quest.title, min, hard: HARD.has(goal.category), weight: quest.schedule.kind === 'weekly' ? 2 : 3, why: `For ${goal.title}` });
  }
  // Weekly quests still short this week: spread over the coming days.
  for (const { goal, quest } of S.activeQuests()) {
    if (quest.schedule.kind !== 'weekly') continue;
    const left = quest.schedule.times - S.weekCount(quest.id, today);
    const sunday = S.addDays(S.mondayOf(today), 6);
    for (let i = 0; i < Math.min(left - 1, 6); i++) weekTasks.push({ id: `wq:${quest.id}:${i}`, title: quest.title, min: 30, hard: HARD.has(goal.category), weight: 2, why: `For ${goal.title}`, due: sunday });
  }
  // To-dos: with a time they're fixed; without one, today's and late ones go in the plan.
  const busy: A.Busy[] = [];
  for (const t of Object.values(st.todos)) {
    if (t.gone || t.done) continue;
    if (t.day && t.time) {
      const at = atTime(t.day, t.time);
      if (at > now - DAY_MS && at < now + 8 * DAY_MS) busy.push({ start: at, end: at + 30 * MIN, title: t.title });
    } else if (!t.day || t.day <= today) {
      tasks.push({ id: `t:${t.id}`, title: t.title, min: 30, hard: false, weight: t.day && t.day < today ? 4 : t.day ? 4 : 1, why: t.day && t.day < today ? 'Was due earlier' : t.day ? 'On your to-do list for today' : 'On your to-do list' });
    }
  }
  // Milestones coming up: work on them on the way.
  const milestones: A.Milestone[] = [];
  for (const g of S.activeGoals()) {
    const lately = (() => {
      for (let i = 0; i < 7; i++) if (g.quests.some((q) => G.isDone(st.checks, S.addDays(today, -i), q.id))) return true;
      return false;
    })();
    for (const m of g.milestones) {
      if (m.done || !m.due || m.due < today) continue;
      const left = S.daysBetween(today, m.due);
      milestones.push({ id: m.id, goal: g.title, title: m.title, due: m.due, doneLately: lately });
      const t = { id: `m:${m.id}`, title: `Work on: ${m.title}`, min: 60, hard: true, weight: 5 + Math.max(0, (14 - left) / 3), why: `${g.title}, due ${m.due === today ? 'today' : m.due}`, due: m.due };
      if (left <= 14) tasks.push(t);
      if (left > 0 && left <= 21) weekTasks.push({ ...t, id: `wm:${m.id}`, weight: t.weight - 1 });
    }
  }
  // The workout the plan asks for today.
  if (S.workoutsOn() && !S.covered(today)) {
    const w = S.plannedFor(today);
    if (w && w !== 'rest') tasks.push({ id: `w:${today}`, title: S.workoutName(w), min: 45, hard: false, weight: 3, why: 'Your workout plan' });
  }
  // Fixed times: your own events and the life log's calendars, today to a week ahead.
  const mid = S.parseKey(today).getTime();
  for (const o of S.eventsBetween(mid, mid + 8 * DAY_MS)) if (!o.allDay && o.end > o.start) busy.push({ start: o.start, end: o.end, title: o.title });
  for (const b of cap >= 2 ? logBusy : []) if (!busy.some((x) => x.start === b.start && x.title === b.title)) busy.push(b);
  const nights = cap < 3 ? [] : (INS.peek()?.signals || []).filter((d) => typeof d.sleepMin === 'number').map((d) => ({ day: d.day, min: d.sleepMin! }));
  return {
    today,
    now,
    midnight: (day) => S.parseKey(day).getTime(),
    tasks,
    weekTasks,
    busy: busy.sort((a, b) => a.start - b.start),
    milestones,
    nights,
    wake: cap < 3 ? undefined : usual('wake'),
    bed: cap < 3 ? undefined : usual('bedtime'),
    best: st.settings.bestTime,
    // People marked close have their own nudge (People), so no early warning for them too.
    people: cap < 3 ? [] : people.filter((p) => !st.people?.[p.who]?.close),
    dismissed: st.dismissed,
  };
}

// ---------- what matters, and when (lib/priorities.ts)

// To-dos not done, your own events and the life log's calendars, goals' milestones and money you
// owe, over the next 14 days.
export function priorities(now = Date.now()): PR.Grid {
  const today = S.keyOf(new Date(now));
  const st = S.state;
  const items: PR.Item[] = [];
  for (const t of Object.values(st.todos)) if (!t.gone && !t.done) items.push({ id: `t:${t.id}`, kind: 'todo', title: t.title, ...(t.day ? { day: t.day } : {}), ...(t.big ? { big: true } : {}), ...(t.time ? { note: t.time } : {}) });
  const mid = S.parseKey(today).getTime();
  for (const o of S.eventsBetween(mid, mid + (PR.HORIZON + 1) * DAY_MS)) items.push({ id: `e:${o.id}:${o.key}`, kind: 'event', title: o.title, day: S.keyOf(new Date(o.start)) });
  for (const b of logBusy) if (b.start >= mid) items.push({ id: `l:${b.title}:${b.start}`, kind: 'event', title: b.title, day: S.keyOf(new Date(b.start)) });
  for (const g of S.activeGoals()) for (const m of g.milestones) if (!m.done && m.due) items.push({ id: `m:${m.id}`, kind: 'milestone', title: m.title, day: m.due, note: `For ${g.title}` });
  for (const d of Object.values(st.debts)) if (!d.gone && !d.settled && d.dir === 'owe') items.push({ id: `d:${d.id}`, kind: 'debt', title: `Pay ${d.who} back ${money(leftOf(d), d.cur)}`, ...(d.due ? { day: d.due } : {}), ...(d.what ? { note: d.what } : {}) });
  return PR.grid(items, today);
}

// ---------- what the screens use

export interface Today {
  plan: A.DayPlan;
  warns: A.Warning[];
  changed: string[]; // since the plan they last saw today
}

type Seen = { day: string; blocks: A.Block[] };
function readSeen(): Seen | null {
  try {
    const s = JSON.parse(globalThis.localStorage?.getItem(SEEN) || 'null');
    return s && typeof s.day === 'string' && Array.isArray(s.blocks) ? s : null;
  } catch {
    return null;
  }
}
function writeSeen(s: Seen) {
  try {
    globalThis.localStorage?.setItem(SEEN, JSON.stringify(s));
  } catch {}
}

// Hooks the plan into the coach, and reads the life log's part a few seconds after the app opens
// and again now and then.
let started = false;
export function initAhead() {
  if (started) return;
  started = true;
  AI.useAhead((cap: number) => contextFor(cap));
  setTimeout(() => void refresh({ maxAge: 0 }), 4000);
  L.onChange(() => void refresh({ maxAge: 5 * MIN }));
}

export function today(now = Date.now()): Today {
  const input = gather(now);
  const plan = A.planDay(input);
  const warns = A.warnings(input);
  const seen = readSeen();
  let changed: string[] = [];
  if (!seen || seen.day !== input.today) writeSeen({ day: input.today, blocks: plan.blocks });
  else changed = A.changes(seen.blocks, plan.blocks);
  return { plan, warns, changed };
}

// They saw what changed: the plan as it is now is the one to compare with.
export function sawChanges(now = Date.now()) {
  const input = gather(now);
  writeSeen({ day: input.today, blocks: A.planDay(input).blocks });
}

export const week = (now = Date.now()) => A.planWeek(gather(now));

export const rules = (): A.NudgeRules => ({ max: S.state.settings.nudges, quietFrom: S.state.settings.quietFrom, quietTo: S.state.settings.quietTo, details: !!S.state.settings.notifyDetails });

// The next-step messages from `now` for `days` days (today first). A decision to check back on is
// one of them, on its day.
export function nudges(now = Date.now(), days = 3): A.Nudge[] {
  const r = rules();
  if (r.max <= 0) return [];
  const input = gather(now);
  const out: A.Nudge[] = [];
  for (let i = 0; i < days; i++) {
    const day = S.addDays(input.today, i);
    const mid = S.parseKey(day).getTime();
    const plan = A.planDay(input, day);
    const warns = i === 0 ? A.warnings(input) : [];
    const back = S.decisionsDue(day)
      .filter((d) => d.checkOn === day || i === 0)
      .slice(0, 1)
      .map((d) => ({ at: mid + 18 * 3600_000, title: r.details ? 'How did it go?' : 'A question from Arise', body: r.details ? `You decided: ${d.chose}. Tell Arise how it turned out.` : 'Open Arise to answer it.', tag: `decision-${d.id}` }));
    out.push(...A.nudgesFor(plan, warns, r, now, mid, back));
  }
  return out;
}

// For the coach: today's plan and the warnings, from only what this AI may read (`cap`), with the
// most private tier of the life log they were made from (a reply made from them carries it).
export function contextFor(cap: number): { text: string; tier: number } {
  try {
    const input = gather(Date.now(), { cap });
    const plan = A.planDay(input);
    const warns = A.warnings(input);
    if (!plan.blocks.length && !warns.length) return { text: '', tier: 1 };
    const fromLog = cap >= 2 && logBusy.some((b) => plan.blocks.some((x) => x.kind === 'fixed' && x.start === b.start && x.title === b.title));
    const sensitive = cap >= 3 && (warns.some((w) => w.kind !== 'deadline') || A.shortNight(input.nights, input.today) != null || input.wake != null);
    return { text: A.planText(plan, warns), tier: sensitive ? 3 : fromLog ? 2 : 1 };
  } catch {
    return { text: '', tier: 1 };
  }
}
