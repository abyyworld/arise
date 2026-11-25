// People (src/people.ts): the screen, opened from Me, with the people who matter, when you were
// last in touch and how often, the ones you might want to reach out to first; who to keep in touch
// with and how often; birthdays and other yearly dates; and who to hide for good. On Today, a card
// when a close person is overdue ("Done", "Later", "Stop for them") and when a date is today or
// tomorrow. All worked out on this device; nothing is sent.

import './styles/people.css';
import * as S from './store';
import * as N from './native.js';
import * as PP from './people';
import * as P from './lib/people';
import { allowed as webAlerts } from './todo-alerts.js';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';

export const VIEW = 'people';
const SHOW = 30; // rows before "Show everyone"
const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const ui = { all: false };

const OFTEN_CHOICES = [['', 'Off'], ...P.OFTEN.map((o) => [o, P.OFTEN_TEXT[o]])];

// ---------- the way in, on Me

export function entryCard() {
  const close = PP.shown().filter((r) => r.close).length;
  const next = PP.coming(30)[0];
  return `<section class="panel people-entry">
    <h2 class="panel-title">${icon('person')}<span>People</span></h2>
    <p class="muted small">The people who matter, when you were last in touch, and their birthdays. Worked out on this device.</p>
    ${close || next ? `<p class="small">${[close ? `Keeping in touch with ${close}.` : '', next ? `Next: ${esc(P.dateName(next.name, next.label))}, ${P.whenText(next.in)}.` : ''].filter(Boolean).join(' ')}</p>` : ''}
    <div class="row"><button class="btn small" data-act="nav" data-v="${VIEW}">See your people</button></div>
  </section>`;
}

// ---------- on Today

export function todayCard(now = Date.now()) {
  const due = PP.overdue(now);
  const soon = PP.coming(1);
  if (!due.length && !soon.length) return '<div id="peopleToday" hidden></div>';
  const top = due[0];
  return `<section class="panel people-today" id="peopleToday">
    <div class="panel-title">${icon('person')}<span>Keep in touch</span></div>
    ${soon.map((c) => `<p class="people-date-line">${c.in === 0 ? 'Today' : 'Tomorrow'}: ${esc(P.dateName(c.name, c.label))}.</p>`).join('')}
    ${
      top
        ? `<p>${esc(P.nudgeText(top.name, top.overdue))}</p>
    <div class="row">
      <button class="btn small primary" data-act="people-done" data-key="${esc(top.key)}">Done</button>
      <button class="btn small ghost" data-act="people-later" data-key="${esc(top.key)}">Later</button>
      <button class="btn small ghost" data-act="people-stop" data-key="${esc(top.key)}">Stop for them</button>
    </div>
    ${due.length > 1 ? `<p class="muted small">${due.length - 1} more to catch up with. <button class="link" data-act="nav" data-v="${VIEW}">See your people</button></p>` : ''}`
        : ''
    }
  </section>`;
}

// ---------- the screen

const detail = (r, now) => [r.last ? `In touch ${P.agoText(r.last, now).toLowerCase()}` : 'Not in touch lately', P.oftenText(r.days, PP.WINDOW)].filter(Boolean).join(' · ');

function rowHTML(r, now) {
  return `<li><button class="people-row${r.overdue != null ? ' due' : ''}" data-act="people-open" data-key="${esc(r.key)}">
    <b>${esc(r.name)}</b>
    <span class="muted small">${esc(detail(r, now))}</span>
    ${r.close || r.overdue != null ? `<span class="people-tags">${r.close ? `<span class="pill">${esc(P.OFTEN_TEXT[r.close])}</span>` : ''}${r.overdue != null ? `<span class="pill due">${esc(P.sinceText(r.overdue))} now</span>` : ''}</span>` : ''}
  </button></li>`;
}

function remindText() {
  const plain = S.state.settings.notifyDetails ? '' : ' On your lock screen it only says there is a date.';
  if (N.isNative) return S.state.settings.notify ? `Arise reminds you the evening before and on the day.${plain}` : 'Arise reminds you the evening before and on the day, once reminders are on (Settings).';
  if (webAlerts()) return `Arise reminds you the evening before and on the day, while it's open on this device.${plain}`;
  return "Arise can remind you the evening before and on the day while it's open: turn on reminders in Settings first.";
}

