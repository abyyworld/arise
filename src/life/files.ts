// Photos and files the Player keeps with Arise: added from a note, from a day in Your days, or from
// Photos and files in Setup and connections. This is the small storage API the rest of the app
// calls (and other features can: a note that keeps photos calls attachToNote and filesForNote).
//
//   putFile(data, { name, type, day, note, sync, shrink })  keep a file; returns its details
//   getFile(id)          its details and bytes (fetched from the cloud the first time on a device
//                        that didn't add it). Null when it's gone or can't be fetched now.
//   listFiles({ day, note, trash })   details, newest first (with the small preview, never the
//                        bytes). Files in the trash only with `trash: true`.
//   trashFiles(ids)      to the trash, on every device, for TRASH_DAYS days; restoreFiles(ids) back
//   emptyTrash()         deleteFile for everything in the trash; clearOldTrash() for what's been
//                        there TRASH_DAYS days (both also happen on their own: files-sync.ts)
//   deleteFile(id)       for good: from this device, the cloud and the Player's other devices
//   folders: listFolders, makeFolder, renameFolder, moveFolder, linkFolder (to a goal: a
//            project), deleteFolder (only an empty one); moveFiles(ids, folder)
//   findCopies()         groups of files with exactly the same bytes; keepOne(id) trashes the rest
//   versions: putFile(data, { versionOf }) or a file with the same name in the same folder
//            ({ sameName }) keeps the old one as a version (files-versions.ts); versionsOf(id),
//            restoreVersion(id), deleteVersion(id). Only current versions are listed, unless asked.
//   renameFile(id, name), keepName(id); setUpkeep(id, text): how to keep it up to date
//   setFolderState(id, 'w' | 'f'): working on it, or finished; finishFiles(ids) moves files to
//            the finished folder next to them (made the first time)
//   setSynced(id, on)    "only on this device" or back to syncing
//   usage()              how much is kept here and in the cloud
//   onFilesChange(fn)    after anything changes, here or from another device
//
// Kept on this device in IndexedDB (files-store.ts). With an account, they sync end-to-end
// encrypted: sealed on the device with keys derived from the life log's (files-seal.ts), so the
// server only ever holds ciphertext (files-sync.ts). Previews are made on the device.

import { cleanFileMeta, folderName, MAX_FILE_BYTES, type FileMeta } from '../lib/validate';
import { sha256Hex } from '../lib/s3';
import { dayKey } from './dates';
import { newFileId, partCount, splitBytes, joinBytes } from './files-seal';
import * as LOCAL from './files-store';
import * as SYNC from './files-sync';
import { copyGroups, dirOf, expired, FINISHED_NAME, finishedFolderIn, foldersIn, inFinished, isWithin, type FolderState, type Folders } from './files-tree';
import { bundleOf, currentOf, currentOnly, groupOf, olderOf, overCap } from './files-versions';
import { extOf, unhelpful } from './files-names';
import { fileName, upkeepText } from '../lib/validate';

export type { StoredFile as FileInfo } from './files-store';
export { SYNC_FILE_MAX, SYNC_TOTAL_MAX } from './files-sync';
export { MAX_FILE_BYTES };
export { TRASH_DAYS } from './files-tree';
export type { Folders } from './files-tree';
export { MAX_VERSIONS } from './files-versions';

export interface PutOptions {
  name?: string;
  type?: string;
  day?: string; // the day it belongs to (default: today, or the day of `at`)
  at?: number; // when it was added (default: now)
  note?: string; // the id of a note in the life log it goes with
  dir?: string; // the folder it goes in (default: the top)
  sync?: boolean; // false: only on this device (default: syncs with the account)
  versionOf?: string; // a new version of this file: it takes the file's place, and the file is kept as a version
  // A file with the same name in the same folder becomes a version of it (the file manager does
  // this). Not for photos and videos with camera names (IMG_1234.jpg, image.jpg): those repeat.
  sameName?: boolean;
  shrink?: boolean; // a photo is saved smaller (at most SHRINK_TO pixels across) when that saves space (default: on)
}

export class FilesError extends Error {
  constructor(
    readonly code: 'too-big' | 'empty' | 'unavailable' | 'not-here' | 'no-name' | 'no-folder' | 'not-empty' | 'loop' | 'same' | 'no-file',
    message: string,
  ) {
    super(message);
  }
}

