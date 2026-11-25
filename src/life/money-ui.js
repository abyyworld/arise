// Money, from Me (next to Your world): where the money went, from the Player's bank statements.
// Spending and money in per month, this month against the usual, the top categories with the
// merchants in each (tap one to put it in another category; kept in the synced state), the
// biggest payments, subscriptions found, and money owed between them and other people (1.34).
// All worked out on this device (lib/money.ts, life/money.ts); nothing is sent. No advice on
// investing or interest: just where it went.

import '../styles/money.css';
import * as S from '../store';
import * as MN from '../lib/money';
import * as EV2 from '../lib/everyday';
import * as MO from './money';
import { VIEW as IMPORT } from './import-ui.js';
import { closeSheet, esc, icon, openSheet, toast } from '../ui.js';

export const VIEW = 'money';
const MAX_AGE = 60_000;
const SHOW_MONTHS = 6;

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
let token = 0;

// ---------- the way in, on Me

export function entryCard() {
  return `<section class="panel money-entry">
    <h2 class="panel-title">${icon('card')}<span>Money</span></h2>
    <p class="muted small">Where your money went, from your bank statements. Worked out on this device.</p>
    <div class="row"><button class="btn small" data-act="nav" data-v="${VIEW}">See your money</button></div>
  </section>`;
}

// ---------- the screen

