// The Calendar: everything with a day in one place. Your own events (lib/events.ts, made here,
// synced end-to-end encrypted), to-dos with a day (todos-ui.js), and events from your other
// calendars in the life log (Google, Outlook, the phone's and the Mac's, calendars by link), each
// in its own colour, with a filter for what to show.
//   Views: Month (a grid, and the picked day's list beside it), Week and Day (hours, with whole-day
//   things on top; the week scrolls sideways on a phone), and List (the next 30 days).
//   Tap an empty hour (or New event) to make an event; tap one of yours to change or delete it
//   (one time of a repeat, or every time); a to-do opens its own sheet; an event from another
//   calendar opens read-only.
//   A calendar file (.ics) comes in as events of your own, and yours go out as one.
// Reminders for your events: native.js (phone apps) and todo-alerts.js (the web app while open),
// both on the device only.

import * as S from './store';
import * as L from './life/log';
import * as EV from './lib/events';
import { fromIcs, inviteIcs, toIcs } from './lib/events-ics';
import { status as syncStatus } from './sync';
import { hasLifeStore } from './life/store-port';
import * as N from './native.js';
import { allowed as webAlerts } from './todo-alerts.js';
import { addForm, dayText, onTodoChange, row as todoRow } from './todos-ui.js';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';
import './styles/calendar.css';

export const VIEW = 'calendar';
const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const DAY = 86_400_000;
const MIN = 60_000;
const HOUR_PX = 44;
const PREFS = 'arise-cal';
export const PRIVATE = 'Your events are locked on your device before they sync. Not even Arise or its cloud providers can read them.';

// ---------- dates (this device's clock)

const pad = (n) => String(n).padStart(2, '0');
const parse = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (k, n) => {
  const d = parse(k);
  d.setDate(d.getDate() + n);
  return keyOf(d);
};
const startOf = (k) => parse(k).getTime();
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const longDay = (k) => parse(k).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const mondayOf = (k) => addDays(k, -((parse(k).getDay() + 6) % 7));
const monthOf = (k) => k.slice(0, 7);
function monthDays(month) {
  const [y, m] = month.split('-').map(Number);
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday first
  return { lead, n: new Date(y, m, 0).getDate(), y, m };
}

// ---------- what to show

const VIEWS = [
  ['month', 'Month'],
  ['week', 'Week'],
  ['day', 'Day'],
  ['list', 'List'],
];
// Where things come from, each in its colour. The last four are from the life log.
const SOURCES = [
  ['own', 'Your events'],
  ['todo', 'To-dos'],
  ['google', 'Google'],
  ['outlook', 'Outlook'],
  ['phone', 'Phone and Mac'],
  ['link', 'By link'],
];
const LINKED = ['google', 'outlook', 'phone', 'link'];

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}') || {};
    return { view: VIEWS.some(([v]) => v === p.view) ? p.view : 'month', hide: Array.isArray(p.hide) ? p.hide.filter((x) => SOURCES.some(([s]) => s === x)) : [] };
  } catch {
    return { view: 'month', hide: [] };
  }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({ view: cal.view, hide: [...cal.hide] }));
  } catch {}
}

const cal = { view: 'month', day: '', hide: new Set(), loaded: false };
let linked = { range: '', list: [] }; // events from the life log for the range on screen
let linkedGen = 0;

const linkedSource = (e) => {
  const app = String(e.meta?.app || '');
  if (app === 'google-calendar') return 'google';
  if (app === 'outlook-calendar') return 'outlook';
  if (app === 'ics') return 'link';
  return 'phone';
};
const SOURCE_NAME = { google: 'Google Calendar', outlook: 'Outlook', link: 'A calendar added by its link', phone: "Your phone's or Mac's calendar" };

// The range a view covers: [from, to) as days.
function range() {
  const k = cal.day;
  if (cal.view === 'month') {
    const { y, m } = monthDays(monthOf(k));
    return [keyOf(new Date(y, m - 1, 1)), keyOf(new Date(y, m, 1))];
  }
  if (cal.view === 'week') {
    const mon = mondayOf(k);
    return [mon, addDays(mon, 7)];
  }
  if (cal.view === 'day') return [k, addDays(k, 1)];
  return [k, addDays(k, 30)];
}

// Everything in from..to (days), as items: { src, id, key?, start, end, allDay, day, lastDay, title, color, done?, todo?, ev? }.
function itemsBetween(from, to) {
  const a = startOf(from);
  const b = startOf(to);
  const out = [];
  if (!cal.hide.has('own')) {
    for (const o of S.eventsBetween(a, b)) out.push({ src: 'own', id: o.id, key: o.key, start: o.start, end: o.end, allDay: o.allDay, day: o.day, lastDay: o.lastDay, title: o.title, color: o.color, repeats: o.repeats, location: o.location });
  }
  if (!cal.hide.has('todo')) {
    for (const t of Object.values(S.state.todos)) {
      if (t.gone || !t.day || t.day < from || t.day >= to) continue;
      const start = t.time ? startOf(t.day) + (Number(t.time.slice(0, 2)) * 60 + Number(t.time.slice(3))) * MIN : startOf(t.day);
      out.push({ src: 'todo', id: t.id, start, end: t.time ? start + 30 * MIN : start, allDay: !t.time, day: t.day, lastDay: t.day, title: t.title, color: 'todo', done: !!t.done, todo: t });
    }
  }
  if (linked.range === `${from}|${to}`) {
    for (const e of linked.list) {
      const src = linkedSource(e);
      if (cal.hide.has(src)) continue;
      const allDay = e.meta?.allDay === true;
      const end = e.end && e.end > e.at ? e.end : allDay ? e.at + DAY : e.at;
      out.push({ src, id: e.id, start: e.at, end, allDay, day: keyOf(new Date(e.at)), lastDay: keyOf(new Date(Math.max(e.at, end - 1))), title: e.title, color: src, ev: e });
    }
  }
  return out.sort((x, y) => Number(y.allDay) - Number(x.allDay) || x.start - y.start || x.title.localeCompare(y.title));
}
const onDayOf = (items, k) => items.filter((i) => i.day <= k && i.lastDay >= k);

