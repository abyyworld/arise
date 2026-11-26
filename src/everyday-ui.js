// On Today: the box to write anything (lib/capture.ts works out what it is, on the device, and
// shows it before saving: a to-do, groceries, money owed, a question for the coach or a note for
// the day), and the card with money owed and groceries (lib/everyday.ts).

import * as S from './store';
import * as AI from './ai.js';
import { classify, asKind } from './lib/capture';
import { questions, questionsLeft, threeThings } from './lib/questions';
import { looseEnds } from './lib/loose';
import * as BRIEF from './brief';
import * as REVIEW from './review';
import { balanceText, money, totals } from './lib/everyday';
import { noteWithFile } from './life/quick-note';
import { hasLifeStore, lifeStore } from './life/store-port';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';
import { todoCard, dayText } from './todos-ui.js';
import * as VOICE from './voice/voice-ui.js';
import './styles/everyday.css';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const TAB = 'arise-everyday-tab';
const tabNow = () => {
  try {
    return localStorage.getItem(TAB) === 'groceries' ? 'groceries' : 'money';
  } catch {
    return 'money';
  }
};

let hooks = { ask: () => false };
export const initEveryday = (h) => (hooks = { ...hooks, ...h });

// ---------- the box

const KINDS = [
  ['todo', 'To-do'],
  ['grocery', 'Groceries'],
  ['debt', 'Money owed'],
  ['question', 'Ask'],
  ['note', 'Note'],
];
let picked = null; // the kind the person picked, over the one worked out

export function captureCard() {
  return `<section class="panel capture" id="captureCard">
    <form data-form="capture">
      <label class="sr-only" for="captureIn">Write anything</label>
      <textarea id="captureIn" rows="2" maxlength="2000" placeholder="Write anything: a to-do, milk and eggs, Sam owes me 10, a question, or how your day went"></textarea>
      <p class="capture-what muted small" id="captureWhat" aria-live="polite"></p>
      <div class="capture-kinds chips" id="captureKinds" hidden role="group" aria-label="Save it as">${KINDS.map(([k, label]) => `<button type="button" class="chip" data-act="capture-kind" data-v="${k}" aria-pressed="false">${label}</button>`).join('')}</div>
      <div class="row capture-row">
        ${VOICE.micButton('captureIn', 'captureFile')}
        <label class="btn ghost small capture-file">${icon('note')} <span id="captureFileName">Add a file</span><input id="captureFile" type="file" hidden></label>
        <button class="btn primary small" type="submit" id="captureGo">Save</button>
      </div>
    </form>
  </section>`;
}

function current() {
  const text = ($('#captureIn')?.value || '').trim();
  if (!text) return null;
  const c = classify(text);
  return picked ? asKind(c, picked) : c;
}

function whatText(c, file) {
  if (file) return `Saves a note for today with ${file.name}.`;
  if (!c) return '';
  switch (c.kind) {
    case 'todo':
      return `A to-do: "${c.title}"${c.day ? `, ${dayText(c.day)}${c.time ? ` at ${c.time}` : ''}` : ''}.`;
    case 'grocery':
      return `Groceries: ${c.items.map((x) => (x.qty ? `${x.qty} ${x.name}` : x.name)).join(', ')}.`;
    case 'debt':
      return c.who && c.amount ? `${c.dir === 'owed' ? `${c.who} owes you` : `You owe ${c.who}`} ${money(c.amount, c.cur || S.currency())}${c.what ? ` for ${c.what}` : ''}${c.day ? `, by ${dayText(c.day)}` : ''}.` : 'Money owed: you fill in who and how much next.';
    case 'question':
      return 'A question for your coach.';
    default:
      return 'A note for today, in your life log.';
  }
}

