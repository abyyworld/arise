// Looking ahead on screen (src/ahead.ts, lib/ahead.ts, lib/decisions.ts):
//   Today: "Your plan" (the day around what's fixed, with what changed since you last looked, and
//   the week in a sheet), "Heads up" (early warnings, each can be put away), and "How did it go?"
//   for a decision whose check-back day came.
//   Coach: "Help me decide": ask about a choice, see the options side by side with Arise's pick
//   and reasons, say what you chose and what you expect, and when to check back. Saved decisions
//   can be opened, changed and deleted.
//   Settings: how many next-step messages a day, quiet hours, and when you think best.

import './styles/ahead.css';
import * as S from './store';
import * as AH from './ahead';
import * as AI from './ai.js';
import { hours } from './lib/ahead';
import { OUTCOME_TEXT } from './lib/decisions';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const hm = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const dayName = (k) => {
  if (k === S.todayKey()) return 'Today';
  if (k === S.addDays(S.todayKey(), 1)) return 'Tomorrow';
  return S.parseKey(k).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
};

const repaint = () => repaintCards();

// ---------- Today

export function planCard(now = Date.now()) {
  let t;
  try {
    t = AH.today(now);
  } catch {
    return '';
  }
  const { plan, changed } = t;
  const rows = plan.blocks
    .filter((b) => b.end > now)
    .map(
      (b) => `<li class="ahead-row ${b.kind}">
        <span class="ahead-time">${hm(b.start)}</span>
        <span class="ahead-what"><span class="ahead-title">${esc(b.title)}</span><span class="ahead-why">${esc(b.kind === 'fixed' ? 'Fixed' : b.kind === 'hard' ? `Needs focus · ${b.why}` : b.why)}</span></span>
        <span class="ahead-len">${esc(hours((b.end - b.start) / 60000))}</span>
      </li>`,
    );
  return `<section class="panel ahead" id="aheadPlan">
    <div class="panel-title">${icon('plan')}<span>Your plan</span><button class="link small ahead-week" data-act="ahead-week">This week</button></div>
    ${changed.length ? `<div class="ahead-changed" role="status"><p><b>Your day changed, so the plan did too.</b></p><ul>${changed.map((c) => `<li>${esc(c)}</li>`).join('')}</ul><button class="btn small ghost" data-act="ahead-seen">Got it</button></div>` : ''}
    ${rows.length ? `<ul class="ahead-list">${rows.join('')}</ul>` : '<p class="muted small">Nothing left to plan today.</p>'}
    ${plan.left.length ? `<p class="muted small">Didn't fit: ${esc(plan.left.map((x) => x.title).join(', '))}.</p>` : ''}
    ${plan.notes.map((n) => `<p class="muted small">${esc(n)}</p>`).join('')}
    <p class="muted small">A suggestion, worked out on this device from your goals, to-dos, calendar and sleep. You decide.</p>
  </section>`;
}

export function warningsCard(now = Date.now()) {
  let warns = [];
  try {
    warns = AH.today(now).warns;
  } catch {}
  if (!warns.length) return '';
  return `<section class="panel ahead-warn" id="aheadWarn">
    <div class="panel-title">${icon('bell')}<span>Heads up</span></div>
    <ul class="ahead-warns">${warns
      .slice(0, 3)
      .map(
        (w) => `<li class="ahead-w ${w.kind}">
        <div><p class="ahead-wt">${esc(w.title)}</p><p class="small">${esc(w.body)}</p></div>
        <button class="icon-btn small" data-act="ahead-dismiss" data-id="${esc(w.id)}" aria-label="Put away: ${esc(w.title)}">${icon('close')}</button>
      </li>`,
      )
      .join('')}</ul>
  </section>`;
}

export function checkBackCard(k = S.todayKey()) {
  const due = S.decisionsDue(k);
  if (!due.length) return '';
  const d = due[0];
  return `<section class="panel ahead-back" id="aheadBack">
    <div class="panel-title">${icon('target')}<span>How did it go?</span>${due.length > 1 ? `<span class="qcount">${due.length}</span>` : ''}</div>
    <p><b>${esc(d.question)}</b></p>
    <p class="small">You chose: ${esc(d.chose)}.${d.expect ? ` You expected: ${esc(d.expect)}.` : ''}</p>
    <div class="row wrap">${Object.entries(OUTCOME_TEXT)
      .map(([v, label]) => `<button class="btn small" data-act="decision-outcome" data-id="${esc(d.id)}" data-v="${v}">${esc(label)}</button>`)
      .join('')}</div>
    <button class="link small" data-act="decision-open" data-id="${esc(d.id)}">Add a note</button>
  </section>`;
}

// Today's cards from here, in order, in one place so they can be painted again on their own.
const cardsInner = () => [checkBackCard(), warningsCard(), planCard()].join('');
export const todayCards = () => [`<div id="aheadCards">${cardsInner()}</div>`];

// Paints what's on screen again: Today's cards, and the Decisions card on Coach.
export function repaintCards() {
  const cards = $('#aheadCards');
  if (cards) cards.innerHTML = cardsInner();
  const dec = $('#decideCard');
  if (dec) dec.outerHTML = decideCard();
}

function weekSheet() {
  let days = [];
  try {
    days = AH.week();
  } catch {}
  openSheet(`<div class="ahead-sheet">
    <h2>This week</h2>
    <p class="muted small">How full each day is, and where what's still to do this week fits best.</p>
    <ul class="ahead-days">${days
      .map((d) => {
        const total = d.busyMin + d.freeMin || 1;
        return `<li>
          <div class="ahead-day"><b>${esc(dayName(d.day))}</b><span class="muted small">${esc(hours(d.busyMin))} fixed · ${esc(hours(d.freeMin))} free</span></div>
          <div class="ahead-bar" aria-hidden="true"><span style="width:${Math.round((100 * d.busyMin) / total)}%"></span></div>
          ${d.items.length ? `<ul class="ahead-items">${d.items.map((x) => `<li>${esc(x.title)} <span class="muted small">${esc(x.why)}</span></li>`).join('')}</ul>` : ''}
        </li>`;
      })
      .join('')}</ul>
  </div>`);
}

// ---------- decisions (Coach)

export function decideCard() {
  const list = S.decisionsList();
  const due = S.decisionsDue().length;
  return `<section class="panel decide" id="decideCard">
    <div class="panel-title">${icon('target')}<span>Decisions</span></div>
    <p class="small">Ask about a choice. Arise lays out the options with what each costs you, says which it would pick and why, and checks back later on how it went. You decide.</p>
    <div class="row wrap">
      <button class="btn small primary" data-act="decide-new">Help me decide</button>
      ${list.length ? `<button class="btn small ghost" data-act="decide-list">Your decisions (${list.length})${due ? ` · ${due} to check` : ''}</button>` : ''}
    </div>
  </section>`;
}

let draft = null; // the advice being looked at: { question, details, options, pick, why, unknown, tier }
let asking = null; // AbortController while Arise works on it

function askSheet(question = '', details = '') {
  draft = null;
  const ready = AI.ready();
  openSheet(`<div class="decide-sheet">
    <h2>Help me decide</h2>
    <form data-form="decide-ask">
      <label for="decQ">What are you deciding?</label>
      <textarea id="decQ" rows="2" maxlength="600" placeholder="Should I take the job offer or stay where I am?" required>${esc(question)}</textarea>
      <label for="decD">Anything else Arise should know (optional)</label>
      <textarea id="decD" rows="3" maxlength="2000" placeholder="The options you see, what matters to you, any dates.">${esc(details)}</textarea>
      ${ready ? '' : `<p class="small muted">Set up the AI coach first (Settings, AI coach) to get advice. You can still save the decision yourself.</p>`}
      <div class="row wrap">
        ${ready ? '<button class="btn primary" type="submit">Ask Arise</button>' : ''}
        <button class="btn ghost" type="button" data-act="decide-self">Save without advice</button>
      </div>
      <p class="small muted">Arise uses what it knows about you: goals, calendar, plan, sleep, notes from your life log and past decisions, as far as the AI you use may read them.</p>
    </form>
    <div id="decOut" aria-live="polite"></div>
  </div>`);
  $('#decQ')?.focus();
}

function adviceHTML(a) {
  const opts = a.options
    .map(
      (o, i) => `<li class="dec-opt${o.name === a.pick ? ' picked' : ''}">
      <p class="dec-name">${esc(o.name)}${o.name === a.pick ? ' <span class="tag">Arise would pick this</span>' : ''}</p>
      <p class="small"><b>Costs:</b> ${esc(o.costs)}</p>
      <p class="small"><b>Moves you toward:</b> ${esc(o.gains)}</p>
      <label class="dec-choose"><input type="radio" name="decChose" value="${i}"> I choose this</label>
    </li>`,
    )
    .join('');
  return `<h3>Your options</h3>
    <ul class="dec-opts">${opts}</ul>
    ${a.why ? `<p><b>Why ${a.pick ? `"${esc(a.pick)}"` : 'Arise leans this way'}:</b> ${esc(a.why)}</p>` : ''}
    ${a.unknown ? `<p class="small muted"><b>What Arise doesn't know:</b> ${esc(a.unknown)}</p>` : ''}
    ${saveForm()}`;
}

function saveForm(d = null) {
  const weeks = d?.checkOn ? Math.max(1, Math.round(S.daysBetween(S.todayKey(), d.checkOn) / 7)) : 4;
  return `<form data-form="decide-save" class="dec-save">
    <label for="decOwn">${draft?.options?.length ? 'Or something else' : 'What did you choose?'}</label>
    <input id="decOwn" type="text" maxlength="200" placeholder="${draft?.options?.length ? 'Leave empty if you picked one above' : 'Your choice'}" value="${esc(d && !d.options.some((o) => o.name === d.chose) ? d.chose || '' : '')}">
    <label for="decExpect">What do you expect to happen?</label>
    <input id="decExpect" type="text" maxlength="600" placeholder="In a month I'll..." value="${esc(d?.expect || '')}">
    <label for="decWeeks">Check back in</label>
    <select id="decWeeks">${[2, 4, 6, 8, 12].map((n) => `<option value="${n}" ${n === weeks ? 'selected' : ''}>${n} weeks</option>`).join('')}</select>
    <div class="row wrap"><button class="btn primary" type="submit">Save decision</button>${d ? '' : '<button class="btn ghost" type="button" data-act="decide-later">Not decided yet</button>'}</div>
  </form>`;
}

async function ask() {
  const question = ($('#decQ')?.value || '').trim();
  const details = ($('#decD')?.value || '').trim();
  if (!question) {
    toast('Write the question first.');
    return;
  }
  const out = $('#decOut');
  asking?.abort();
  asking = new AbortController();
  if (out) out.innerHTML = `<p class="muted">Arise is weighing it up…</p><button class="btn small ghost" data-act="decide-stop">Stop</button>`;
  try {
    const a = await AI.adviseDecision(question, details, { signal: asking.signal });
    draft = { question, details, ...a };
    if ($('#decOut')) $('#decOut').innerHTML = adviceHTML(draft);
  } catch (err) {
    if ($('#decOut')) $('#decOut').innerHTML = `<p class="error">${esc(err?.name === 'AbortError' ? 'Stopped.' : err?.message || 'Something went wrong. Try again.')}</p>`;
  } finally {
    asking = null;
  }
}

function saveFromSheet(existing) {
  const pickIdx = Number(document.querySelector('input[name="decChose"]:checked')?.value);
  const own = ($('#decOwn')?.value || '').trim();
  const options = existing ? existing.options : draft?.options || [];
  const chose = own || (Number.isInteger(pickIdx) ? options[pickIdx]?.name : '') || existing?.chose || '';
  const expect = ($('#decExpect')?.value || '').trim();
  const weeks = Number($('#decWeeks')?.value) || 4;
  if (!chose) {
    toast('Pick an option or write what you chose.');
    return;
  }
  const checkOn = S.addDays(S.todayKey(), weeks * 7);
  if (existing) S.updateDecision(existing.id, { chose, expect: expect || null, checkOn });
  else {
    const question = draft?.question || ($('#decQ')?.value || '').trim();
    if (!question) {
      toast('Write the question first.');
      return;
    }
    S.addDecision({ question, details: draft?.details || ($('#decD')?.value || '').trim() || undefined, options, pick: draft?.pick || undefined, why: draft?.why || undefined, unknown: draft?.unknown || undefined, tier: draft?.tier > 1 ? draft.tier : undefined, chose, expect: expect || undefined, checkOn });
  }
  draft = null;
  closeSheet();
  repaint();
  toast(`Saved. Arise will ask how it went on ${S.parseKey(checkOn).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}.`);
}

function saveUndecided() {
  const question = draft?.question || ($('#decQ')?.value || '').trim();
  if (!question) return;
  S.addDecision({ question, details: draft?.details || undefined, options: draft?.options || [], pick: draft?.pick || undefined, why: draft?.why || undefined, unknown: draft?.unknown || undefined, tier: draft?.tier > 1 ? draft.tier : undefined });
  draft = null;
  closeSheet();
  repaint();
  toast('Saved. Open it from Decisions when you choose.');
}

function listSheet() {
  const list = S.decisionsList();
  openSheet(`<div class="decide-sheet">
    <h2>Your decisions</h2>
    ${
      list.length
        ? `<ul class="dec-list">${list
            .map(
              (d) => `<li><button class="dec-row" data-act="decision-open" data-id="${esc(d.id)}">
          <span class="dec-q">${esc(d.question)}</span>
          <span class="muted small">${esc(new Date(d.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))} · ${esc(d.outcome ? OUTCOME_TEXT[d.outcome] : d.chose ? `Chose ${d.chose}` : 'Not decided yet')}</span>
        </button></li>`,
            )
            .join('')}</ul>`
        : '<p class="muted">No decisions yet.</p>'
    }
  </div>`);
}

function openSheetFor(id) {
  const d = S.state.decisions[id];
  if (!d || d.gone) return;
  draft = null;
  openSheet(`<div class="decide-sheet">
    <h2>${esc(d.question)}</h2>
    ${d.details ? `<p class="small">${esc(d.details)}</p>` : ''}
    ${
      d.options.length
        ? `<ul class="dec-opts">${d.options
            .map(
              (o, i) => `<li class="dec-opt${o.name === d.pick ? ' picked' : ''}"><p class="dec-name">${esc(o.name)}${o.name === d.pick ? ' <span class="tag">Arise picked</span>' : ''}${o.name === d.chose ? ' <span class="tag">You chose</span>' : ''}</p>
          <p class="small"><b>Costs:</b> ${esc(o.costs)}</p><p class="small"><b>Moves you toward:</b> ${esc(o.gains)}</p>
          <label class="dec-choose"><input type="radio" name="decChose" value="${i}" ${o.name === d.chose ? 'checked' : ''}> I choose this</label></li>`,
            )
            .join('')}</ul>`
        : ''
    }
    ${d.why ? `<p><b>Why:</b> ${esc(d.why)}</p>` : ''}
    ${d.unknown ? `<p class="small muted"><b>What Arise didn't know:</b> ${esc(d.unknown)}</p>` : ''}
    ${saveForm(d).replace('data-form="decide-save"', `data-form="decide-update" data-id="${esc(d.id)}"`)}
    ${
      d.chose
        ? `<h3>How did it go?</h3>
      <div class="row wrap">${Object.entries(OUTCOME_TEXT)
        .map(([v, label]) => `<button class="btn small ${d.outcome === v ? 'primary' : ''}" data-act="decision-outcome" data-id="${esc(d.id)}" data-v="${v}" aria-pressed="${d.outcome === v}">${esc(label)}</button>`)
        .join('')}</div>
      <label for="decNote">A note (optional)</label>
      <textarea id="decNote" rows="2" maxlength="1000">${esc(d.note || '')}</textarea>
      <button class="btn small ghost" data-act="decision-note" data-id="${esc(d.id)}">Save note</button>`
        : ''
    }
    <p><button class="link small danger" data-act="decision-del" data-id="${esc(d.id)}">Delete this decision</button></p>
  </div>`);
}

// ---------- Settings

export function settingsHTML() {
  const st = S.state.settings;
  return `<div class="ahead-settings" id="aheadSettings">
    <h3 class="sub">Next-step messages</h3>
    <p class="small muted">A few messages at the right moment with your next step, from your plan and early warnings. On the phone apps they're planned on the phone. On the web they come while Arise is open.</p>
    <label class="field"><span>How many a day</span>
      <select data-set="nudges">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${st.nudges === n ? 'selected' : ''}>${n === 0 ? 'None' : n}</option>`).join('')}</select></label>
    <label class="field"><span>Quiet from</span><input type="time" data-set="quietFrom" value="${esc(st.quietFrom)}"></label>
    <label class="field"><span>Quiet until</span><input type="time" data-set="quietTo" value="${esc(st.quietTo)}"></label>
    <label class="field"><span>I think best in</span>
      <select data-set="bestTime">${[
        ['', 'Work it out from when I wake'],
        ['morning', 'The morning'],
        ['afternoon', 'The afternoon'],
        ['evening', 'The evening'],
      ]
        .map(([v, l]) => `<option value="${v}" ${st.bestTime === v ? 'selected' : ''}>${l}</option>`)
        .join('')}</select></label>
  </div>`;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
globalThis.document?.addEventListener('change', (e) => {
  const el = e.target;
  const key = el?.dataset?.set;
  if (!key || !el.closest?.('#aheadSettings')) return;
  const st = S.state.settings;
  if (key === 'nudges') st.nudges = Math.max(0, Math.min(5, Number(el.value) || 0));
  else if ((key === 'quietFrom' || key === 'quietTo') && TIME.test(el.value)) st[key] = el.value;
  else if (key === 'bestTime' && ['', 'morning', 'afternoon', 'evening'].includes(el.value)) st.bestTime = el.value;
  else return;
  S.save();
  toast('Saved.');
});

// ---------- actions

globalThis.document?.addEventListener('submit', (e) => {
  const form = e.target?.dataset?.form;
  if (form === 'decide-ask') {
    e.preventDefault();
    void ask();
  } else if (form === 'decide-save') {
    e.preventDefault();
    saveFromSheet(null);
  } else if (form === 'decide-update') {
    e.preventDefault();
    saveFromSheet(S.state.decisions[e.target.dataset.id] || null);
  }
});

// True when it was one of these.
export function handleAction(act, el) {
  const id = el?.dataset?.id;
  switch (act) {
    case 'ahead-week':
      weekSheet();
      return true;
    case 'ahead-seen':
      AH.sawChanges();
      repaint();
      return true;
    case 'ahead-dismiss':
      if (id) S.dismissWarning(id);
      repaint();
      toast('Put away.');
      return true;
    case 'decide-new':
      askSheet();
      return true;
    case 'decide-stop':
      asking?.abort();
      return true;
    case 'decide-self': {
      const question = ($('#decQ')?.value || '').trim();
      if (!question) {
        toast('Write the question first.');
        return true;
      }
      draft = { question, details: ($('#decD')?.value || '').trim(), options: [] };
      if ($('#decOut')) $('#decOut').innerHTML = saveForm();
      return true;
    }
    case 'decide-later':
      saveUndecided();
      return true;
    case 'decide-list':
      listSheet();
      return true;
    case 'decision-open':
      if (id) openSheetFor(id);
      return true;
    case 'decision-outcome': {
      const v = el?.dataset?.v;
      if (!id || !OUTCOME_TEXT[v]) return true;
      S.updateDecision(id, { outcome: v, closed: Date.now() });
      if ($('.decide-sheet')) openSheetFor(id);
      repaint();
      toast('Thanks. Arise learns from it.');
      return true;
    }
    case 'decision-note': {
      if (!id) return true;
      const note = ($('#decNote')?.value || '').trim();
      S.updateDecision(id, { note: note || null });
      toast('Saved.');
      return true;
    }
    case 'decision-del': {
      const d = S.state.decisions[id];
      if (!d) return true;
      S.removeDecision(id);
      closeSheet();
      repaint();
      toast('Deleted.');
      return true;
    }
    default:
      return false;
  }
}