async function loadLinked() {
  if (!hasLifeStore()) return;
  const [from, to] = range();
  const key = `${from}|${to}`;
  const gen = ++linkedGen;
  let list = [];
  try {
    // Calendars only (Google, Outlook, the phone's, the Mac's, by link), not Arise's own events.
    list = await L.eventsBetween(startOf(from) - DAY, startOf(to), { sources: ['calendar', 'mac'], kinds: ['event'], limit: 3000 });
  } catch {}
  if (gen !== linkedGen) return;
  linked = { range: key, list: list.filter((e) => (e.end && e.end > e.at ? e.end : e.at + 1) > startOf(from)) };
  repaint();
}

// ---------- pieces

const swatch = (color) => `<i class="cal-sw c-${esc(color)}" aria-hidden="true"></i>`;
const whenText = (i) => (i.allDay ? (i.lastDay !== i.day ? `Until ${dayText(i.lastDay)}` : 'All day') : i.end > i.start ? `${clock(i.start)} to ${clock(i.end)}` : clock(i.start));

// One item as a button that opens it.
function itemButton(i, { cls = 'cal-item', showWhen = true } = {}) {
  const act = i.src === 'own' ? `data-act="cal-ev" data-id="${esc(i.id)}" data-key="${esc(i.key)}"` : i.src === 'todo' ? `data-act="todo-edit" data-id="${esc(i.id)}"` : `data-act="cal-linked" data-id="${esc(i.id)}"`;
  const label = `${i.title}, ${whenText(i)}${i.src === 'todo' ? ', to-do' : ''}${i.done ? ', done' : ''}`;
  return `<button class="${cls} c-${esc(i.color)}${i.done ? ' done' : ''}" ${act} aria-label="${esc(label)}">${showWhen ? `<span class="cal-when">${esc(i.allDay ? 'All day' : clock(i.start))}</span> ` : ''}<span class="cal-what">${esc(i.title)}</span></button>`;
}

function toolbar() {
  const [from, to] = range();
  let title;
  if (cal.view === 'month') title = parse(from).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  else if (cal.view === 'day') title = longDay(cal.day);
  else {
    const last = addDays(to, -1);
    const o = { day: 'numeric', month: 'short' };
    title = `${parse(from).toLocaleDateString(undefined, o)} to ${parse(last).toLocaleDateString(undefined, { ...o, year: 'numeric' })}`;
  }
  const unit = { month: 'month', week: 'week', day: 'day', list: '30 days' }[cal.view];
  const sources = SOURCES.filter(([s]) => !LINKED.includes(s) || hasLifeStore());
  return `<div class="cal-bar">
      <h2 class="cal-title" aria-live="polite">${esc(title)}</h2>
      <div class="cal-nav">
        <button class="btn small ghost" data-act="cal-today">Today</button>
        <button class="icon-btn" data-act="cal-move" data-n="-1" aria-label="Last ${unit}">${icon('back')}</button>
        <button class="icon-btn flip" data-act="cal-move" data-n="1" aria-label="Next ${unit}">${icon('back')}</button>
      </div>
      <div class="cal-tools">
        <div class="seg cal-views" role="group" aria-label="View">${VIEWS.map(([v, l]) => `<button class="${cal.view === v ? 'on' : ''}" data-act="cal-view" data-v="${v}" aria-pressed="${cal.view === v}">${l}</button>`).join('')}</div>
        <button class="btn small primary" data-act="cal-new">${icon('up')} New event</button>
      </div>
    </div>
    <div class="cal-filters" role="group" aria-label="Show">${sources.map(([s, l]) => `<button class="cal-chip" data-act="cal-filter" data-v="${s}" aria-pressed="${!cal.hide.has(s)}">${swatch(s === 'own' ? 'blue' : s)}${esc(l)}</button>`).join('')}</div>`;
}

// ---------- month

