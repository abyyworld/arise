// Photos and files on screen: a day's photos in Your days (and adding them there), the photos a
// note is saved with, one file's sheet (see it, save it, sync or not, delete), and "Photos and
// files" in Setup and connections, with how much is kept where. The storage is files.ts.

import '../styles/files.css';
import { esc, icon, openSheet, closeSheet, toast } from '../ui.js';
import * as N from '../native.js';
import * as F from './files';
import * as FS from './files-sync';
import * as CLOUD from './cloud';
import { dayKey } from './dates';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const ACCEPT = 'image/*,application/pdf,text/plain,audio/*,video/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip';
const isImage = (f) => f.type.startsWith('image/');
const longDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

// Object URLs made for what's on screen, let go when it's drawn again.
const urls = { day: [], sheet: [], place: [] };
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

// One file in a grid: its preview, or its name.
function tile(where, f) {
  const u = thumbURL(where, f);
  const label = `${isImage(f) ? 'Photo' : f.name}, ${longDay(f.day)}`;
  return `<button class="file-tile${u ? '' : ' plain'}" data-act="myfiles-file" data-id="${esc(f.id)}" aria-label="${esc(label)}">${u ? `<img src="${esc(u)}" alt="" loading="lazy">` : `<span class="file-name">${icon('note')}<small>${esc(f.name)}</small></span>`}</button>`;
}

const addLabel = (id, day, text = 'Add photos or files') =>
  `<label class="btn ghost small file-add">${esc(text)}<input type="file" id="${id}" data-day="${esc(day)}" accept="${ACCEPT}" multiple hidden></label>`;

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
  const files = [...(input?.files || [])];
  if (!files.length) return 0;
  return addFiles(files, { day, note: noteId });
}

// ---------- adding

async function addFiles(files, opts) {
  let n = 0;
  for (const file of files) {
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
  if (t?.id !== 'myfilesDay' && t?.id !== 'myfilesPlace') return;
  const files = [...(t.files || [])];
  if (!files.length) return;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(t.dataset.day || '') ? t.dataset.day : dayKey(Date.now());
  const n = await addFiles(files, { day });
  t.value = '';
  if (n) toast(n === 1 ? 'Kept.' : `${n} kept.`);
});

// ---------- one file

let shown = null; // the id of the file in the sheet

async function openFile(id) {
  letGo('sheet');
  const list = await F.listFiles().catch(() => []);
  const f = list.find((x) => x.id === id);
  if (!f) {
    toast("That file isn't here any more.");
    return;
  }
  shown = id;
  const stays = F.staysHere(f);
  const preview = f.thumb ? `<img class="file-full" id="myfilesImg" src="${esc(thumbURL('sheet', f))}" alt="${esc(f.name)}">` : '';
  openSheet(`<p class="kicker">${esc(longDay(f.day))}</p>
    <h2 class="display sheet-title file-title">${esc(f.name)}</h2>
    ${preview}
    <p class="muted small">${esc(F.sizeText(f.size))}${f.w && f.h ? ` · ${f.w} × ${f.h}` : ''} · ${esc(stays || (f.up ? 'Synced, end-to-end encrypted.' : CLOUD.signedIn() ? 'Syncs soon, end-to-end encrypted.' : 'Syncs once you sign in.'))}</p>
    <p class="muted small" id="myfilesState">${f.here ? '' : 'Getting it from your other devices…'}</p>
    <div class="row">
      <button class="btn ghost small" data-act="myfiles-save" data-id="${esc(f.id)}">${icon('share')} Save a copy</button>
      ${f.size <= F.SYNC_FILE_MAX ? `<button class="btn ghost small" data-act="myfiles-sync" data-id="${esc(f.id)}" data-on="${!f.sync}">${f.sync ? 'Keep only on this device' : 'Sync it'}</button>` : ''}
    </div>
    <button class="btn ghost block danger" data-act="myfiles-del" data-id="${esc(f.id)}">Delete from all your devices</button>`);
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
    <p class="small">Keep photos and files with your days: from a note, from a day in Your days, or here. Each is encrypted on your device before it syncs, so only your devices can open it.</p>
    <div class="row"><button class="btn small primary" data-act="myfiles-open">Open</button></div>
  </section>`;
}

async function openPlace() {
  letGo('place');
  let list = [];
  let u = { count: 0, here: 0, synced: 0, quota: 0 };
  try {
    [list, u] = await Promise.all([F.listFiles(), F.usage()]);
  } catch (err) {
    toast(err?.message || "Your files couldn't be read.");
    return;
  }
  const note = FS.status.otherAccount
    ? "The files on this device belong to another account, so they aren't synced."
    : FS.status.newer
      ? 'A newer version of Arise synced your files. They sync again once this app has updated.'
      : FS.status.error || '';
  const days = new Map();
  for (const f of list.slice(0, 200)) days.set(f.day, [...(days.get(f.day) || []), f]);
  const groups = [...days]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([k, fs]) => `<p class="label">${esc(longDay(k))}</p><div class="file-grid">${fs.map((f) => tile('place', f)).join('')}</div>`)
    .join('');
  openSheet(`<p class="kicker">Your days</p>
    <h2 class="display sheet-title">Photos and files</h2>
    <p class="small">${esc(whereLine())}</p>
    <p class="muted small">On this device: ${esc(F.sizeText(u.here))} in ${u.count} ${u.count === 1 ? 'file' : 'files'}${u.quota ? `, of the ${esc(F.sizeText(u.quota))} this browser lets Arise keep` : ''}.${CLOUD.signedIn() ? ` Synced: ${esc(F.sizeText(u.synced))} of ${esc(F.sizeText(F.SYNC_TOTAL_MAX))}.` : ''}</p>
    <p class="muted small">Big photos are saved smaller (${F.SHRINK_TO} pixels across) to save space. Files over ${esc(F.sizeText(F.SYNC_FILE_MAX))} stay on the device you add them on.</p>
    ${note ? `<p class="muted small">${esc(note)}</p>` : ''}
    <div class="row">${addLabel('myfilesPlace', dayKey(Date.now()))}</div>
    ${groups || '<p class="muted small">Nothing kept yet.</p>'}`);
}

// ---------- taps

export async function handleAction(act, el) {
  if (!act.startsWith('myfiles-')) return false;
  const id = el?.dataset?.id || '';
  switch (act) {
    case 'myfiles-open':
      await openPlace();
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
      if (!globalThis.confirm?.('Delete this from all your devices? This cannot be undone.')) return true;
      try {
        await F.deleteFile(id);
        toast('Deleted.');
      } catch (err) {
        toast(err?.message || "It couldn't be deleted.");
      }
      shown = null;
      letGo('sheet');
      closeSheet();
      return true;
    }
    default:
      return false;
  }
}

// Anything changing (here or from another device): the day on screen catches up.
F.onFilesChange(() => {
  const el = $('#lifeFiles');
  const day = $('#myfilesDay')?.dataset.day;
  if (el && day) void fillDay(day);
});
