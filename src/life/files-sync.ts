// Photos and files between the Player's devices, end-to-end encrypted like the life log, in the
// same cloud folder under the same database rules (users/{uid}/life/{43 characters}: see
// files-seal.ts). Nothing here needs a new rule, a storage bucket or a paid plan.
//
// Cloud layout, every id an HMAC (files-seal.ts):
//   files index   which files there are (each one's number of parts and size), and which were
//                 deleted and when, sealed. Every change to it checks nobody else wrote in between.
//                 Its `tree` (files-tree.ts): the folders, and where each file sits (its folder,
//                 in the trash since when) with a SHA-256 of its bytes for finding copies. Apps
//                 from before the tree ignore it, so they still list every file (one in the trash
//                 shows as a plain file there). An index they write back comes without it; the
//                 next device with the tree puts back what it knows (the change made last wins).
//   file#meta     a file's details and small preview, sealed: what another device shows at once
//   file#0..n-1   its bytes, in sealed parts of 512 KB: fetched only when it's opened there
//
// When: after each sync of the life log that went through (cloud.ts onSynced), so a file never
// goes to an account the life log doesn't, and a few seconds after a file is added or deleted
// here. A file is sent before the index lists it, so another device never sees a file it can't
// fetch; a deleted file leaves the index first, then its documents go.
//
// Where the files go is one small interface (FileRemote). With the Player's own storage set up (a
// Cloudflare R2 bucket in their own account, lib/own-storage.ts), new files' parts go there
// instead (PartsStore, r2Store): far more room, 10 GB free. The index and each file's details
// stay in the database, so a device always knows what there is and where.

import type { Sealed } from '../lib/crypto';
import { cleanFileMeta, cleanFilesIndex, cleanFilesTree, type FilePlaceRec, type FilesIndex, type FilesTree } from '../lib/validate';
import { canon, expired, fieldsOf, mergeFolders, placeOf, sameFolders } from './files-tree';
import { filesCloud, onSynced, queue as queueLife, type FilesCloud } from './cloud';
import type { LifeKeys } from './seal';
import { fileDocIds, indexDocId, metaDocId, openFilesIndex, openMeta, openPart, partCount, partDocId, sealFilesIndex, sealMeta, sealPart } from './files-seal';
import * as LOCAL from './files-store';
import { sha256Hex, sign } from '../lib/s3';
import { endpoint, isOn, type OwnStorage } from '../lib/own-storage';
import { MAX_FILE_BYTES } from '../lib/validate';
import * as S from '../store';

export const FILES_SCHEMA = 1;
// 2: some files' parts are in the Player's own storage. Written only while one is listed, so
// apps from before it keep syncing everyone else's files.
export const FILES_SCHEMA_OWN = 2;
// What goes to the cloud: files up to SYNC_FILE_MAX each, and SYNC_TOTAL_MAX in all per account.
// Bigger ones stay on the device they were added on. (The free database has room for about a
// gigabyte for everyone who uses this copy of Arise, so each account keeps to a share of it.)
export const SYNC_FILE_MAX = 20 * 1024 * 1024;
export const SYNC_TOTAL_MAX = 250 * 1024 * 1024;
// With the Player's own storage: every file Arise keeps (MAX_FILE_BYTES), and its free 10 GB.
export const OWN_FILE_MAX = MAX_FILE_BYTES;
export const OWN_TOTAL_MAX = 10 * 1024 * 1024 * 1024;
const GONE_KEEP = 400 * 864e5; // like the life log's tombstones
const GROUP_CHARS = 8_000_000; // per write to the cloud, which takes up to 10 MB
const GROUP_DOCS = 400;

// ---------- where the files go

export interface FileRemote {
  get(id: string): Promise<Sealed | null>;
  put(docs: readonly { id: string; s: Sealed }[]): Promise<void>;
  del(ids: readonly string[]): Promise<void>;
  // Writes the index only if it's still the one read (`expect`: its iv, '' for none). False:
  // another device wrote first.
  swapIndex(id: string, expect: string, next: Sealed): Promise<boolean>;
}

