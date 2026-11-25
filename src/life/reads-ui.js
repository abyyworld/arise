// "Arise reads it for you" on screen (reads.ts): its switches in Settings, Your life log; how the
// queue is going in What Arise knows; and on a note's or a file's sheet, the description, the
// Player's note refined and the original, with "Not quite? Fix it" and "Describe again".

import { esc, closeSheet, openSheet, toast } from '../ui.js';
import * as R from './reads';
import * as C from './reads-core';
import { READ_PER_DAY } from '../lib/validate';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const $$ = (sel, root = globalThis.document) => [...(root?.querySelectorAll(sel) ?? [])];

// ---------- Settings, Your life log

const toggle = (act, on, title, small, extra = '') =>
  `<button class="toggle-row" data-act="${act}" data-on="${!on}" aria-pressed="${on}"${extra}><span><b>${esc(title)}</b><small>${esc(small)}</small></span><span class="switch ${on ? 'on' : ''}"></span></button>`;

export function settingsBlock() {
  const p = R.prefs();
  const per = READ_PER_DAY.map((n) => `<button class="${p.perDay === n ? 'on' : ''}" data-act="reads-per-day" data-v="${n}" aria-pressed="${p.perDay === n}">${n}</button>`).join('');
  return `<div id="readsSettings">
    ${toggle(
      'reads-on',
      p.on,
      'Describe new notes and files',
      'Arise asks the AI for a one-line description, a tidy copy of your note and a few tags, and keeps them with it. Only an AI that may read your life log reads them: the private AI or the AI on your device, unless you let less private ones read it.',
    )}
    ${
      p.on
        ? `<p class="label">How many a day</p>
    <div class="seg" role="group" aria-label="How many a day">${per}</div>
    ${toggle('reads-allow', p.health, 'Also health', 'Notes that look like they are about your health. Off: they are held back.', ' data-k="health"')}
    ${toggle('reads-allow', p.money, 'Also money', 'Notes that look like they are about your money or bank. Off: they are held back.', ' data-k="money"')}
    ${toggle('reads-allow', p.id, 'Also ID papers', 'Notes that look like a passport, an ID card or long numbers. Off: they are held back. Never sent to a less private AI.', ' data-k="id"')}
    <p class="muted small reads-status">${esc(C.statusText())}</p>
    <div class="row"><button class="btn ghost small" data-act="reads-run">Run now</button></div>`
        : ''
    }
  </div>`;
}

function repaintSettings() {
  const el = $('#readsSettings');
  if (el) el.outerHTML = settingsBlock();
}

// ---------- What Arise knows

export function knowsPanel() {
  const p = R.prefs();
  return `<section class="panel" id="readsKnows">
    <div class="panel-title"><span>Arise reads it for you</span></div>
    <p class="small reads-status">${esc(C.statusText())}</p>
    <p class="muted small">${p.on ? `${R.allReads().length} described so far. At most ${p.perDay} a day.` : 'Arise can describe your new notes and files, and tag them, so you find them again.'}</p>
    ${p.on ? '<div class="row"><button class="btn ghost small" data-act="reads-run">Run now</button></div>' : '<div class="row"><button class="btn ghost small" data-act="nav" data-v="settings">Settings</button></div>'}
  </section>`;
}

export function fillStatus() {
  const text = C.statusText();
  for (const el of $$('.reads-status')) el.textContent = text;
  const k = $('#readsKnows');
  if (k) k.outerHTML = knowsPanel();
}

// ---------- a note's or a file's sheet

// Where it goes on the sheet; fillSlot fills it once it's read.
export const slot = (id) => `<div class="reads-box" id="readsBox" data-id="${esc(id)}"></div>`;

const tagList = (tags) => (tags.length ? `<p class="reads-tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</p>` : '');

// `original`: the original text to show (a file's; a note's is on the sheet already, just below).
export function readHTML(read, { on = R.prefs().on, original = '', note = true } = {}) {
  if (!read) {
    if (!on) return '';
    return `<p class="muted small">Arise hasn't described this yet.</p>
      <div class="row"><button class="btn ghost small" data-act="reads-again">Describe it</button></div>`;
  }
  const mine = read.from === 'you';
  return `<p class="label">${mine ? 'Description (yours)' : 'Description (AI-written)'}</p>
    <p class="reads-desc">${esc(read.desc)}</p>
    ${tagList(read.tags)}
    ${read.tidy ? `<p class="label">Your note, refined</p><p class="life-detail reads-tidy">${esc(read.tidy)}</p>` : ''}
    <div class="row"><button class="btn ghost small" data-act="reads-fix">Not quite? Fix it</button><button class="btn ghost small" data-act="reads-again">Describe again</button></div>
    ${original ? `<details class="other"><summary>The original</summary><p class="life-detail">${esc(original)}</p></details>` : note ? '<p class="label">The original</p>' : ''}`;
}

