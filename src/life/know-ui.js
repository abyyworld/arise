// The flags on each fact in What Arise knows (know.ts): "Never send to an AI", "Check again on" a
// day, "Imported, not confirmed", and the facts to look at again: two that may say the same thing
// (merge them) and two that disagree (which is right?).

import { esc, fmt, closeSheet, openSheet, toast } from '../ui.js';
import * as M from './memory';
import { addDays, dayKey } from './dates';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const failed = (err) => toast(err?.message || "That couldn't be saved.");
const today = () => dayKey(Date.now());
const day = (k) => fmt(k, { day: 'numeric', month: 'short', year: k.slice(0, 4) === today().slice(0, 4) ? undefined : 'numeric' });
const factOf = (id) => M.allFacts().find((f) => f.id === id) || null;

// ---------- on each fact

// The flags, as small tags under the fact.
export function flagTags(f) {
  const fl = M.flagOf(f.id);
  const tags = [];
  if (fl?.noAI) tags.push('<span class="tag">Never sent to an AI</span>');
  if (fl?.check && !f.until) tags.push(`<span class="tag">Check again on ${esc(day(fl.check))}</span>`);
  if (M.isUnconfirmed(f)) tags.push('<span class="tag">Imported, not confirmed</span>');
  return tags.length ? `<p class="fact-flags">${tags.join(' ')}</p>` : '';
}

// The buttons that set them.
export function flagButtons(f) {
  const fl = M.flagOf(f.id);
  const out = [];
  if (M.isUnconfirmed(f)) out.push(`<button class="link" data-act="know-ok" data-id="${esc(f.id)}">It's right</button>`);
  out.push(`<button class="link" data-act="know-noai" data-id="${esc(f.id)}" data-on="${fl?.noAI ? 'false' : 'true'}">${fl?.noAI ? 'Let AIs read it' : 'Never send to an AI'}</button>`);
  if (!f.until) out.push(`<button class="link" data-act="know-check" data-id="${esc(f.id)}">Check again on…</button>`);
  return out.join('');
}

function openCheck(id) {
  const f = factOf(id);
  if (!f) return;
  const fl = M.flagOf(id);
  const k = fl?.check || addDays(today(), 90);
  openSheet(`<p class="kicker">Check again on</p>
    <h2 class="display sheet-title life-ev-title">${esc(f.text)}</h2>
    <label class="field inline"><span class="k">On</span><input id="knowCheck" type="date" min="${esc(addDays(today(), 1))}" value="${esc(k)}"></label>
    <button class="btn primary block" data-act="know-check-save" data-id="${esc(id)}">Save</button>
    ${fl?.check ? `<button class="btn ghost block" data-act="know-check-off" data-id="${esc(id)}">Don't ask</button>` : ''}
    <p class="muted small">On that day, Today asks if it's still true.</p>`);
}

// ---------- to look at again

export function checksPanel() {
  const rows = checkRows();
  return `<section class="panel" id="knowChecks"${rows.length ? '' : ' hidden'}>
    <div class="panel-title"><span>Look at these</span></div>
    <div id="knowChecksList">${rows.length ? `<ul class="fact-list">${rows.join('')}</ul>` : ''}</div>
  </section>`;
}

let shown = { dupes: [], clashes: [] };

export function fillChecks() {
  const box = $('#knowChecks');
  if (!box || !M.isLoaded()) return;
  const rows = checkRows();
  box.hidden = !rows.length;
  const list = $('#knowChecksList');
  if (list) list.innerHTML = rows.length ? `<ul class="fact-list">${rows.join('')}</ul>` : '';
}

function checkRows() {
  if (!M.isLoaded()) return [];
  shown = M.factPairs();
  return [
    ...shown.clashes.map((p, i) => `<li class="fact"><p class="fact-text">These two disagree</p><p class="muted small">“${esc(p.a.text)}” and “${esc(p.b.text)}”</p><div class="fact-acts"><button class="link" data-act="know-clash" data-i="${i}">Which is right?</button></div></li>`),
    ...shown.dupes.map((p, i) => `<li class="fact"><p class="fact-text">These may say the same</p><p class="muted small">“${esc(p.a.text)}” and “${esc(p.b.text)}”</p><div class="fact-acts"><button class="link" data-act="know-dupe" data-i="${i}">Merge them?</button></div></li>`),
  ];
}

function openClash(i) {
  const p = shown.clashes[i];
  if (!p) return;
  openSheet(`<p class="kicker">These two disagree</p>
    <h2 class="display sheet-title">Which is right?</h2>
    <button class="btn block" data-act="know-right" data-a="${esc(p.a.id)}" data-b="${esc(p.b.id)}">${esc(p.a.text)}</button>
    <button class="btn block" data-act="know-right" data-a="${esc(p.b.id)}" data-b="${esc(p.a.id)}">${esc(p.b.text)}</button>
    <button class="btn ghost block" data-act="know-apart" data-a="${esc(p.a.id)}" data-b="${esc(p.b.id)}">Both are true</button>
    <p class="muted small">The other one goes, and Arise won't learn it again.</p>`);
}

function openDupe(i) {
  const p = shown.dupes[i];
  if (!p) return;
  openSheet(`<p class="kicker">These may say the same</p>
    <h2 class="display sheet-title">Keep one as the words</h2>
    <button class="btn block" data-act="know-merge" data-a="${esc(p.a.id)}" data-b="${esc(p.b.id)}">${esc(p.a.text)}</button>
    <button class="btn block" data-act="know-merge" data-a="${esc(p.b.id)}" data-b="${esc(p.a.id)}">${esc(p.b.text)}</button>
    <button class="btn ghost block" data-act="know-apart" data-a="${esc(p.a.id)}" data-b="${esc(p.b.id)}">They're different</button>
    <p class="muted small">The one you keep takes the days of both. If either was kept from AIs, the merged one is too.</p>`);
}

// ---------- taps

export async function handleAction(act, el) {
  const d = el.dataset;
  try {
    switch (act) {
      case 'know-ok':
        await M.confirmFact(d.id);
        toast('Marked as right.');
        return true;
      case 'know-noai': {
        const on = d.on === 'true';
        await M.flagFact(d.id, { noAI: on });
        toast(on ? 'This stays with you. No AI gets it.' : 'AIs can read it again, as your settings allow.');
        return true;
      }
      case 'know-check':
        openCheck(d.id);
        return true;
      case 'know-check-save': {
        const k = $('#knowCheck')?.value || '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k <= today()) {
          toast('Pick a day after today.');
          return true;
        }
        await M.flagFact(d.id, { check: k });
        closeSheet();
        toast(`Arise asks on ${day(k)}.`);
        return true;
      }
      case 'know-check-off':
        await M.flagFact(d.id, { check: null });
        closeSheet();
        toast("It won't ask.");
        return true;
      case 'know-clash':
        openClash(Number(d.i));
        return true;
      case 'know-dupe':
        openDupe(Number(d.i));
        return true;
      case 'know-right':
        await M.pickRight(d.a, d.b);
        closeSheet();
        toast("Thanks. The other one is gone, and Arise won't learn it again.");
        return true;
      case 'know-merge':
        await M.mergeFacts(d.a, d.b);
        closeSheet();
        toast('Merged into one.');
        return true;
      case 'know-apart':
        await M.keepApart(d.a, d.b);
        closeSheet();
        toast("Got it. Arise won't ask about these two again.");
        return true;
      default:
        return false;
    }
  } catch (err) {
    failed(err);
    return true;
  }
}
