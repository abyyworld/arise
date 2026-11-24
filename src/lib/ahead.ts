// Looking ahead: the plan for today and the week, the early warnings, and the few next-step
// messages, all worked out on this device with no AI and no network. Pure: everything comes in
// through `AheadInput` (src/ahead.ts gathers it from the store and the life log), so the same input
// always gives the same plan.
//
// The plan fits the things worth doing today around what's already fixed (calendar events, to-dos
// with a time), hard work in the hours the Player thinks best, and plans again whenever the input
// changes: a meeting moved, a short night, something ticked off. Arise only suggests: nothing here
// changes the Player's data.

export type Best = 'morning' | 'afternoon' | 'evening';

export interface Busy {
  start: number; // moments
  end: number;
  title: string;
}

// Something worth doing, from a quest, a to-do, a milestone or the workout plan.
export interface Task {
  id: string; // stable across plans: 'q:<quest>', 't:<todo>', 'm:<milestone>', 'w:<day>'
  title: string;
  min: number; // how long, roughly
  hard: boolean; // needs a clear head (study, deep work)
  weight: number; // how much it matters today: higher first
  why: string; // in plain words, for the plan
  due?: string; // a day by which it must be done
}

export interface Milestone {
  id: string;
  goal: string; // the goal's title
  title: string;
  due: string; // YYYY-MM-DD
  doneLately: boolean; // anything for that goal ticked in the last 7 days
}

export interface Night {
  day: string; // the morning it ended
  min: number;
}

export interface Person {
  who: string; // a stable key
  name: string; // as shown
  last: string; // the last day in touch
  weeks: number; // weeks in touch, of the 7 before the last 3
}

export interface AheadInput {
  today: string; // YYYY-MM-DD
  now: number;
  midnight: (day: string) => number; // that day's local midnight
  tasks: Task[]; // for today
  weekTasks: Task[]; // what still needs doing this week (weekly quests left, milestones), not today's
  busy: Busy[]; // fixed times, today to a week ahead
  milestones: Milestone[];
  nights: Night[]; // up to 4 weeks, any order
  wake?: number; // usual wake time, minutes after midnight
  bed?: number; // usual bedtime, minutes after midnight (may be past 24 * 60)
  best?: Best | ''; // when the Player thinks best ('' or left out: worked out from their wake time)
  people: Person[];
  dismissed?: Record<string, unknown>; // warning ids the Player put away
}

export interface Block {
  start: number;
  end: number;
  title: string;
  kind: 'fixed' | 'hard' | 'light';
  why: string;
  id?: string; // the task's
}

export interface DayPlan {
  day: string;
  blocks: Block[]; // in time order: fixed ones and suggested ones
  left: Task[]; // what didn't fit
  notes: string[]; // why the day looks the way it does ("Short night: ...")
  free: number; // free minutes left after the plan
}

export interface Warning {
  id: string; // stable, so it can be put away
  kind: 'deadline' | 'sleep' | 'person';
  title: string;
  body: string;
  lock: string; // what may show on the lock screen without details
  weight: number;
}

const MIN = 60_000;
const DAY_MIN = 24 * 60;
const GAP = 10; // minutes kept free between blocks
const SHORT_BLOCK = 15;
export const SHORT_NIGHT = 6 * 60; // minutes of sleep that count as a short night

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const hours = (min: number) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
};
const addDay = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(y, m - 1, d + n, 12);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const daysFrom = (a: string, b: string) => {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
};

// ---------- sleep

// Last night, the last 7 nights and the 3 weeks before, in minutes (NaN when unknown).
export function sleepSummary(nights: readonly Night[], today: string) {
  const by = new Map(nights.map((n) => [n.day, n.min]));
  const range = (from: number, to: number) => {
    const out: number[] = [];
    for (let i = from; i < to; i++) {
      const v = by.get(addDay(today, -i));
      if (typeof v === 'number' && v > 0) out.push(v);
    }
    return out;
  };
  const week = range(0, 7);
  const before = range(7, 28);
  return { last: by.get(today) ?? NaN, week: avg(week), weekN: week.length, before: avg(before), beforeN: before.length };
}

// Last night was short: under 6 hours, or an hour under their usual.
export function shortNight(nights: readonly Night[], today: string): number | null {
  const s = sleepSummary(nights, today);
  if (!Number.isFinite(s.last)) return null;
  const usual = Number.isFinite(s.before) ? s.before : s.week;
  return s.last < SHORT_NIGHT || (Number.isFinite(usual) && s.last < usual - 60) ? s.last : null;
}

// ---------- the day