const docOf = (d: unknown): Sealed | null => {
  const x = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  return typeof x.iv === 'string' && typeof x.ct === 'string' ? { iv: x.iv, ct: x.ct } : null;
};
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

// The account's folder in Firestore (the life log's: cloud.ts).
export function firestoreRemote(c: FilesCloud): FileRemote {
  const { fb, db } = c;
  const row = (s: Sealed, t: number) => ({ v: 1 as const, iv: s.iv, ct: s.ct, updated: t });
  return {
    async get(id) {
      const snap = await fb.getDoc(c.ref(id));
      return snap.exists() ? docOf(snap.data()) : null;
    },
    async put(docs) {
      let i = 0;
      while (i < docs.length) {
        const batch = fb.writeBatch(db);
        let chars = 0;
        let n = 0;
        const t = Date.now();
        while (i < docs.length && n < GROUP_DOCS && (n === 0 || chars + docs[i].s.ct.length <= GROUP_CHARS)) {
          batch.set(c.ref(docs[i].id), row(docs[i].s, t));
          chars += docs[i].s.ct.length;
          n++;
          i++;
        }
        await batch.commit();
      }
    },
    async del(ids) {
      for (let i = 0; i < ids.length; i += GROUP_DOCS) {
        const batch = fb.writeBatch(db);
        for (const id of ids.slice(i, i + GROUP_DOCS)) batch.delete(c.ref(id));
        await batch.commit();
      }
    },
    async swapIndex(id, expect, next) {
      return fb.runTransaction(db, async (tx) => {
        const [cur, acct] = [await tx.get(c.ref(id)), await tx.get(c.account)];
        if (!acct.exists()) throw fail('gone', 'This account was deleted.');
        if ((cur.exists() ? docOf(cur.data())?.iv : '') !== expect) return false;
        tx.set(c.ref(id), row(next, Date.now()));
        return true;
      });
    },
  };
}

// Where a file's parts can go instead of the database.
export interface PartsStore {
  get(id: string): Promise<Sealed | null>;
  put(docs: readonly { id: string; s: Sealed }[]): Promise<void>;
  del(ids: readonly string[]): Promise<void>;
}

const OWN_AT_ONCE = 4;
async function inTurns<T>(list: readonly T[], fn: (x: T) => Promise<void>) {
  for (let i = 0; i < list.length; i += OWN_AT_ONCE) await Promise.all(list.slice(i, i + OWN_AT_ONCE).map(fn));
}

