// Photos and files on screen: a day's photos in Your days (and adding them there), the photos a
// note is saved with, one file's sheet (see it, save it, move it, sync or not, to the trash), and
// "Photos and files" in Setup and connections: a file manager with folders (a folder can be a
// goal's project folder, shown on that goal), search, sorting, a grid or a list, choosing several
// files to move or delete, the trash, and finding copies. The storage is files.ts; the rules for
// folders, sorting and copies are files-tree.ts.

import '../styles/files.css';
import { esc, icon, openSheet, closeSheet, toast } from '../ui.js';
import * as N from '../native.js';
import * as F from './files';
import * as FS from './files-sync';
import * as T from './files-tree';
import * as S from '../store';
import { CORS, readOwnStorage } from '../lib/own-storage';
import * as CLOUD from './cloud';
import { dayKey } from './dates';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const $$ = (sel, root = globalThis.document) => [...(root?.querySelectorAll(sel) ?? [])];
const ACCEPT = 'image/*,application/pdf,text/plain,audio/*,video/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip';
const isImage = (f) => f.type.startsWith('image/');
const longDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const shortDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const files = (n) => `${n} ${n === 1 ? 'file' : 'files'}`;

// Object URLs made for what's on screen, let go when it's drawn again.
const urls = { day: [], sheet: [], place: [], goal: [] };
function urlFor(where, blob) {
  const u = URL.createObjectURL(blob);
  urls[where].push(u);
  return u;
}
function letGo(where) {
  for (const u of urls[where].splice(0)) URL.revokeObjectURL(u);
}
const thumbURL = (where, f) => (f.thumb ? urlFor(where, new Blob([f.thumb], { type: 'image/jpeg' })) : '');

// Where the files are kept, in one line.
function whereLine() {
  const { main } = CLOUD.lines();
  return CLOUD.signedIn() && main.startsWith('Synced') ? 'Synced between your devices, end-to-end encrypted.' : 'On this device only. Sign in to sync them.';
}

// One file in a grid: its preview, or its name. `act` is what a tap does.
function tile(where, f, act = 'myfiles-file', picked) {
  const u = thumbURL(where, f);
  const label = `${isImage(f) ? 'Photo' : f.name}, ${longDay(f.day)}`;
  const pick = picked === undefined ? '' : ` aria-pressed="${picked}"`;
  return `<button class="file-tile${u ? '' : ' plain'}${picked ? ' picked' : ''}" data-act="${act}" data-id="${esc(f.id)}" aria-label="${esc(label)}"${pick}>${u ? `<img src="${esc(u)}" alt="" loading="lazy">` : `<span class="file-name">${icon('note')}<small>${esc(f.name)}</small></span>`}${picked ? `<span class="file-check">${icon('check')}</span>` : ''}</button>`;
}

// One file in a list: preview, name, and a line under it.
function row(where, f, act, more, picked) {
  const u = thumbURL(where, f);
  const pick = picked === undefined ? '' : ` aria-pressed="${picked}"`;
  return `<button class="file-row${picked ? ' picked' : ''}" data-act="${act}" data-id="${esc(f.id)}"${pick}>
    <span class="file-row-pic">${picked ? icon('check') : u ? `<img src="${esc(u)}" alt="" loading="lazy">` : icon('note')}</span>
    <span class="file-row-text"><b>${esc(f.name)}</b><small>${esc(more)}</small></span>
  </button>`;
}

const addLabel = (id, day, text = 'Add photos or files', dir = '') =>
  `<label class="btn ghost small file-add">${esc(text)}<input type="file" id="${id}" data-day="${esc(day)}"${dir ? ` data-dir="${esc(dir)}"` : ''} accept="${ACCEPT}" multiple hidden></label>`;

// ---------- a day in Your days

export const daySlot = () => '<div id="lifeFiles" class="life-files"></div>';

let dayToken = 0;
export async function fillDay(day) {
  const token = ++dayToken;
  let list = [];
  try {
    list = await F.listFiles({ day });
  } catch {
    list = [];
  }
  const el = $('#lifeFiles');
  if (!el || token !== dayToken) return;
  letGo('day');
  el.innerHTML = `${list.length ? `<div class="file-grid">${list.map((f) => tile('day', f)).join('')}</div>` : ''}<div class="row">${addLabel('myfilesDay', day, list.length ? 'Add more' : 'Add photos or files')}</div>`;
}

// ---------- the photos a note is saved with (life/screens.js, Add to your day)

export const noteField = () => `<label class="field"><span class="k">Photos or files <span class="muted">· if you like</span></span><input type="file" id="lifeNoteFiles" accept="${ACCEPT}" multiple></label>`;

export async function saveNoteFiles(noteId, day) {
  const input = $('#lifeNoteFiles');
  const list = [...(input?.files || [])];
  if (!list.length) return 0;
  return addFiles(list, { day, note: noteId });
}

// ---------- adding