// When they think best: their pick, else the first hours after they usually wake.
export function bestWindow(input: Pick<AheadInput, 'best' | 'wake'>): { from: number; to: number; label: string } {
  const wake = input.wake ?? 7 * 60;
  const best = input.best || 'morning';
  if (best === 'afternoon') return { from: 13 * 60, to: 17 * 60, label: 'the afternoon' };
  if (best === 'evening') return { from: 18 * 60, to: 21 * 60 + 30, label: 'the evening' };
  const from = Math.max(6 * 60, Math.min(11 * 60, wake + 60));
  return { from, to: from + 4 * 60, label: 'the morning' };
}

// The free stretches of a day between `from` and `to` (moments), around the busy times.
export function freeGaps(busy: readonly Busy[], from: number, to: number): { start: number; end: number }[] {
  const taken = busy
    .filter((b) => b.end > from && b.start < to)
    .map((b) => ({ start: Math.max(from, b.start - GAP * MIN), end: Math.min(to, b.end + GAP * MIN) }))
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  let t = from;
  for (const b of taken) {
    if (b.start > t) out.push({ start: t, end: b.start });
    t = Math.max(t, b.end);
  }
  if (to > t) out.push({ start: t, end: to });
  return out.filter((g) => g.end - g.start >= SHORT_BLOCK * MIN);
}

const order = (a: Task, b: Task) => b.weight - a.weight || (a.due || '9999').localeCompare(b.due || '9999') || a.id.localeCompare(b.id);

// The plan for `day` (today: from now on). Hard tasks go first into the hours they think best,
// then anywhere; light ones fill the rest. After a short night the day is lighter and hard work
// moves to the first hours, when a tired head works best.
export function planDay(input: AheadInput, day = input.today): DayPlan {
  const mid = input.midnight(day);
  const wake = input.wake ?? 7 * 60;
  const bed = Math.min(DAY_MIN + 60, Math.max(20 * 60, input.bed ?? 23 * 60));
  const dayStart = mid + Math.max(5 * 60, wake + 30) * MIN;
  const dayEnd = mid + (bed - 60) * MIN; // the last hour before bed stays free
  const from = day === input.today ? Math.max(dayStart, Math.ceil(input.now / (5 * MIN)) * 5 * MIN) : dayStart;
  const notes: string[] = [];
  const fixed = input.busy.filter((b) => b.end > mid && b.start < mid + DAY_MIN * MIN);
  const blocks: Block[] = fixed.map((b) => ({ start: b.start, end: b.end, title: b.title, kind: 'fixed', why: 'In your calendar' }));
  const tasks = [...(day === input.today ? input.tasks : [])].sort(order);
  const short = day === input.today ? shortNight(input.nights, input.today) : null;
  let budget = Infinity;
  let win = bestWindow(input);
  if (short != null) {
    budget = 0.7 * Math.max(0, (dayEnd - from) / MIN);
    win = { from: Math.max(6 * 60, wake + 30), to: Math.max(6 * 60, wake + 30) + 3 * 60, label: 'the first hours' };
    notes.push(`Short night (${hours(short)}): the day is lighter and hard work comes first, while your head is clearest.`);
  }
  let gaps = freeGaps(fixed, from, dayEnd);
  const take = (t: Task, prefer: { from: number; to: number } | null): boolean => {
    const len = t.min * MIN;
    const tries = prefer ? [...gaps.filter((g) => overlaps(g, prefer)), ...gaps.filter((g) => !overlaps(g, prefer))] : gaps;
    for (const g of tries) {
      let start = g.start;
      if (prefer) {
        const pf = mid + prefer.from * MIN;
        if (start < pf && g.end - pf >= len) start = pf;
      }
      if (g.end - start < len) continue;
      blocks.push({ start, end: start + len, title: t.title, kind: t.hard ? 'hard' : 'light', why: t.why, id: t.id });
      gaps = gaps.flatMap((x) => (x !== g ? [x] : [{ start: x.start, end: start - GAP * MIN }, { start: start + len + GAP * MIN, end: x.end }])).filter((x) => x.end - x.start >= SHORT_BLOCK * MIN);
      gaps.sort((a, b) => a.start - b.start);
      return true;
    }
    return false;
  };
  const overlaps = (g: { start: number; end: number }, w: { from: number; to: number }) => g.start < mid + w.to * MIN && g.end > mid + w.from * MIN;
  const left: Task[] = [];
  let used = 0;
  for (const t of [...tasks.filter((x) => x.hard), ...tasks.filter((x) => !x.hard)]) {
    if (used + t.min > budget && t.weight < 3) {
      left.push(t);
      continue;
    }
    if (take(t, t.hard ? win : null)) used += t.min;
    else left.push(t);
  }
  if (left.length && short == null && tasks.length) notes.push(`${left.length === 1 ? 'One thing' : `${left.length} things`} didn't fit today. Move ${left.length === 1 ? 'it' : 'them'} to another day, or drop ${left.length === 1 ? 'it' : 'one'}.`);
  if (!tasks.length && day === input.today) notes.push('Nothing to fit in today. A free day is fine too.');
  blocks.sort((a, b) => a.start - b.start || a.end - b.end);
  const free = gaps.reduce((n, g) => n + (g.end - g.start) / MIN, 0);
  return { day, blocks, left, notes, free: Math.round(free) };
}

