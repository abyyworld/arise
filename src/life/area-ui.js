// The parts of your life, each with its own page (area-notes.ts): "Add here" (a note, or a
// sub-branch like Work > Drone EduTrain, with dates if you like), the same note under several
// parts, "Mark as key", your own labels, filters by type, label and dates, "These go together",
// and notes that grow ("Add to the earlier note?"). On What Arise knows.

import { esc, fmt, icon, openSheet, toast } from '../ui.js';
import * as M from './memory';
import * as AN from './area-notes';
import { AREA_IDS, AREAS } from '../lib/life-check';
import { closest } from './embed/index';
import { dayKey } from './dates';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const $$ = (sel, root = globalThis.document) => [...(root?.querySelectorAll(sel) ?? [])];
const today = () => dayKey(Date.now());
const day = (k) => fmt(k, { day: 'numeric', month: 'short', year: k.slice(0, 4) === today().slice(0, 4) ? undefined : 'numeric' });
const failed = (err) => toast(err?.message || "That couldn't be saved.");
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const noteOf = (id) => AN.live(M.areaNotes()).find((n) => n.id === id) || null;

const noFilter = () => ({ type: 'all', label: '', from: '', to: '' });
// The page open now: the area, the sub-branch in it ('' the top), the filters, what's being
// written ('note' or 'branch', or the note being edited), and a new note waiting on "Add to the
// earlier note?".
const ui = { area: null, parent: '', filter: noFilter(), kind: 'note', edit: null, pending: null, earlier: null };

// ---------- on What Arise knows

export const areasPanel = () => `<section class="panel" id="knowLifeAreas">
    <div class="panel-title"><span>Your life areas</span></div>
    <p class="muted small">Notes you keep under each part of your life. Key ones go to the coach first.</p>
    <div id="knowAreaList">${listHTML()}</div>
  </section>`;

function listHTML() {
  if (!M.isLoaded()) return '<p class="muted small">Reading…</p>';
  const n = AN.counts(M.areaNotes());
  return `<ul class="hist-list">${AREA_IDS.map(
    (a) => `<li><button class="hist" data-act="area-open" data-area="${a}"><span class="hist-name">${esc(AREAS[a].label)}</span><span class="hist-date">${n[a] ? `${n[a]} ${n[a] === 1 ? 'note' : 'notes'}` : 'Add here'}</span></button></li>`,
  ).join('')}</ul>`;
}

export function fillAreasPanel() {
  const el = $('#knowAreaList');
  if (el) el.innerHTML = listHTML();
}

// ---------- an area's page

const TYPES = [
  ['all', 'All'],
  ['notes', 'Notes'],
  ['branches', 'Sub-branches'],
  ['key', 'Key'],
  ['linked', 'Linked'],
];

function title() {
  const list = M.areaNotes();
  const branch = ui.parent ? noteOf(ui.parent) : null;
  return branch ? `${AN.pathOf(list, branch, ui.area)} > ${branch.title}` : AREAS[ui.area].label;
}