function monthHTML(items) {
  const today = S.todayKey();
  const { lead, n, y, m } = monthDays(monthOf(cal.day));
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="cal-cell blank" aria-hidden="true"></span>');
  for (let d = 1; d <= n; d++) {
    const k = `${y}-${pad(m)}-${pad(d)}`;
    const here = onDayOf(items, k);
    const own = here.filter((i) => i.src === 'own').length;
    const left = here.filter((i) => i.src === 'todo' && !i.done).length;
    const evs = here.filter((i) => LINKED.includes(i.src)).length;
    const said = [own ? `${own} ${own === 1 ? 'event' : 'events'}` : '', left ? `${left} to do` : '', evs ? `${evs} in your calendar` : ''].filter(Boolean).join(', ');
    const chips = here.slice(0, 3).map((i) => `<span class="cal-mini c-${esc(i.color)}${i.done ? ' done' : ''}">${esc(i.title)}</span>`).join('');
    const more = here.length > 3 ? `<span class="cal-more">${here.length - 3} more</span>` : '';
    cells.push(
      `<button class="cal-cell${k === today ? ' today' : ''}${k === cal.day ? ' on' : ''}" data-act="cal-day" data-d="${k}" aria-pressed="${k === cal.day}" aria-label="${esc(longDay(k))}${said ? `: ${said}` : ''}"><span class="cal-num">${d}</span><span class="cal-dots">${own ? '<i class="dot own"></i>' : ''}${left ? '<i class="dot todo"></i>' : ''}${evs ? '<i class="dot ev"></i>' : ''}</span><span class="cal-chips" aria-hidden="true">${chips}${more}</span></button>`,
    );
  }
  const names = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }));
  return `<div class="cal-grid cal-month-grid" role="group" aria-label="Days">${names.map((x) => `<span class="cal-name" aria-hidden="true">${esc(x)}</span>`).join('')}${cells.join('')}</div>`;
}

// The picked day: your events, to-dos (with the box to add one), and the other calendars'.
function dayHTML(items) {
  const k = cal.day;
  const today = S.todayKey();
  const here = onDayOf(items, k);
  const own = here.filter((i) => i.src === 'own');
  const todos = cal.hide.has('todo') ? [] : Object.values(S.state.todos)
        .filter((t) => !t.gone && (t.done ? keyOf(new Date(t.done)) === k : t.day === k))
        .sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.created - b.created);
  const overdue = k === today && !cal.hide.has('todo') ? S.todosFor(k).open.filter((t) => !t.day || t.day < k) : [];
  const evs = here.filter((i) => LINKED.includes(i.src));
  const anyLinked = LINKED.some((s) => !cal.hide.has(s));
  return `<section class="panel todos" id="calDay">
    <div class="panel-title">${icon('days')}<span>${esc(dayText(k, today))}</span><button class="link small cal-add" data-act="cal-new" data-d="${k}">${icon('up')} Event</button></div>
    ${
      cal.hide.has('own')
        ? ''
        : own.length
          ? `<ul class="cal-list">${own.map((i) => `<li>${itemButton(i)}</li>`).join('')}</ul>`
          : '<p class="muted small">No events of your own on this day.</p>'
    }
    ${cal.hide.has('todo') ? '' : todos.length ? `<ul class="qlist">${todos.map((t) => todoRow(t, today, { showDay: false })).join('')}</ul>` : '<p class="muted small">No to-dos on this day.</p>'}
    ${overdue.length ? `<p class="label">Still to do from before, or with no day</p><ul class="qlist later">${overdue.map((t) => todoRow(t, today)).join('')}</ul>` : ''}
    ${cal.hide.has('todo') ? '' : addForm(k)}
    ${
      evs.length
        ? `<p class="label">In your calendar</p><ul class="cal-events">${evs.map((i) => `<li>${itemButton(i, { cls: 'cal-item linked' })}</li>`).join('')}</ul>`
        : hasLifeStore() && anyLinked
          ? `<p class="muted small">${k > today ? "Nothing coming up from your calendar. Google, Outlook and calendars added by their link show what's coming; the iPhone's calendar adds events once they've happened." : 'Nothing from your calendar. Connect it on Setup and connections.'}</p>`
          : ''
    }
  </section>`;
}

// ---------- week and day: hours

// Side by side when they overlap: each timed item's column and how many share its group.
function columns(list) {
  const sorted = [...list].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const out = new Map();
  let group = [];
  let groupEnd = -1;
  const close = () => {
    const n = Math.max(1, ...group.map((g) => out.get(g).col + 1));
    for (const g of group) out.get(g).cols = n;
    group = [];
  };
  for (const it of sorted) {
    if (it.top >= groupEnd && group.length) close();
    const used = new Set(group.filter((g) => g.bottom > it.top).map((g) => out.get(g).col));
    let col = 0;
    while (used.has(col)) col++;
    out.set(it, { col, cols: 1 });
    group.push(it);
    groupEnd = Math.max(groupEnd, it.bottom);
  }
  if (group.length) close();
  return out;
}