// What changed since the plan the Player saw earlier today: moved, added or gone, in plain words.
export function changes(before: readonly Block[], after: readonly Block[]): string[] {
  const key = (b: Block) => b.id || `f:${b.title}`;
  const was = new Map(before.filter((b) => b.kind !== 'fixed').map((b) => [key(b), b]));
  const out: string[] = [];
  for (const b of after) {
    if (b.kind === 'fixed') continue;
    const old = was.get(key(b));
    was.delete(key(b));
    if (old && Math.abs(old.start - b.start) >= 15 * MIN) out.push(`${b.title} moved from ${hhmm(old.start)} to ${hhmm(b.start)}.`);
  }
  const fixedBefore = new Set(before.filter((b) => b.kind === 'fixed').map((b) => `${b.title}@${b.start}`));
  for (const b of after) if (b.kind === 'fixed' && !fixedBefore.has(`${b.title}@${b.start}`) && before.length) out.push(`${b.title} at ${hhmm(b.start)} is new or moved in your calendar.`);
  return out.slice(0, 4);
}

// ---------- the week

export interface WeekDay {
  day: string;
  busyMin: number; // fixed time between wake and bed
  freeMin: number;
  items: { id: string; title: string; why: string }[];
}

// The next 7 days: how full each is, and where what still needs doing this week fits best (the
// freest day before it's due, at most 2 a day, not after a day that's already packed).
export function planWeek(input: AheadInput): WeekDay[] {
  const wake = input.wake ?? 7 * 60;
  const bed = Math.min(DAY_MIN + 60, Math.max(20 * 60, input.bed ?? 23 * 60));
  const days: WeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDay(input.today, i);
    const mid = input.midnight(day);
    const from = i === 0 ? Math.max(input.now, mid + wake * MIN) : mid + wake * MIN;
    const to = mid + (bed - 60) * MIN;
    const gaps = freeGaps(input.busy, from, to);
    const freeMin = Math.round(gaps.reduce((n, g) => n + (g.end - g.start) / MIN, 0));
    const busyMin = Math.round(
      input.busy.filter((b) => b.end > mid + wake * MIN && b.start < to).reduce((n, b) => n + (Math.min(to, b.end) - Math.max(mid + wake * MIN, b.start)) / MIN, 0),
    );
    days.push({ day, busyMin: Math.max(0, busyMin), freeMin, items: [] });
  }
  const load = new Map(days.map((d) => [d.day, 0]));
  for (const t of [...input.weekTasks].sort(order)) {
    const ok = days.filter((d, i) => i > 0 && (!t.due || d.day <= t.due) && (load.get(d.day) || 0) < 2 && d.freeMin - (load.get(d.day) || 0) * 60 >= t.min);
    const pick = ok.sort((a, b) => b.freeMin - (load.get(b.day) || 0) * 60 - (a.freeMin - (load.get(a.day) || 0) * 60) || a.day.localeCompare(b.day))[0];
    if (!pick) continue;
    pick.items.push({ id: t.id, title: t.title, why: t.why });
    load.set(pick.day, (load.get(pick.day) || 0) + 1);
  }
  return days;
}

// ---------- early warnings