// The Player's own Cloudflare R2 bucket, signed on this device (lib/s3.ts). Each part is the same
// sealed JSON the database would hold, under arise/<its id>.
export function r2Store(cfg: OwnStorage, fetcher: typeof fetch = (...a) => fetch(...a)): PartsStore {
  const url = (id: string) => `${endpoint(cfg)}/arise/${id}`;
  const call = async (method: string, id: string, body?: string) => {
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(body);
    const headers = await sign({ method, url: url(id), payloadHash: await sha256Hex(bytes), keyId: cfg.keyId, secret: cfg.secret, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' } }) });
    let res: Response;
    try {
      res = await fetcher(url(id), { method, headers, ...(body === undefined ? {} : { body: bytes }) });
    } catch {
      throw fail('unavailable', "Couldn't reach your own storage. Check the internet connection, and the CORS policy on the bucket.");
    }
    return res;
  };
  const bad = (res: Response) =>
    fail('own-storage', res.status === 403 || res.status === 401 ? 'Your own storage said no. Check the access key, and that its token may read and write this bucket.' : res.status === 404 ? "Your own storage couldn't find that bucket." : `Your own storage answered with an error (${res.status}).`);
  return {
    async get(id) {
      const res = await call('GET', id);
      if (res.status === 404) return null;
      if (!res.ok) throw bad(res);
      try {
        return docOf(JSON.parse(await res.text()));
      } catch {
        return null;
      }
    },
    async put(docs) {
      await inTurns(docs, async (d) => {
        const res = await call('PUT', d.id, JSON.stringify({ v: 1, iv: d.s.iv, ct: d.s.ct }));
        if (!res.ok) throw bad(res);
      });
    },
    async del(ids) {
      await inTurns(ids, async (id) => {
        const res = await call('DELETE', id);
        if (!res.ok && res.status !== 404) throw bad(res);
      });
    },
  };
}

// Before saving the Player's own storage: a test part written, read back and deleted.
export async function checkOwnStorage(cfg: OwnStorage, fetcher?: typeof fetch): Promise<void> {
  const store = r2Store(cfg, fetcher);
  const id = `check-${Date.now().toString(36)}`;
  const s = { iv: 'check', ct: 'Arise checks it can write here. This can be deleted.' };
  await store.put([{ id, s }]);
  const back = await store.get(id);
  if (!back || back.ct !== s.ct) throw fail('own-storage', "Arise wrote to your own storage but couldn't read it back. Check the token may read and write this bucket.");
  await store.del([id]);
}

// ---------- status, for the screen

export const status = {
  busy: false,
  otherAccount: false, // the files here synced with another account
  newer: false, // a newer version of Arise synced them
  error: '',
  synced: 0, // bytes in the cloud
  at: 0,
};
const listeners = new Set<() => void>();
export function onFilesSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const told = () => listeners.forEach((fn) => fn());

// ---------- one sync

export interface SyncDeps {
  remote: FileRemote;
  own?: PartsStore | null; // the Player's own storage, where new files' parts go when it's set up
  keys: LifeKeys;
  uid: string;
  live?: () => boolean;
  now?: number;
}

const emptyIndex = (): FilesIndex => ({ schema: FILES_SCHEMA, seq: 0, files: {}, gone: {} });
const syncedBytes = (idx: FilesIndex) => Object.values(idx.files).reduce((n, f) => n + f.size, 0);
const bytesIn = (idx: FilesIndex, own: boolean) => Object.values(idx.files).reduce((n, f) => n + (!!f.o === own ? f.size : 0), 0);
const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

async function readIndex(d: SyncDeps, id: string): Promise<{ tag: string; idx: FilesIndex; tree: FilesTree }> {
  const s = await d.remote.get(id);
  if (!s) return { tag: '', idx: emptyIndex(), tree: cleanFilesTree(null) };
  const raw = JSON.parse(await openFilesIndex(d.keys, d.uid, s));
  return { tag: s.iv, idx: cleanFilesIndex(raw), tree: cleanFilesTree(raw && typeof raw === 'object' ? (raw as { tree?: unknown }).tree : null) };
}

// A file's place from the tree, as its own fields (only the ones set).
const placeFields = (p: FilePlaceRec | undefined) => ({ ...(p?.d ? { dir: p.d } : {}), ...(p?.t ? { bin: p.t } : {}), ...(p?.m ? { moved: p.m } : {}), ...(p?.h ? { hash: p.h } : {}) });

// Pulls what changed elsewhere and pushes what changed here. Says whether anything changed here.
export async function syncFiles(d: SyncDeps): Promise<boolean> {
  const live = d.live || (() => true);
  const now = d.now ?? Date.now();
  let st = await LOCAL.readFilesState();
  // Files that synced with another account never go into this one.
  if (st && st.uid !== d.uid) throw fail('other-account', 'The files on this device belong to another account.');
  if (!st) {
    st = { uid: d.uid, seq: 0 };
    await LOCAL.writeFilesState(st);
  }
  const idxId = await indexDocId(d.keys);
  const sent = new Set<string>(); // sent in this sync, so a second go doesn't send them again
  let changedHere = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (!live()) return changedHere;
    const { tag, idx, tree } = await readIndex(d, idxId);
    if (idx.schema > FILES_SCHEMA_OWN) throw fail('newer', 'A newer version of Arise synced your files.');
    if (idx.seq < st.seq) throw fail('older', 'The files in the cloud are older than ones this device has seen.');

    // ---- the trash: what's been there TRASH_DAYS days goes for good, like a deletion
    for (const f of await LOCAL.allStored()) {
      if (!expired(f, now)) continue;
      await LOCAL.removeStored(f.id, f.up || f.sync ? { id: f.id, at: now, n: f.up ? partCount(f.size) : 0 } : undefined);
      changedHere = true;
    }

    // ---- take in: deleted elsewhere, and new elsewhere
    const here = new Map((await LOCAL.allStored()).map((f) => [f.id, f]));
    const gone = new Map((await LOCAL.tombs()).map((t) => [t.id, t]));
    for (const id of Object.keys(idx.gone)) {
      const f = here.get(id);
      // (One this device sends again, after "only on this device" was undone there, stays.)
      if (f && f.up) {
        await LOCAL.removeStored(id);
        here.delete(id);
        changedHere = true;
      }
    }
    for (const f of [...here.values()]) {
      if (!f.up || idx.files[f.id] || idx.gone[f.id]) continue;
      // It was in the cloud and isn't any more, with no word of why (an old copy put back, or
      // deleted so long ago that the note of it is gone). Its bytes here go up again; a file
      // whose bytes were never here can't be fetched any more, so it goes.
      if (f.here) await LOCAL.patchFile(f.id, { up: false });
      else {
        await LOCAL.removeStored(f.id);
        here.delete(f.id);
        changedHere = true;
      }
    }
    // ---- folders, and where each file sits: the change made last wins
    const mine = await LOCAL.readTree();
    const folders = mergeFolders(mine, { dirs: tree.dirs, gone: tree.gone }, now);
    if (!sameFolders(folders, mine)) {
      await LOCAL.writeTree(folders);
      changedHere = true;
    }
    for (const [id, p] of Object.entries(tree.files)) {
      const f = here.get(id);
      if (!f || !idx.files[id]) continue;
      const patch: LOCAL.FilePatch = (p.m || 0) > (f.moved || 0) ? fieldsOf(p) : {};
      if (p.h && !f.hash) patch.hash = p.h;
      if (!Object.keys(patch).length) continue;
      const nf = await LOCAL.patchFile(id, patch);
      if (nf) here.set(id, nf);
      changedHere = true;
    }
    for (const [id, info] of Object.entries(idx.files)) {
      if (!live()) return changedHere;
      const f = here.get(id);
      if (f) {
        // Sent from here before, and the note that it was got lost.
        if (!f.up && f.sync) await LOCAL.patchFile(id, { up: true });
        continue;
      }
      if (gone.has(id)) continue; // deleted here: it leaves the index below
      const s = await d.remote.get(await metaDocId(d.keys, id));
      if (!s) continue; // being sent by another device right now: next time
      let meta;
      try {
        meta = cleanFileMeta(JSON.parse(await openMeta(d.keys, d.uid, id, s)));
      } catch {
        meta = null;
      }
      if (!meta || meta.id !== id || partCount(meta.size) !== info.n) continue;
      const { dir: _d, bin: _b, moved: _m, hash: _h, ...plain } = meta;
      await LOCAL.saveFile({ ...plain, ...placeFields(tree.files[id]), sync: true, here: false, up: true });
      changedHere = true;
    }

    // ---- send what changed here
    const next: FilesIndex = { schema: FILES_SCHEMA, seq: idx.seq, files: { ...idx.files }, gone: { ...idx.gone } };
    const own = d.own || null;
    let room = own ? OWN_TOTAL_MAX - bytesIn(idx, true) : SYNC_TOTAL_MAX - bytesIn(idx, false);
    const most = own ? OWN_FILE_MAX : SYNC_FILE_MAX;
    const added: string[] = [];
    const leaving: { id: string; n: number; keep: boolean; o?: 1 }[] = [];
    for (const f of (await LOCAL.allStored()).reverse()) {
      if (!live()) return changedHere;
      if (f.sync && f.here && !idx.files[f.id] && !gone.has(f.id)) {
        if (f.size > most || f.size > room) continue; // stays on this device (files.ts says so)
        const n = partCount(f.size);
        if (!sent.has(f.id)) {
          const parts = await LOCAL.readParts(f.id, n);
          if (!parts) continue;
          // (Where it sits goes in the index's tree, not here: it changes.)
          const { thumb, here: _h, up: _u, where: _w, dir: _d, bin: _b, moved: _m, hash: _x, ...rest } = f;
          const metaText = JSON.stringify({ ...rest, sync: true, ...(own ? { where: 'own' } : {}), ...(thumb ? { thumb: b64(thumb) } : {}) });
          const docs: { id: string; s: Sealed }[] = [];
          for (let i = 0; i < n; i++) docs.push({ id: await partDocId(d.keys, f.id, i), s: await sealPart(d.keys, d.uid, f.id, i, n, parts[i]) });
          // The details last: once they're there, so is everything they describe.
          const meta = { id: await metaDocId(d.keys, f.id), s: await sealMeta(d.keys, d.uid, f.id, metaText) };
          if (own) {
            await own.put(docs);
            await d.remote.put([meta]);
          } else await d.remote.put([...docs, meta]);
          sent.add(f.id);
        }
        next.files[f.id] = own ? { n, size: f.size, o: 1 } : { n, size: f.size };
        delete next.gone[f.id];
        room -= f.size;
        added.push(f.id);
      } else if (!f.sync && idx.files[f.id]) {
        // "Only on this device": it goes from the cloud and the other devices, and stays here.
        leaving.push({ id: f.id, n: idx.files[f.id].n, keep: true, ...(idx.files[f.id].o ? { o: 1 as const } : {}) });
      }
    }
    for (const t of gone.values()) {
      const was = idx.files[t.id] || idx.gone[t.id];
      leaving.push({ id: t.id, n: idx.files[t.id]?.n || t.n, keep: false, ...(was?.o ? { o: 1 as const } : {}) });
    }
    for (const l of leaving) {
      if (next.files[l.id]) {
        delete next.files[l.id];
        next.gone[l.id] = l.o ? { at: now, n: l.n, o: 1 } : { at: now, n: l.n };
      }
    }
    if (Object.values(next.files).some((f) => f.o)) next.schema = FILES_SCHEMA_OWN;
    for (const [id, g] of Object.entries(next.gone)) if (now - g.at > GONE_KEEP) delete next.gone[id];

    // The tree: the folders together, and each listed file's place as it is here now.
    const after = new Map((await LOCAL.allStored()).map((f) => [f.id, f]));
    const places: FilesTree['files'] = {};
    for (const id of Object.keys(next.files)) {
      const f = after.get(id);
      const p = f ? placeOf(f) : { ...tree.files[id] };
      if (!p.h && tree.files[id]?.h) p.h = tree.files[id].h;
      if (Object.keys(p).length) places[id] = p;
    }
    const nextTree: FilesTree = { dirs: folders.dirs, gone: folders.gone, files: places };
    const treeEmpty = !Object.keys(nextTree.dirs).length && !Object.keys(nextTree.gone).length && !Object.keys(places).length;

    const changed =
      added.length > 0 || leaving.some((l) => idx.files[l.id]) || Object.keys(next.gone).length !== Object.keys(idx.gone).length || canon(nextTree) !== canon(tree);
    if (changed) {
      next.seq = idx.seq + 1;
      const sealed = await sealFilesIndex(d.keys, d.uid, JSON.stringify(treeEmpty ? next : { ...next, tree: nextTree }));
      if (!live()) return changedHere;
      if (!(await d.remote.swapIndex(idxId, tag, sealed))) continue; // another device wrote first: again
    }
    st.seq = next.seq;
    await LOCAL.writeFilesState(st);
    for (const id of added) await LOCAL.patchFile(id, { up: true });
    // The documents of what left the index go now. A deletion stays noted here until they have.
    for (const l of leaving) {
      if (l.n) {
        const [meta, ...parts] = await fileDocIds(d.keys, l.id, l.n);
        // Parts in the Player's own storage go from there; without it here, they stay there
        // (sealed, and nothing lists them any more).
        if (l.o) {
          if (own) await own.del(parts);
          await d.remote.del([meta]);
        } else await d.remote.del([meta, ...parts]);
      }
      if (l.keep) await LOCAL.patchFile(l.id, { up: false });
      else await LOCAL.dropTomb(l.id);
    }
    status.synced = syncedBytes(next);
    return changedHere || added.length > 0 || leaving.length > 0;
  }
  return changedHere;
}

// A file that's only in the cloud (added on another device): its bytes, fetched and kept here.
export async function fetchBytes(d: SyncDeps, id: string): Promise<Uint8Array[] | null> {
  const f = await LOCAL.getStored(id);
  if (!f) return null;
  const n = partCount(f.size);
  const from: PartsStore | null | undefined = f.where === 'own' ? d.own : d.remote;
  if (!from) return null; // in the Player's own storage, which isn't set up here
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const s = await from.get(await partDocId(d.keys, id, i));
    if (!s) return null;
    parts.push(await openPart(d.keys, d.uid, id, i, n, s));
  }
  if (parts.reduce((k, p) => k + p.length, 0) !== f.size) return null;
  await LOCAL.saveFile({ ...f, here: true }, parts);
  return parts;
}