function hoursHTML(items, days) {
  const today = S.todayKey();
  const head = days
    .map((k) => `<button class="cal-dh${k === today ? ' today' : ''}" data-act="cal-open-day" data-d="${k}" aria-label="${esc(longDay(k))}"><span>${esc(parse(k).toLocaleDateString(undefined, { weekday: 'short' }))}</span><b>${parse(k).getDate()}</b></button>`)
    .join('');
  const allDay = days
    .map((k) => {
      const list = onDayOf(items, k).filter((i) => i.allDay);
      return `<div class="cal-ad" data-d="${k}">${list.map((i) => itemButton(i, { cls: 'cal-item', showWhen: false })).join('')}</div>`;
    })
    .join('');
  const labels = Array.from({ length: 24 }, (_, h) => `<span class="cal-hl" style="top:${h * HOUR_PX}px">${pad(h)}:00</span>`).join('');
  const cols = days
    .map((k) => {
      const s = startOf(k);
      const e = startOf(addDays(k, 1));
      const span = e - s; // (23 or 25 hours on a day the clocks change)
      const timed = items
        .filter((i) => !i.allDay && i.start < e && (i.end > s || (i.end === i.start && i.start >= s)))
        .map((i) => {
          const top = Math.max(0, ((Math.max(i.start, s) - s) / span) * 24 * HOUR_PX);
          const bottom = Math.max(top + 20, ((Math.min(Math.max(i.end, i.start + 30 * MIN), e) - s) / span) * 24 * HOUR_PX);
          return { i, top, bottom };
        });
      const cols = columns(timed);
      const slots = Array.from({ length: 24 }, (_, h) => `<button class="cal-slot" data-act="cal-new" data-d="${k}" data-h="${h}" aria-hidden="true" tabindex="-1"></button>`).join('');
      const blocks = timed
        .map((t) => {
          const { col, cols: n } = cols.get(t);
          return `<div class="cal-block" style="top:${t.top.toFixed(1)}px;height:${(t.bottom - t.top).toFixed(1)}px;left:${((col / n) * 100).toFixed(2)}%;width:${(100 / n).toFixed(2)}%">${itemButton(t.i, { cls: 'cal-item' })}</div>`;
        })
        .join('');
      const now = Date.now();
      const line = k === today ? `<i class="cal-now" style="top:${(((now - s) / span) * 24 * HOUR_PX).toFixed(1)}px" aria-hidden="true"></i>` : '';
      return `<div class="cal-col${k === today ? ' today' : ''}" data-d="${k}">${slots}${blocks}${line}</div>`;
    })
    .join('');
  return `<div class="cal-hours-wrap${days.length > 1 ? ' week' : ''}">
    <div class="cal-hours-grid" style="--days:${days.length}">
      <div class="cal-corner" aria-hidden="true"></div>${head}
      <div class="cal-corner small muted">All day</div>${allDay}
    </div>
    <div class="cal-scroll" id="calScroll">
      <div class="cal-hours-grid" style="--days:${days.length}">
        <div class="cal-labels" style="height:${24 * HOUR_PX}px">${labels}</div>${cols}
      </div>
    </div>
  </div>`;
}

// ---------- list

function listHTML(items) {
  const [from, to] = range();
  const groups = [];
  for (let k = from; k < to; k = addDays(k, 1)) {
    const here = onDayOf(items, k);
    if (here.length) groups.push(`<section class="cal-agenda-day"><h3 class="label"><button class="link" data-act="cal-open-day" data-d="${k}">${esc(dayText(k))}</button>${k !== S.todayKey() && dayText(k).length < 10 ? ` <span class="muted">${esc(longDay(k))}</span>` : ''}</h3><ul class="cal-list">${here.map((i) => `<li>${itemButton(i)}</li>`).join('')}</ul></section>`);
  }
  return groups.length ? groups.join('') : '<p class="muted">Nothing in these 30 days.</p>';
}

// ---------- the screen

function bodyHTML() {
  const [from, to] = range();
  const items = itemsBetween(from, to);
  if (cal.view === 'month') {
    return `<div class="cols"><div class="col"><section class="panel cal" id="calMonth">${monthHTML(items)}</section></div><div class="col">${dayHTML(items)}</div></div>`;
  }
  if (cal.view === 'week') return `<section class="panel cal cal-time" id="calWeek">${hoursHTML(items, Array.from({ length: 7 }, (_, i) => addDays(from, i)))}</section>`;
  if (cal.view === 'day') return `<div class="cols"><div class="col"><section class="panel cal cal-time" id="calDayHours">${hoursHTML(items, [from])}</section></div><div class="col">${dayHTML(items)}</div></div>`;
  return `<section class="panel cal" id="calList">${listHTML(items)}</section>`;
}

function footHTML() {
  return `<section class="panel cal-foot">
    <div class="row wrap">
      <button class="btn small ghost" data-act="cal-import">${icon('up')} Import a calendar file</button>
      <button class="btn small ghost" data-act="cal-export">${icon('share')} Export your events</button>
    </div>
    <input type="file" id="calImport" accept=".ics,text/calendar" hidden>
    <p class="muted small">A calendar file (.ics) from Google, Outlook or Apple comes in as events of your own. Export gives your events as one file for any calendar app.</p>
    <p class="muted small">${esc(PRIVATE)}</p>
  </section>`;
}

let scrolled = '';
export function renderCalendar(root) {
  if (!cal.loaded) {
    const p = loadPrefs();
    cal.view = p.view;
    cal.hide = new Set(p.hide);
    cal.loaded = true;
  }
  if (!cal.day) cal.day = S.todayKey();
  root.innerHTML = `
    <header class="page-head life-back-head"><button class="icon-btn" data-act="nav" data-v="today" aria-label="Back to Today">${icon('back')}</button><div><p class="kicker">Your events, to-dos and calendars</p><h1 class="display">Calendar</h1></div></header>
    <div id="calTop">${toolbar()}</div>
    <div id="calBody">${bodyHTML()}</div>
    ${footHTML()}`;
  scrolled = '';
  afterPaint();
  void loadLinked(); // again each time: new events may have come in since
}

function afterPaint() {
  // Week and day open at 7:00 (once per view and range), with the hours scrolling inside.
  const box = $('#calScroll');
  const key = `${cal.view}|${range().join('|')}`;
  if (box && scrolled !== key) {
    box.scrollTop = 7 * HOUR_PX;
    scrolled = key;
  }
}

function repaint() {
  const body = $('#calBody');
  if (!body) return;
  const top = $('#calTop');
  if (top) top.innerHTML = toolbar();
  const keep = $('#calScroll')?.scrollTop;
  body.innerHTML = bodyHTML();
  const box = $('#calScroll');
  if (box && keep != null) box.scrollTop = keep;
  afterPaint();
}
onTodoChange(repaint);