function preview() {
  const c = current();
  const file = $('#captureFile')?.files?.[0] || null;
  const what = $('#captureWhat');
  const kinds = $('#captureKinds');
  if (what) what.textContent = whatText(c, file);
  if (kinds) {
    kinds.hidden = !c || !!file;
    kinds.querySelectorAll('[data-act="capture-kind"]').forEach((b) => {
      const on = !!c && b.dataset.v === c.kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  const go = $('#captureGo');
  if (go) go.textContent = c?.kind === 'question' && !file ? 'Ask' : 'Save';
}

function clear() {
  picked = null;
  const box = $('#captureIn');
  if (box) box.value = '';
  const f = $('#captureFile');
  if (f) f.value = '';
  const name = $('#captureFileName');
  if (name) name.textContent = 'Add a file';
  preview();
}

function repaintTodos() {
  const el = $('#todoCard');
  if (el) el.outerHTML = todoCard();
}

let saving = false;
async function saveNote(text, file) {
  if (!hasLifeStore()) {
    toast('Notes go in the life log, which this version of Arise does not have.');
    return false;
  }
  const event = await noteWithFile({ text, at: Date.now() }, file);
  if (!event) return false;
  const n = await (await lifeStore()).addEvents([event]);
  return n > 0;
}

async function capture() {
  if (saving) return;
  const file = $('#captureFile')?.files?.[0] || null;
  const c = current();
  if (!c && !file) {
    toast('Write something first.');
    $('#captureIn')?.focus();
    return;
  }
  saving = true;
  try {
    if (file || c.kind === 'note') {
      if (!(await saveNote(c?.text || '', file))) throw new Error("That couldn't be saved.");
      toast('Added to your day.');
      void refreshLoose();
    } else if (c.kind === 'todo') {
      if (!S.addTodo({ title: c.title, day: c.day, time: c.time })) throw new Error("That couldn't be added.");
      repaintTodos();
      toast(`Added to your to-dos${c.day ? ` for ${dayText(c.day).toLowerCase() === 'today' ? 'today' : dayText(c.day)}` : ''}.`);
    } else if (c.kind === 'grocery') {
      const n = S.addGroceries(c.items);
      setTab('groceries');
      toast(n ? `Added ${n === 1 ? c.items[0].name : `${n} things`} to groceries.` : 'Already on the list.');
    } else if (c.kind === 'debt') {
      if (c.who && c.amount) {
        S.addDebt({ who: c.who, amount: c.amount, cur: c.cur, dir: c.dir, what: c.what, due: c.day });
        setTab('money');
        toast('Saved.');
      } else {
        debtSheet({ text: c.text });
        clear();
        return;
      }
    } else if (c.kind === 'question') {
      if (!hooks.ask(c.text)) return;
    }
    clear();
  } catch (err) {
    toast(err?.message || "That couldn't be saved.");
  } finally {
    saving = false;
  }
}

// ---------- money owed and groceries

function setTab(tab) {
  try {
    localStorage.setItem(TAB, tab);
  } catch {}
  repaint();
}

function moneyPane() {
  const list = S.balances().filter((b) => b.net !== 0);
  const today = S.todayKey();
  const sum = totals(S.state.debts)
    .map((t) => [t.owed ? `you're owed ${money(t.owed, t.cur)}` : '', t.owe ? `you owe ${money(t.owe, t.cur)}` : ''].filter(Boolean).join(', '))
    .filter(Boolean);
  return `${sum.length ? `<p class="muted small">In all: ${esc(sum.join('; '))}.</p>` : ''}
    ${
      list.length
        ? `<ul class="qlist money-list">${list
            .map((b) => {
              const late = b.due && b.due < today;
              return `<li><button class="money-row ${b.net > 0 ? 'in' : 'out'}" data-act="money-person" data-v="${esc(b.who)}" data-cur="${esc(b.cur)}">
              <span class="money-who">${esc(balanceText(b))}</span>
              <span class="qmeta${late ? ' late' : ''}">${esc([b.items.length > 1 ? `${b.items.length} things` : b.items[0].what || '', b.due ? `${late ? 'Was due' : 'Due'} ${dayText(b.due, today)}` : ''].filter(Boolean).join(' · '))}</span>
            </button></li>`;
            })
            .join('')}</ul>`
        : '<p class="muted small">No one owes anyone. Write "Sam owes me 10 for lunch" in the box above, or add it here.</p>'
    }
    <div class="row"><button class="btn small" data-act="money-add">${icon('up')} Add</button></div>`;
}

function groceriesPane() {
  const list = S.groceriesList();
  const got = list.filter((g) => g.got);
  return `<form class="todo-add" data-form="grocery-add">
      <label class="sr-only" for="groceryIn">Add groceries</label>
      <input id="groceryIn" type="text" maxlength="300" placeholder="Milk, eggs, 2 bread" autocomplete="off" enterkeyhint="done">
      <button class="btn small primary" type="submit">Add</button>
    </form>
    ${
      list.length
        ? `<ul class="qlist grocery-list">${list
            .map(
              (g) => `<li class="qrow ${g.got ? 'done' : ''}">
            <button class="qcheck" data-act="grocery-tick" data-id="${esc(g.id)}" aria-pressed="${!!g.got}" aria-label="${esc(g.name)}: ${g.got ? 'bought' : 'to buy'}">${icon('check')}</button>
            <span class="qbody"><span class="qtitle">${esc(g.qty ? `${g.qty} ${g.name}` : g.name)}</span></span>
            <button class="icon-btn small" data-act="grocery-del" data-id="${esc(g.id)}" aria-label="Take ${esc(g.name)} off the list">${icon('close')}</button>
          </li>`,
            )
            .join('')}</ul>`
        : '<p class="muted small">Nothing to buy. Add things here, or write "buy milk and eggs" in the box above.</p>'
    }
    ${got.length ? `<div class="row"><button class="link" data-act="grocery-clear">Clear what you bought (${got.length})</button></div>` : ''}`;
}

export function everydayCard() {
  const tab = tabNow();
  return `<section class="panel everyday" id="everydayCard">
    <div class="panel-title">${icon('card')}<span>Money and groceries</span></div>
    <div class="seg" role="tablist" aria-label="Money and groceries">
      <button role="tab" data-act="everyday-tab" data-v="money" aria-selected="${tab === 'money'}" class="${tab === 'money' ? 'on' : ''}">Who owes whom</button>
      <button role="tab" data-act="everyday-tab" data-v="groceries" aria-selected="${tab === 'groceries'}" class="${tab === 'groceries' ? 'on' : ''}">Groceries${S.groceriesList().filter((g) => !g.got).length ? ` (${S.groceriesList().filter((g) => !g.got).length})` : ''}</button>
    </div>
    <div role="tabpanel">${tab === 'money' ? moneyPane() : groceriesPane()}</div>
  </section>`;
}

export function repaint() {
  const el = $('#everydayCard');
  if (el) el.outerHTML = everydayCard();
}

// ---------- sheets

const CURS = ['GBP', 'USD', 'EUR', 'UZS', 'KZT', 'RUB', 'TRY', 'INR', 'AED', 'JPY', 'CAD', 'AUD'];

function debtSheet({ who = '', text = '' } = {}) {
  const cur = S.currency();
  const curs = CURS.includes(cur) ? CURS : [cur, ...CURS];
  openSheet(`<div class="debt-sheet">
    <p class="kicker">Money owed</p><h2 class="display sheet-title">Add it</h2>
    ${text ? `<p class="muted small">You wrote: "${esc(text)}"</p>` : ''}
    <form data-form="debt-save">
      <div class="seg" role="group" aria-label="Which way">
        <button type="button" data-act="debt-dir" data-v="owed" class="on" aria-pressed="true">They owe me</button>
        <button type="button" data-act="debt-dir" data-v="owe" aria-pressed="false">I owe them</button>
      </div>
      <label class="field"><span class="k">Who</span><input id="debtWho" type="text" maxlength="60" value="${esc(who)}" autocomplete="off"></label>
      <div class="debt-amount">
        <label class="field"><span class="k">How much</span><input id="debtAmount" type="number" inputmode="decimal" min="0" step="0.01"></label>
        <label class="field"><span class="k">Currency</span><select id="debtCur">${curs.map((c) => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span class="k">What for <span class="muted">· if you like</span></span><input id="debtWhat" type="text" maxlength="120" autocomplete="off"></label>
      <label class="field"><span class="k">Pay back by <span class="muted">· if you like</span></span><input id="debtDue" type="date"></label>
      <button class="btn primary block" type="submit">Save</button>
      <p class="muted small">Kept with the rest of your Arise, locked before it syncs.</p>
    </form>
  </div>`);
  $(who ? '#debtAmount' : '#debtWho')?.focus();
}

function personSheet(who, cur) {
  const b = S.balances().find((x) => x.who.toLowerCase() === who.toLowerCase() && x.cur === cur);
  if (!b) {
    closeSheet();
    return;
  }
  const today = S.todayKey();
  openSheet(`<div class="person-sheet" data-who="${esc(b.who)}" data-cur="${esc(b.cur)}">
    <p class="kicker">Money owed</p><h2 class="display sheet-title">${esc(b.who)}</h2>
    <p>${esc(balanceText(b))}.</p>
    <ul class="qlist">${b.items
      .map(
        (x) => `<li class="qrow">
      <button class="qcheck" data-act="debt-settle" data-id="${esc(x.id)}" aria-label="Paid back: ${esc(x.what || money(x.amount, x.cur))}">${icon('check')}</button>
      <span class="qbody"><span class="qtitle">${esc(`${x.dir === 'owed' ? `${b.who} owes you` : `You owe ${b.who}`} ${money(x.amount, x.cur)}`)}</span>
      <span class="qmeta">${esc([x.what, x.due ? `${x.due < today ? 'Was due' : 'Due'} ${dayText(x.due, today)}` : '', `Added ${new Date(x.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`].filter(Boolean).join(' · '))}</span></span>
      <button class="icon-btn small" data-act="debt-del" data-id="${esc(x.id)}" aria-label="Delete">${icon('close')}</button>
    </li>`,
      )
      .join('')}</ul>
    <p class="muted small">Tick one when it's paid back.</p>
    <div class="row">
      <button class="btn primary small" data-act="debt-settle-all">All paid back</button>
      <button class="btn small" data-act="money-add" data-v="${esc(b.who)}">Add more</button>
    </div>
  </div>`);
}

function saveDebt() {
  const dir = $('.debt-sheet [data-act="debt-dir"].on')?.dataset.v === 'owe' ? 'owe' : 'owed';
  const who = ($('#debtWho')?.value || '').trim();
  const amount = Number($('#debtAmount')?.value);
  if (!who) {
    toast('Say who it is.');
    $('#debtWho')?.focus();
    return;
  }
  if (!(amount > 0)) {
    toast('Say how much.');
    $('#debtAmount')?.focus();
    return;
  }
  const cur = $('#debtCur')?.value || S.currency();
  if (cur !== S.state.settings.currency) {
    S.state.settings.currency = cur;
  }
  const d = S.addDebt({ who, amount, cur, dir, what: ($('#debtWhat')?.value || '').trim() || undefined, due: $('#debtDue')?.value || undefined });
  if (!d) {
    toast("That couldn't be saved.");
    return;
  }
  closeSheet();
  setTab('money');
  toast('Saved.');
}

// ---------- the morning brief (brief.ts): on Today until noon, when it's on

export function briefCard(now = new Date()) {
  if (!BRIEF.on() || now.getHours() >= 12) return '';
  let b;
  try {
    b = BRIEF.today();
  } catch {
    return '';
  }
  return `<section class="panel brief" id="briefCard">
    <div class="panel-title">${icon('today')}<span>Your morning brief</span></div>
    <ul class="brief-list">${b.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  </section>`;
}

// ---------- your week in review (review.ts): Sunday afternoon and Monday morning

export function reviewCard(now = new Date()) {
  const monday = REVIEW.on() ? REVIEW.weekNow(now) : null;
  if (!monday || S.state.dismissed[`review:${monday}`] != null) return '<div id="reviewCard"></div>';
  let r;
  try {
    r = REVIEW.reviewOf(monday);
  } catch {
    return '<div id="reviewCard"></div>';
  }
  const list = (xs) => `<ul class="brief-list">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return `<div id="reviewCard"><section class="panel review" data-week="${esc(monday)}">
    <div class="panel-title">${icon('progress')}<span>Your week</span></div>
    <p class="label">What went well</p>${list(r.wins)}
    ${r.numbers.length ? `<p class="label">In numbers</p>${list(r.numbers)}` : ''}
    <p class="label">One thing to try</p><p>${esc(r.try)}</p>
    <p class="label">Next week</p>${list(r.ahead)}
    <div class="row"><button class="btn small primary" data-act="review-done">Got it</button></div>
    <p class="muted small">Worked out on this device from your to-dos, quests, check-ins and what Arise saw.</p>
  </section></div>`;
}

// ---------- A quick one: short questions from your coach (lib/questions.ts)

function questionInput(now = new Date()) {
  const today = S.todayKey();
  const st = S.state;
  const lastTick = (g) => {
    const ids = new Set(g.quests.map((q) => q.id));
    for (let i = 0; i < 60; i++) {
      const k = S.addDays(today, -i);
      const day = st.checks[k];
      if (day && Object.entries(day).some(([id, c]) => ids.has(id) && c.done)) return k;
    }
    return null;
  };
  const monday = S.mondayOf(today);
  const sunday = S.addDays(monday, 6);
  return {
    today,
    hour: now.getHours(),
    weekday: now.getDay(),
    monday,
    todos: Object.values(st.todos).filter((t) => !t.gone),
    goals: S.activeGoals().map((g) => ({ id: g.id, title: g.title, quests: g.quests.filter((q) => !q.archived).length, lastTick: lastTick(g), created: g.created })),
    owed: Object.values(st.debts)
      .filter((d) => !d.gone && !d.settled && d.dir === 'owed')
      .map((d) => ({ id: d.id, who: d.who, text: `${money(d.amount, d.cur)}${d.what ? ` for ${d.what}` : ''}`, due: d.due })),
    bestTime: st.settings.bestTime,
    weekBig: Object.values(st.todos).filter((t) => !t.gone && !t.done && t.big && (!t.day || t.day <= sunday)).length,
    dismissed: st.dismissed,
    loose: looseCache.filter((l) => st.dismissed[`q:loose:${l.id}`] == null),
    now: now.getTime(),
    dayStart: S.parseKey(today).getTime(),
  };
}

// How many quick ones are left today, counting the one on screen (at most 6 a day: lib/questions.ts).
export const questionsLeftToday = () => questionsLeft(S.state.dismissed, S.parseKey(S.todayKey()).getTime());

// Loose ends in the last 2 weeks of their own notes (lib/loose.ts), read from the life log now
// and then: on opening, and after a note is added here.
let looseCache = [];
export async function refreshLoose(now = Date.now()) {
  if (!hasLifeStore()) return [];
  try {
    const L = await import('./life/log');
    const notes = (await L.eventsBetween(now - 14 * 86_400_000, now + 60_000, { sources: ['manual'] }))
      .filter((e) => e.kind === 'note' && typeof e.detail === 'string')
      .map((e) => ({ id: e.id, text: e.detail, at: e.at }));
    looseCache = looseEnds(notes, Object.values(S.state.todos).filter((t) => !t.gone), S.state.dismissed);
  } catch {
    return looseCache;
  }
  const el = $('#askCard');
  if (el) el.outerHTML = questionCard();
  return looseCache;
}

export function questionCard() {
  const q = questions(questionInput())[0];
  if (!q) return '<div id="askCard"></div>';
  const more = questionsLeftToday() - 1;
  return `<div id="askCard"><section class="panel ask" data-q="${esc(q.id)}">
    <div class="panel-title">${icon('chat')}<span>A quick one</span><button class="icon-btn small ask-x" data-act="q-skip" aria-label="Not now">${icon('close')}</button></div>
    <p class="ask-text">${esc(q.text)}</p>
    ${q.hint ? `<p class="muted small">${esc(q.hint)}</p>` : ''}
    ${
      q.write
        ? `<form data-form="q-write" data-act="${esc(q.write.act)}"><label class="sr-only" for="askIn">${esc(q.text)}</label><textarea id="askIn" class="log-text" rows="3" maxlength="400" placeholder="${esc(q.write.placeholder)}"></textarea><div class="row"><button class="btn small primary" type="submit">Save</button><button class="btn small ghost" type="button" data-act="q-skip">Not now</button></div></form>`
        : `<div class="row wrap">${q.choices.map((c, i) => `<button class="btn small${i === 0 ? ' primary' : ''}" data-act="${esc(c.act)}"${c.v ? ` data-v="${esc(c.v)}"` : ''}>${esc(c.label)}</button>`).join('')}</div>`
    }
    <p class="muted small ask-left">${more > 0 ? `Up to ${more} more today.` : 'Last one for today.'}</p>
  </section></div>`;
}

function repaintAll() {
  const el = $('#askCard');
  if (el) el.outerHTML = questionCard();
  repaintTodos();
  repaint();
}

function answered() {
  const id = $('#askCard [data-q]')?.dataset.q;
  if (!id) return;
  S.dismissWarning(`q:${id}`);
  // One getting-to-know-you question a day, answered or not.
  if (id.startsWith('know:')) S.dismissWarning(`q:know-day:${S.todayKey()}`);
}

async function answerKnow() {
  const text = ($('#askIn')?.value || '').trim();
  const q = $('#askCard .ask-text')?.textContent || '';
  if (!text) {
    toast('Write a few words, or tap Not now.');
    return;
  }
  if (!(await saveNote(text ? `${q}\n${text}` : '', null))) {
    toast("That couldn't be saved.");
    return;
  }
  answered();
  repaintAll();
  toast('Kept in your notes. Thank you.');
}

function answerWeek() {
  const things = threeThings($('#askIn')?.value || '');
  if (!things.length) {
    toast('Write at least one thing, or tap Not now.');
    return;
  }
  const sunday = S.addDays(S.mondayOf(S.todayKey()), 6);
  for (const title of things) {
    const t = S.addTodo({ title, day: sunday });
    if (t) S.editTodo(t.id, { big: true });
  }
  answered();
  repaintAll();
  toast(`Added ${things.length === 1 ? 'it' : `all ${things.length}`} for this week.`);
}

function answer(act, v) {
  switch (act) {
    case 'q-skip':
      break;
    case 'q-loose-done':
      toast('Nice. Put away.');
      break;
    case 'q-loose-todo':
      S.addTodo({ title: v });
      toast('Added to your to-dos.');
      break;
    case 'q-paid':
      S.settleDebt(v);
      toast('Marked as paid back.');
      break;
    case 'q-todo-day': {
      const [id, day] = (v || '').split('|');
      S.editTodo(id, { day });
      toast(`Moved to ${dayText(day).toLowerCase() === 'today' ? 'today' : dayText(day)}.`);
      break;
    }
    case 'q-todo-drop':
      S.removeTodo(v);
      toast('Dropped.');
      break;
    case 'q-goal-pause':
      S.setGoalStatus(v, 'paused');
      toast('Paused. Pick it up again in Goals.');
      break;
    case 'q-best':
      S.state.settings.bestTime = v;
      S.save();
      toast('Saved. Your plan uses it from now on.');
      break;
    default:
      return false;
  }
  answered();
  repaintAll();
  return true;
}

// ---------- Write it my way (on Coach)

export function writeCard() {
  return `<section class="panel write" id="writeCard">
    <div class="panel-title">${icon('note')}<span>Write it my way</span></div>
    <p class="small">Rough notes in, a message, email, post or comment out, in your own voice.</p>
    <div class="row"><button class="btn small primary" data-act="write-open">Write something</button></div>
  </section>`;
}

const WRITE_LABELS = [
  ['message', 'Message'],
  ['email', 'Email'],
  ['post', 'Post'],
  ['comment', 'Comment'],
];
let writeKind = 'message';
let writing = null; // AbortController while the AI writes

function writeSheet() {
  const voice = S.state.settings.voice || '';
  openSheet(`<div class="write-sheet">
    <p class="kicker">Write it my way</p><h2 class="display sheet-title">What do you want to say?</h2>
    <form data-form="write-go">
      <div class="seg" role="group" aria-label="What it is">${WRITE_LABELS.map(([k, l]) => `<button type="button" data-act="write-kind" data-v="${k}" class="${k === writeKind ? 'on' : ''}" aria-pressed="${k === writeKind}">${l}</button>`).join('')}</div>
      <label class="field"><span class="k">Your rough notes</span><textarea id="writeNotes" class="log-text" rows="5" maxlength="4000" placeholder="tell sam cant make fri, ill bring the book sat, sorry"></textarea></label>
      <label class="field"><span class="k">To <span class="muted">· if you like</span></span><input id="writeTo" type="text" maxlength="80" placeholder="My manager, a friend, a group chat" autocomplete="off"></label>
      <details class="write-voice"${voice ? '' : ' open'}><summary>How you write${voice ? ' (saved)' : ''}</summary>
        <label class="field"><span class="k">Paste a few messages you wrote yourself</span><textarea id="writeVoice" class="log-text" rows="4" maxlength="3000">${esc(voice)}</textarea></label>
        <p class="muted small">Arise copies how you sound from this, not what it says. Kept with the rest of your Arise.</p>
      </details>
      <button class="btn primary block" type="submit" id="writeGo">Write it</button>
      <div id="writeOut" aria-live="polite"></div>
      <p class="muted small">Only these words, and your sample, go to the AI you use. Nothing else of yours.</p>
    </form>
  </div>`);
  $('#writeNotes')?.focus();
}

async function writeGo() {
  if (writing) return;
  const notes = ($('#writeNotes')?.value || '').trim();
  if (!notes) {
    toast('Write your rough notes first.');
    $('#writeNotes')?.focus();
    return;
  }
  if (!AI.ready()) {
    toast('Turn on the AI coach in Settings first.');
    return;
  }
  const voice = ($('#writeVoice')?.value || '').trim().slice(0, 3000);
  if (voice !== (S.state.settings.voice || '')) {
    S.state.settings.voice = voice;
    S.save();
  }
  const out = $('#writeOut');
  const go = $('#writeGo');
  writing = new AbortController();
  if (go) {
    go.disabled = true;
    go.textContent = 'Writing...';
  }
  try {
    const text = await AI.writeMyWay(notes, writeKind, { to: ($('#writeTo')?.value || '').trim(), signal: writing.signal });
    if (out) out.innerHTML = `<div class="write-out" id="writeText">${esc(text)}</div><div class="row"><button class="btn small primary" type="button" data-act="write-copy">Copy</button><button class="btn small ghost" type="button" data-act="write-again">Write it again</button></div>`;
  } catch (err) {
    if (out) out.innerHTML = `<p class="muted small">${esc(err?.message || "That didn't work. Try again.")}</p>`;
  } finally {
    writing = null;
    if (go) {
      go.disabled = false;
      go.textContent = 'Write it';
    }
  }
}

// True when it was one of these.
export function handleAction(act, el) {
  if (act?.startsWith('voice-')) return VOICE.handleAction(act, el);
  const v = el?.dataset?.v;
  const id = el?.dataset?.id;
  switch (act) {
    case 'capture-kind':
      picked = v;
      preview();
      return true;
    case 'q-skip':
    case 'q-loose-done':
    case 'q-loose-todo':
    case 'q-paid':
    case 'q-todo-day':
    case 'q-todo-drop':
    case 'q-goal-pause':
    case 'q-best':
      return answer(act, v);
    case 'review-done': {
      const w = $('#reviewCard [data-week]')?.dataset.week;
      if (w) S.dismissWarning(`review:${w}`);
      const el = $('#reviewCard');
      if (el) el.outerHTML = reviewCard();
      toast('Have a good week.');
      return true;
    }
    case 'write-open':
      writeSheet();
      return true;
    case 'write-kind':
      writeKind = v in AI.WRITE_KINDS ? v : 'message';
      el.parentElement.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b === el);
        b.setAttribute('aria-pressed', String(b === el));
      });
      return true;
    case 'write-again':
      writeGo();
      return true;
    case 'write-copy': {
      const text = $('#writeText')?.textContent || '';
      globalThis.navigator?.clipboard?.writeText(text).then(
        () => toast('Copied.'),
        () => toast("Couldn't copy. Select the text and copy it."),
      );
      return true;
    }
    case 'everyday-tab':
      setTab(v === 'groceries' ? 'groceries' : 'money');
      return true;
    case 'money-add':
      debtSheet({ who: v || '' });
      return true;
    case 'money-person':
      personSheet(v, el.dataset.cur);
      return true;
    case 'debt-dir':
      el.parentElement.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b === el);
        b.setAttribute('aria-pressed', String(b === el));
      });
      return true;
    case 'debt-settle':
    case 'debt-del': {
      const d = S.state.debts[id];
      if (!d) return true;
      if (act === 'debt-settle') S.settleDebt(id);
      else S.removeDebt(id);
      repaint();
      personSheet(d.who, d.cur);
      toast(act === 'debt-settle' ? 'Marked as paid back.' : 'Deleted.');
      return true;
    }
    case 'debt-settle-all': {
      const box = $('.person-sheet');
      const b = S.balances().find((x) => x.who === box?.dataset.who && x.cur === box?.dataset.cur);
      for (const x of b?.items || []) S.settleDebt(x.id);
      closeSheet();
      repaint();
      toast('All paid back.');
      return true;
    }
    case 'grocery-tick': {
      const g = S.state.groceries[id];
      if (g) S.setGot(id, !g.got);
      repaint();
      return true;
    }
    case 'grocery-del':
      S.removeGroceries([id]);
      repaint();
      return true;
    case 'grocery-clear':
      S.removeGroceries(S.groceriesList().filter((g) => g.got).map((g) => g.id));
      repaint();
      return true;
    default:
      return false;
  }
}

function addGroceries() {
  const input = $('#groceryIn');
  const text = (input?.value || '').trim();
  if (!text) return;
  const c = asKind({ kind: 'note', text }, 'grocery');
  const n = S.addGroceries(c.items || []);
  repaint();
  $('#groceryIn')?.focus();
  if (!n) toast('Already on the list.');
}

globalThis.document?.addEventListener('submit', (e) => {
  const form = e.target?.dataset?.form;
  if (form === 'capture') {
    e.preventDefault();
    capture();
  } else if (form === 'grocery-add') {
    e.preventDefault();
    addGroceries();
  } else if (form === 'debt-save') {
    e.preventDefault();
    saveDebt();
  } else if (form === 'q-write') {
    e.preventDefault();
    if (e.target.dataset.act === 'q-know') void answerKnow();
    else answerWeek();
  } else if (form === 'write-go') {
    e.preventDefault();
    writeGo();
  }
});

globalThis.document?.addEventListener('input', (e) => {
  if (e.target?.id === 'captureIn') {
    if (!e.target.value.trim()) picked = null;
    preview();
  }
});
globalThis.document?.addEventListener('change', (e) => {
  if (e.target?.id === 'captureFile') {
    const f = e.target.files?.[0];
    const name = $('#captureFileName');
    if (name) name.textContent = f ? f.name : 'Add a file';
    preview();
  }
});
// Return saves; Shift+Return makes a new line.
globalThis.document?.addEventListener('keydown', (e) => {
  if (e.target?.id === 'captureIn' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    capture();
  }
});
