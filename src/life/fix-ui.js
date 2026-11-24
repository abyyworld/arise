// Putting things right: "Not quite? Fix it" on any event in the life log (its title, its time, its
// kind where that makes sense, or delete it), and "This isn't right, teach it" on what Arise knows
// (a fact, or a part of life worked out from the days). Each is kept as a correction that wins over
// importing the same thing again, another device's older copy and the memory learning it again
// (fixes.ts), and goes to the Player's other devices with the life log.

import { esc, fmt, closeSheet, openSheet, toast } from '../ui.js';
import * as L from './log';
import * as M from './memory';
import * as INS from './insight';
import { saveFix } from './fix-store';
import { dayKey, dayStart } from './dates';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const hhmm = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const failed = (err) => toast(err?.message || "That couldn't be saved.");

// The kinds an event can be changed to, in plain words. Only offered when it's one of these now
// (a step count or a sleep stays what it is).
export const FIX_KINDS = [
  ['note', 'A note'],
  ['event', 'A calendar event'],
  ['place', 'A place'],
  ['trip', 'A trip'],
  ['workout', 'A workout'],
  ['call', 'A call'],
  ['message', 'A chat or message'],
  ['watch', 'Something watched'],
  ['listen', 'Something listened to'],
  ['play', 'A game'],
  ['purchase', 'A purchase'],
  ['other', 'Something else'],
];
const kindable = (kind) => FIX_KINDS.some(([k]) => k === kind);

// ---------- an event

export const fixButton = (id) => `<button class="btn ghost block" data-act="fix-ev" data-id="${esc(id)}">Not quite? Fix it</button>`;

