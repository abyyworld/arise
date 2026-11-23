// Photos and files the Player keeps with Arise: added from a note, from a day in Your days, or from
// Photos and files in Setup and connections. This is the small storage API the rest of the app
// calls (and other features can: a note that keeps photos calls attachToNote and filesForNote).
//
//   putFile(data, { name, type, day, note, sync, shrink })  keep a file; returns its details
//   getFile(id)          its details and bytes (fetched from the cloud the first time on a device
//                        that didn't add it). Null when it's gone or can't be fetched now.
//   listFiles({ day, note })   details, newest first (with the small preview, never the bytes)
//   deleteFile(id)       from this device, the cloud and the Player's other devices
//   setSynced(id, on)    "only on this device" or back to syncing
//   usage()              how much is kept here and in the cloud
//   onFilesChange(fn)    after anything changes, here or from another device
//
// Kept on this device in IndexedDB (files-store.ts). With an account, they sync end-to-end
// encrypted: sealed on the device with keys derived from the life log's (files-seal.ts), so the
// server only ever holds ciphertext (files-sync.ts). Previews are made on the device.

import { cleanFileMeta, MAX_FILE_BYTES, type FileMeta } from '../lib/validate';
import { dayKey } from './dates';
import { newFileId, partCount, splitBytes, joinBytes } from './files-seal';
import * as LOCAL from './files-store';
import * as SYNC from './files-sync';

export type { StoredFile as FileInfo } from './files-store';
export { SYNC_FILE_MAX, SYNC_TOTAL_MAX } from './files-sync';
export { MAX_FILE_BYTES };

export interface PutOptions {
  name?: string;
  type?: string;
  day?: string; // the day it belongs to (default: today, or the day of `at`)
  at?: number; // when it was added (default: now)
  note?: string; // the id of a note in the life log it goes with
  sync?: boolean; // false: only on this device (default: syncs with the account)
  shrink?: boolean; // a photo is saved smaller (at most SHRINK_TO pixels across) when that saves space (default: on)
}

export class FilesError extends Error {
  constructor(
    readonly code: 'too-big' | 'empty' | 'unavailable' | 'not-here',
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
  const meta = cleanFileMeta({ id: newFileId(), name, type, size: bytes.length, at, day: opts.day || dayKey(at), note: opts.note, w, h, thumb, sync: opts.sync !== false } satisfies Partial<FileMeta>);
  if (!meta) throw new FilesError('empty', "That file couldn't be kept.");
  const stored: LOCAL.StoredFile = { ...meta, here: true, up: false };
  await LOCAL.saveFile(stored, splitBytes(bytes));
  changed();
  if (stored.sync) SYNC.queue();
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
  return { info, blob: new Blob([joinBytes(parts)], { type: info.type }) };
}

export async function listFiles(filter: { day?: string; note?: string } = {}): Promise<LOCAL.StoredFile[]> {
  const all = await LOCAL.allStored(filter.day);
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
  if (f.size > SYNC.SYNC_FILE_MAX) return `Only on this device: files over ${Math.round(SYNC.SYNC_FILE_MAX / 1048576)} MB don't sync.`;
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