let filling = 0;
export async function fillSlot() {
  const el = $('#readsBox');
  if (!el) return;
  const token = ++filling;
  const id = el.dataset.id;
  const read = await R.getRead(id).catch(() => null);
  let original = '';
  if (read && id.startsWith('f:')) original = ((await R.candidate(id).catch(() => null))?.text || '').slice(0, 4000);
  if (token !== filling || $('#readsBox')?.dataset.id !== id) return;
  $('#readsBox').innerHTML = readHTML(read, { original, note: id.startsWith('e:') });
  // One "Not quite? Fix it" on the sheet: this one, which also leads to fixing the note itself.
  if (read && id.startsWith('e:')) for (const b of $$('.sheet-body > [data-act="fix-ev"]')) b.hidden = true;
}

// ---------- "Not quite? Fix it"

export async function openFix(id) {
  const read = await R.getRead(id).catch(() => null);
  const note = id.startsWith('e:');
  openSheet(`<p class="kicker">Not quite? Fix it</p>
    <h2 class="display sheet-title">Teach Arise</h2>
    ${read ? `<p class="muted">Arise wrote: “${esc(read.desc)}”</p>` : ''}
    <label class="field"><span class="k">Description</span><input id="readsDesc" type="text" maxlength="200" value="${esc(read?.desc || '')}"></label>
    <label class="field"><span class="k">Tags <span class="muted">· with commas</span></span><input id="readsTags" type="text" maxlength="200" value="${esc((read?.tags || []).join(', '))}"></label>
    <label class="field"><span class="k">Your note, refined</span><textarea id="readsTidy" class="log-text" rows="5" maxlength="4000">${esc(read?.tidy || '')}</textarea></label>
    <button class="btn primary block" data-act="reads-fix-save" data-id="${esc(id)}">Save</button>
    ${note ? `<button class="btn ghost block" data-act="fix-ev" data-id="${esc(id.slice(2))}">Fix the note itself: its title or time</button>` : ''}
    <p class="muted small">Arise keeps your words, and no AI writes over them. They go to all your devices.</p>`);
  $('#readsDesc')?.focus();
}

async function saveFix(id) {
  const desc = ($('#readsDesc')?.value || '').trim();
  if (!desc) {
    toast('Write a short description.');
    return;
  }
  const tags = ($('#readsTags')?.value || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const tidy = ($('#readsTidy')?.value || '').trim();
  try {
    const r = await R.fixRead(id, { desc, tags, tidy });
    closeSheet();
    toast(r ? 'Thanks. Arise keeps your words.' : "That couldn't be saved.");
  } catch (err) {
    toast(err?.message || "That couldn't be saved.");
  }
}

// ---------- taps

const boxId = () => $('#readsBox')?.dataset.id || '';

export async function handleAction(act, el) {
  const d = el?.dataset || {};
  switch (act) {
    case 'reads-on':
      await R.setPrefs({ on: d.on === 'true' });
      repaintSettings();
      if (d.on === 'true') toast('On. Arise starts with your notes and files from the last few weeks.');
      return true;
    case 'reads-per-day':
      await R.setPrefs({ perDay: Number(d.v) });
      repaintSettings();
      return true;
    case 'reads-allow':
      if (['health', 'money', 'id'].includes(d.k)) await R.setPrefs({ [d.k]: d.on === 'true' });
      repaintSettings();
      return true;
    case 'reads-run': {
      toast('Reading…');
      const n = await R.runNow();
      fillStatus();
      toast(n ? `Described ${n === 1 ? '1 note or file' : `${n} notes and files`}.` : C.statusText());
      return true;
    }
    case 'reads-fix': {
      const id = boxId();
      if (id) await openFix(id);
      return true;
    }
    case 'reads-fix-save':
      await saveFix(d.id);
      return true;
    case 'reads-again': {
      const id = boxId();
      if (!id) return true;
      R.describeAgain(id);
      toast(R.prefs().on ? 'Arise will describe it again soon.' : 'Turn on "Describe new notes and files" in Settings first.');
      return true;
    }
    default:
      return false;
  }
}

// ---------- in the app

// The device is erased (or the log emptied): it's off again, and its queue goes.
export const forget = () => R.forget();

let started = false;
export function initReadsUI() {
  if (started) return;
  started = true;
  R.initReads();
  R.onReadsChange(() => {
    fillStatus();
    if ($('#readsBox')) void fillSlot();
  });
}