export function renderMoney(root) {
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">You</p><h1 class="display">Money</h1></div>
      <button class="btn small ghost" data-act="nav" data-v="progress">${icon('back')} Me</button>
    </header>
    <div id="mnBody">${MO.peekTxs() ? bodyHTML() : '<section class="panel"><p class="muted small">Reading…</p></section>'}</div>`;
  void fill();
}

async function fill() {
  const t = ++token;
  try {
    await MO.getTxs({ maxAge: MAX_AGE });
  } catch {}
  const el = $('#mnBody');
  if (t !== token || !el?.isConnected) return;
  el.innerHTML = bodyHTML();
}

function redraw() {
  const el = $('#mnBody');
  if (el) el.innerHTML = bodyHTML();
}

const day = (at) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const share = (x) => `${Math.round(x * 100)}%`;
const payments = (n) => `${n} ${n === 1 ? 'payment' : 'payments'}`;

function bodyHTML(now = Date.now()) {
  const s = MO.summary(now);
  if (!s) {
    return `<section class="panel mn-empty">
        <div class="panel-title"><span>No bank statements yet</span></div>
        <p class="muted">Bring in a statement from your bank (a CSV file), and Arise shows where your money went. It stays on this device.</p>
        <div class="row"><button class="btn small" data-act="nav" data-v="${IMPORT}">Bring in a statement</button></div>
      </section>
      ${owedPanel()}
      ${footHTML()}`;
  }
  return [thisMonth(s), months(s), whereItWent(s), biggest(s), subs(s), owedPanel(), others(s), footHTML()].join('');
}

function thisMonth(s) {
  const c = (n) => MN.cash(n, s.cur, true);
  const p = s.pace;
  const inNow = s.months.find((m) => m.month === p.month)?.in || 0;
  let vs = '<p class="muted small">Arise needs a whole month of statements to say what your usual is.</p>';
  if (p.usualByNow != null) {
    const d = p.spent - p.usualByNow;
    const word = Math.abs(d) < Math.max(1, p.usualByNow * 0.05) ? 'About the same as usual.' : d > 0 ? `${c(d)} more than usual by now.` : `${c(-d)} less than usual by now.`;
    vs = `<p>${esc(word)}</p><p class="muted small">By this day of the month you usually spend ${esc(c(p.usualByNow))}. A usual month: ${esc(c(p.usualMonth))} (from ${p.months} ${p.months === 1 ? 'month' : 'months'}).</p>`;
  }
  return `<section class="panel mn-now">
    <div class="panel-title"><span>This month</span></div>
    <div class="body-stats"><div><span class="k">Spent so far</span><b>${esc(c(p.spent))}</b><span class="s">${esc(MN.monthName(p.month))}</span></div><div><span class="k">Money in</span><b>${esc(c(inNow))}</b><span class="s">so far</span></div></div>
    ${vs}
  </section>`;
}

function months(s) {
  const list = s.months.slice(-SHOW_MONTHS).reverse();
  const most = Math.max(1, ...list.map((m) => Math.max(m.out, m.in)));
  const c = (n) => MN.cash(n, s.cur, true);
  const bar = (v, cls) => `<span class="mn-bar ${cls}" style="width:${Math.max(v > 0 ? 2 : 0, Math.round((v / most) * 100))}%"></span>`;
  return `<section class="panel mn-months">
    <div class="panel-title"><span>Month by month</span></div>
    <ul class="mn-list">${list
      .map(
        (m) => `<li class="mn-month"><b>${esc(MN.monthName(m.month))}</b>
        <span class="mn-line"><span>Spent ${esc(c(m.out))}</span>${bar(m.out, 'out')}</span>
        <span class="mn-line"><span>In ${esc(c(m.in))}</span>${bar(m.in, 'in')}</span></li>`,
      )
      .join('')}</ul>
  </section>`;
}

function whereItWent(s) {
  if (!s.top.length) return '';
  const cats = S.moneyCats();
  const c = (n) => MN.cash(n, s.cur, true);
  return `<section class="panel mn-cats">
    <div class="panel-title"><span>Where it went</span></div>
    <p class="muted small">The last 3 months. Tap a place to change its category.</p>
    ${s.top
      .slice(0, 8)
      .map(
        (x) => `<details class="mn-cat"><summary><b>${esc(MN.CATS[x.cat])}</b> <span>${esc(c(x.total))}</span> <small class="muted">${share(x.share)}</small></summary>
        <ul class="mn-list">${x.merchants
          .slice(0, 12)
          .map((m) => `<li><button class="mn-row" data-act="mn-merchant" data-k="${esc(m.key)}"><span>${esc(MN.merchantName(m.key))}${MN.isOwnCat(m.key, cats) ? ' <small class="muted">(your category)</small>' : ''}</span><span>${esc(c(m.total))} <small class="muted">${payments(m.n)}</small></span></button></li>`)
          .join('')}</ul></details>`,
      )
      .join('')}
  </section>`;
}

function biggest(s) {
  if (!s.big.length) return '';
  return `<section class="panel mn-big">
    <div class="panel-title"><span>Biggest payments</span></div>
    <p class="muted small">The last 3 months.</p>
    <ul class="mn-list">${s.big
      .map((t) => `<li><button class="mn-row" data-act="mn-merchant" data-k="${esc(t.key)}"><span>${esc(MN.merchantName(t.key))} <small class="muted">${esc(day(t.at))}, ${esc(MN.CATS[MN.categoryOf(t.key, S.moneyCats())])}</small></span><span>${esc(MN.cash(t.amount, s.cur))}</span></button></li>`)
      .join('')}</ul>
  </section>`;
}

function subs(s) {
  const c = (n) => MN.cash(n, s.cur);
  const body = s.subs.length
    ? `<ul class="mn-list">${s.subs.map((x) => `<li class="mn-sub"><span><b>${esc(MN.merchantName(x.key))}</b> <small class="muted">last paid ${esc(day(x.last))}</small></span><span>${esc(c(x.amount))} a month <small class="muted">about ${esc(MN.cash(x.amount * 12, s.cur, true))} a year</small></span></li>`).join('')}</ul>
      <p class="muted small">The same amount to the same place about once a month, at least 3 times.</p>`
    : '<p class="muted small">None found. A subscription shows here once the same amount goes to the same place about once a month, 3 times or more.</p>';
  return `<section class="panel mn-subs"><div class="panel-title"><span>Subscriptions</span></div>${body}</section>`;
}

// Money owed between them and other people (lib/everyday.ts), in each currency.
function owedPanel() {
  const t = EV2.totals(S.state.debts).filter((x) => x.owed || x.owe);
  const lines = t.length
    ? t.map((x) => `<p>${[x.owed ? `People owe you ${esc(EV2.money(x.owed, x.cur))}.` : '', x.owe ? `You owe others ${esc(EV2.money(x.owe, x.cur))}.` : ''].filter(Boolean).join(' ')}</p>`).join('')
    : '<p class="muted small">Nothing owed between you and other people.</p>';
  return `<section class="panel mn-owed"><div class="panel-title"><span>Money owed</span></div>${lines}<button class="link small" data-act="nav" data-v="today">On Today →</button></section>`;
}

function others(s) {
  if (!s.others) return '';
  return `<p class="muted small mn-note">${s.others} ${s.others === 1 ? 'payment is' : 'payments are'} in another currency, so ${s.others === 1 ? "it isn't" : "they aren't"} counted here.</p>`;
}

const footHTML = () => '<p class="muted small mn-note">Worked out on this device from your bank statements. Nothing is sent. Your coach reads only a short summary of each month, and only an AI that may read money.</p>';

// ---------- changing a category

function merchantSheet(key) {
  const cats = S.moneyCats();
  const now = MN.categoryOf(key, cats);
  const own = MN.isOwnCat(key, cats);
  openSheet(`<div class="mn-sheet" data-k="${esc(key)}">
    <p class="kicker">Category</p><h2 class="display sheet-title">${esc(MN.merchantName(key))}</h2>
    <p class="muted small">${own ? 'You put it in' : 'Arise put it in'} ${esc(MN.CATS[now])}. Pick another, and every payment there moves with it.</p>
    <div class="mn-picks">${Object.entries(MN.CATS)
      .map(([id, label]) => `<button class="btn small${id === now ? ' primary' : ' ghost'}" data-act="mn-cat" data-k="${esc(key)}" data-v="${id}" aria-pressed="${id === now}">${esc(label)}</button>`)
      .join('')}</div>
    ${own ? `<button class="link small" data-act="mn-cat" data-k="${esc(key)}" data-v="">Back to Arise's guess</button>` : ''}
  </div>`);
}

export function handleAction(act, el) {
  if (act === 'mn-merchant') {
    if (el.dataset.k) merchantSheet(el.dataset.k);
    return true;
  }
  if (act === 'mn-cat') {
    const key = el.dataset.k;
    const cat = el.dataset.v || null;
    if (key && S.setMoneyCat(key, cat)) {
      closeSheet();
      toast(cat ? `${MN.merchantName(key)} is in ${MN.CATS[cat]} now.` : `${MN.merchantName(key)} is back to Arise's guess.`);
      redraw();
    }
    return true;
  }
  return false;
}