async function addFiles(list, opts) {
  let n = 0;
  for (const file of list) {
    try {
      await F.putFile(file, opts);
      n++;
    } catch (err) {
      toast(err?.message || `${file.name} couldn't be kept.`);
    }
  }
  return n;
}

globalThis.document?.addEventListener('change', async (e) => {
  const t = e.target;
  if (t?.id === 'myfilesSort') {
    place.sort = T.isSort(t.value) ? t.value : 'date';
    await drawPlace();
    return;
  }
  if (t?.id === 'myfilesGoal') {
    await run(() => F.linkFolder(place.dir, t.value || undefined), t.value ? 'Linked. It shows on that goal.' : 'Not a project folder any more.');
    return;
  }
  if (t?.id === 'myfilesFileDir' && shown) {
    const to = t.value || undefined;
    await run(() => F.moveFiles([shown], to), 'Moved.');
    return;
  }
  if (t?.id !== 'myfilesDay' && t?.id !== 'myfilesPlace') return;
  const list = [...(t.files || [])];
  if (!list.length) return;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(t.dataset.day || '') ? t.dataset.day : dayKey(Date.now());
  const n = await addFiles(list, { day, ...(t.dataset.dir ? { dir: t.dataset.dir } : {}) });
  t.value = '';
  if (n) toast(n === 1 ? 'Kept.' : `${n} kept.`);
});

globalThis.document?.addEventListener('input', (e) => {
  if (e.target?.id !== 'myfilesFind') return;
  place.q = e.target.value;
  void drawPlace();
});

// Does it, then says so (or says what went wrong).
async function run(fn, said) {
  try {
    const out = await fn();
    if (said) toast(typeof said === 'function' ? said(out) : said);
    return out;
  } catch (err) {
    toast(err?.message || "That didn't work.");
    return undefined;
  }
}

// ---------- one file

let shown = null; // the id of the file in the sheet

// The folders as choices in a list, with the top first.
function folderOptions(dirs, current, skip) {
  const top = `<option value=""${current ? '' : ' selected'}>All files (the top)</option>`;
  return (
    top +
    T.folderChoices(dirs)
      .filter((o) => !skip || !T.isWithin(dirs, o.id, skip))
      .map((o) => `<option value="${esc(o.id)}"${o.id === current ? ' selected' : ''}>${esc(o.label)}</option>`)
      .join('')
  );
}

async function openFile(id) {
  letGo('sheet');
  const [list, tree] = await Promise.all([F.listFiles({ trash: 'all' }).catch(() => []), F.listFolders().catch(() => T.emptyFolders())]);
  const f = list.find((x) => x.id === id);
  if (!f) {
    toast("That file isn't here any more.");
    return;
  }
  shown = id;
  const stays = F.staysHere(f);
  const preview = f.thumb ? `<img class="file-full" id="myfilesImg" src="${esc(thumbURL('sheet', f))}" alt="${esc(f.name)}">` : '';
  const bin = f.bin
    ? `<p class="small">In the trash. It goes for good in ${T.daysLeft(f)} ${T.daysLeft(f) === 1 ? 'day' : 'days'}.</p>
    <div class="row"><button class="btn primary small" data-act="myfiles-restore" data-id="${esc(f.id)}">Put it back</button><button class="btn ghost small danger" data-act="myfiles-forget" data-id="${esc(f.id)}">Delete for good</button></div>`
    : `<label class="field"><span class="k">Folder</span><select id="myfilesFileDir">${folderOptions(tree.dirs, T.dirOf(tree.dirs, f))}</select></label>
    <button class="btn ghost block danger" data-act="myfiles-del" data-id="${esc(f.id)}">Delete from all your devices</button>
    <p class="muted small">It goes to the trash first, on all your devices. You can put it back for ${F.TRASH_DAYS} days.</p>`;
  openSheet(`<p class="kicker">${esc(longDay(f.day))}</p>
    <h2 class="display sheet-title file-title">${esc(f.name)}</h2>
    ${preview}
    <p class="muted small">${esc(F.sizeText(f.size))}${f.w && f.h ? ` · ${f.w} × ${f.h}` : ''} · ${esc(stays || (f.up ? 'Synced, end-to-end encrypted.' : CLOUD.signedIn() ? 'Syncs soon, end-to-end encrypted.' : 'Syncs once you sign in.'))}</p>
    <p class="muted small" id="myfilesState">${f.here ? '' : 'Getting it from your other devices…'}</p>
    <div class="row">
      <button class="btn ghost small" data-act="myfiles-save" data-id="${esc(f.id)}">${icon('share')} Save a copy</button>
      ${f.size <= F.SYNC_FILE_MAX ? `<button class="btn ghost small" data-act="myfiles-sync" data-id="${esc(f.id)}" data-on="${!f.sync}">${f.sync ? 'Keep only on this device' : 'Sync it'}</button>` : ''}
    </div>
    ${bin}
    <button class="link small" data-act="myfiles-open">Back to Photos and files</button>`);
  // The whole picture (or the bytes, for the Save button) once they're here.
  if (isImage(f) || !f.here) {
    const got = await F.getFile(id).catch(() => null);
    if (shown !== id) return;
    const state = $('#myfilesState');
    if (!got) {
      if (state) state.textContent = "It couldn't be fetched right now. Check you're online and signed in.";
      return;
    }
    if (state) state.textContent = '';
    const img = $('#myfilesImg');
    if (img && isImage(f)) img.src = urlFor('sheet', got.blob);
  }
}