function itemHTML(n, list) {
  const others = n.areas.filter((a) => a !== ui.area).map((a) => AREAS[a].label);
  const covers = n.from || n.to ? `${n.from ? day(n.from) : '…'} to ${n.to ? day(n.to) : 'now'}` : '';
  const meta = [n.branch ? 'Sub-branch' : '', `Written ${day(n.day)}`, ...(n.more || []).map((m) => `added to ${day(m.day)}`), covers, others.length ? `Also in ${others.join(', ')}` : ''].filter(Boolean).join(' · ');
  const links = AN.linked(list, n.id);
  return `<li class="fact ${n.key ? 'pinned' : ''}" data-note="${esc(n.id)}">
    <p class="fact-text">${n.key ? `${icon('pin')} ` : ''}${n.branch ? `<b>${esc(n.title)}</b>` : esc(n.title)}</p>
    ${n.text ? `<p class="small area-text">${esc(n.text)}</p>` : ''}
    ${(n.more || []).map((m) => `<p class="small area-text"><span class="muted">${esc(day(m.day))}:</span> ${esc(m.text)}</p>`).join('')}
    <p class="muted small">${esc(meta)}</p>
    ${n.labels?.length ? `<p class="fact-flags">${n.labels.map((l) => `<span class="tag">${esc(l)}</span>`).join(' ')}</p>` : ''}
    ${links.length ? `<p class="small">Goes with: ${links.map((l) => `<button class="link" data-act="area-go" data-id="${esc(l.id)}">${esc(l.title || AN.noteText(l).slice(0, 40))}</button>`).join(', ')}</p>` : ''}
    <div class="fact-acts">
      ${n.branch ? `<button class="link" data-act="area-in" data-id="${esc(n.id)}">Open</button>` : ''}
      <button class="link" data-act="area-key" data-id="${esc(n.id)}">${n.key ? 'Not key' : 'Mark as key'}</button>
      <button class="link" data-act="area-edit" data-id="${esc(n.id)}">Edit</button>
      <button class="link" data-act="area-link" data-id="${esc(n.id)}">These go together…</button>
      <button class="link danger-link" data-act="area-del" data-id="${esc(n.id)}">Delete</button>
    </div>
  </li>`;
}

function pageHTML() {
  const list = M.areaNotes();
  const f = ui.filter;
  const items = AN.notesIn(list, ui.area, { parent: ui.parent, filter: f });
  const labels = AN.labelsIn(list, ui.area);
  const filtered = f.type !== 'all' || f.label || f.from || f.to;
  return `<div id="areaPage">
    <p class="kicker">Your life areas</p>
    <h2 class="display sheet-title">${esc(title())}</h2>
    ${ui.parent ? `<button class="link" data-act="area-up">${icon('back')} Back</button>` : ''}
    <button class="btn primary block" data-act="area-add">Add here</button>
    <div class="seg" role="group" aria-label="Show">${TYPES.map(([v, l]) => `<button data-act="area-type" data-v="${v}" class="${f.type === v ? 'on' : ''}" aria-pressed="${f.type === v}">${l}</button>`).join('')}</div>
    ${labels.length ? `<div class="row wrap" role="group" aria-label="Labels">${labels.map((l) => `<button class="btn small ${f.label === l ? 'primary' : 'ghost'}" data-act="area-label" data-v="${esc(l)}" aria-pressed="${f.label === l}">${esc(l)}</button>`).join('')}</div>` : ''}
    <div class="row wrap">
      <label class="field inline"><span class="k">From</span><input id="areaF" type="date" value="${esc(f.from)}"></label>
      <label class="field inline"><span class="k">To</span><input id="areaT" type="date" value="${esc(f.to)}"></label>
      <button class="btn small ghost" data-act="area-dates">Show</button>
      ${filtered ? '<button class="btn small ghost" data-act="area-clear">Show all</button>' : ''}
    </div>
    ${items.length ? `<ul class="fact-list" id="areaItems">${items.map((n) => itemHTML(n, list)).join('')}</ul>` : `<p class="muted" id="areaItems">${filtered ? 'Nothing matches.' : 'Nothing here yet. Add a note, or a sub-branch for a project or a part of it.'}</p>`}
  </div>`;
}

let watching = false;
export function openArea(area, parent = '') {
  if (!AREA_IDS.includes(area)) return;
  if (area !== ui.area) ui.filter = noFilter();
  ui.area = area;
  ui.parent = parent;
  ui.pending = null;
  openSheet(pageHTML());
  // Changed on another device or tab: the page follows, unless a form is open.
  if (!watching) {
    watching = true;
    M.onMemoryChange(() => {
      if ($('#areaPage')) $('#areaPage').outerHTML = pageHTML();
      fillAreasPanel();
    });
  }
}
const back = () => openArea(ui.area, ui.parent);

// ---------- adding and editing

