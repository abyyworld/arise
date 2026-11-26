// "What was sent to an AI" on screen (the log is src/ai-log.ts): a panel on What Arise knows, a way
// in from Settings, AI coach, and the sheet with the whole list, a filter by AI, the switch for
// keeping the full text and Delete all. Everything here stays on this device.

import { esc, icon, openSheet, toast } from './ui.js';
import * as SENT from './ai-log';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const ui = { ai: '', open: false };
const SHOW = 200; // in the sheet at once

const two = (n) => String(n).padStart(2, '0');
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
export function whenText(t, now = Date.now()) {
  const d = new Date(t);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (sameDay(t, now)) return `Today ${hm}`;
  if (sameDay(t, now - 86_400_000)) return `Yesterday ${hm}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${hm}`;
}

const aiText = (e) => (e.ai === 'own' || e.ai === 'local') && e.who ? e.who : SENT.AI_NAMES[e.ai];
const answerText = (e) => (e.answer === 'yes' ? 'Answered' : e.answer === 'stopped' ? 'Stopped' : `No answer: ${e.why || 'it failed'}`);

function rowHTML(e, now) {
  const parts = e.parts.map((p) => `<li>${esc(p.name)} <span class="muted">${esc(SENT.charsText(p.chars))}</span></li>`).join('');
  return `<li class="fact sent-row" data-id="${esc(e.id)}">
    <p><b>${esc(SENT.PURPOSES[e.for])}</b> to ${esc(aiText(e))}</p>
    <p class="muted small">${esc(whenText(e.at, now))} · ${esc(SENT.charsText(e.chars))} · ${esc(answerText(e))}${e.bg ? ' · Arise did this by itself' : ''}</p>
    ${e.tier ? `<p class="muted small">From your life log: up to ${esc(SENT.TIER_WORDS[e.tier])}.</p>` : ''}
    <details class="other"><summary>What went</summary><ul class="changes small">${parts}</ul>${e.text ? `<pre class="sent-text">${esc(e.text)}</pre>` : ''}</details>
  </li>`;
}

// The line under the panel's title: how many, and the last one.
function summaryText(list, now) {
  if (!list.length) return 'Nothing sent yet. Each time Arise asks an AI something, it shows here.';
  const week = list.filter((e) => e.at > now - 7 * 86_400_000).length;
  const last = list[0];
  return `${week} in the last 7 days. Last: ${SENT.PURPOSES[last.for].toLowerCase()} to ${aiText(last)}, ${whenText(last.at, now).toLowerCase()}.`;
}

// ---------- What Arise knows

export const knowsPanel = () => `<section class="panel" id="sentPanel">
    <div class="panel-title">${icon('system')}<span>What was sent to an AI</span></div>
    <p class="small" id="sentSummary">${esc(summaryText(SENT.sentList(), Date.now()))}</p>
    <button class="btn ghost small" data-act="sent-open">See what was sent</button>
    <p class="muted small">Kept on this device only, for 90 days.</p>
  </section>`;

export function fillPanel() {
  const el = $('#sentSummary');
  if (el) el.textContent = summaryText(SENT.sentList(), Date.now());
}

// ---------- Settings, AI coach

export const settingsLink = () => `<button class="btn ghost small" data-act="sent-open">What was sent to an AI</button>`;

// ---------- the sheet

function sheetHTML(now = Date.now()) {
  const all = SENT.sentList({ now });
  const ais = SENT.sentAIs(all);
  if (ui.ai && !ais.includes(ui.ai)) ui.ai = '';
  const list = ui.ai ? all.filter((e) => e.ai === ui.ai) : all;
  const full = SENT.fullText();
  const seg = (v, label) => `<button class="${ui.ai === v ? 'on' : ''}" data-act="sent-filter" data-v="${esc(v)}" aria-pressed="${ui.ai === v}">${esc(label)}</button>`;
  const chars = list.reduce((a, e) => a + e.chars, 0);
  return `<p class="kicker">On this device only</p>
    <h2 class="display sheet-title">What was sent to an AI</h2>
    <p class="muted small">Every time Arise asks an AI something: when, which AI, what for and how much went. The AI on this device and your computer's AI keep it all on your own machine.</p>
    ${ais.length > 1 ? `<div class="seg" role="group" aria-label="Which AI">${seg('', 'All')}${ais.map((a) => seg(a, SENT.AI_NAMES[a])).join('')}</div>` : ''}
    <p class="small" id="sentCount">${list.length ? `${list.length} request${list.length === 1 ? '' : 's'}, ${esc(SENT.charsText(chars))} in all.` : 'Nothing here yet.'}</p>
    ${list.length ? `<ul class="fact-list sent-list" id="sentList">${list.slice(0, SHOW).map((e) => rowHTML(e, now)).join('')}</ul>${list.length > SHOW ? `<p class="muted small">Showing the newest ${SHOW}.</p>` : ''}` : ''}
    <button class="toggle-row" data-act="sent-full" data-on="${!full}" aria-pressed="${full}"><span><b>Keep the full text</b><small>Off: only the sizes and parts are kept. On: the exact words sent are kept too, for 7 days, so you can read them here. Never synced.</small></span><span class="switch ${full ? 'on' : ''}"></span></button>
    ${all.length ? '<button class="btn ghost block danger" data-act="sent-del-all">Delete all</button>' : ''}`;
}

export function openSent() {
  ui.open = true;
  openSheet(sheetHTML());
}

function repaint() {
  const body = $('#sheet .sheet-body');
  if (ui.open && body && $('#sentCount', body)) body.innerHTML = sheetHTML();
  fillPanel();
}

let watching = false;
function watch() {
  if (watching) return;
  watching = true;
  SENT.onSentChange(() => repaint());
}

export function handleAction(act, el) {
  watch();
  switch (act) {
    case 'sent-open':
      openSent();
      return true;
    case 'sent-filter':
      ui.ai = el?.dataset?.v || '';
      repaint();
      return true;
    case 'sent-full': {
      const on = el?.dataset?.on === 'true';
      SENT.setFullText(on);
      repaint();
      toast(on ? 'The full text is kept for 7 days from now on.' : 'Full text off. What was kept is gone.');
      return true;
    }
    case 'sent-del-all':
      if (!confirm('Delete the whole list of what was sent to an AI? This only clears it on this device.')) return true;
      SENT.deleteAllSent();
      repaint();
      toast('Deleted.');
      return true;
    default:
      return false;
  }
}