// To the share sheet or a download, like a backup.
async function saveCopy(id) {
  const got = await F.getFile(id).catch(() => null);
  if (!got) {
    toast("It couldn't be fetched right now. Check you're online and signed in.");
    return;
  }
  const { info, blob } = got;
  if (N.isNative) {
    try {
      await N.shareBytes(info.name, blob);
    } catch (err) {
      toast(err?.message || "It couldn't be saved.");
    }
    return;
  }
  const file = new File([blob], info.name, { type: info.type });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file], title: info.name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const u = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = u;
  a.download = info.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}

// ---------- Photos and files: everything, in Setup and connections

export function hubPanel() {
  return `<section class="panel" id="hubMyFiles">
    <div class="panel-title">${icon('note')}<span>Photos and files</span></div>
    <p class="small">Keep photos and files with your days: from a note, from a day in Your days, or here, in folders of your own. Each is encrypted on your device before it syncs, so only your devices can open it.</p>
    <div class="row"><button class="btn small primary" data-act="myfiles-open">Open</button></div>
  </section>`;
}

// What the file manager shows. Kept while the app is open, so it opens where it was.
const place = {
  mode: 'files', // 'files', 'trash' or 'copies'
  dir: '', // the folder open ('' : the top)
  sort: 'date',
  grid: true,
  q: '', // search by name
  picking: false, // choosing several files
  picked: new Set(),
  naming: null, // { kind: 'new' } or { kind: 'rename' }: the folder name field is open
  copies: null, // the groups of copies, once looked for
};
const resetPick = () => {
  place.picking = false;
  place.picked.clear();
};

async function openPlace() {
  letGo('place');
  await F.clearOldTrash().catch(() => 0);
  let u = { count: 0, here: 0, synced: 0, quota: 0 };
  try {
    u = await F.usage();
  } catch (err) {
    toast(err?.message || "Your files couldn't be read.");
    return;
  }
  const note = FS.status.otherAccount
    ? "The files on this device belong to another account, so they aren't synced."
    : FS.status.newer
      ? 'A newer version of Arise synced your files. They sync again once this app has updated.'
      : FS.status.error || '';
  openSheet(`<p class="kicker">Your days</p>
    <h2 class="display sheet-title">Photos and files</h2>
    <p class="small">${esc(whereLine())}</p>
    <p class="muted small">On this device: ${esc(F.sizeText(u.here))} in ${files(u.count)}${u.quota ? `, of the ${esc(F.sizeText(u.quota))} this browser lets Arise keep` : ''}.${CLOUD.signedIn() ? ` Synced: ${esc(F.sizeText(u.synced))} of ${esc(F.sizeText(FS.totalMax()))}.` : ''}</p>
    <p class="muted small">Big photos are saved smaller (${F.SHRINK_TO} pixels across) to save space. Files over ${esc(F.sizeText(FS.fileMax()))} stay on the device you add them on.</p>
    ${note ? `<p class="muted small">${esc(note)}</p>` : ''}
    <div class="files-find"><input type="search" id="myfilesFind" placeholder="Search by name" aria-label="Search by name" autocomplete="off" value="${esc(place.q)}"></div>
    <div id="myfilesMain" class="files-main"></div>
    ${CLOUD.signedIn() ? ownPart() : ''}`);
  await drawPlace();
}

// The file manager, drawn again after each change (the search field above it stays).
let placeToken = 0;
async function drawPlace() {
  const el = $('#myfilesMain');
  if (!el) return;
  const token = ++placeToken;
  let all = [];
  let tree = T.emptyFolders();
  try {
    [all, tree] = await Promise.all([F.listFiles({ trash: 'all' }), F.listFolders()]);
  } catch (err) {
    toast(err?.message || "Your files couldn't be read.");
    return;
  }
  if (place.dir && !tree.dirs[place.dir]) place.dir = '';
  if (place.mode === 'copies' && !place.copies) {
    el.innerHTML = '<p class="muted small">Looking for copies…</p>';
    const groups = await F.findCopies().catch(() => []);
    if (token !== placeToken) return;
    place.copies = groups;
  }
  if (token !== placeToken || !$('#myfilesMain')) return;
  letGo('place');
  const find = $('#myfilesFind');
  if (find) find.closest('.files-find').hidden = place.mode !== 'files';
  el.innerHTML = place.mode === 'trash' ? trashHTML(all) : place.mode === 'copies' ? copiesHTML(all, tree) : filesHTML(all, tree);
}