function formHTML(n) {
  const list = M.areaNotes();
  const areas = n ? n.areas : [ui.area];
  const kind = n ? (n.branch ? 'branch' : 'note') : ui.kind;
  const labels = AN.labelsIn(list);
  return `<p class="kicker">${n ? 'Edit' : 'Add here'}</p>
    <h2 class="display sheet-title">${esc(title())}</h2>
    ${n ? '' : `<div class="seg" role="group" aria-label="What it is"><button data-act="area-kind" data-v="note" class="${kind === 'note' ? 'on' : ''}" aria-pressed="${kind === 'note'}">A note</button><button data-act="area-kind" data-v="branch" class="${kind === 'branch' ? 'on' : ''}" aria-pressed="${kind === 'branch'}">A sub-branch</button></div>`}
    <label class="field"><span class="k">Title${kind === 'note' ? ' <span class="muted">· if you like</span>' : ''}</span><input id="areaTitle" type="text" maxlength="120" autocomplete="off" value="${esc(n?.title || '')}" placeholder="${kind === 'branch' ? 'Drone EduTrain' : 'First client call'}"></label>
    <label class="field"><span class="k">Note${kind === 'branch' ? ' <span class="muted">· if you like</span>' : ''}</span><textarea id="areaText" class="log-text" rows="4" maxlength="4000">${esc(n?.text || '')}</textarea></label>
    <div class="row wrap">
      <label class="field inline"><span class="k">Starts <span class="muted">· if you like</span></span><input id="areaFrom" type="date" value="${esc(n?.from || '')}"></label>
      <label class="field inline"><span class="k">Ends</span><input id="areaTo" type="date" value="${esc(n?.to || '')}"></label>
    </div>
    <p class="label">Show it under</p>
    <div class="row wrap" role="group" aria-label="Show it under">${AREA_IDS.map((a) => `<label class="check"><input type="checkbox" name="areaPick" value="${a}" ${areas.includes(a) ? 'checked' : ''}> ${esc(AREAS[a].label)}</label>`).join('')}</div>
    <label class="field"><span class="k">Labels <span class="muted">· with commas</span></span><input id="areaLabels" type="text" maxlength="200" autocomplete="off" list="areaLabelList" value="${esc((n?.labels || []).join(', '))}"><datalist id="areaLabelList">${labels.map((l) => `<option value="${esc(l)}"></option>`).join('')}</datalist></label>
    <label class="check"><input type="checkbox" id="areaKey" ${n?.key ? 'checked' : ''}> Mark as key</label>
    <button class="btn primary block" data-act="area-save">Save</button>
    <button class="btn ghost block" data-act="area-back">Back</button>`;
}

function openForm(id = null) {
  const n = id ? noteOf(id) : null;
  ui.edit = n ? n.id : null;
  if (!n) ui.pending = null;
  openSheet(formHTML(n));
  $('#areaTitle')?.focus();
}

function readForm() {
  const areas = $$('input[name="areaPick"]')
    .filter((i) => i.checked)
    .map((i) => i.value);
  const from = $('#areaFrom')?.value || '';
  const to = $('#areaTo')?.value || '';
  return {
    areas: areas.length ? areas : [ui.area],
    title: ($('#areaTitle')?.value || '').trim(),
    text: ($('#areaText')?.value || '').trim(),
    from: isDay(from) ? from : '',
    to: isDay(to) ? to : '',
    key: !!$('#areaKey')?.checked,
    labels: ($('#areaLabels')?.value || '')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
  };
}

// The earlier note a new one may be about: the newest in the same sub-branch, or the closest in
// meaning in the same parts of life (only with the search model on this device).
async function earlierFor(note) {
  const list = M.areaNotes();
  const inBranch = AN.earlierInBranch(list, note.parent);
  if (inBranch) return inBranch;
  const cands = AN.candidates(list, note.areas);
  const hit = await closest(AN.noteText(note), cands.map(AN.noteText)).catch(() => null);
  return hit ? cands[hit.i] : null;
}