export async function openEventFix(id) {
  const e = await L.getEvent(id).catch(() => null);
  if (!e || e.source === 'arise') return;
  const kinds = kindable(e.kind) ? `<label class="field"><span class="k">What it was</span><select id="fixKind">${FIX_KINDS.map(([k, label]) => `<option value="${k}" ${k === e.kind ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>` : '';
  openSheet(`<p class="kicker">Not quite? Fix it</p>
    <h2 class="display sheet-title">${esc(fmt(dayKey(e.at), { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
    <label class="field"><span class="k">What happened</span><input id="fixTitle" type="text" maxlength="300" value="${esc(e.title)}"></label>
    <label class="field inline"><span class="k">Time</span><input id="fixTime" type="time" value="${hhmm(e.at)}"></label>
    ${kinds}
    <button class="btn primary block" data-act="fix-ev-save" data-id="${esc(e.id)}">Save</button>
    <button class="btn ghost block danger" data-act="fix-ev-del" data-id="${esc(e.id)}">It didn't happen: delete it</button>
    <p class="muted small">Arise keeps your fix, even if you bring the same thing in again, and it goes to all your devices.</p>`);
  $('#fixTitle')?.focus();
}

async function saveEventFix(id) {
  const e = await L.getEvent(id).catch(() => null);
  if (!e) return closeSheet();
  const title = ($('#fixTitle')?.value || '').trim();
  if (!title) {
    toast('Write what happened, or delete it.');
    return;
  }
  const [h, m] = ($('#fixTime')?.value || hhmm(e.at)).split(':').map(Number);
  const d = new Date(dayStart(dayKey(e.at)));
  d.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0);
  if (d.getTime() > Date.now()) {
    toast("That time hasn't come yet.");
    return;
  }
  const kind = $('#fixKind')?.value;
  try {
    const r = await L.fixEvent(id, { title, at: hhmm(d.getTime()) === hhmm(e.at) ? undefined : d.getTime(), kind: kindable(kind) ? kind : undefined });
    closeSheet();
    toast(r === false ? 'Nothing changed.' : 'Fixed. Arise will keep it this way.');
  } catch (err) {
    failed(err);
  }
}

// ---------- what Arise knows

export const teachLink = (id) => `<button class="link" data-act="fix-fact" data-id="${esc(id)}">This isn't right</button>`;

function teachSheet(kicker, said, act, id) {
  openSheet(`<p class="kicker">${esc(kicker)}</p>
    <h2 class="display sheet-title">Teach Arise</h2>
    <p class="muted">Arise thinks: “${esc(said)}”</p>
    <label class="field"><span class="k">What's true?</span><textarea id="teachText" class="log-text" rows="3" maxlength="240" placeholder="In your words. Leave it empty if it just isn't true."></textarea></label>
    <button class="btn primary block" data-act="${act}" data-id="${esc(id)}">Save</button>
    <p class="muted small">Arise keeps this and won't learn the old words again, even when it learns from your days afresh.</p>`);
  $('#teachText')?.focus();
}

export function openTeachFact(id) {
  const f = M.allFacts().find((x) => x.id === id);
  if (f) teachSheet("This isn't right", f.text, 'fix-fact-save', id);
}

// ---------- the parts of life (areas.ts), on What Arise knows

export const areasPanel = () => `<section class="panel">
    <div class="panel-title"><span>Your life, worked out</span></div>
    <p class="muted small">Worked out from your days on this device. If one isn't right, tell Arise.</p>
    <div id="knowAreas"><p class="muted small">Reading…</p></div>
  </section>`;

let areas = [];

export async function fillAreas() {
  let ins = null;
  try {
    ins = await INS.get({ maxAge: 10 * 60000 });
  } catch {}
  areas = (ins?.areas || []).filter((a) => a.score != null || a.fixed);
  const el = $('#knowAreas');
  if (!el) return;
  el.innerHTML = areas.length
    ? `<ul class="fact-list">${areas
        .map(
          (a) => `<li class="fact"><p class="fact-text"><b>${esc(a.label)}</b></p><p class="muted small">${esc(a.reason)}</p>
      <div class="fact-acts"><button class="link" data-act="fix-area" data-id="${esc(a.id)}">This isn't right</button></div></li>`,
        )
        .join('')}</ul>`
    : '<p class="muted small">Not enough to go on yet.</p>';
}

// ---------- taps

export async function handleAction(act, el) {
  const d = el.dataset;
  switch (act) {
    case 'fix-ev':
      await openEventFix(d.id);
      return true;
    case 'fix-ev-save':
      await saveEventFix(d.id);
      return true;
    case 'fix-ev-del':
      if (!confirm("Delete this from your log? Arise won't bring it back, even if you import the same thing again.")) return true;
      try {
        await L.fixEvent(d.id, 'delete');
        closeSheet();
        toast('Deleted.');
      } catch (err) {
        failed(err);
      }
      return true;
    case 'fix-fact':
      openTeachFact(d.id);
      return true;
    case 'fix-fact-save': {
      try {
        const r = await M.teachFact(d.id, $('#teachText')?.value || '');
        closeSheet();
        if (r) toast(r === 'removed' ? "Gone. Arise won't learn it again." : 'Thanks. Arise knows it now.');
      } catch (err) {
        failed(err);
      }
      return true;
    }
    case 'fix-area': {
      const a = areas.find((x) => x.id === d.id);
      if (a) teachSheet(`${a.label}: this isn't right`, a.reason, 'fix-area-save', a.id);
      return true;
    }
    case 'fix-area-save': {
      const a = areas.find((x) => x.id === d.id);
      if (!a) return true;
      const right = ($('#teachText')?.value || '').trim();
      try {
        await saveFix({ id: `area:${a.id}`, at: Date.now(), wrong: a.reason, ...(right ? { right } : { gone: true }), tier: Math.max(a.tier, 2) });
        INS.forgetInsight();
        closeSheet();
        toast('Thanks. Arise uses your words for this for the next 4 weeks.');
        await fillAreas();
      } catch (err) {
        failed(err);
      }
      return true;
    }
    default:
      return false;
  }
}
