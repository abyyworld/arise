// To-dos (lib/todos.ts), on Today and in the calendar (calendar-ui.js).
//   Today: what's left to do, with its day and time if it has them, a box to add one (with a day
//   and a time if you like), what got done today, and what's coming up. Ticked like quests; tap
//   one to change or delete it. To-dos an AI app added through the web connector show its name.
//   The calendar shows them on their days with the same rows, the box to add one for a day, and
//   this sheet to change one.
// Reminders at a to-do's time: the phone apps schedule them (native.js), and the web app shows
// them while it's open (todo-alerts.js).

import * as S from './store';
import * as N from './native.js';
import { allowed as webAlerts } from './todo-alerts.js';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';

const CALENDAR = 'calendar'; // calendar-ui.js VIEW
const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;

const parse = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const dayText = (k, today = S.todayKey()) => {
  if (k === today) return 'Today';
  if (k === S.addDays(today, 1)) return 'Tomorrow';
  if (k === S.addDays(today, -1)) return 'Yesterday';
  return parse(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};
export function row(t, today, { showDay = true } = {}) {
  const done = !!t.done;
  const late = !done && t.day && t.day < today;
  const when = t.day && showDay ? `${late ? 'Was due ' : ''}${dayText(t.day, today)}${t.time ? `, ${t.time}` : ''}` : t.time || '';
  const meta = [when, t.from ? `From ${t.from}` : ''].filter(Boolean);
  return `<li class="qrow ${done ? 'done' : ''}" data-todo="${esc(t.id)}">
    <button class="qcheck" data-act="todo-tick" data-id="${esc(t.id)}" aria-pressed="${done}" aria-label="${esc(t.title)}: ${done ? 'done' : 'not done yet'}">${icon('check')}</button>
    <button class="qbody todo-open" data-act="todo-edit" data-id="${esc(t.id)}" aria-label="Change ${esc(t.title)}">
      <span class="qtitle">${esc(t.title)}</span>
      ${meta.length ? `<span class="qmeta${late ? ' late' : ''}">${esc(meta.join(' · '))}</span>` : ''}
    </button>
    <button class="icon-btn small" data-act="todo-del" data-id="${esc(t.id)}" aria-label="Delete ${esc(t.title)}">${icon('close')}</button>
  </li>`;
}

// The box to add one. `day`: fixed to that day (the calendar's).
export const addForm = (day = '') => `<form class="todo-add" data-form="todo-add">
      <label class="sr-only" for="todoIn">New to-do</label>
      <input id="todoIn" type="text" maxlength="200" placeholder="${day ? `Add a to-do for ${esc(dayText(day).toLowerCase() === 'today' ? 'today' : dayText(day))}` : 'Add a to-do'}" autocomplete="off" enterkeyhint="done">
      <label class="sr-only" for="todoDay">Day (optional)</label>
      <input id="todoDay" type="date" value="${esc(day)}" aria-label="Day (optional)" ${day ? 'hidden' : ''}>
      <label class="sr-only" for="todoTime">Time (optional)</label>
      <input id="todoTime" type="time" value="" aria-label="Time (optional, with a day)">
      <button class="btn small primary" type="submit">Add</button>
    </form>`;

export function todoCard(k = S.todayKey()) {
  const { open, done, later } = S.todosFor(k);
  const next = later.slice(0, 3);
  return `<section class="panel todos" id="todoCard">
    <div class="panel-title">${icon('check')}<span>To do</span>${open.length + done.length ? `<span class="qcount">${done.length}/${open.length + done.length}</span>` : ''}</div>
    ${open.length || done.length ? `<ul class="qlist">${[...open, ...done].map((t) => row(t, k)).join('')}</ul>` : '<p class="muted small">Nothing to do. Add anything you want to get done, today or another day.</p>'}
    ${addForm()}
    ${next.length ? `<p class="label">Coming up</p><ul class="qlist later">${next.map((t) => row(t, k)).join('')}</ul>${later.length > next.length ? `<p class="muted small">And ${later.length - next.length} more.</p>` : ''}` : ''}
    <div class="row"><button class="link" data-act="nav" data-v="${CALENDAR}">${icon('days')} Calendar</button></div>
  </section>`;
}

// ---------- after a change

// The calendar paints itself again after a change here (calendar-ui.js sets this).
let afterChange = () => {};
export const onTodoChange = (fn) => (afterChange = fn);

function repaint() {
  const el = $('#todoCard');
  if (el) el.outerHTML = todoCard();
  afterChange();
}

function add() {
  const input = $('#todoIn');
  const title = (input?.value || '').trim();
  if (!title) {
    toast('Write what to do first.');
    input?.focus();
    return;
  }
  const day = $('#todoDay')?.value || undefined;
  const time = $('#todoTime')?.value || undefined;
  if (time && !day) {
    toast('Pick a day for the time too.');
    $('#todoDay')?.focus();
    return;
  }
  if (!S.addTodo({ title, day, time })) {
    toast("That couldn't be added.");
    return;
  }
  repaint();
  $('#todoIn')?.focus();
}

// ---------- changing one

// What a time does, here.
function remindText() {
  const plain = S.state.settings.notifyDetails ? '' : " On your lock screen it only says there's something on your list.";
  if (N.isNative) return S.state.settings.notify ? `With a time, Arise reminds you then.${plain}` : 'With a time, Arise reminds you then, once reminders are on (Settings).';
  if (webAlerts()) return `With a time, Arise reminds you then, while it's open on this device.${plain}`;
  return 'With a time, Arise can remind you while it\'s open: turn on reminders in Settings first.';
}

function editSheet(t) {
  openSheet(`<div class="todo-sheet" data-id="${esc(t.id)}">
    <p class="kicker">To do</p><h2 class="display sheet-title">Change it</h2>
    <form data-form="todo-save">
      <label class="field"><span class="k">What</span><input id="todoEditTitle" type="text" maxlength="200" value="${esc(t.title)}" autocomplete="off"></label>
      <label class="field"><span class="k">Day</span><input id="todoEditDay" type="date" value="${esc(t.day || '')}"></label>
      <label class="field"><span class="k">Time</span><input id="todoEditTime" type="time" value="${esc(t.time || '')}"></label>
      <label class="check"><input id="todoEditBig" type="checkbox" ${t.big ? 'checked' : ''}> Matters a lot (it goes first in What matters)</label>
      <p class="muted small">${esc(remindText())}${t.from ? ` Added by ${esc(t.from)}.` : ''}</p>
      <div class="row">
        <button class="btn primary small" type="submit">Save</button>
        <button class="btn ghost small danger" type="button" data-act="todo-del" data-id="${esc(t.id)}">Delete</button>
      </div>
    </form>
  </div>`);
}

function save() {
  const box = $('.todo-sheet');
  const id = box?.dataset.id;
  if (!id || !S.state.todos[id]) return;
  const title = ($('#todoEditTitle')?.value || '').trim();
  if (!title) {
    toast('Write what to do first.');
    return;
  }
  const day = $('#todoEditDay')?.value || null;
  const time = $('#todoEditTime')?.value || null;
  if (time && !day) {
    toast('Pick a day for the time too.');
    return;
  }
  S.editTodo(id, { title, day, time: day ? time : null, big: !!$('#todoEditBig')?.checked });
  closeSheet();
  repaint();
  toast('Saved.');
}

// True when it was one of these.
export function handleAction(act, el) {
  const id = el?.dataset?.id;
  switch (act) {
    case 'todo-tick': {
      const t = S.state.todos[id];
      if (!t) return true;
      S.setTodoDone(id, !t.done);
      repaint();
      return true;
    }
    case 'todo-edit': {
      const t = S.state.todos[id];
      if (t && !t.gone) editSheet(t);
      return true;
    }
    case 'todo-del': {
      const t = S.state.todos[id];
      if (!t) return true;
      S.removeTodo(id);
      if ($('.todo-sheet')) closeSheet();
      repaint();
      toast(`Deleted "${t.title}".`);
      return true;
    }
    default:
      return false;
  }
}

// Return in a box adds or saves, without the page reloading.
globalThis.document?.addEventListener('submit', (e) => {
  const form = e.target?.dataset?.form;
  if (form !== 'todo-add' && form !== 'todo-save') return;
  e.preventDefault();
  if (form === 'todo-add') add();
  else save();
});