// A deadline close with nothing done, sleep sliding, someone important gone quiet. Most important
// first; the ones the Player put away stay away.
export function warnings(input: AheadInput): Warning[] {
  const out: Warning[] = [];
  for (const m of input.milestones) {
    const left = daysFrom(input.today, m.due);
    if (left < 0 || left > 7 || m.doneLately) continue;
    const when = left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
    out.push({
      id: `deadline:${m.id}:${m.due}`,
      kind: 'deadline',
      title: `${m.title} is due ${when}`,
      body: `Nothing for ${m.goal} was ticked off in the last 7 days. One small step today keeps it in reach, or move the date if it no longer fits.`,
      lock: `A deadline is ${when === 'today' ? 'today' : 'coming up'}. Open Arise to see it.`,
      weight: 10 - left,
    });
  }
  const s = sleepSummary(input.nights, input.today);
  if (s.weekN >= 4 && s.beforeN >= 7 && s.week <= s.before - 45) {
    const exam = input.busy.find((b) => b.start >= input.now && b.start < input.now + 7 * DAY_MIN * MIN && /\b(exam|test|interview|deadline|presentation|imtihon)\b/i.test(b.title));
    out.push({
      id: `sleep:${input.today.slice(0, 8)}${Math.floor(Number(input.today.slice(8)) / 7)}`,
      kind: 'sleep',
      title: 'Your sleep is sliding',
      body: `About ${hours(s.week)} a night this week, against ${hours(s.before)} before.${exam ? ` ${exam.title} is coming up, so tonight is a good night to go to bed earlier.` : ' Going to bed 30 minutes earlier tonight is the easiest fix.'}`,
      lock: 'Something about your week. Open Arise to see it.',
      weight: exam ? 8 : 5,
    });
  }
  for (const p of input.people) {
    const quiet = daysFrom(p.last, input.today);
    if (p.weeks < 4 || quiet < 21) continue;
    out.push({
      id: `person:${p.who}:${p.last}`,
      kind: 'person',
      title: `${p.name} has gone quiet`,
      body: `You were in touch most weeks, but not for ${Math.floor(quiet / 7)} weeks now. A short message is enough.`,
      lock: 'Someone you used to talk to often. Open Arise to see who.',
      weight: 4 + Math.min(2, p.weeks - 4),
    });
  }
  const gone = input.dismissed || {};
  return out.filter((w) => !Object.hasOwn(gone, w.id)).sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

// ---------- next-step messages

export interface NudgeRules {
  max: number; // a day, 0 to 5
  quietFrom: string; // HH:MM
  quietTo: string;
  details: boolean; // what it's about may show on the lock screen
}

export interface Nudge {
  at: number;
  title: string;
  body: string;
  tag: string; // stable for the same message
}

const mins = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
// Inside the quiet hours (which may run past midnight).
export function isQuiet(t: number, rules: Pick<NudgeRules, 'quietFrom' | 'quietTo'>): boolean {
  const d = new Date(t);
  const m = d.getHours() * 60 + d.getMinutes();
  const a = mins(rules.quietFrom);
  const b = mins(rules.quietTo);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

const SPACING = 90 * MIN;

// A day's messages: a warning first, a little after the quiet hours end, then a heads-up 10
// minutes before the hard blocks, most important first, never in the quiet hours, at least 90
// minutes apart, and no more than `max`. Plain words on the lock screen unless details are on.
export function nudgesFor(plan: DayPlan, warns: readonly Warning[], rules: NudgeRules, now: number, midnight: number, extra: readonly Nudge[] = []): Nudge[] {
  if (rules.max <= 0) return [];
  const cands: (Nudge & { w: number })[] = [];
  const morning = midnight + (mins(rules.quietTo) + 30) * MIN;
  const top = warns[0];
  if (top) cands.push({ at: morning, title: rules.details ? top.title : 'Arise noticed something', body: rules.details ? top.body : top.lock, tag: `warn-${top.id}`, w: 100 + top.weight });
  for (const n of extra) cands.push({ ...n, w: 90 });
  for (const b of plan.blocks) {
    if (b.kind === 'fixed') continue;
    const w = b.kind === 'hard' ? 50 : 20;
    cands.push({
      at: b.start - 10 * MIN,
      title: rules.details ? `Next: ${b.title}` : 'Your next step',
      body: rules.details ? `At ${hhmm(b.start)}, ${hours((b.end - b.start) / MIN)}. ${b.why}` : 'Open Arise to see what your plan has next.',
      tag: `plan-${plan.day}-${b.id || b.title}`,
      w: w - (b.start - midnight) / (DAY_MIN * MIN),
    });
  }
  const chosen: Nudge[] = [];
  for (const c of cands.sort((a, b) => b.w - a.w)) {
    if (chosen.length >= rules.max) break;
    if (c.at <= now || c.at < midnight || c.at >= midnight + DAY_MIN * MIN) continue;
    if (isQuiet(c.at, rules)) continue;
    if (chosen.some((x) => Math.abs(x.at - c.at) < SPACING)) continue;
    chosen.push({ at: c.at, title: c.title, body: c.body, tag: c.tag });
  }
  return chosen.sort((a, b) => a.at - b.at);
}

// The plan as a few lines, for the coach.
export function planText(plan: DayPlan, warns: readonly Warning[]): string {
  const lines = plan.blocks.map((b) => `- ${hhmm(b.start)} to ${hhmm(b.end)}: ${b.title}${b.kind === 'fixed' ? ' (fixed)' : b.kind === 'hard' ? ' (needs focus)' : ''}`);
  return [
    `## Arise's plan for today (${plan.day}), worked out on the device`,
    ...(lines.length ? lines : ['- Nothing planned.']),
    ...(plan.left.length ? [`Didn't fit: ${plan.left.map((t) => t.title).join(', ')}.`] : []),
    ...plan.notes,
    ...(warns.length ? ['Early warnings:', ...warns.slice(0, 3).map((w) => `- ${w.title}. ${w.body}`)] : []),
  ].join('\n');
}
