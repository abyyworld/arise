// Your week in review (lib/review.ts), gathered from the store and what Arise saw: the card on
// Today on Sunday afternoon and Monday morning, and a plain notification on Sunday at 18:00, from
// this device only (the plan's next-step path, never the reminders server). Off on this device
// from Settings, Your plan and next steps.

import * as S from './store';
import * as G from './lib/goals';
import * as INS from './life/insight';
import * as R from './lib/review';

const OFF = 'arise-review-off';
export const on = () => {
  try {
    return localStorage.getItem(OFF) !== '1';
  } catch {
    return true;
  }
};
export function setOn(yes: boolean) {
  try {
    if (yes) localStorage.removeItem(OFF);
    else localStorage.setItem(OFF, '1');
  } catch {}
}

// The week looked back on at this moment: Sunday from 15:00, its own week; Monday before noon, the
// week before. Otherwise none.
export function weekNow(now = new Date()): string | null {
  const k = S.keyOf(now);
  const wd = now.getDay();
  if (wd === 0 && now.getHours() >= 15) return S.mondayOf(k);
  if (wd === 1 && now.getHours() < 12) return S.mondayOf(S.addDays(k, -1));
  return null;
}

export function inputFor(monday: string): R.ReviewInput {
  const st = S.state;
  const days = Array.from({ length: 7 }, (_, i) => S.addDays(monday, i));
  const sunday = days[6];
  const from = S.parseKey(monday).getTime();
  const to = S.parseKey(S.addDays(monday, 7)).getTime();
  const todosDone = Object.values(st.todos)
    .filter((t) => !t.gone && t.done && t.done >= from && t.done < to)
    .sort((a, b) => a.done! - b.done!)
    .map((t) => t.title);
  const todosLate = Object.values(st.todos).filter((t) => !t.gone && !t.done && t.day && t.day <= sunday).length;
  const quests = S.activeQuests().map(({ quest }) => {
    if (quest.schedule.kind === 'weekly') return { title: quest.title, done: S.weekCount(quest.id, sunday), due: quest.schedule.times };
    let due = 0;
    let done = 0;
    for (const k of days) {
      if (k < quest.created || !G.dueOn(quest, k)) continue;
      due++;
      if (st.checks[k]?.[quest.id]?.done) done++;
    }
    return { title: quest.title, done, due };
  });
  const milestones: string[] = [];
  for (const g of st.goals) for (const m of g.milestones) if (m.done && m.done >= monday && m.done <= sunday) milestones.push(m.title);
  const sig = (INS.peek()?.signals || []).filter((d) => d.day >= monday && d.day <= sunday);
  const logs = days.map((k) => st.logs[k]).filter(Boolean);
  const nextMon = S.addDays(monday, 7);
  const nextSun = S.addDays(monday, 13);
  const nextDeadlines: { title: string; due: string }[] = [];
  for (const g of S.activeGoals()) for (const m of g.milestones) if (!m.done && m.due && m.due >= nextMon && m.due <= nextSun) nextDeadlines.push({ title: m.title, due: m.due });
  for (const t of Object.values(st.todos)) if (!t.gone && !t.done && t.big && t.day && t.day >= nextMon && t.day <= nextSun) nextDeadlines.push({ title: t.title, due: t.day });
  nextDeadlines.sort((a, b) => a.due.localeCompare(b.due));
  return {
    monday,
    todosDone,
    todosLate,
    quests: quests.filter((q) => q.due > 0),
    workouts: days.reduce((a, k) => a + S.sessionsOn(k).length, 0),
    milestones,
    sleep: sig.map((d) => d.sleepMin).filter((x): x is number => typeof x === 'number'),
    mood: logs.map((l) => l.m).filter((x): x is number => typeof x === 'number'),
    energy: logs.map((l) => l.e).filter((x): x is number => typeof x === 'number'),
    focusMin: sig.reduce((a, d) => a + (d.focusMin || 0), 0),
    nextDeadlines,
    nextEvents: S.eventsBetween(S.parseKey(nextMon).getTime(), S.parseKey(S.addDays(nextMon, 7)).getTime()).length,
  };
}

export const reviewOf = (monday: string) => R.review(inputFor(monday));

// Sunday at 18:00, plain words, for the next few days' notifications.
export function nudges(now = Date.now(), days = 3) {
  if (!on()) return [];
  const out: { at: number; title: string; body: string; tag: string }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    if (d.getDay() !== 0) continue;
    d.setHours(18, 0, 0, 0);
    if (d.getTime() <= now) continue;
    const monday = S.mondayOf(S.keyOf(d));
    if (S.state.dismissed[`review:${monday}`] != null) continue;
    out.push({ at: d.getTime(), title: 'Your week', body: 'Your week is ready to look back on, with one thing to try next week.', tag: `review-${monday}` });
  }
  return out;
}