// How many things are on your calendar on day k (your events, and the other calendars' when this
// build has the life log). For the hero on Today.
export async function calendarCount(k) {
  const own = S.eventsOn(k).length;
  if (!hasLifeStore()) return own;
  const from = parse(k).getTime();
  const to = parse(S.addDays(k, 1)).getTime();
  return own + (await L.eventsBetween(from, to, { sources: ['calendar', 'mac'], kinds: ['event'], limit: 500 })).length;
}

// ---------- the event sheet

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const wdName = (d) => new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
const COLOR_NAMES = { blue: 'Blue', teal: 'Teal', green: 'Green', yellow: 'Yellow', orange: 'Orange', red: 'Red', pink: 'Pink', purple: 'Purple', gray: 'Grey' };

function remindHelp() {
  const plain = S.state.settings.notifyDetails ? '' : " On your lock screen it only says there's something in your calendar.";
  if (N.isNative) return S.state.settings.notify ? `Reminders come on this phone.${plain}` : 'Reminders come once reminders are on (Settings).';
  if (webAlerts()) return `Reminders come while Arise is open on this device.${plain}`;
  return "Reminders come while Arise is open, once reminders are on in Settings. The phone apps remind you even when it's closed.";
}

// sheet: { id?, key?, scope: 'one' | 'all', draft }
let sheet = null;

// The form's values for an event, or for one time of it.
function draftOf(e, key, scope) {
  const c = scope === 'one' ? e.changes?.[key] : null;
  let start = e.start;
  let end = e.end;
  let allDay = !!e.allDay;
  if (scope === 'one') {
    start = c ? c.start : key;
    allDay = c ? !!c.allDay : !!e.allDay;
    if (c) end = c.end;
    else if (e.end) end = EV.wallText(EV.wallOf(key) + (EV.wallOf(e.end) - EV.wallOf(e.start)), allDay);
    else end = undefined;
  }
  return {
    title: (c && c.title) || e.title,
    allDay,
    start,
    end: end || start,
    location: c ? c.location || '' : e.location || '',
    notes: c ? c.notes || '' : e.notes || '',
    color: e.color || 'blue',
    repeat: e.repeat || null,
    remind: e.remind || [],
    tz: e.tz || '',
    guests: (e.guests || []).join(', '),
  };
}

function newDraft(day, hour) {
  const k = day || cal.day || S.todayKey();
  let h = hour;
  if (h == null) h = k === S.todayKey() ? Math.min(23, new Date().getHours() + 1) : 9;
  const start = `${k}T${pad(h)}:00`;
  const end = h < 23 ? `${k}T${pad(h + 1)}:00` : `${k}T23:59`;
  return { title: '', allDay: false, start, end, location: '', notes: '', color: 'blue', repeat: null, remind: [], tz: EV.deviceZone(), guests: '' };
}