function bodyHTML(now = Date.now()) {
  const list = PP.shown(now);
  const rows = ui.all ? list : list.slice(0, SHOW);
  const dates = PP.coming(366).slice(0, 8);
  const found = PP.foundDates(now);
  const hidden = PP.hiddenRows(now);
  return `<section class="panel">
      <div class="panel-title">${icon('person')}<span>Reach out</span>${list.length ? `<span class="qcount">${list.length}</span>` : ''}</div>
      <p class="muted small">From your calls, messages, calendar and notes, on this device. The ones you might want to reach out to come first. Tap someone to keep in touch, add a birthday or hide them.</p>
      ${
        rows.length
          ? `<ul class="people-list" id="peopleList">${rows.map((r) => rowHTML(r, now)).join('')}</ul>${list.length > rows.length ? `<button class="link" data-act="people-all">Show everyone (${list.length})</button>` : ''}`
          : '<p class="muted small" id="peopleList">No one yet. Arise finds people in your calls and messages once your phone is connected or your history is brought in. You can add someone yourself below.</p>'
      }
    </section>
    <section class="panel">
      <div class="panel-title">${icon('calendar')}<span>Birthdays and dates</span></div>
      ${
        dates.length
          ? `<ul class="people-dates">${dates.map((c) => `<li><button class="people-row" data-act="people-open" data-key="${esc(c.key)}"><b>${esc(P.dateName(c.name, c.label))}</b><span class="muted small">${esc(P.mdText(c.md))}, ${esc(P.whenText(c.in))}</span></button></li>`).join('')}</ul>`
          : '<p class="muted small">No dates yet. Tap someone to add their birthday.</p>'
      }
      <p class="muted small">${esc(remindText())}</p>
      ${
        found.length
          ? `<p class="label">Found in your calendar</p><ul class="people-found">${found
              .slice(0, 10)
              .map((f) => `<li><span>${esc(P.dateName(f.name, 'Birthday'))}, ${esc(P.mdText(f.md))}</span><button class="btn small" data-act="people-found-add" data-key="${esc(f.key)}" data-name="${esc(f.name)}" data-md="${esc(f.md)}">Add</button></li>`)
              .join('')}</ul>`
          : ''
      }
    </section>
    <section class="panel">
      <div class="panel-title">${icon('heart')}<span>Add someone</span></div>
      <form class="people-add" data-form="people-add">
        <label class="field"><span class="k">Name</span><input id="peopleName" type="text" maxlength="${P.NAME_MAX}" autocomplete="off" placeholder="Mum"></label>
        <label class="field"><span class="k">Birthday (the year doesn't matter)</span><input id="peopleBirthday" type="date"></label>
        <label class="field"><span class="k">Keep in touch</span><select id="peopleOften">${OFTEN_CHOICES.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select></label>
        <button class="btn small primary" type="submit">Add</button>
      </form>
    </section>
    ${
      hidden.length
        ? `<details class="panel people-hidden"><summary>Hidden (${hidden.length})</summary><ul>${hidden.map((r) => `<li><span>${esc(r.name)}</span><button class="btn small ghost" data-act="people-unhide" data-key="${esc(r.key)}">Show again</button></li>`).join('')}</ul></details>`
        : ''
    }`;
}

