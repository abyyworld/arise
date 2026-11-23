// Photos and files on this device: IndexedDB 'arise-my-files' (not 'arise-files', which is the
// "Your files" folder's: src/files-folder.js). The storage behind files.ts, and what the sync
// (files-sync.ts) reads and writes.
//
//   files   one FileMeta each (lib/validate.ts), plus `here` (its bytes are on this device) and
//           `up` (it's in the cloud). Index: day.
//   parts   a file's bytes in parts of PART_BYTES (files-seal.ts): { k: id#i, id, i, b }. Index: id.
//   gone    files deleted here that the cloud may still have: { id, at, n }
//   kv      the sync's own notes: which account, and the files index it last saw

import { cleanFileMeta, type FileMeta } from '../lib/validate';

export const FILES_DB = 'arise-my-files';
const VERSION = 1;

export interface StoredFile extends FileMeta {
  here: boolean; // its bytes are on this device (else only its details and preview, until opened)
  up: boolean; // it's in the cloud
}
export interface Tomb {
  id: string;
  at: number;
  n: number; // its parts in the cloud (0: not known)
}
export interface FilesState {
  uid: string; // the account the files synced with
  seq: number; // the newest files index this device has seen
}

let opening: Promise<IDBDatabase> | null = null;

export function openFilesDB(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) {
      reject(Object.assign(new Error("This browser can't keep files (it has no on-device database)."), { code: 'unavailable' }));
      return;
    }
    const r = idb.open(FILES_DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' }).createIndex('day', 'day');
      if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts', { keyPath: 'k' }).createIndex('id', 'id');
      if (!db.objectStoreNames.contains('gone')) db.createObjectStore('gone', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      db.onclose = () => {
        opening = null;
      };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Object.assign(new Error('Your files are busy in another tab. Close it and try again.'), { code: 'blocked' }));
  }).catch((err) => {
    opening = null;
    throw err;
  });
  return opening;
}

// Forget the open connection (tests, which swap the database between simulated devices).
export function closeFilesDB() {
  const o = opening;
  opening = null;
  o?.then((db) => db.close()).catch(() => {});
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Saving the file was stopped.'));
  });

export function cleanStored(raw: unknown): StoredFile | null {
  const m = cleanFileMeta(raw);
  if (!m) return null;
  const r = raw as { here?: unknown; up?: unknown };
  return { ...m, here: r.here !== false, up: r.up === true };
}

// A file's details and (when given) its bytes, in one go. The bytes' parts replace any it had.
export async function saveFile(f: StoredFile, parts?: readonly Uint8Array[]): Promise<void> {
  const db = await openFilesDB();
  const tx = db.transaction(['files', 'parts'], 'readwrite');
  tx.objectStore('files').put(f);
  if (parts) {
    const store = tx.objectStore('parts');
    const old = store.index('id').getAllKeys(f.id);
    old.onsuccess = () => {
      for (const k of old.result) store.delete(k);
      parts.forEach((b, i) => store.put({ k: `${f.id}#${i}`, id: f.id, i, b: new Uint8Array(b) }));
    };
  }
  await done(tx);
}

// Only the details (here, up, sync): never the bytes.
export async function patchFile(id: string, patch: Partial<Pick<StoredFile, 'here' | 'up' | 'sync'>>): Promise<StoredFile | null> {
  const db = await openFilesDB();
  const tx = db.transaction('files', 'readwrite');
  const store = tx.objectStore('files');
  let out: StoredFile | null = null;
  const g = store.get(id);
  g.onsuccess = () => {
    const f = cleanStored(g.result);
    if (!f) return;
    out = { ...f, ...patch };
    store.put(out);
  };
  await done(tx);
  return out;
}

export async function getStored(id: string): Promise<StoredFile | null> {
  const db = await openFilesDB();
  return cleanStored(await req(db.transaction('files').objectStore('files').get(id)));
}

// Every file, or one day's, newest first.
export async function allStored(day?: string): Promise<StoredFile[]> {
  const db = await openFilesDB();
  const store = db.transaction('files').objectStore('files');
  const rows = await req(day ? store.index('day').getAll(day) : store.getAll());
  return rows
    .map(cleanStored)
    .filter((f): f is StoredFile => !!f)
    .sort((a, b) => b.at - a.at);
}

// A file's bytes, in their parts. Null when they aren't all here.
export async function readParts(id: string, n: number): Promise<Uint8Array[] | null> {
  const db = await openFilesDB();
  const rows = (await req(db.transaction('parts').objectStore('parts').index('id').getAll(id))) as { i: number; b: Uint8Array }[];
  const parts: Uint8Array[] = [];
  for (const r of rows) if (Number.isInteger(r.i) && r.i >= 0 && r.i < n) parts[r.i] = new Uint8Array(r.b);
  for (let i = 0; i < n; i++) if (!parts[i]) return null;
  return parts;
}

// A file goes from this device: its details and bytes. With `tomb`, the cloud is told on the next
// sync, so it goes from the Player's other devices too.
export async function removeStored(id: string, tomb?: Tomb): Promise<void> {
  const db = await openFilesDB();
  const tx = db.transaction(['files', 'parts', 'gone'], 'readwrite');
  tx.objectStore('files').delete(id);
  const parts = tx.objectStore('parts');
  const keys = parts.index('id').getAllKeys(id);
  keys.onsuccess = () => {
    for (const k of keys.result) parts.delete(k);
  };
  if (tomb) tx.objectStore('gone').put(tomb);
  await done(tx);
}

export async function tombs(): Promise<Tomb[]> {
  const db = await openFilesDB();
  return ((await req(db.transaction('gone').objectStore('gone').getAll())) as Tomb[]).filter((t) => t && typeof t.id === 'string');
}
export async function dropTomb(id: string): Promise<void> {
  const db = await openFilesDB();
  const tx = db.transaction('gone', 'readwrite');
  tx.objectStore('gone').delete(id);
  await done(tx);
}

export async function readFilesState(): Promise<FilesState | null> {
  const db = await openFilesDB();
  const row = (await req(db.transaction('kv').objectStore('kv').get('state'))) as { v?: FilesState } | undefined;
  const v = row?.v;
  return v && typeof v.uid === 'string' && v.uid ? { uid: v.uid, seq: Number(v.seq) || 0 } : null;
}
export async function writeFilesState(st: FilesState | null): Promise<void> {
  const db = await openFilesDB();
  const tx = db.transaction('kv', 'readwrite');
  if (st) tx.objectStore('kv').put({ k: 'state', v: st });
  else tx.objectStore('kv').delete('state');
  await done(tx);
}

// Everything goes from this device ("Erase all data", or another account's data taking its place).
// The cloud keeps its copy.
export async function eraseFilesHere(): Promise<void> {
  const db = await openFilesDB();
  const tx = db.transaction(['files', 'parts', 'gone', 'kv'], 'readwrite');
  for (const s of ['files', 'parts', 'gone', 'kv']) tx.objectStore(s).clear();
  await done(tx);
}

// Whether this browser has kept any files (without making the database if it hasn't).
export async function hasFilesDB(): Promise<boolean> {
  const idb = (globalThis as { indexedDB?: IDBFactory & { databases?: () => Promise<{ name?: string }[]> } }).indexedDB;
  if (!idb) return false;
  if (typeof idb.databases !== 'function') return true;
  try {
    return (await idb.databases()).some((d) => d.name === FILES_DB);
  } catch {
    return true;
  }
}
