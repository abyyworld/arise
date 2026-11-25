// Focus on screen (focus.ts): Start on a block of the plan, or Focus on its own; a bar on Today
// with the time left, Pause and Stop; and when it ends, a sheet to tick the quest or the to-do,
// with the time kept in the life log as a note.

import * as F from './focus';
import * as S from './store';
import { makeNote } from './life/quick-note';
import { hasLifeStore, lifeStore } from './life/store-port';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
let hooks = { replan: () => {} };
export const initFocus = (h) => {
  hooks = { ...hooks, ...h };
  tickLater();
};

export function bar(now = Date.now()) {
  const f = F.current();
  if (!f) return '<div id="focusBar"></div>';
  const ms = F.left(f, now);
  return `<div id="focusBar"><section class="panel focus-bar" role="timer" aria-live="off">
    <div class="focus-row">
      <span class="focus-clock" id="focusClock">${F.clock(ms)}</span>
      <span class="focus-what"><b>${esc(f.title)}</b><small class="muted">${f.paused ? 'Paused' : `${f.min} min of focus`}</small></span>
      ${f.paused ? `<button class="btn small" data-act="focus-resume">Go on</button>` : `<button class="btn small ghost" data-act="focus-pause">Pause</button>`}
      <button class="btn small ghost" data-act="focus-stop">Stop</button>
    </div>
  </section></div>`;
}

function repaint() {
  const el = $('#focusBar');
  if (el) el.outerHTML = bar();
}

// Ticks the clock while a focus runs; finishes it when the time is up.
let timer = null;
function tickLater() {
  clearInterval(timer);
  timer = null;
  if (!F.current()) return;
  timer = setInterval(() => {
    const f = F.current();
    if (!f) return tickLater();
    if (F.done(f)) {
      finish(true);
      return;
    }
    const c = $('#focusClock');
    if (c) c.textContent = F.clock(F.left(f));
  }, 1000);
}

export function startSheet(title = '', task = '', min = 25) {
  openSheet(`<div class="focus-sheet" data-task="${esc(task)}">
    <p class="kicker">Focus</p><h2 class="display sheet-title">Start a focus block</h2>
    <form data-form="focus-go">
      <label class="field"><span class="k">On what</span><input id="focusTitle" type="text" maxlength="120" value="${esc(title)}" placeholder="Essay draft" autocomplete="off"></label>
      <div class="seg" role="group" aria-label="How long">${[15, 25, 45, 60, 90].map((m) => `<button type="button" data-act="focus-min" data-v="${m}" class="${m === min ? 'on' : ''}" aria-pressed="${m === min}">${m} min</button>`).join('')}</div>
      <button class="btn primary block" type="submit">Start</button>
      <p class="muted small">Arise lets you know when the time is up. Your phone stays yours: nothing is blocked.</p>
    </form>
  </div>`);
  $('#focusTitle')?.focus();
}

function go() {
  const title = ($('#focusTitle')?.value || '').trim() || 'Focus';
  const min = Number($('.focus-sheet [data-act="focus-min"].on')?.dataset.v) || 25;
  const task = $('.focus-sheet')?.dataset.task || undefined;
  F.start(title, min, task);
  closeSheet();
  repaint();
  tickLater();
  hooks.replan();
  toast(`${min} minutes on ${title}. Go.`);
}

async function keepInLog(f, ran) {
  if (ran < 5 || !hasLifeStore()) return;
  try {
    const e = makeNote({ title: `Focused ${ran} min: ${f.title}`, text: `Focused ${ran} minutes on ${f.title}.`, at: Date.now() });
    if (e) await (await lifeStore()).addEvents([{ ...e, meta: { ...(e.meta || {}), focus: ran } }]);
  } catch {}
}

function finish(timeUp = false) {
  const out = F.stop();
  clearInterval(timer);
  timer = null;
  repaint();
  hooks.replan();
  if (!out) return;
  const { f, ran } = out;
  void keepInLog(f, ran);
  const qid = f.task?.startsWith('q:') ? f.task.slice(2) : '';
  const tid = f.task?.startsWith('t:') ? f.task.slice(2) : '';
  const quest = qid && S.activeQuests().find((x) => x.quest.id === qid);
  const todo = tid && S.state.todos[tid] && !S.state.todos[tid].gone && !S.state.todos[tid].done ? S.state.todos[tid] : null;
  openSheet(`<div class="focus-done">
    <p class="kicker">Focus</p><h2 class="display sheet-title">${timeUp ? 'Time is up' : 'Stopped'}</h2>
    <p>${ran ? `${ran} minutes on ${esc(f.title)}.` : `Stopped before a minute on ${esc(f.title)}.`}${ran >= 5 ? ' Kept in your day.' : ''}</p>
    <div class="row wrap">
      ${quest ? `<button class="btn small primary" data-act="focus-tick" data-v="${esc(qid)}">Tick "${esc(quest.quest.title)}"</button>` : ''}
      ${todo ? `<button class="btn small primary" data-act="focus-todo" data-v="${esc(tid)}">Mark "${esc(todo.title)}" done</button>` : ''}
      <button class="btn small" data-act="focus-again">Another block</button>
      <button class="btn small ghost" data-act="focus-close">Take a break</button>
    </div>
  </div>`);
}

// True when it was one of these.
export function handleAction(act, el) {
  const v = el?.dataset?.v;
  switch (act) {
    case 'focus-new':
      startSheet();
      return true;
    case 'focus-start':
      startSheet(el.dataset.title || '', el.dataset.task || '', Math.min(90, Math.max(15, Number(el.dataset.min) || 25)));
      return true;
    case 'focus-min':
      el.parentElement.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b === el);
        b.setAttribute('aria-pressed', String(b === el));
      });
      return true;
    case 'focus-pause':
      F.pause();
      repaint();
      hooks.replan();
      return true;
    case 'focus-resume':
      F.resume();
      repaint();
      tickLater();
      hooks.replan();
      return true;
    case 'focus-stop':
      finish(false);
      return true;
    case 'focus-tick':
      S.tick(v, { done: true });
      closeSheet();
      toast('Ticked off.');
      return true;
    case 'focus-todo':
      S.setTodoDone(v, true);
      closeSheet();
      toast('Done.');
      return true;
    case 'focus-again':
      startSheet();
      return true;
    case 'focus-close':
      closeSheet();
      return true;
    default:
      return false;
  }
}

globalThis.document?.addEventListener('submit', (e) => {
  if (e.target?.dataset?.form !== 'focus-go') return;
  e.preventDefault();
  go();
});