export function renderPeople(root) {
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">You</p><h1 class="display">People</h1></div>
      <button class="btn small ghost" data-act="nav" data-v="progress">${icon('back')} Me</button>
    </header>
    <div id="peopleScreen">${bodyHTML()}</div>`;
  void PP.refresh();
}

// Paints what's on screen again: the screen, the card on Today and an open person.
export function repaint() {
  const scr = $('#peopleScreen');
  if (scr) scr.innerHTML = bodyHTML();
  const card = $('#peopleToday');
  if (card) card.outerHTML = todayCard();
  const sheet = $('.people-sheet');
  if (sheet?.dataset.key) personSheet(sheet.dataset.key);
}
PP.onPeopleChange(() => repaint());

// ---------- one person

function personSheet(key) {
  const now = Date.now();
  const r = PP.rows(now).find((x) => x.key === key);
  if (!r) return closeSheet();
  const seen = PP.seenNow().get(key);
  const from = seen ? [seen.calls ? 'calls and messages' : '', seen.named ? 'your calendar and notes' : ''].filter(Boolean).join(' and ') : '';
  openSheet(`<div class="people-sheet" data-key="${esc(key)}">
    <p class="kicker">People</p><h2 class="display sheet-title">${esc(r.name)}</h2>
    <p class="muted small">${esc(detail(r, now))}.${from ? ` From ${esc(from)}.` : ''}</p>
    <p class="label">Keep in touch</p>
    <div class="seg" role="group" aria-label="Keep in touch">${OFTEN_CHOICES.map(([v, t]) => `<button data-act="people-close" data-key="${esc(key)}" data-v="${v}" class="${(r.close || '') === v ? 'on' : ''}" aria-pressed="${(r.close || '') === v}">${esc(t)}</button>`).join('')}</div>
    <p class="muted small">${r.close ? `Arise nudges you on Today when it's been longer than that.${r.overdue != null ? ` It's been ${esc(P.sinceText(r.overdue))}.` : ''}` : 'Mark them as close, and Arise nudges you on Today when it has been too long.'}</p>
    <div class="row"><button class="btn small" data-act="people-done" data-key="${esc(key)}">In touch today</button></div>
    <p class="label">Birthdays and dates</p>
    ${r.dates.length ? `<ul class="people-found">${r.dates.map((d, i) => `<li><span>${esc(d.label)}: ${esc(P.mdText(d.md))}</span><button class="icon-btn small" data-act="people-date-del" data-key="${esc(key)}" data-i="${i}" aria-label="Take away ${esc(d.label)}">${icon('close')}</button></li>`).join('')}</ul>` : ''}
    ${
      r.dates.length < P.MAX_DATES
        ? `<form class="people-add" data-form="people-date">
      <label class="field"><span class="k">What</span><input id="peopleDateLabel" type="text" maxlength="${P.LABEL_MAX}" placeholder="Birthday" autocomplete="off"></label>
      <label class="field"><span class="k">Day (the year doesn't matter)</span><input id="peopleDateDay" type="date"></label>
      <button class="btn small" type="submit">Add the date</button>
    </form>`
        : ''
    }
    <div class="row people-sheet-end">
      ${r.own && !r.seen ? `<button class="btn small ghost danger" data-act="people-remove" data-key="${esc(key)}">Remove</button>` : `<button class="btn small ghost danger" data-act="people-hide" data-key="${esc(key)}">Hide for good</button>`}
    </div>
  </div>`);
}

const mdFrom = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v.slice(5) : '');

function addFromForm() {
  const name = ($('#peopleName')?.value || '').trim();
  if (!name) {
    toast('Write their name first.');
    $('#peopleName')?.focus();
    return;
  }
  const md = mdFrom($('#peopleBirthday')?.value);
  const often = $('#peopleOften')?.value || '';
  const key = PP.addPerson(name, often ? { close: often } : {});
  if (!key) {
    toast("That couldn't be added.");
    return;
  }
  if (md) PP.addDate(key, 'Birthday', md);
  repaint();
  toast(`Added ${name}.`);
}

function addDateFromForm() {
  const key = $('.people-sheet')?.dataset.key;
  if (!key) return;
  const md = mdFrom($('#peopleDateDay')?.value);
  if (!md) {
    toast('Pick the day first.');
    $('#peopleDateDay')?.focus();
    return;
  }
  if (!PP.addDate(key, $('#peopleDateLabel')?.value || 'Birthday', md)) {
    toast("That couldn't be added.");
    return;
  }
  repaint();
  toast('Date added.');
}

// True when it was one of these.
export function handleAction(act, el) {
  const key = el?.dataset?.key;
  const name = () => PP.nameOf(key) || 'them';
  switch (act) {
    case 'people-open':
      if (key) personSheet(key);
      return true;
    case 'people-all':
      ui.all = true;
      repaint();
      return true;
    case 'people-close': {
      const v = el.dataset.v || null;
      if (key && PP.setClose(key, v)) toast(v ? `Keeping in touch with ${name()}: ${P.OFTEN_TEXT[v].toLowerCase()}.` : `No more nudges for ${name()}.`);
      repaint();
      return true;
    }
    case 'people-done':
      if (key && PP.touched(key)) toast(`Noted: in touch with ${name()} today.`);
      repaint();
      return true;
    case 'people-later':
      if (key && PP.later(key)) toast(`Arise asks again about ${name()} in a week.`);
      repaint();
      return true;
    case 'people-stop':
      if (key && PP.setClose(key, null)) toast(`No more nudges for ${name()}.`);
      repaint();
      return true;
    case 'people-hide': {
      const who = name();
      if (key && PP.hide(key)) {
        closeSheet();
        toast(`${who} is hidden. You can show them again at the bottom of People.`);
      }
      repaint();
      return true;
    }
    case 'people-unhide':
      if (key && PP.unhide(key)) toast(`${name()} is back.`);
      repaint();
      return true;
    case 'people-remove': {
      const who = name();
      if (key && PP.remove(key)) {
        closeSheet();
        toast(`Removed ${who}.`);
      }
      repaint();
      return true;
    }
    case 'people-date-del':
      if (key) PP.removeDate(key, Number(el.dataset.i));
      repaint();
      return true;
    case 'people-found-add': {
      const k = PP.addPerson(el.dataset.name || '');
      if (k && PP.addDate(k, 'Birthday', el.dataset.md || '')) toast(`Added ${el.dataset.name}'s birthday.`);
      repaint();
      return true;
    }
    default:
      return false;
  }
}

// Return in a box adds, without the page reloading.
globalThis.document?.addEventListener('submit', (e) => {
  const form = e.target?.dataset?.form;
  if (form !== 'people-add' && form !== 'people-date') return;
  e.preventDefault();
  if (form === 'people-add') addFromForm();
  else addDateFromForm();
});