async function save() {
  const f = readForm();
  if (f.from && f.to && f.to < f.from) {
    toast('The end comes before the start.');
    return;
  }
  const now = Date.now();
  if (ui.edit) {
    const n = noteOf(ui.edit);
    if (!n) return back();
    const next = AN.editNote(n, { ...f, from: f.from || '', to: f.to || '' }, now);
    if (!next) {
      toast(n.branch ? 'A sub-branch needs a title.' : 'Write a title or a few words first.');
      return;
    }
    await M.putAreaNotes([next]);
    ui.edit = null;
    toast('Saved.');
    return back();
  }
  const note = AN.makeNote({ ...f, branch: ui.kind === 'branch', parent: ui.parent || undefined, from: f.from || undefined, to: f.to || undefined }, today(), now);
  if (!note) {
    toast(ui.kind === 'branch' ? 'A sub-branch needs a title.' : 'Write a title or a few words first.');
    return;
  }
  const earlier = note.branch ? null : await earlierFor(note);
  if (earlier) {
    ui.pending = note;
    ui.earlier = earlier.id;
    openSheet(`<p class="kicker">Notes that grow</p>
      <h2 class="display sheet-title">Add to the earlier note?</h2>
      <p class="muted">“${esc(earlier.title || AN.noteText(earlier).slice(0, 80))}”, written ${esc(day(earlier.day))}.</p>
      <p class="small">It becomes one note that grows. Both dates stay.</p>
      <button class="btn primary block" data-act="area-grow">Add to it</button>
      <button class="btn ghost block" data-act="area-apart">Keep it separate</button>`);
    return;
  }
  await M.putAreaNotes([note]);
  toast('Added.');
  back();
}

// The new note goes into the earlier one: its words under that day, its parts of life, labels and
// dates too.
async function growInto() {
  const note = ui.pending;
  const was = ui.earlier ? noteOf(ui.earlier) : null;
  ui.pending = null;
  if (!note) return back();
  if (!was) {
    await M.putAreaNotes([note]);
    return back();
  }
  const words = [note.title && note.title !== was.title ? note.title : '', note.text || ''].filter(Boolean).join('\n');
  const now = Date.now();
  let next = AN.grow(was, words || note.title, note.day, now);
  if (next)
    next = AN.editNote(
      next,
      {
        areas: [...new Set([...next.areas, ...note.areas])],
        labels: [...new Set([...(next.labels || []), ...(note.labels || [])])],
        from: [next.from, note.from].filter(Boolean).sort()[0] || '',
        to: [next.to, note.to].filter(Boolean).sort().at(-1) || '',
        key: !!(next.key || note.key),
      },
      now,
    );
  if (!next) return failed();
  await M.putAreaNotes([next]);
  toast('Added to the earlier note.');
  back();
}

async function keepSeparate() {
  const note = ui.pending;
  ui.pending = null;
  if (note) await M.putAreaNotes([note]);
  toast('Added.');
  back();
}

// ---------- links

function openLink(id) {
  const n = noteOf(id);
  if (!n) return;
  const list = M.areaNotes();
  const linked = new Set(AN.linked(list, id).map((x) => x.id));
  const others = AN.sortNotes(AN.live(list).filter((x) => x.id !== id));
  openSheet(`<p class="kicker">These go together</p>
    <h2 class="display sheet-title">${esc(n.title || AN.noteText(n).slice(0, 60))}</h2>
    <p class="muted small">Pick a note that goes with it. The link shows on both.</p>
    ${
      others.length
        ? `<ul class="hist-list">${others
            .map(
              (x) =>
                `<li><button class="hist" data-act="${linked.has(x.id) ? 'area-unlink' : 'area-link-to'}" data-a="${esc(id)}" data-b="${esc(x.id)}"><span class="hist-name">${esc(x.title || AN.noteText(x).slice(0, 60))}</span><span class="hist-date">${esc(linked.has(x.id) ? 'Linked. Tap to unlink' : AN.pathOf(list, x))}</span></button></li>`,
            )
            .join('')}</ul>`
        : '<p class="muted">Add another note first.</p>'
    }
    <button class="btn ghost block" data-act="area-back">Back</button>`);
}