// ---------- pictures (previews, and photos saved smaller), made on the device

export const THUMB_PX = 320;
export const SHRINK_TO = 2560;

export interface ImageTools {
  // A picture scaled to fit `max` pixels across and down, as JPEG, with the picture's own size.
  // Null when this browser can't read the picture (then there's no preview).
  scale(blob: Blob, max: number, quality: number): Promise<{ blob: Blob; w: number; h: number } | null>;
}

const browserTools: ImageTools = {
  async scale(blob, max, quality) {
    const g = globalThis as { createImageBitmap?: typeof createImageBitmap; OffscreenCanvas?: typeof OffscreenCanvas; document?: Document };
    if (typeof g.createImageBitmap !== 'function') return null;
    let bmp: ImageBitmap;
    try {
      bmp = await g.createImageBitmap(blob);
    } catch {
      return null;
    }
    const w = bmp.width;
    const h = bmp.height;
    const k = Math.min(1, max / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k));
    const ch = Math.max(1, Math.round(h * k));
    try {
      if (typeof g.OffscreenCanvas === 'function') {
        const c = new g.OffscreenCanvas(cw, ch);
        c.getContext('2d')?.drawImage(bmp, 0, 0, cw, ch);
        return { blob: await c.convertToBlob({ type: 'image/jpeg', quality }), w, h };
      }
      const c = g.document?.createElement('canvas');
      if (!c) return null;
      c.width = cw;
      c.height = ch;
      c.getContext('2d')?.drawImage(bmp, 0, 0, cw, ch);
      const out = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
      return out ? { blob: out, w, h } : null;
    } catch {
      return null;
    } finally {
      bmp.close?.();
    }
  },
};
let tools: ImageTools = browserTools;
// For tests: pictures without a browser.
export const _setImageTools = (t: ImageTools | null) => (tools = t || browserTools);

const isImage = (type: string) => /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/.test(type);

async function bytesOf(data: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  const b = data as Blob;
  return new Uint8Array(typeof b.arrayBuffer === 'function' ? await b.arrayBuffer() : await new Response(b).arrayBuffer());
}

// ---------- changes

const listeners = new Set<() => void>();
export function onFilesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());
SYNC.onSyncChange(changed);

// ---------- the API