function toolbar() {
  const sorts = T.SORTS.map((s) => `<option value="${s.by}"${s.by === place.sort ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
  const view = (grid, label) => `<button class="${place.grid === grid ? 'on' : ''}" data-act="myfiles-view" data-v="${grid ? 'grid' : 'list'}" aria-pressed="${place.grid === grid}">${label}</button>`;
  return `<div class="files-bar">
    <label class="files-sort"><span class="sr-only">Sort</span><select id="myfilesSort" aria-label="Sort">${sorts}</select></label>
    <div class="seg" role="group" aria-label="Show as">${view(true, 'Grid')}${view(false, 'List')}</div>
  </div>`;
}

function crumbs(tree, last) {
  const path = T.pathOf(tree.dirs, place.dir || undefined);
  const parts = [`<button class="link small" data-act="myfiles-dir" data-id="">All files</button>`];
  for (const id of path) parts.push(id === place.dir && !last ? `<b>${esc(tree.dirs[id].name)}</b>` : `<button class="link small" data-act="myfiles-dir" data-id="${esc(id)}">${esc(tree.dirs[id].name)}</button>`);
  if (last) parts.push(`<b>${esc(last)}</b>`);
  return `<nav class="files-path" aria-label="Where you are">${parts.join('<span class="muted"> / </span>')}</nav>`;
}

function namingHTML(tree) {
  if (!place.naming) return '';
  const old = place.naming.kind === 'rename' ? tree.dirs[place.dir]?.name || '' : '';
  return `<div class="files-naming">
    <label class="field"><span class="k">${place.naming.kind === 'rename' ? 'New name' : 'Name of the new folder'}</span><input id="myfilesName" autocomplete="off" maxlength="80" value="${esc(old)}"></label>
    <div class="row"><button class="btn primary small" data-act="myfiles-name-save">${place.naming.kind === 'rename' ? 'Rename' : 'Make it'}</button><button class="btn ghost small" data-act="myfiles-name-cancel">Cancel</button></div>
  </div>`;
}

// What can be done with the folder that's open.
function folderTools(tree) {
  const d = tree.dirs[place.dir];
  if (!d) return '';
  const goals = S.state.goals || [];
  const goalOpts = `<option value="">Not a project</option>${goals.map((g) => `<option value="${esc(g.id)}"${d.g === g.id ? ' selected' : ''}>${esc(g.title)}</option>`).join('')}`;
  const goal = d.g ? goals.find((g) => g.id === d.g) : null;
  return `${goal ? `<p class="small files-project">${icon('target')} The project folder of <b>${esc(goal.title)}</b>.</p>` : ''}
  <details class="files-folder-tools"><summary class="small">This folder</summary>
    <div class="row"><button class="btn ghost small" data-act="myfiles-rename">Rename</button><button class="btn ghost small danger" data-act="myfiles-rmdir">Delete the folder</button></div>
    <label class="field"><span class="k">Move it into</span><select id="myfilesFolderTo">${folderOptions(tree.dirs, T.parentOf(tree.dirs, place.dir), place.dir)}</select></label>
    <div class="row"><button class="btn ghost small" data-act="myfiles-folder-move">Move the folder</button></div>
    ${goals.length ? `<label class="field"><span class="k">Project folder for a goal</span><select id="myfilesGoal">${goalOpts}</select></label>` : ''}
  </details>`;
}

function filesHTML(all, tree) {
  const live = all.filter((f) => !f.bin);
  const binned = all.length - live.length;
  const q = place.q.trim();
  const counts = new Map();
  for (const f of live) {
    const d = T.dirOf(tree.dirs, f) || '';
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const shownFolders = q ? Object.keys(tree.dirs).filter((id) => T.nameMatches(tree.dirs[id].name, q)) : T.foldersIn(tree.dirs, place.dir || undefined);
  const list = T.sortFiles(q ? live.filter((f) => T.nameMatches(f.name, q)) : live.filter((f) => (T.dirOf(tree.dirs, f) || '') === place.dir), place.sort);
  const pathText = (f) => {
    const p = T.pathOf(tree.dirs, T.dirOf(tree.dirs, f));
    return p.length ? p.map((x) => tree.dirs[x].name).join(' / ') : 'All files';
  };
  const act = place.picking ? 'myfiles-pick' : 'myfiles-file';
  const picked = (f) => (place.picking ? place.picked.has(f.id) : undefined);
  const more = (f) => [F.sizeText(f.size), shortDay(f.day), ...(q ? [pathText(f)] : place.sort === 'kind' ? [T.kindOf(f.type)] : [])].join(' · ');
  const folderHTML = shownFolders
    .map((id) => {
      const n = counts.get(id) || 0;
      const inner = T.foldersIn(tree.dirs, id).length;
      const sub = [files(n), ...(inner ? [`${inner} ${inner === 1 ? 'folder' : 'folders'}`] : []), ...(tree.dirs[id].g ? ['project'] : [])].join(' · ');
      return `<button class="${place.grid ? 'folder-tile' : 'folder-row'}" data-act="myfiles-dir" data-id="${esc(id)}"><span class="folder-pic">${icon('days')}</span><span class="file-row-text"><b>${esc(q ? pathText({ dir: id }) || tree.dirs[id].name : tree.dirs[id].name)}</b><small>${esc(sub)}</small></span></button>`;
    })
    .join('');
  const fileHTML = place.grid ? `<div class="file-grid">${list.map((f) => tile('place', f, act, picked(f))).join('')}</div>` : `<div class="file-list">${list.map((f) => row('place', f, act, more(f), picked(f))).join('')}</div>`;
  const pickBar = place.picking
    ? `<div class="files-pickbar" role="region" aria-label="Chosen files">
        <p class="small"><b>${place.picked.size}</b> chosen. <button class="link small" data-act="myfiles-pick-all">Choose all ${list.length}</button></p>
        <label class="field"><span class="k">Move them to</span><select id="myfilesMoveTo">${folderOptions(tree.dirs, place.dir || undefined)}</select></label>
        <div class="row"><button class="btn primary small" data-act="myfiles-move"${place.picked.size ? '' : ' disabled'}>Move</button><button class="btn ghost small danger" data-act="myfiles-trash"${place.picked.size ? '' : ' disabled'}>Move to the trash</button><button class="btn ghost small" data-act="myfiles-pick-stop">Done</button></div>
      </div>`
    : '';
  const empty = !shownFolders.length && !list.length ? `<p class="muted small">${q ? 'Nothing has that name.' : place.dir ? 'This folder is empty.' : 'Nothing kept yet.'}</p>` : '';
  return `${toolbar()}
    ${q ? `<p class="small">Search results for <b>${esc(q)}</b> in all your folders.</p>` : crumbs(tree)}
    ${q ? '' : folderTools(tree)}
    ${namingHTML(tree)}
    <div class="row">${addLabel('myfilesPlace', dayKey(Date.now()), 'Add photos or files', place.dir)}<button class="btn ghost small" data-act="myfiles-mkdir">New folder</button>${list.length && !place.picking ? '<button class="btn ghost small" data-act="myfiles-pick-start">Choose files</button>' : ''}</div>
    ${pickBar}
    ${folderHTML ? `<div class="${place.grid ? 'folder-grid' : 'file-list'}">${folderHTML}</div>` : ''}
    ${list.length ? fileHTML : ''}
    ${empty}
    <div class="row files-more"><button class="btn ghost small" data-act="myfiles-bin">${icon('del')} Trash${binned ? ` (${binned})` : ''}</button><button class="btn ghost small" data-act="myfiles-copies">Find copies</button></div>`;
}

function trashHTML(all) {
  const list = T.sortFiles(
    all.filter((f) => f.bin),
    'date',
  ).sort((a, b) => b.bin - a.bin);
  const rows = list
    .map((f) => {
      const left = T.daysLeft(f);
      return `<div class="file-bin-row">${row('place', f, 'myfiles-file', `${F.sizeText(f.size)} · goes for good in ${left} ${left === 1 ? 'day' : 'days'}`)}<button class="btn ghost small" data-act="myfiles-restore" data-id="${esc(f.id)}">Put back</button></div>`;
    })
    .join('');
  return `${crumbs({ dirs: {} }, 'Trash')}
    <p class="small">Deleted files wait here for ${F.TRASH_DAYS} days, on all your devices, then go by themselves. Until then you can put them back.</p>
    ${list.length ? `<div class="file-list">${rows}</div><button class="btn ghost block danger" data-act="myfiles-empty">Empty the trash</button>` : '<p class="muted small">The trash is empty.</p>'}`;
}

function copiesHTML(all, tree) {
  const live = new Set(all.filter((f) => !f.bin).map((f) => f.id));
  const groups = (place.copies || []).map((g) => g.filter((f) => live.has(f.id))).filter((g) => g.length > 1);
  const where = (f) => {
    const p = T.pathOf(tree.dirs, T.dirOf(tree.dirs, f));
    return p.length ? p.map((x) => tree.dirs[x].name).join(' / ') : 'All files';
  };
  const spare = groups.reduce((n, g) => n + g[0].size * (g.length - 1), 0);
  const body = groups
    .map(
      (g) => `<div class="copy-group">
        <p class="label">${g.length} copies of the same file</p>
        <div class="file-list">${g
          .map((f) => `<div class="file-bin-row">${row('place', f, 'myfiles-file', `${F.sizeText(f.size)} · ${shortDay(f.day)} · ${where(f)}`)}<button class="btn ghost small" data-act="myfiles-keep" data-id="${esc(f.id)}">Keep this one</button></div>`)
          .join('')}</div>
      </div>`,
    )
    .join('');
  return `${crumbs({ dirs: {} }, 'Copies')}
    <p class="small">Files with exactly the same contents, compared on your device. Keep one, and the others go to the trash.</p>
    ${groups.length ? `<p class="muted small">${groups.length} ${groups.length === 1 ? 'group' : 'groups'}. Keeping one of each frees ${esc(F.sizeText(spare))}.</p>${body}` : '<p class="muted small">No copies found. Every file here is different.</p>'}
    <p class="muted small">Files that are only on your other devices are compared once one of your devices has checked them.</p>`;
}

// ---------- on a goal: its project folders (goals-ui.js)

// A place on a goal's card for its project folders, filled in once they're read.
export function goalSlot(goalId) {
  queueMicrotask(() => void fillGoalSlots().catch(() => {}));
  return `<div class="goal-files" data-goal="${esc(goalId)}"></div>`;
}

export async function fillGoalSlots() {
  const slots = $$('.goal-files[data-goal]');
  if (!slots.length) return;
  let tree = T.emptyFolders();
  let list = [];
  try {
    [tree, list] = await Promise.all([F.listFolders(), F.listFiles()]);
  } catch {
    return; // this browser keeps no files
  }
  for (const el of slots) {
    const goal = el.dataset.goal;
    const mine = Object.keys(tree.dirs)
      .filter((id) => tree.dirs[id].g === goal)
      .sort((a, b) => tree.dirs[a].name.localeCompare(tree.dirs[b].name));
    const count = (id) => list.filter((f) => T.isWithin(tree.dirs, T.dirOf(tree.dirs, f), id)).length;
    el.innerHTML = mine.length
      ? `<p class="label">Project files</p><div class="row">${mine.map((id) => `<button class="btn ghost small" data-act="myfiles-folder" data-id="${esc(id)}">${icon('days')} ${esc(tree.dirs[id].name)} <span class="muted">· ${files(count(id))}</span></button>`).join('')}</div>`
      : `<button class="link small" data-act="myfiles-project" data-goal="${esc(goal)}">${icon('days')} Add a project folder</button>`;
  }
}

// ---------- your own storage (lib/own-storage.ts): far more room, in your own Cloudflare account

const CORS_TEXT = JSON.stringify(CORS, null, 2);
let ownOpen = false; // the setup form is open

export function ownPart() {
  const on = S.ownStorage();
  const head = `<h3 class="sub">Your own storage <span class="tag">10 GB free</span></h3>`;
  if (on && !ownOpen) {
    return `<div class="own-storage" id="ownStorage">${head}
      <p class="small">On: new photos and files go to the bucket <b>${esc(on.bucket)}</b> in your own Cloudflare account, up to ${esc(F.sizeText(FS.OWN_FILE_MAX))} each and ${esc(F.sizeText(FS.OWN_TOTAL_MAX))} in all. They're encrypted on your device first, so Cloudflare only ever holds scrambled parts it can't open.</p>
      <p class="muted small">The key syncs with your account, locked like the rest of your data, so your other devices can fetch the files too. It only ever reaches those scrambled parts.</p>
      <div class="row"><button class="btn ghost small" data-act="myfiles-own-edit">Change</button><button class="btn ghost small danger" data-act="myfiles-own-remove">Remove</button></div>
    </div>`;
  }
  if (!ownOpen) {
    return `<div class="own-storage" id="ownStorage">${head}
      <p class="small">The free cloud has room for ${esc(F.sizeText(FS.SYNC_TOTAL_MAX))} of your files, ${esc(F.sizeText(FS.SYNC_FILE_MAX))} each. Want more? Keep them in your own Cloudflare account instead: 10 GB free, files up to ${esc(F.sizeText(FS.OWN_FILE_MAX))}. They're encrypted on your device first, so Cloudflare can't open them.</p>
      <div class="row"><button class="btn ghost small" data-act="myfiles-own-edit">Set it up</button></div>
    </div>`;
  }
  return `<div class="own-storage" id="ownStorage">${head}
    <ol class="own-steps small">
      <li>Make a free account at cloudflare.com, then open <b>R2</b> and turn it on (the free plan is enough; Cloudflare may ask for a card, and charges nothing under 10 GB).</li>
      <li><b>Create bucket</b>, with any name, like <code>arise-files</code>.</li>
      <li>In the bucket, <b>Settings</b>, <b>CORS policy</b>, <b>Add</b>, and paste this, so Arise may reach it: <button class="link small" data-act="myfiles-own-cors">Copy</button><pre class="own-cors">${esc(CORS_TEXT)}</pre></li>
      <li>Back in R2, <b>Manage API tokens</b>, <b>Create API token</b>: <b>Object Read &amp; Write</b>, for this bucket only. Copy the <b>Access Key ID</b> and the <b>Secret Access Key</b>.</li>
      <li>Your <b>Account ID</b> is on the R2 page too. Paste all four here.</li>
    </ol>
    <div class="stack">
      <label class="field"><span class="k">Account ID</span><input id="ownAccount" autocomplete="off" spellcheck="false" value="${esc(S.ownStorage()?.account || '')}"></label>
      <label class="field"><span class="k">Bucket name</span><input id="ownBucket" autocomplete="off" spellcheck="false" value="${esc(S.ownStorage()?.bucket || '')}"></label>
      <label class="field"><span class="k">Access Key ID</span><input id="ownKeyId" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span class="k">Secret Access Key</span><input id="ownSecret" type="password" autocomplete="off" spellcheck="false"></label>
      <p class="muted small">Arise tries writing, reading and deleting a small test file before it saves this. The key syncs with your account, locked like the rest of your data, and is never in a backup file.</p>
      <div class="row"><button class="btn primary small" data-act="myfiles-own-save">Check and save</button><button class="btn ghost small" data-act="myfiles-own-cancel">Cancel</button></div>
    </div>
  </div>`;
}

function repaintOwn() {
  const el = $('#ownStorage');
  if (el) el.outerHTML = ownPart();
}

async function saveOwn(btn) {
  const cfg = readOwnStorage({ account: $('#ownAccount')?.value, bucket: $('#ownBucket')?.value, keyId: $('#ownKeyId')?.value, secret: $('#ownSecret')?.value });
  if (typeof cfg === 'string') {
    toast(cfg);
    return;
  }
  if (btn) btn.disabled = true;
  try {
    await FS.checkOwnStorage(cfg);
  } catch (err) {
    toast(err?.message || "Arise couldn't reach your own storage.");
    if (btn) btn.disabled = false;
    return;
  }
  S.setOwnStorage(cfg);
  ownOpen = false;
  repaintOwn();
  toast('Your own storage works. New files go there from now on.');
  void FS.syncNow();
}

// ---------- taps

// Back to the file manager after a change in a file's sheet, or the sheet closes.
async function backToPlace() {
  shown = null;
  letGo('sheet');
  if ($('#myfilesMain')) await drawPlace();
  else closeSheet();
}

export async function handleAction(act, el) {
  if (!act.startsWith('myfiles-')) return false;
  const id = el?.dataset?.id || '';
  switch (act) {
    case 'myfiles-open':
      shown = null;
      Object.assign(place, { mode: 'files', naming: null });
      resetPick();
      await openPlace();
      return true;
    case 'myfiles-own-edit':
      ownOpen = true;
      repaintOwn();
      return true;
    case 'myfiles-own-cancel':
      ownOpen = false;
      repaintOwn();
      return true;
    case 'myfiles-own-cors':
      try {
        await globalThis.navigator?.clipboard?.writeText(CORS_TEXT);
        toast('Copied.');
      } catch {
        toast('Select it and copy it by hand.');
      }
      return true;
    case 'myfiles-own-save':
      await saveOwn(el);
      return true;
    case 'myfiles-own-remove':
      if (!globalThis.confirm?.("Stop using your own storage? Files already there stay there, and open on a device only while it's set up or they're already on it. New files go to the free cloud again.")) return true;
      S.removeOwnStorage();
      ownOpen = false;
      repaintOwn();
      toast('Your own storage is off.');
      return true;
    case 'myfiles-file':
      await openFile(id);
      return true;
    case 'myfiles-save':
      await saveCopy(id);
      return true;
    case 'myfiles-sync': {
      const on = el.dataset.on === 'true';
      try {
        await F.setSynced(id, on);
        toast(on ? 'It syncs to your other devices.' : 'Only on this device now. It goes from your other devices.');
      } catch (err) {
        toast(err?.message || "That didn't work.");
      }
      await openFile(id);
      return true;
    }
    case 'myfiles-del': {
      if (!globalThis.confirm?.(`Delete this from all your devices? It waits in the trash for ${F.TRASH_DAYS} days first, so you can put it back.`)) return true;
      await run(() => F.trashFile(id), 'Moved to the trash.');
      shown = null;
      letGo('sheet');
      closeSheet();
      return true;
    }
    case 'myfiles-restore':
      await run(() => F.restoreFiles([id]), 'Put back.');
      if (shown) await backToPlace();
      else await drawPlace();
      return true;
    case 'myfiles-forget':
      if (!globalThis.confirm?.("Delete this file for good, from all your devices? This can't be undone.")) return true;
      await run(() => F.deleteFile(id), 'Deleted for good.');
      await backToPlace();
      return true;
    case 'myfiles-empty': {
      const n = (await F.listFiles({ trash: true }).catch(() => [])).length;
      if (!n) return true;
      const ask = n === 1 ? "Delete the 1 file in the trash for good, from all your devices? This can't be undone." : `Delete all ${n} files in the trash for good, from all your devices? This can't be undone.`;
      if (!globalThis.confirm?.(ask)) return true;
      await run(() => F.emptyTrash(), (k) => (k === 1 ? '1 file deleted for good.' : `${k} files deleted for good.`));
      await drawPlace();
      return true;
    }

    // ---- the file manager
    case 'myfiles-folder': // from a goal: open its project folder
      Object.assign(place, { mode: 'files', dir: id, q: '', naming: null });
      resetPick();
      await openPlace();
      return true;
    case 'myfiles-project': {
      const goal = S.goalById?.(el.dataset.goal || '');
      if (!goal) return true;
      const made = await run(() => F.makeFolder(goal.title, { goal: goal.id }), 'Made. Files you add here show on the goal.');
      if (!made) return true;
      Object.assign(place, { mode: 'files', dir: made, q: '', naming: null });
      resetPick();
      await openPlace();
      return true;
    }
    case 'myfiles-dir':
      Object.assign(place, { mode: 'files', dir: id, naming: null, q: '' });
      resetPick();
      if ($('#myfilesFind')) $('#myfilesFind').value = '';
      await drawPlace();
      return true;
    case 'myfiles-view':
      place.grid = el.dataset.v !== 'list';
      await drawPlace();
      return true;
    case 'myfiles-bin':
      Object.assign(place, { mode: 'trash', naming: null });
      resetPick();
      await drawPlace();
      return true;
    case 'myfiles-copies':
      Object.assign(place, { mode: 'copies', naming: null, copies: null });
      resetPick();
      await drawPlace();
      return true;
    case 'myfiles-keep': {
      const n = await run(() => F.keepOne(id), (k) => (k === 1 ? 'Kept one. The copy went to the trash.' : `Kept one. ${k} copies went to the trash.`));
      if (n !== undefined) await drawPlace();
      return true;
    }
    case 'myfiles-mkdir':
      place.naming = { kind: 'new' };
      await drawPlace();
      $('#myfilesName')?.focus();
      return true;
    case 'myfiles-rename':
      place.naming = { kind: 'rename' };
      await drawPlace();
      $('#myfilesName')?.focus();
      return true;
    case 'myfiles-name-cancel':
      place.naming = null;
      await drawPlace();
      return true;
    case 'myfiles-name-save': {
      const name = $('#myfilesName')?.value || '';
      const ok =
        place.naming?.kind === 'rename'
          ? await run(async () => (await F.renameFolder(place.dir, name), true), 'Renamed.')
          : await run(async () => (place.dir = await F.makeFolder(name, { in: place.dir || undefined })), 'Folder made.');
      if (ok) place.naming = null;
      await drawPlace();
      return true;
    }
    case 'myfiles-folder-move': {
      const to = $('#myfilesFolderTo')?.value || undefined;
      await run(() => F.moveFolder(place.dir, to), 'Moved.');
      await drawPlace();
      return true;
    }
    case 'myfiles-rmdir': {
      const tree = await F.listFolders().catch(() => T.emptyFolders());
      const up = T.parentOf(tree.dirs, place.dir) || '';
      const gone = await run(async () => (await F.deleteFolder(place.dir), true), 'Folder deleted.');
      if (gone) place.dir = up;
      await drawPlace();
      return true;
    }
    case 'myfiles-pick-start':
      place.picking = true;
      place.picked.clear();
      await drawPlace();
      return true;
    case 'myfiles-pick-stop':
      resetPick();
      await drawPlace();
      return true;
    case 'myfiles-pick':
      if (place.picked.has(id)) place.picked.delete(id);
      else place.picked.add(id);
      await drawPlace();
      return true;
    case 'myfiles-pick-all':
      for (const b of $$('#myfilesMain [data-act="myfiles-pick"]')) place.picked.add(b.dataset.id);
      await drawPlace();
      return true;
    case 'myfiles-move': {
      const to = $('#myfilesMoveTo')?.value || undefined;
      const ids = [...place.picked];
      const n = await run(() => F.moveFiles(ids, to), (k) => (k === 1 ? '1 file moved.' : `${k} files moved.`));
      if (n !== undefined) resetPick();
      await drawPlace();
      return true;
    }
    case 'myfiles-trash': {
      const ids = [...place.picked];
      const n = await run(() => F.trashFiles(ids), (k) => `${k === 1 ? '1 file' : `${k} files`} moved to the trash. You can put them back for ${F.TRASH_DAYS} days.`);
      if (n !== undefined) resetPick();
      await drawPlace();
      return true;
    }
    default:
      return false;
  }
}

// Anything changing (here or from another device): the day on screen, the file manager and the
// goals' project folders catch up.
F.onFilesChange(() => {
  const el = $('#lifeFiles');
  const day = $('#myfilesDay')?.dataset.day;
  if (el && day) void fillDay(day);
  if ($('#myfilesMain')) {
    if (place.mode === 'copies') place.copies = null;
    void drawPlace();
  }
  void fillGoalSlots().catch(() => {});
});