// ---------- taps

export async function handleAction(act, el) {
  const d = el.dataset;
  try {
    switch (act) {
      case 'area-open':
        ui.filter = noFilter();
        openArea(d.area, '');
        return true;
      case 'area-in':
        openArea(ui.area, d.id);
        return true;
      case 'area-up': {
        const b = noteOf(ui.parent);
        const up = b?.parent && noteOf(b.parent)?.areas.includes(ui.area) ? b.parent : '';
        openArea(ui.area, up);
        return true;
      }
      case 'area-back':
        ui.edit = null;
        ui.pending = null;
        back();
        return true;
      case 'area-go': {
        const n = noteOf(d.id);
        if (!n) return true;
        const area = n.areas.includes(ui.area) ? ui.area : n.areas[0];
        ui.filter = noFilter();
        openArea(area, n.parent && noteOf(n.parent)?.areas.includes(area) ? n.parent : '');
        return true;
      }
      case 'area-type':
        ui.filter = { ...ui.filter, type: d.v || 'all' };
        back();
        return true;
      case 'area-label':
        ui.filter = { ...ui.filter, label: ui.filter.label === d.v ? '' : d.v || '' };
        back();
        return true;
      case 'area-dates': {
        const from = $('#areaF')?.value || '';
        const to = $('#areaT')?.value || '';
        ui.filter = { ...ui.filter, from: isDay(from) ? from : '', to: isDay(to) ? to : '' };
        back();
        return true;
      }
      case 'area-clear':
        ui.filter = noFilter();
        back();
        return true;
      case 'area-add':
        ui.kind = 'note';
        openForm();
        return true;
      case 'area-kind': {
        // Keeps what's typed so far.
        const f = readForm();
        ui.kind = d.v === 'branch' ? 'branch' : 'note';
        openSheet(formHTML(null));
        $('#areaTitle').value = f.title;
        $('#areaText').value = f.text;
        return true;
      }
      case 'area-edit':
        openForm(d.id);
        return true;
      case 'area-save':
        await save();
        return true;
      case 'area-grow':
        await growInto();
        return true;
      case 'area-apart':
        await keepSeparate();
        return true;
      case 'area-key': {
        const n = noteOf(d.id);
        const next = n && AN.editNote(n, { key: !n.key }, Date.now());
        if (next) await M.putAreaNotes([next]);
        if (next) toast(next.key ? 'Marked as key. It goes first, and to the coach first.' : 'Not key any more.');
        back();
        return true;
      }
      case 'area-del': {
        const n = noteOf(d.id);
        if (!n) return true;
        const inside = AN.live(M.areaNotes()).filter((x) => x.parent === n.id);
        if (!confirm(n.branch && inside.length ? `Delete "${n.title}"? The ${inside.length === 1 ? 'note' : `${inside.length} notes`} in it stay, one level up.` : 'Delete this note?')) return true;
        const now = Date.now();
        await M.putAreaNotes([AN.tombstone(n.id, now), ...inside.map((x) => AN.editNote(x, { parent: n.parent || '' }, now)).filter(Boolean)]);
        toast('Deleted.');
        if (ui.parent === n.id) ui.parent = n.parent || '';
        back();
        return true;
      }
      case 'area-link':
        openLink(d.id);
        return true;
      case 'area-link-to':
        await M.putAreaNotes(AN.linkNotes(M.areaNotes(), d.a, d.b, Date.now()));
        toast('Linked. It shows on both.');
        openLink(d.a);
        return true;
      case 'area-unlink':
        await M.putAreaNotes(AN.unlinkNotes(M.areaNotes(), d.a, d.b, Date.now()));
        toast('Unlinked.');
        openLink(d.a);
        return true;
      default:
        return false;
    }
  } catch (err) {
    failed(err);
    return true;
  }
}

export const _ui = ui; // for tests