// ---------- in the app

// What syncs now: with the Player's own storage, far bigger files and far more of them.
export const ownStorageOn = () => isOn(S.ownStorage());
export const fileMax = () => (ownStorageOn() ? OWN_FILE_MAX : SYNC_FILE_MAX);
export const totalMax = () => (ownStorageOn() ? OWN_TOTAL_MAX : SYNC_TOTAL_MAX);

let running: Promise<void> | null = null;
let again = false;
const changeFns = new Set<() => void>();
// The files on this device changed because of the sync (files.ts tells the screens).
export const onSyncChange = (fn: () => void) => (changeFns.add(fn), () => changeFns.delete(fn));

async function deps(): Promise<SyncDeps | null> {
  const c = await filesCloud();
  const cfg = S.ownStorage();
  return c && { remote: firestoreRemote(c), own: isOn(cfg) ? r2Store(cfg) : null, keys: c.keys, uid: c.uid, live: c.live };
}

// Syncs now, if the life log syncs for an account here. Asking while one is on runs one more after.
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      const d = await deps().catch(() => null);
      if (!d) break;
      status.busy = true;
      told();
      try {
        const changed = await syncFiles(d);
        Object.assign(status, { otherAccount: false, newer: false, error: '', at: Date.now() });
        if (changed) changeFns.forEach((fn) => fn());
      } catch (err) {
        const code = String((err as { code?: string })?.code || '');
        if (code === 'other-account') status.otherAccount = true;
        else if (code === 'newer') status.newer = true;
        else if (!/unavailable|network|offline|deadline|permission|gone|blocked/.test(code)) status.error = (err as Error)?.message || 'Something went wrong.';
      } finally {
        status.busy = false;
        told();
      }
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

// After a change here: the life log's sync runs first (it decides whether this account syncs on
// this device), then this one.
export function queue() {
  queueLife(3000);
}

// The bytes of a file added on another device, from the cloud. Null when they can't be fetched
// (not signed in, offline, or not there).
export async function download(id: string): Promise<Uint8Array[] | null> {
  const d = await deps().catch(() => null);
  if (!d) return null;
  return fetchBytes(d, id);
}

onSynced(() => void syncNow());
