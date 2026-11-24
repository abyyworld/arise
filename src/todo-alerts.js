// Reminders at a to-do's time, and for your own calendar events (lib/events.ts), in the web app
// (the phone apps schedule their own: native.js). The reminders server never learns about to-dos
// or events, so these come while Arise is open (a tab, or the installed app in the background),
// from this device only. Plain on the lock screen unless the Player turned on details in
// notifications.

import * as S from './store';
import * as EV from './lib/events';
import { isNative } from './native.js';
import * as WR from './web-reminders';

const AHEAD = 24 * 3600_000; // timers for the next day; planned again on every change and visit
let timers = [];

// The to-dos due in the next day, not done yet, with when: [{ id, at }].
export function dueSoon(now = Date.now()) {
  return Object.values(S.state.todos)
    .filter((t) => !t.gone && !t.done && t.day && t.time)
    .map((t) => {
      const [y, m, d] = t.day.split('-').map(Number);
      const [h, min] = t.time.split(':').map(Number);
      return { id: t.id, at: new Date(y, m - 1, d, h, min).getTime() };
    })
    .filter((x) => x.at > now && x.at <= now + AHEAD)
    .sort((a, b) => a.at - b.at);
}

// Only with reminders on in Settings (and the browser's permission, which turning them on asks for).
export const allowed = () => !isNative && WR.isOn() && typeof Notification !== 'undefined' && Notification.permission === 'granted';

// Your events' reminders due in the next day.
export const eventsSoon = (now = Date.now()) => EV.reminders(S.state.events, now, now + AHEAD);

async function notify(title, body, tag) {
  try {
    const reg = await globalThis.navigator?.serviceWorker?.getRegistration?.();
    if (reg) await reg.showNotification(title, { body, tag });
    else new Notification(title, { body, tag });
  } catch {}
}

// Still due when its timer fires (not deleted or moved meanwhile).
function showEvent(tag, now) {
  const r = EV.reminders(S.state.events, now - 60_000, now + 60_000).find((x) => x.tag === tag);
  if (!r) return;
  const { title, body } = EV.reminderText(r, !!S.state.settings.notifyDetails);
  void notify(title, body, tag);
}

async function show(id) {
  const t = S.state.todos[id];
  if (!t || t.gone || t.done) return;
  const details = !!S.state.settings.notifyDetails;
  const title = details ? t.title : 'Something on your to-do list';
  const body = details ? 'On your to-do list in Arise.' : 'Open Arise to see it.';
  try {
    const reg = await globalThis.navigator?.serviceWorker?.getRegistration?.();
    if (reg) await reg.showNotification(title, { body, tag: `todo-${id}` });
    else new Notification(title, { body, tag: `todo-${id}` });
  } catch {}
}

// Next-step messages from the plan and the early warnings (src/ahead.ts, hooked in by app.js with
// useNudges): shown while Arise is open, like the rest here.
let nudgeSource = () => [];
export function useNudges(fn) {
  nudgeSource = fn;
}
function nudgesSoon(now) {
  try {
    return (nudgeSource(now) || []).filter((n) => n && n.at > now && n.at <= now + AHEAD);
  } catch {
    return [];
  }
}

// Plans the timers again from the to-dos as they are now. Says which ids it planned.
export function planAlerts(now = Date.now()) {
  for (const t of timers) clearTimeout(t);
  timers = [];
  if (!allowed()) return [];
  const due = dueSoon(now);
  for (const { id, at } of due) timers.push(setTimeout(() => void show(id), at - now));
  const evs = eventsSoon(now);
  for (const r of evs) timers.push(setTimeout(() => showEvent(r.tag, r.at), r.at - now));
  const next = nudgesSoon(now);
  // Still the same message when its timer fires (the plan may have moved meanwhile).
  for (const n of next) timers.push(setTimeout(() => nudgesSoon(n.at - 60_000).some((x) => x.tag === n.tag) && void notify(n.title, n.body, n.tag), n.at - now));
  return [...due.map((x) => x.id), ...evs.map((r) => r.tag), ...next.map((n) => n.tag)];
}

export function initTodoAlerts() {
  if (isNative) return;
  S.onSave(() => planAlerts());
  globalThis.document?.addEventListener('visibilitychange', () => planAlerts());
  planAlerts();
}
