// Look back, from Your days: a day, a month or a year, with arrows to step back and forward. What
// happened (counted on this device: lookback.ts), the journal for a day, and what Arise knew about
// the Player then, with what changed since (the snapshots: fixes.ts). No AI unless they tap "Ask
// the coach", which goes through the coach's own rules for what each AI may read.

import * as SYS from '../system.js';
import { esc, fmt, icon, openSheet } from '../ui.js';
import * as M from './memory';
import { readKnew } from './fix-store';
import { dayKey } from './dates';
import { daysOf, keyOf, kindText, knewThen, rangeOf, step, tally } from './lookback';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const today = () => dayKey(Date.now());
const look = { span: 'month', key: '' };
let token = 0;

const SPANS = [
  ['day', 'Day'],
  ['month', 'Month'],
  ['year', 'Year'],
];
const SHOW = 8;

const longDay = (k) => fmt(k, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDay = (k) => fmt(k, { weekday: 'short', day: 'numeric', month: 'short' });
const plainDay = (k) => fmt(k, { day: 'numeric', month: 'long', year: 'numeric' });
export function titleOf(span, key) {
  if (span === 'day') return longDay(key);
  if (span === 'month') return fmt(`${key}-01`, { month: 'long', year: 'numeric' });
  return key;
}
const thisOne = (span) => ({ day: 'this day', month: 'this month', year: 'this year' })[span];
// Never after the one today is in.
const latest = (span) => keyOf(span, today());
const clampKey = (span, key) => (key > latest(span) ? latest(span) : key);

// Opens Look back on the month (or `span`) a day is in.
export function openLookBack(day, span = look.span) {
  const k = /^\d{4}-\d{2}-\d{2}$/.test(day || '') && day <= today() ? day : today();
  look.span = SPANS.some(([s]) => s === span) ? span : 'month';
  look.key = keyOf(look.span, k);
  openSheet(`<div id="lookBack">${shellHTML()}</div>`);
  fill();
}

function pickerHTML() {
  const { span, key } = look;
  if (span === 'day') return `<input id="lookPick" type="date" value="${esc(key)}" max="${esc(today())}">`;
  if (span === 'month') return `<input id="lookPick" type="month" value="${esc(key)}" max="${esc(latest('month'))}">`;
  return `<input id="lookPick" type="number" inputmode="numeric" min="1990" max="${esc(latest('year'))}" value="${esc(key)}">`;
}

function shellHTML() {
  const { span, key } = look;
  const seg = SPANS.map(([v, label]) => `<button class="${span === v ? 'on' : ''}" data-act="lookback-span" data-v="${v}" aria-pressed="${span === v}">${label}</button>`).join('');
  return `<p class="kicker">${icon('days')} Look back</p>
    <div class="seg" role="group" aria-label="Look back by">${seg}</div>
    <div class="life-nav">
      <button class="icon-btn" data-act="lookback-step" data-d="-1" aria-label="Before">${icon('back')}</button>
      <div class="life-nav-day">
        <b class="lookback-title">${esc(titleOf(span, key))}</b>
        <label class="sr-only" for="lookPick">Pick a ${span}</label>
        ${pickerHTML()}
      </div>
      <button class="icon-btn" data-act="lookback-step" data-d="1" aria-label="After" ${key >= latest(span) ? 'disabled' : ''}>${icon('next')}</button>
    </div>
    <div id="lookBody"><div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Looking back…</div></div>`;
}

function redraw() {
  const el = $('#lookBack');
  if (!el) return;
  el.innerHTML = shellHTML();
  fill();
}

const listHTML = (rows) => `<ul class="changes">${rows.map((r) => `<li>${r}</li>`).join('')}</ul>`;
const counted = (list, one) => listHTML(list.map(([name, n]) => `${esc(name)} <span class="muted">(${n.toLocaleString()} ${n === 1 ? one : `${one}s`})</span>`));

function happenedHTML(t, journal) {
  const { span, key } = look;
  if (!t.total) return `<p class="muted">Nothing in your log for ${thisOne(span)}.</p>${journal}`;
  const parts = [`<p>${t.total.toLocaleString()} ${t.total === 1 ? 'thing' : 'things'} in your log.</p>`, listHTML(t.kinds.slice(0, SHOW).map(([k, n]) => esc(kindText(k, n))))];
  if (journal) parts.push(journal);
  if (span !== 'day') {
    if (t.days.length)
      parts.push(
        `<p class="label">Busiest days</p><ul class="hist-list">${t.days
          .map(([k, n]) => `<li><button class="hist" data-act="life-open-day" data-day="${esc(k)}"><span class="hist-date">${esc(shortDay(k))}</span><span class="hist-name">${n.toLocaleString()} ${n === 1 ? 'thing' : 'things'}</span></button></li>`)
          .join('')}</ul>`,
      );
  }
  if (t.places.length) parts.push(`<p class="label">Places</p>${counted(t.places, 'time')}`);
  if (t.people.length) parts.push(`<p class="label">People</p>${counted(t.people, 'time')}`);
  if (t.sites.length) parts.push(`<p class="label">Sites</p>${counted(t.sites, 'visit')}`);
  if (key && span === 'day') parts.push(`<button class="btn ghost small" data-act="life-journal" data-day="${esc(key)}">${icon('note')} Open this day</button>`);
  return parts.join('');
}

function knewHTML(then) {
  const { span, key } = look;
  const { knew, first, changes } = then;
  if (!knew) {
    if (first) return `<p class="muted">Arise started keeping this on ${esc(plainDay(first))}.</p>`;
    return `<p class="muted">Arise hasn't kept this yet. It starts once it knows something about you.</p>`;
  }
  const facts = knew.facts.map((f) => esc(f.text));
  const now = daysOf(span, key).last >= today();
  const head = `<p class="muted small">${now ? 'What it knows now.' : `As it stood on ${esc(plainDay(knew.day))}.`}</p>`;
  const shown = facts.length ? listHTML(facts.slice(0, SHOW)) : '<p class="muted">Nothing yet.</p>';
  const more = facts.length > SHOW ? `<details class="other"><summary>${facts.length - SHOW} more</summary>${listHTML(facts.slice(SHOW))}</details>` : '';
  if (now || !changes) return head + shown + more;
  const { added, changed, dropped } = changes;
  const what = [];
  if (added.length) what.push(`<p class="label">Learned since</p>${listHTML(added.slice(0, SHOW).map(esc))}`);
  if (changed.length) what.push(`<p class="label">Changed since</p>${listHTML(changed.slice(0, SHOW).map((c) => `${esc(c.now)} <span class="muted">(was: ${esc(c.was)})</span>`))}`);
  if (dropped.length) what.push(`<p class="label">No longer known</p>${listHTML(dropped.slice(0, SHOW).map(esc))}`);
  const diff = what.length ? what.join('') : '<p class="muted small">Nothing has changed since then.</p>';
  return `${head}${shown}${more}<p class="kicker lookback-changed">What changed since then</p>${diff}`;
}

async function journalOf(k) {
  try {
    const intro = (await M.builtJournal(k)).intro.trim();
    return intro ? `<p class="journal-intro">${esc(intro)}</p>` : '';
  } catch {
    return '';
  }
}

async function fill() {
  const me = ++token;
  const { span, key } = look;
  let html;
  try {
    const [from, to] = rangeOf(span, key);
    await M.load().catch(() => {});
    const [t, list, journal] = await Promise.all([tally(from, to), readKnew(), span === 'day' ? journalOf(key) : '']);
    const then = knewThen(list, span, key, M.knewNow());
    const ask = `<button class="btn ghost small" data-act="lookback-ask">${icon('system')} Ask the coach about ${thisOne(span)}</button>`;
    html = `<section class="lookback-part"><p class="kicker">What happened</p>${happenedHTML(t, journal)}</section>
      <section class="lookback-part"><p class="kicker">What Arise knew about you then</p>${knewHTML(then)}</section>
      <div class="row">${ask}</div>
      <p class="muted small">Worked out on this device. Asking the coach sends your question to the AI you use, which reads only what it may.</p>`;
  } catch (err) {
    html = `<p class="error small">${esc(err?.message || "Your log couldn't be read.")}</p>`;
  }
  if (me !== token) return;
  const el = $('#lookBody');
  if (el) el.innerHTML = html;
}

// The question for the coach: its own rules decide what of the log the AI may read.
export function askText(span, key) {
  if (span === 'day') return `What happened on ${key}? Tell me about that day.`;
  if (span === 'month') return `What happened in my life in ${titleOf(span, key)}?`;
  return `What happened in my life in ${key}? Give me the highlights of the year.`;
}

export function handleAction(act, el) {
  const d = el.dataset;
  switch (act) {
    case 'lookback-open':
      openLookBack(d.day, d.span);
      return true;
    case 'lookback-span': {
      const span = SPANS.some(([s]) => s === d.v) ? d.v : 'month';
      const day = look.span === 'day' ? look.key : daysOf(look.span, look.key).first;
      look.span = span;
      look.key = clampKey(span, keyOf(span, day > today() ? today() : day));
      redraw();
      return true;
    }
    case 'lookback-step':
      look.key = clampKey(look.span, step(look.span, look.key, Number(d.d) < 0 ? -1 : 1));
      redraw();
      $(`#lookBack [data-act="lookback-step"][data-d="${Number(d.d) < 0 ? -1 : 1}"]`)?.focus();
      return true;
    case 'lookback-ask':
      SYS.askCoach(askText(look.span, look.key), { about: 2 });
      return true;
    default:
      return false;
  }
}

// Picking a day, month or year.
globalThis.document?.addEventListener('change', (e) => {
  if (e.target?.id !== 'lookPick') return;
  const v = String(e.target.value || '');
  const ok = look.span === 'day' ? /^\d{4}-\d{2}-\d{2}$/.test(v) : look.span === 'month' ? /^\d{4}-\d{2}$/.test(v) : /^\d{4}$/.test(v);
  if (!ok) return;
  look.key = clampKey(look.span, v);
  redraw();
});