export async function putFile(data: Blob | ArrayBuffer | Uint8Array, opts: PutOptions = {}): Promise<LOCAL.StoredFile> {
  const asFile = data as Partial<File>;
  let type = String(opts.type || asFile.type || 'application/octet-stream').toLowerCase();
  let name = String(opts.name || asFile.name || (isImage(type) ? 'Photo' : 'File'));
  let bytes = await bytesOf(data);
  if (!bytes.length) throw new FilesError('empty', 'That file is empty.');
  let w = 0;
  let h = 0;
  let thumb: Uint8Array | undefined;
  if (isImage(type)) {
    const blob = data instanceof Blob ? data : new Blob([new Uint8Array(bytes)], { type });
    // A big photo is saved smaller when that saves space (most phone photos are far bigger than a
    // screen). Its name says JPEG then.
    if (opts.shrink !== false && type !== 'image/gif') {
      const small = await tools.scale(blob, SHRINK_TO, 0.85).catch(() => null);
      if (small) [w, h] = [small.w, small.h];
      if (small && small.blob.size > 0 && small.blob.size < bytes.length * 0.9) {
        bytes = await bytesOf(small.blob);
        if (type !== 'image/jpeg') name = name.replace(/\.[a-z0-9]{1,5}$/i, '') + '.jpg';
        type = 'image/jpeg';
        // The size it's kept at.
        const k = Math.min(1, SHRINK_TO / Math.max(w, h, 1));
        [w, h] = [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
      }
    }
    const t = await tools.scale(blob, THUMB_PX, 0.7).catch(() => null);
    if (t) {
      if (!w) [w, h] = [t.w, t.h];
      const tb = await bytesOf(t.blob);
      if (tb.length && tb.length <= 96 * 1024) thumb = tb;
    }
  }
  if (bytes.length > MAX_FILE_BYTES) throw new FilesError('too-big', `That file is too big to keep (the most is ${Math.round(MAX_FILE_BYTES / 1048576)} MB).`);
  const at = opts.at ?? Date.now();
  const hash = await sha256Hex(bytes);
  let dir = opts.dir && (await LOCAL.readTree()).dirs[opts.dir] ? opts.dir : undefined;
  // The file it's a new version of, if any.
  const all = opts.versionOf || opts.sameName ? await LOCAL.allStored() : [];
  let prev: LOCAL.StoredFile | null = null;
  if (opts.versionOf) {
    prev = currentOf(all, opts.versionOf);
    if (!prev || prev.bin) throw new FilesError('no-file', "That file isn't here any more.");
  } else if (opts.sameName && !(/^(image|video)\//.test(type) && unhelpful(name))) {
    const want = name.toLowerCase();
    prev = currentOnly(all).find((f) => !f.bin && (f.dir || undefined) === dir && f.name.toLowerCase() === want) || null;
  }
  const now = Date.now();
  let more: Partial<FileMeta> = {};
  if (prev) {
    if (prev.hash === hash) throw new FilesError('same', `That's the same as the current version of ${prev.name}.`);
    dir = prev.dir;
    // It keeps the file's name, unless it's another kind of file (a PDF for a Word file).
    if (extOf(name) === extOf(prev.name)) name = prev.name;
    more = { vg: groupOf(prev), cur: now, upkeep: prev.upkeep, moved: now, edited: now };
  }
  const sync = opts.sync ?? (prev ? prev.sync : true);
  const meta = cleanFileMeta({ id: newFileId(), name, type, size: bytes.length, at, day: opts.day || dayKey(at), note: opts.note, w, h, thumb, sync, hash, dir, moved: dir ? now : undefined, ...more } satisfies Partial<FileMeta>);
  if (!meta) throw new FilesError('empty', "That file couldn't be kept.");
  const stored: LOCAL.StoredFile = { ...meta, here: true, up: false };
  await LOCAL.saveFile(stored, splitBytes(bytes));
  // More than MAX_VERSIONS older versions: the oldest go to the trash.
  if (prev) for (const f of overCap([...all, stored], stored.id)) await LOCAL.patchFile(f.id, { bin: now, moved: now });
  changed();
  if (stored.sync || prev) SYNC.queue();
  return stored;
}

// A note's photos and files: the hook for notes that keep files.
export const attachToNote = (noteId: string, data: Blob | ArrayBuffer | Uint8Array, opts: Omit<PutOptions, 'note'> = {}) => putFile(data, { ...opts, note: noteId });
export const filesForNote = (noteId: string) => listFiles({ note: noteId });

export async function getFile(id: string): Promise<{ info: LOCAL.StoredFile; blob: Blob } | null> {
  const info = await LOCAL.getStored(id);
  if (!info) return null;
  const n = partCount(info.size);
  let parts = info.here ? await LOCAL.readParts(id, n) : null;
  if (!parts) {
    parts = await SYNC.download(id).catch(() => null);
    if (!parts) return null;
    info.here = true;
    changed();
  }
  const bytes = joinBytes(parts);
  // Its SHA-256, for finding copies, the first time it's opened (files kept before there was one).
  if (!info.hash) {
    info.hash = await sha256Hex(bytes);
    await LOCAL.patchFile(id, { hash: info.hash });
    if (info.sync) SYNC.queue();
  }
  return { info, blob: new Blob([bytes], { type: info.type }) };
}

// Files in the trash only with `trash: true`; `trash: 'all'` lists both. Out of the trash, only
// each file's current version, unless `versions: true` (in the trash, and with 'all', every one).
export async function listFiles(filter: { day?: string; note?: string; trash?: boolean | 'all'; versions?: boolean } = {}): Promise<LOCAL.StoredFile[]> {
  const hide = !filter.trash && !filter.versions;
  let all = await LOCAL.allStored(hide ? undefined : filter.day);
  if (hide) all = currentOnly(all).filter((f) => !filter.day || f.day === filter.day);
  else all = all.filter((f) => filter.trash === 'all' || !!f.bin === !!filter.trash);
  return filter.note ? all.filter((f) => f.note === filter.note) : all;
}

// From everywhere: this device now, the cloud and the other devices on the next sync.
export async function deleteFile(id: string): Promise<boolean> {
  const f = await LOCAL.getStored(id);
  if (!f) return false;
  // Noted for the cloud when it is (or may be) there.
  await LOCAL.removeStored(id, f.up || f.sync ? { id, at: Date.now(), n: f.up ? partCount(f.size) : 0 } : undefined);
  changed();
  if (f.up || f.sync) SYNC.queue();
  return true;
}

// ---------- folders (files-tree.ts): synced end-to-end encrypted in the files index's tree

export const listFolders = (): Promise<Folders> => LOCAL.readTree();

async function editFolders(fn: (t: Folders, now: number) => void): Promise<Folders> {
  const t = await LOCAL.readTree();
  fn(t, Date.now());
  await LOCAL.writeTree(t);
  changed();
  SYNC.queue();
  return t;
}
const nameOrSay = (name: string) => {
  const n = folderName(name);
  if (!n) throw new FilesError('no-name', 'Give the folder a name.');
  return n;
};
const mustHave = (t: Folders, id: string) => {
  if (!t.dirs[id]) throw new FilesError('no-folder', "That folder isn't here any more.");
  return t.dirs[id];
};

// A new folder, at the top or in another one, and (when given) the project folder of a goal.
export async function makeFolder(name: string, opts: { in?: string; goal?: string } = {}): Promise<string> {
  const n = nameOrSay(name);
  const id = newFileId();
  await editFolders((t, now) => {
    t.dirs[id] = { name: n, e: now, ...(opts.in && t.dirs[opts.in] ? { p: opts.in } : {}), ...(opts.goal ? { g: opts.goal } : {}) };
  });
  return id;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const n = nameOrSay(name);
  await editFolders((t, now) => {
    t.dirs[id] = { ...mustHave(t, id), name: n, e: now };
  });
}

// Into another folder (none: to the top). Never into itself or a folder inside it.
export async function moveFolder(id: string, into?: string): Promise<void> {
  await editFolders((t, now) => {
    const d = { ...mustHave(t, id), e: now };
    if (into) {
      mustHave(t, into);
      if (isWithin(t.dirs, into, id)) throw new FilesError('loop', "A folder can't go inside itself.");
      d.p = into;
    } else delete d.p;
    t.dirs[id] = d;
  });
}

// A folder as the project folder of a goal (lib/goals.ts), shown on that goal. None: not any more.
export async function linkFolder(id: string, goal?: string): Promise<void> {
  await editFolders((t, now) => {
    const d = { ...mustHave(t, id), e: now };
    if (goal) d.g = goal;
    else delete d.g;
    t.dirs[id] = d;
  });
}

// The project folders of a goal, by name.
export async function foldersForGoal(goal: string): Promise<{ id: string; name: string }[]> {
  const t = await LOCAL.readTree();
  return Object.entries(t.dirs)
    .filter(([, d]) => d.g === goal)
    .map(([id, d]) => ({ id, name: d.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Only an empty one: no folders in it, and no files but ones in the trash (they go back to the top).
export async function deleteFolder(id: string): Promise<void> {
  const t = await LOCAL.readTree();
  mustHave(t, id);
  const inIt = (await LOCAL.allStored()).some((f) => !f.bin && dirOf(t.dirs, f) === id);
  if (inIt || foldersIn(t.dirs, id).length) throw new FilesError('not-empty', 'Only an empty folder can be deleted. Move or delete what is in it first.');
  await editFolders((tt, now) => {
    delete tt.dirs[id];
    tt.gone[id] = now;
  });
}

// ---------- moving, and the trash

// The ids it changed.
async function patchIds(ids: readonly string[], fn: (f: LOCAL.StoredFile, now: number) => LOCAL.FilePatch | null): Promise<string[]> {
  const now = Date.now();
  const done: string[] = [];
  for (const id of new Set(ids)) {
    const f = await LOCAL.getStored(id);
    const p = f && fn(f, now);
    if (!p) continue;
    await LOCAL.patchFile(id, p);
    done.push(id);
  }
  if (done.length) {
    changed();
    SYNC.queue();
  }
  return done;
}

// These files, and the older versions of each that's a current one (they go where it goes).
async function withVersions(ids: readonly string[]): Promise<string[]> {
  const all = await LOCAL.allStored();
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    for (const f of olderOf(all, id)) out.add(f.id);
  }
  return [...out];
}
// How many of the ones asked for changed (their versions aren't counted).
const counted = (done: readonly string[], asked: readonly string[]) => done.filter((id) => asked.includes(id)).length;

// Into a folder (none: to the top), with their older versions.
export async function moveFiles(ids: readonly string[], dir?: string): Promise<number> {
  if (dir && !(await LOCAL.readTree()).dirs[dir]) throw new FilesError('no-folder', "That folder isn't here any more.");
  const done = await patchIds(await withVersions(ids), (f, now) => (f.bin || (f.dir || undefined) === (dir || undefined) ? null : { dir: dir || undefined, moved: now }));
  return counted(done, ids);
}

// To the trash on every device, with their older versions. They stay TRASH_DAYS days, and can be
// put back until then.
export async function trashFiles(ids: readonly string[]): Promise<number> {
  return counted(await patchIds(await withVersions(ids), (f, now) => (f.bin ? null : { bin: now, moved: now })), ids);
}
export const trashFile = async (id: string) => (await trashFiles([id])) > 0;

// Back from the trash, to their folder (or the top, when it's gone), with what went there with them.
export async function restoreFiles(ids: readonly string[]): Promise<number> {
  const [t, all] = await Promise.all([LOCAL.readTree(), LOCAL.allStored()]);
  const every = ids.flatMap((id) => bundleOf(all, id).map((f) => f.id));
  return counted(await patchIds(every, (f, now) => (f.bin ? { bin: undefined, moved: now, dir: dirOf(t.dirs, f) } : null)), ids);
}

// From the trash for good, with what went there with it. Says how many files went.
export async function deleteForGood(id: string): Promise<number> {
  let n = 0;
  for (const f of bundleOf(await LOCAL.allStored(), id)) if (await deleteFile(f.id)) n++;
  return n;
}

// ---------- versions (files-versions.ts)

// A file's older versions, newest first (none when it isn't the current one).
export const versionsOf = async (id: string): Promise<LOCAL.StoredFile[]> => olderOf(await LOCAL.allStored(), id);

// The current version of the file this one is a version of (itself when it's the current one).
export const currentVersion = async (id: string): Promise<LOCAL.StoredFile | null> => currentOf(await LOCAL.allStored(), id);

// An older version becomes the current one, in the current one's folder, with its name and note.
// The current one becomes a version.
export async function restoreVersion(id: string): Promise<LOCAL.StoredFile | null> {
  const all = await LOCAL.allStored();
  const v = all.find((f) => f.id === id);
  const cur = currentOf(all, id);
  if (!v || v.bin || !cur) throw new FilesError('no-file', "That version isn't here any more.");
  if (cur.id === id) return v;
  const now = Date.now();
  const patch: LOCAL.FilePatch = { cur: now, moved: now, dir: cur.dir, upkeep: cur.upkeep, edited: now };
  if (cur.name !== v.name && extOf(cur.name) === extOf(v.name)) Object.assign(patch, { name: cur.name, renamed: now });
  const out = await LOCAL.patchFile(id, patch);
  changed();
  SYNC.queue();
  return out;
}

// An older version, to the trash on its own (put back, it's a version again).
export async function deleteVersion(id: string): Promise<boolean> {
  const cur = currentOf(await LOCAL.allStored(), id);
  if (!cur || cur.id === id) return false;
  return (await patchIds([id], (f, now) => (f.bin ? null : { bin: now, moved: now }))).length > 0;
}

// ---------- a file's name, and how to keep it up to date

export async function renameFile(id: string, name: string): Promise<void> {
  const n = fileName(name);
  if (!n) throw new FilesError('no-name', 'Give it a name.');
  await patchIds([id], (_f, now) => ({ name: n, renamed: now, edited: now }));
}
// "Keep" on a suggested name: the name stays, and nothing is suggested for it again.
export async function keepName(id: string): Promise<void> {
  await patchIds([id], (f, now) => (f.renamed ? null : { renamed: now, edited: now }));
}

// A short note on how to keep a file up to date ("Update the CV after each new job"). Empty: none.
export async function setUpkeep(id: string, text: string): Promise<void> {
  const u = upkeepText(text) || undefined;
  await patchIds([id], (f, now) => ((f.upkeep || undefined) === u ? null : { upkeep: u, edited: now }));
}

// ---------- working on, and finished

export async function setFolderState(id: string, state?: FolderState): Promise<void> {
  await editFolders((t, now) => {
    const d = { ...mustHave(t, id), e: now };
    if (state) d.s = state;
    else delete d.s;
    t.dirs[id] = d;
  });
}

// Into the finished folder next to each (made the first time, called Finished). Says how many moved.
export async function finishFiles(ids: readonly string[]): Promise<number> {
  const all = await LOCAL.allStored();
  const t = await LOCAL.readTree();
  const by = new Map<string, string[]>();
  for (const id of ids) {
    const f = all.find((x) => x.id === id);
    const d = f && dirOf(t.dirs, f);
    if (!f || f.bin || inFinished(t.dirs, d)) continue;
    by.set(d || '', [...(by.get(d || '') || []), id]);
  }
  let n = 0;
  for (const [d, list] of by) {
    let to = finishedFolderIn((await LOCAL.readTree()).dirs, d || undefined);
    if (!to) {
      const made = newFileId();
      await editFolders((tt, now) => {
        tt.dirs[made] = { name: FINISHED_NAME, e: now, s: 'f', ...(d && tt.dirs[d] ? { p: d } : {}) };
      });
      to = made;
    }
    n += await moveFiles(list, to);
  }
  return n;
}

// Everything in the trash, for good. Says how many.
export async function emptyTrash(): Promise<number> {
  let n = 0;
  for (const f of await listFiles({ trash: true })) if (await deleteFile(f.id)) n++;
  return n;
}

// What's been in the trash TRASH_DAYS days goes for good (the sync does this too, on every device).
export async function clearOldTrash(now = Date.now()): Promise<number> {
  let n = 0;
  for (const f of await listFiles({ trash: true })) if (expired(f, now) && (await deleteFile(f.id))) n++;
  return n;
}

// ---------- copies: files with exactly the same bytes

// The SHA-256 of files kept here from before there was one, one at a time. Says how many.
export async function fillHashes(live: () => boolean = () => true): Promise<number> {
  let n = 0;
  let synced = false;
  for (const f of await LOCAL.allStored()) {
    if (!live()) break;
    if (f.hash || !f.here) continue;
    const parts = await LOCAL.readParts(f.id, partCount(f.size));
    if (!parts) continue;
    await LOCAL.patchFile(f.id, { hash: await sha256Hex(joinBytes(parts)) });
    synced ||= f.sync;
    n++;
  }
  if (synced) SYNC.queue();
  return n;
}

// Groups of files (not in the trash) with exactly the same bytes, oldest first in each.
export async function findCopies(): Promise<LOCAL.StoredFile[][]> {
  await fillHashes();
  return copyGroups(await listFiles());
}

// Keeps this one, and sends its copies to the trash. Says how many went.
export async function keepOne(id: string): Promise<number> {
  const f = await LOCAL.getStored(id);
  if (!f?.hash || f.bin) return 0;
  const others = (await listFiles()).filter((x) => x.id !== id && x.hash === f.hash).map((x) => x.id);
  return trashFiles(others);
}

// Off: only on this device (it goes from the cloud and the other devices). On: syncs again.
export async function setSynced(id: string, on: boolean): Promise<LOCAL.StoredFile | null> {
  const f = await LOCAL.getStored(id);
  if (!f) return null;
  if (!on && !f.here) throw new FilesError('not-here', 'Open it on this device first, so a copy stays here.');
  const out = await LOCAL.patchFile(id, { sync: on });
  changed();
  SYNC.queue();
  return out;
}

// Whether a file stays on this device whatever the setting, and why ('' when it syncs).
export function staysHere(f: Pick<FileMeta, 'size' | 'sync'>): string {
  if (!f.sync) return 'Only on this device.';
  if (f.size > SYNC.fileMax()) return `Only on this device: files over ${Math.round(SYNC.fileMax() / 1048576)} MB don't sync${SYNC.ownStorageOn() ? '' : ' without your own storage'}.`;
  return '';
}

export interface Usage {
  count: number;
  here: number; // bytes kept on this device
  synced: number; // bytes in the cloud (as of the last sync)
  quota: number; // what this browser lets Arise keep, all told (0: not known)
}
export async function usage(): Promise<Usage> {
  const all = await LOCAL.allStored();
  let quota = 0;
  try {
    quota = (await globalThis.navigator?.storage?.estimate?.())?.quota || 0;
  } catch {}
  return {
    count: all.length,
    here: all.filter((f) => f.here).reduce((n, f) => n + f.size, 0),
    synced: SYNC.status.synced || all.filter((f) => f.up).reduce((n, f) => n + f.size, 0),
    quota,
  };
}

// A size in plain words.
export function sizeText(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1048576) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}
