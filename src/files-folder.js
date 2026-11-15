// Your files: a folder of the Player's own, like their Filen folder (or iCloud Drive, Dropbox,
// OneDrive, Google Drive), that their own app keeps synced to their other devices. Arise never logs
// in to any of them: on a computer (Chrome, Edge, Brave, Arc) it's given the folder once and writes
// to it; Filen's app does the rest. In it, an "Arise" folder with:
//   backups/arise-backup-YYYY-MM-DD.json   once a day while Arise is open, the newest 7 kept
//   arise-extension-chrome.zip              the browser extension, when asked, for your other computers
// The folder is kept in this browser only (IndexedDB), never synced. A browser asks again for
// permission after a restart unless the Player allowed it on every visit; then Arise shows a button.
// Phones and other browsers save through the share sheet instead, where Filen shows up too.

import * as S from './store';
import { EXTENSION_ZIP } from './life/browser-config';

const DB = 'arise-files';
const KEY = 'folder';
const STATE = 'arise-files';
const KEEP = 7;
const DAY_MS = 86_400_000;

export const supported = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function' && !window.Capacitor?.isNativePlatform?.();

// ---------- the folder, kept in this browser

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(mode, fn) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}
let store = {
  get: () => kv('readonly', (s) => s.get(KEY)).catch(() => null),
  put: (h) => kv('readwrite', (s) => s.put(h, KEY)),
  drop: () => kv('readwrite', (s) => s.delete(KEY)),
};
const getFolder = () => store.get();
const putFolder = (h) => store.put(h);
const dropFolder = () => store.drop();
// For tests: where the folder is kept (a folder handle can't be copied into a fake database).
export const _useStore = (s) => (store = s);

// What this device remembers about it (no names of files, only the folder's own name and when).
export function state() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE) || '{}') || {};
    return { name: typeof s.name === 'string' ? s.name.slice(0, 120) : '', last: Number(s.last) || 0, error: typeof s.error === 'string' ? s.error.slice(0, 200) : '', ext: Number(s.ext) || 0 };
  } catch {
    return { name: '', last: 0, error: '', ext: 0 };
  }
}
function setState(patch) {
  try {
    const next = { ...state(), ...patch };
    if (!next.name) localStorage.removeItem(STATE);
    else localStorage.setItem(STATE, JSON.stringify(next));
  } catch {}
}

const listeners = new Set();
export const onChange = (cb) => (listeners.add(cb), () => listeners.delete(cb));
const changed = () => listeners.forEach((cb) => cb());

// 'granted', 'prompt' (needs a tap to allow again), 'denied' (blocked: pick the folder again) or
// 'none' (no folder picked). `ask` only from a tap.
export async function access(ask = false) {
  const h = await getFolder();
  if (!h) return 'none';
  const opts = { mode: 'readwrite' };
  let p = (await h.queryPermission?.(opts)) || 'granted';
  if (p === 'prompt' && ask) p = (await h.requestPermission?.(opts)) || 'denied';
  return p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'prompt';
}
export const PAUSED = 'Backups are paused until you allow the folder again: Setup and connections, Your files.';
export const BLOCKED = 'Your browser blocked that folder. Pick it again.';

// Asks for a folder (from a tap). False when the Player closed the picker.
export async function pick() {
  let h;
  try {
    h = await window.showDirectoryPicker({ id: 'arise-files', mode: 'readwrite', startIn: 'documents' });
  } catch (err) {
    if (err?.name === 'AbortError') return false;
    throw err;
  }
  await putFolder(h);
  setState({ name: h.name || 'your folder', last: 0, error: '' });
  await backupNow();
  changed();
  return true;
}

export async function forget() {
  await dropFolder();
  setState({ name: '' });
  changed();
}

async function ariseFolder(h, ...parts) {
  let dir = await h.getDirectoryHandle('Arise', { create: true });
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  return dir;
}

async function writeFile(dir, name, data) {
  const f = await dir.getFileHandle(name, { create: true });
  const w = await f.createWritable();
  try {
    await w.write(data);
    await w.close();
  } catch (err) {
    await w.abort?.().catch(() => {}); // (so no half-written temporary file is left to sync)
    throw err;
  }
}

// ---------- backups

export const backupName = (k) => `arise-backup-${k}.json`;
const BACKUP = /^arise-backup-(\d{4}-\d{2}-\d{2})\.json$/;

// Which backups to delete so only the newest `keep` stay.
export function oldBackups(names, keep = KEEP) {
  return names
    .filter((n) => BACKUP.test(n))
    .sort()
    .reverse()
    .slice(keep);
}

// Writes today's backup (and lets the oldest go). Throws when it can't; says so in state().
// `ask`: from a tap, so the browser may ask for permission again.
export async function backupNow({ ask = false } = {}) {
  const h = await getFolder();
  if (!h) return false;
  const a = await access(ask);
  if (a !== 'granted') {
    setState({ error: a === 'denied' ? BLOCKED : PAUSED });
    changed();
    if (ask) throw new Error(a === 'denied' ? BLOCKED : "The folder wasn't allowed, so nothing was saved.");
    return false;
  }
  try {
    const dir = await ariseFolder(h, 'backups');
    await writeFile(dir, backupName(S.todayKey()), JSON.stringify(S.exportData(), null, 2));
    const names = [];
    for await (const [name] of dir.entries()) names.push(name);
    for (const n of oldBackups(names)) await dir.removeEntry(n).catch(() => {});
    setState({ last: Date.now(), error: '' });
  } catch (err) {
    setState({ error: err?.message || "Couldn't write to the folder." });
    changed();
    throw err;
  }
  changed();
  return true;
}

// Once a day, while Arise is open and the folder is allowed.
export async function backupIfDue(now = Date.now()) {
  const st = state();
  if (!st.name || now - st.last < DAY_MS) return false;
  try {
    return await backupNow();
  } catch {
    return false;
  }
}

// The browser extension, into the folder, for the Player's other computers.
export async function saveExtension(fetcher = fetch) {
  const h = await getFolder();
  if (!h || (await access(true)) !== 'granted') return false;
  const res = await fetcher(EXTENSION_ZIP, { cache: 'no-store' });
  if (!res.ok) throw new Error("The extension isn't on this copy of the site yet.");
  await writeFile(await ariseFolder(h), 'arise-extension-chrome.zip', await res.blob());
  setState({ ext: Date.now() });
  changed();
  return true;
}

export function initFiles() {
  if (!supported()) return;
  void backupIfDue();
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void backupIfDue();
  });
}
