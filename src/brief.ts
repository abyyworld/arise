// The morning brief (lib/brief.ts), gathered from the store and the life log's calendars: the card
// on Today in the morning, and the notification at the time picked in Settings (ids 8500+ in the
// phone apps through native.js, while open on the web through todo-alerts.js). Never to the
// reminders server, so no server learns what's in it.

import * as S from './store';
import * as B from './lib/brief';
import { logEvents } from './ahead';
import { leftOf, money } from './lib/everyday';

const DAY_MS = 86_400_000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const on = () => TIME.test(S.state.settings.briefAt || '');

export function inputFor(k: string): B.BriefInput {
  const st = S.state;
  const from = S.parseKey(k).getTime();
  const to = S.parseKey(S.addDays(k, 1)).getTime();
  const own = S.eventsBetween(from, to).map((o) => ({ start: o.start, title: o.title, allDay: !!o.allDay }));
  const seen = new Set(own.map((e) => `${e.start}|${e.title}`));
  const theirs = logEvents(from, to)
    .filter((b) => !seen.has(`${b.start}|${b.title}`))
    .map((b) => ({ start: b.start, title: b.title, allDay: false }));
  const events = [...own, ...theirs].sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
  const td = S.todosFor(k);
  const todos = td.open.filter((t) => t.day).map((t) => ({ title: t.title, late: t.day! < k, ...(t.time ? { time: t.time } : {}) }));
  const week = S.addDays(k, 7);
  const deadlines: B.BriefInput['deadlines'] = [];
  for (const g of S.activeGoals()) for (const m of g.milestones) if (!m.done && m.due && m.due >= k && m.due <= week) deadlines.push({ title: m.title, due: m.due, goal: g.title });
  deadlines.sort((a, b) => a.due.localeCompare(b.due));
  const owe = Object.values(st.debts)
    .filter((d) => !d.gone && !d.settled && d.dir === 'owe' && d.due && d.due <= k)
    .map((d) => ({ text: `pay ${d.who} back ${money(leftOf(d), d.cur)}`, due: d.due! }));
  return {
    day: k,
    events,
    todos,
    deadlines,
    quests: S.questsFor(k).filter((q) => !q.done).length,
    owe,
    groceries: Object.values(st.groceries).filter((g) => !g.gone && !g.got).length,
  };
}

export const today = () => B.brief(inputFor(S.todayKey()));

// Notifications for the next few days, at the time picked: plain words unless details are on.
export function nudges(now = Date.now(), days = 3): { at: number; title: string; body: string; tag: string }[] {
  if (!on()) return [];
  const [h, m] = S.state.settings.briefAt.split(':').map(Number);
  const out = [];
  for (let i = 0; i < days; i++) {
    const k = S.addDays(S.keyOf(new Date(now)), i);
    const d = S.parseKey(k);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now || d.getTime() > now + days * DAY_MS) continue;
    const b = B.brief(inputFor(k));
    out.push({ at: d.getTime(), title: b.title, body: S.state.settings.notifyDetails ? b.body : b.plain, tag: `brief-${k}` });
  }
  return out;
}