function sheetHTML() {
  const { id, scope, draft: d } = sheet;
  const e = id ? S.state.events[id] : null;
  const repeating = !!e?.repeat;
  const r = d.repeat || { freq: '' };
  const startDay = d.start.slice(0, 10);
  const startTime = d.allDay ? '09:00' : d.start.slice(11, 16);
  const endDay = d.end.slice(0, 10);
  const endTime = d.allDay ? '10:00' : d.end.slice(11, 16);
  const ends = r.until ? 'on' : r.count ? 'after' : 'never';
  const days = r.days?.length ? r.days : [parse(startDay).getDay()];
  const choices = [...new Set([...EV.REMIND_CHOICES, ...d.remind])].sort((a, b) => a - b);
  const otherZone = d.tz && d.tz !== EV.deviceZone() && !d.allDay;
  return `<div class="ev-sheet" data-id="${esc(id || '')}">
    <p class="kicker">Your calendar</p><h2 class="display sheet-title">${id ? 'Change event' : 'New event'}</h2>
    ${repeating ? `<div class="seg" role="group" aria-label="Change">${[['one', 'This time only'], ['all', 'Every time']].map(([v, l]) => `<button type="button" class="${scope === v ? 'on' : ''}" data-act="ev-scope" data-v="${v}" aria-pressed="${scope === v}">${l}</button>`).join('')}</div>` : ''}
    <form data-form="ev-save" class="ev-form" data-allday="${d.allDay ? 1 : 0}" data-repeat="${esc(r.freq)}" data-ends="${ends}">
      <label class="field"><span class="k">Title</span><input id="evTitle" type="text" maxlength="${EV.TITLE_MAX}" value="${esc(d.title)}" autocomplete="off" placeholder="What is it?"></label>
      <label class="check"><input id="evAllDay" type="checkbox" ${d.allDay ? 'checked' : ''}> All day</label>
      <div class="ev-row"><label class="field"><span class="k">Starts</span><input id="evStartDay" type="date" value="${esc(startDay)}"></label><label class="field ev-time"><span class="k">At</span><input id="evStartTime" type="time" value="${esc(startTime)}"></label></div>
      <div class="ev-row"><label class="field"><span class="k">Ends</span><input id="evEndDay" type="date" value="${esc(endDay)}"></label><label class="field ev-time"><span class="k">At</span><input id="evEndTime" type="time" value="${esc(endTime)}"></label></div>
      ${otherZone ? `<p class="muted small">Times are in ${esc(d.tz)}, where it was made.</p>` : ''}
      <label class="field"><span class="k">Where <span class="muted">· if you like</span></span><input id="evPlace" type="text" maxlength="${EV.PLACE_MAX}" value="${esc(d.location)}" autocomplete="off"></label>
      <label class="field"><span class="k">Notes <span class="muted">· if you like</span></span><textarea id="evNotes" rows="3" maxlength="${EV.NOTES_MAX}">${esc(d.notes)}</textarea></label>
      ${
        scope === 'one'
          ? `<p class="muted small">This changes only this time. ${esc(EV.repeatLabel(e.repeat))}.</p>`
          : `<fieldset class="ev-colors"><legend class="k">Colour</legend>${EV.COLORS.map((c) => `<label class="ev-color c-${c}"><input type="radio" name="evColor" value="${c}" ${d.color === c ? 'checked' : ''}><span class="sr-only">${COLOR_NAMES[c]}</span></label>`).join('')}</fieldset>
      <label class="field"><span class="k">Repeat</span><select id="evRepeat">${[['', 'Never'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['yearly', 'Every year']].map(([v, l]) => `<option value="${v}" ${r.freq === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="ev-repeat">
        <label class="field inline"><span class="k">Every</span><input id="evEvery" type="number" min="1" max="99" value="${r.every || 1}" inputmode="numeric"></label>
        <fieldset class="ev-days"><legend class="k">On</legend>${WEEKDAYS.map((wd) => `<label class="ev-day"><input type="checkbox" name="evDay" value="${wd}" ${days.includes(wd) ? 'checked' : ''}><span>${esc(wdName(wd))}</span></label>`).join('')}</fieldset>
        <label class="field"><span class="k">Ends</span><select id="evEnds">${[['never', 'Never'], ['on', 'On a day'], ['after', 'After so many times']].map(([v, l]) => `<option value="${v}" ${ends === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field ev-until"><span class="k">Last day</span><input id="evUntil" type="date" value="${esc(r.until || '')}"></label>
        <label class="field ev-count"><span class="k">Times</span><input id="evCount" type="number" min="1" max="999" value="${r.count || 10}" inputmode="numeric"></label>
      </div>
      <label class="field"><span class="k">Who's coming <span class="muted">· if you like</span></span><input id="evGuests" type="text" maxlength="2000" value="${esc(d.guests || '')}" autocomplete="off" placeholder="sam@example.com, Jo"></label>
      <p class="muted small">With email addresses, Send invite makes an invite they can accept in their own calendar. You send it yourself, from your email or messages.</p>
      <fieldset class="ev-remind"><legend class="k">Remind me</legend>${choices.map((m) => `<label class="check"><input type="checkbox" name="evRemind" value="${m}" ${d.remind.includes(m) ? 'checked' : ''}> ${esc(EV.remindLabel(m))}</label>`).join('')}</fieldset>
      <p class="muted small">${esc(remindHelp())} A whole-day event's reminders count from 9:00 that day.</p>`
      }
      <p class="muted small">${esc(PRIVATE)}${e?.from ? ` Added by ${esc(e.from)}.` : ''}</p>
      <div class="row wrap">
        <button class="btn primary small" type="submit">Save</button>
        ${scope === 'one' ? '' : `<button class="btn small" type="button" data-act="ev-save-invite">Save and send invite</button>`}
        ${id ? `<button class="btn ghost small danger" type="button" data-act="ev-del">${scope === 'one' ? 'Delete this time' : 'Delete'}</button>` : ''}
        <button class="btn ghost small" type="button" data-act="ev-cancel">Cancel</button>
      </div>
    </form>
  </div>`;
}

function openEditor(next) {
  sheet = next;
  openSheet(sheetHTML());
  if (!next.id) $('#evTitle')?.focus();
}

// What the form says now, as a draft (for switching between this time and every time).
function readForm() {
  const d = { ...sheet.draft };
  const v = (id) => $(`#${id}`)?.value ?? '';
  d.title = v('evTitle');
  d.location = v('evPlace');
  d.notes = v('evNotes');
  return d;
}

function save() {
  if (!sheet) return;
  const { id, key, scope } = sheet;
  const v = (sel) => $(`#${sel}`)?.value ?? '';
  const title = v('evTitle').trim();
  if (!title) {
    toast('Write a title first.');
    $('#evTitle')?.focus();
    return;
  }
  const allDay = !!$('#evAllDay')?.checked;
  const sd = v('evStartDay');
  const ed = v('evEndDay') || sd;
  const st = v('evStartTime') || '09:00';
  const et = v('evEndTime') || st;
  if (!EV.isDay(sd) || !EV.isDay(ed)) {
    toast('Pick a day.');
    return;
  }
  const start = allDay ? sd : `${sd}T${st}`;
  const end = allDay ? ed : `${ed}T${et}`;
  if (EV.wallOf(end) < EV.wallOf(start)) {
    toast('The end is before the start.');
    return;
  }
  const location = v('evPlace').trim();
  const notes = v('evNotes').trim();
  if (scope === 'one') {
    S.changeEventTime(id, key, { start, end: end !== start ? end : undefined, ...(allDay ? { allDay: true } : {}), title, location: location || undefined, notes: notes || undefined });
  } else {
    const color = $('input[name="evColor"]:checked')?.value || 'blue';
    const freq = v('evRepeat');
    let repeat;
    if (freq) {
      repeat = { freq };
      const every = Math.round(Number(v('evEvery')) || 1);
      if (every > 1) repeat.every = Math.min(every, 99);
      if (freq === 'weekly') repeat.days = [...document.querySelectorAll('input[name="evDay"]:checked')].map((x) => Number(x.value));
      if (freq === 'weekly' && !repeat.days.length) repeat.days = [parse(sd).getDay()];
      const ends = v('evEnds');
      if (ends === 'on') {
        if (!EV.isDay(v('evUntil')) || v('evUntil') < sd) {
          toast('Pick a last day on or after the start.');
          return;
        }
        repeat.until = v('evUntil');
      } else if (ends === 'after') repeat.count = Math.max(1, Math.min(999, Math.round(Number(v('evCount')) || 1)));
    }
    const remind = [...document.querySelectorAll('input[name="evRemind"]:checked')].map((x) => Number(x.value));
    const tz = allDay ? undefined : sheet.draft.tz || EV.deviceZone() || undefined;
    const guests = EV.guestsFrom(v('evGuests'));
    const fields = { title, start, end: end !== start ? end : undefined, allDay: allDay || undefined, tz, location: location || undefined, notes: notes || undefined, color, repeat, remind, guests: guests.length ? guests : undefined };
    if (id) {
      const e = S.state.events[id];
      // A repeat keeps the times left out and changed on their own.
      S.updateEvent(id, { ...fields, skip: repeat ? e?.skip : undefined, changes: repeat ? e?.changes : undefined });
      savedId = id;
    } else {
      const made = S.addEvent(fields);
      if (!made) {
        toast("That couldn't be saved.");
        return;
      }
      savedId = made.id;
    }
    // Jump to the day it starts on, if it's off screen.
    if (!id) {
      const [from, to] = range();
      if (sd < from || sd >= to) cal.day = sd;
    }
  }
  sheet = null;
  closeSheet();
  repaint();
  toast('Saved.');
}

function remove() {
  if (!sheet?.id) return;
  const { id, key, scope } = sheet;
  const e = S.state.events[id];
  if (!e) return;
  if (scope === 'one') S.skipEventTime(id, key);
  else {
    if (!confirm(e.repeat ? `Delete "${e.title}", every time?` : `Delete "${e.title}"?`)) return;
    S.removeEvent(id);
  }
  sheet = null;
  closeSheet();
  repaint();
  toast(scope === 'one' ? 'Deleted this time.' : `Deleted "${e.title}".`);
}

// An event from another calendar: what it is, and where to change it.
function showLinked(id) {
  const e = linked.list.find((x) => x.id === id);
  if (!e) return;
  const src = linkedSource(e);
  const allDay = e.meta?.allDay === true;
  const day = keyOf(new Date(e.at));
  const end = e.end && e.end > e.at ? e.end : null;
  const when = allDay ? `${longDay(day)}${end && keyOf(new Date(end - 1)) !== day ? ` to ${longDay(keyOf(new Date(end - 1)))}` : ''}, all day` : `${longDay(day)}, ${clock(e.at)}${end ? ` to ${clock(end)}` : ''}`;
  const place = typeof e.meta?.location === 'string' ? e.meta.location : e.detail || '';
  const calName = typeof e.meta?.calendar === 'string' && e.meta.calendar ? e.meta.calendar : '';
  openSheet(`<div class="ev-linked">
    <p class="kicker">${swatch(src)} ${esc(SOURCE_NAME[src])}${calName ? `: ${esc(calName)}` : ''}</p>
    <h2 class="display sheet-title">${esc(e.title)}</h2>
    <p class="muted">${esc(when)}</p>
    ${place ? `<p>${esc(place)}</p>` : ''}
    ${e.url ? `<p class="small"><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">Open the link ${icon('ext')}</a></p>` : ''}
    <p class="muted small">This comes from ${esc(src === 'phone' ? 'that calendar' : SOURCE_NAME[src])}, so it can only be read here. Change it there.</p>
  </div>`);
}

// ---------- invites

let savedId = ''; // the event the last save was for
const safeName = (s) => (s.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'invite').replace(/\s+/g, '-');

// An invite for the event's guests, sent by the person: the share sheet with the invite file where
// there is one, else the file saved and their email app opened with the guests filled in.
export async function sendInvite(e) {
  const emails = (e.guests || []).filter(EV.isEmail);
  if (!emails.length) {
    toast("Add the guests' email addresses first, under Who's coming.");
    return 'none';
  }
  const text = inviteIcs(e, { organizer: syncStatus.user?.email || '' });
  const name = `${safeName(e.title)}.ics`;
  const when = e.allDay ? e.start.slice(0, 10) : e.start.replace('T', ' at ');
  if (N.isNative) {
    try {
      await N.shareFile(name, text);
    } catch (err) {
      toast(err?.message || "The invite couldn't be shared.");
    }
    return 'shared';
  }
  const file = new File([text], name, { type: 'text/calendar' });
  if (globalThis.navigator?.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `Invite: ${e.title}`, text: `${e.title}, ${when}` });
      return 'shared';
    } catch {}
  }
  await saveIcs(text, name);
  const body = `You're invited: ${e.title}, ${when}${e.location ? `, ${e.location}` : ''}.\n\nThe invite is attached: open it to add it to your calendar.`;
  try {
    globalThis.location.href = `mailto:${emails.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(`Invite: ${e.title}`)}&body=${encodeURIComponent(body)}`;
  } catch {}
  toast(`Saved ${name}. Attach it to the email that opened.`);
  return 'email';
}

// ---------- import and export

async function saveIcs(text, name = 'arise-calendar.ics') {
  if (N.isNative) {
    try {
      await N.shareFile(name, text);
    } catch (err) {
      toast(err?.message || 'The file could not be saved.');
    }
    return;
  }
  const url = URL.createObjectURL(new File([text], name, { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function importFile(file) {
  let text = '';
  try {
    text = await file.text();
  } catch {
    toast("That file couldn't be read.");
    return 0;
  }
  let got;
  try {
    got = fromIcs(text);
  } catch {
    toast("That isn't a calendar file (.ics).");
    return 0;
  }
  if (!got.events.length && !got.todos.length) {
    toast('No events or to-dos in that file.');
    return 0;
  }
  const n = got.events.length ? S.importEvents(got.events) : 0;
  const t = got.todos.length ? S.importTodos(got.todos) : 0;
  repaint();
  const parts = [n ? `${n} ${n === 1 ? 'event' : 'events'}` : '', t ? `${t} ${t === 1 ? 'to-do' : 'to-dos'}` : ''].filter(Boolean);
  toast(`Added ${parts.join(' and ') || 'nothing new'}${got.name ? ` from ${got.name}` : ''}.`);
  return n + t;
}

// ---------- taps

// True when it was one of these.
export function handleAction(act, el) {
  const d = el?.dataset || {};
  switch (act) {
    case 'cal-day':
      cal.day = d.d;
      repaint();
      return true;
    case 'cal-open-day':
      cal.day = d.d;
      cal.view = 'day';
      savePrefs();
      repaint();
      void loadLinked();
      return true;
    case 'cal-view':
      cal.view = d.v;
      savePrefs();
      repaint();
      void loadLinked();
      return true;
    case 'cal-move': {
      const n = Number(d.n || 0);
      if (cal.view === 'month') {
        const [y, m] = monthOf(cal.day).split('-').map(Number);
        const first = keyOf(new Date(y, m - 1 + n, 1));
        cal.day = monthOf(S.todayKey()) === monthOf(first) ? S.todayKey() : first;
      } else cal.day = addDays(cal.day, n * { week: 7, day: 1, list: 30 }[cal.view]);
      repaint();
      void loadLinked();
      return true;
    }
    case 'cal-today':
      cal.day = S.todayKey();
      repaint();
      void loadLinked();
      return true;
    case 'cal-filter': {
      const s = d.v;
      if (cal.hide.has(s)) cal.hide.delete(s);
      else cal.hide.add(s);
      savePrefs();
      repaint();
      return true;
    }
    case 'cal-new':
      openEditor({ scope: 'all', draft: newDraft(d.d, d.h != null ? Number(d.h) : undefined) });
      return true;
    case 'cal-ev': {
      const e = S.state.events[d.id];
      if (!e || e.gone) return true;
      const scope = e.repeat ? 'one' : 'all';
      openEditor({ id: e.id, key: d.key || e.start, scope, draft: draftOf(e, d.key || e.start, scope) });
      return true;
    }
    case 'ev-scope': {
      if (!sheet?.id || sheet.scope === d.v) return true;
      const e = S.state.events[sheet.id];
      const typed = readForm();
      const draft = draftOf(e, sheet.key, d.v);
      openEditor({ ...sheet, scope: d.v, draft: { ...draft, title: typed.title || draft.title } });
      return true;
    }
    case 'ev-del':
      remove();
      return true;
    case 'ev-save-invite': {
      savedId = '';
      save();
      const e = savedId && S.state.events[savedId];
      if (e) void sendInvite(e);
      return true;
    }
    case 'ev-cancel':
      sheet = null;
      closeSheet();
      return true;
    case 'cal-linked':
      showLinked(d.id);
      return true;
    case 'cal-import':
      $('#calImport')?.click();
      return true;
    case 'cal-export': {
      const live = EV.liveEvents(S.state.events);
      if (!live.length) {
        toast('No events of your own to export yet.');
        return true;
      }
      void saveIcs(toIcs(S.state.events));
      return true;
    }
    default:
      return false;
  }
}

// The form: Return saves; switches show and hide what goes with them.
globalThis.document?.addEventListener('submit', (e) => {
  if (e.target?.dataset?.form !== 'ev-save') return;
  e.preventDefault();
  save();
});
globalThis.document?.addEventListener('change', (e) => {
  const t = e.target;
  const form = t?.closest?.('.ev-form');
  if (t?.id === 'calImport' && t.files?.[0]) {
    const f = t.files[0];
    t.value = '';
    void importFile(f);
    return;
  }
  if (!form) return;
  if (t.id === 'evAllDay') form.dataset.allday = t.checked ? '1' : '0';
  if (t.id === 'evRepeat') form.dataset.repeat = t.value;
  if (t.id === 'evEnds') form.dataset.ends = t.value;
  // The end moves with the start, keeping its length.
  if (t.id === 'evStartDay' && sheet) {
    const end = $('#evEndDay');
    if (end && end.value && end.value < t.value) end.value = t.value;
  }
});

// For tests: the calendar starts again on today, in the month.
export function _reset() {
  cal.view = 'month';
  cal.day = '';
  cal.hide = new Set();
  cal.loaded = false;
  linked = { range: '', list: [] };
  sheet = null;
}
