// Versions, names, notes on keeping a file up to date and finished folders between two devices,
// sealed in the files index's tree; and older apps reading and writing that index: they still
// list every file (each version as a file of its own) and never lose one, and what they drop when
// they write comes back.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sealed } from '../lib/crypto';
import { newDataKey } from '../lib/crypto';
import { cleanFilesIndex } from '../lib/validate';
import { newLifeKey, type LifeKeys } from './seal';
import * as F from './files';
import * as LOCAL from './files-store';
import { indexDocId, openFilesIndex, sealFilesIndex } from './files-seal';
import { syncFiles, type FileRemote, type SyncDeps } from './files-sync';

vi.setConfig({ testTimeout: 20_000 });

function memRemote() {
  const docs = new Map<string, Sealed>();
  const r: FileRemote & { docs: Map<string, Sealed> } = {
    docs,
    async get(id) {
      return docs.get(id) ?? null;
    },
    async put(list) {
      for (const d of list) docs.set(d.id, d.s);
    },
    async del(ids) {
      for (const id of ids) docs.delete(id);
    },
    async swapIndex(id, expect, next) {
      if ((docs.get(id)?.iv ?? '') !== expect) return false;
      docs.set(id, next);
      return true;
    },
  };
  return r;
}

const dbs = new Map<string, IDBFactory>();
function on(name: string) {
  LOCAL.closeFilesDB();
  if (!dbs.has(name)) dbs.set(name, new IDBFactory());
  globalThis.indexedDB = dbs.get(name)!;
}

let keys: LifeKeys;
let remote: ReturnType<typeof memRemote>;
const deps = (over: Partial<SyncDeps> = {}): SyncDeps => ({ remote, keys, uid: 'uid1', ...over });
const bytes = (n: number, seed = 1) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) & 255;
  return b;
};
const wait = () => new Promise((r) => setTimeout(r, 3));
const ids = (list: { id: string }[]) => list.map((f) => f.id);
const indexOf = async () => JSON.parse(await openFilesIndex(keys, 'uid1', remote.docs.get(await indexDocId(keys))!));
// The index written back by an older app: `shape` is what it keeps of it.
async function writeBack(shape: (raw: Record<string, unknown>) => Record<string, unknown>) {
  const raw = await indexOf();
  const id = await indexDocId(keys);
  remote.docs.set(id, await sealFilesIndex(keys, 'uid1', JSON.stringify({ ...shape(raw), seq: raw.seq + 1 })));
}
// Apps from before the tree: the index without it.
const beforeTree = (raw: Record<string, unknown>) => {
  const old = cleanFilesIndex(raw);
  return { schema: old.schema, files: old.files, gone: old.gone };
};
// Apps from 1.35 to 1.38: the tree as they read it, without names, notes, versions or Finished
// (and the time those changed), each record with the same time it had.
type Rec = Record<string, unknown>;
const pick = (o: Rec, keep: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => keep.includes(k)));
const withOldTree = (raw: Record<string, unknown>) => {
  const tree = raw.tree as { dirs: Record<string, Rec>; gone: Rec; files: Record<string, Rec> };
  const dirs = Object.fromEntries(Object.entries(tree.dirs).map(([id, d]) => [id, pick(d, ['name', 'p', 'g', 'e'])]));
  const files = Object.fromEntries(Object.entries(tree.files).map(([id, f]) => [id, pick(f, ['d', 't', 'm', 'h'])]));
  return { ...raw, tree: { dirs, gone: tree.gone, files } };
};

beforeEach(async () => {
  dbs.clear();
  keys = (await newLifeKey(await newDataKey(), 'uid1')).keys;
  remote = memRemote();
  F._setImageTools({ scale: async () => null });
});

describe('between two devices', () => {
  it('syncs versions, and a restore on one device shows on the other', async () => {
    on('phone');
    const v1 = await F.putFile(bytes(10), { name: 'CV.docx', sameName: true });
    await syncFiles(deps());
    await wait();
    const v2 = await F.putFile(bytes(11, 2), { name: 'CV.docx', sameName: true });
    await syncFiles(deps());
    // Each version is a file of its own in the list older apps read, as it was.
    const idx = await indexOf();
    expect(idx.files[v1.id]).toEqual({ n: 1, size: 10 });
    expect(idx.files[v2.id]).toEqual({ n: 1, size: 11 });
    expect(idx.tree.files[v2.id]).toMatchObject({ v: v1.id, c: v2.cur, k: v2.edited });

    on('laptop');
    await syncFiles(deps());
    expect(ids(await F.listFiles())).toEqual([v2.id]);
    expect(ids(await F.versionsOf(v2.id))).toEqual([v1.id]);
    await wait();
    await F.restoreVersion(v1.id);
    await syncFiles(deps());

    on('phone');
    await syncFiles(deps());
    expect(ids(await F.listFiles())).toEqual([v1.id]);
    expect(ids(await F.versionsOf(v1.id))).toEqual([v2.id]);
  });

  it('syncs a new name, the note on keeping it up to date, and folders marked working on or finished', async () => {
    on('phone');
    const a = await F.makeFolder('Job hunt');
    const f = await F.putFile(bytes(10), { name: 'IMG_1234.jpg', dir: a });
    await F.renameFile(f.id, 'Cover letter.jpg');
    await F.setUpkeep(f.id, 'Update the CV after each new job');
    await F.setFolderState(a, 'w');
    await syncFiles(deps());
    // Sealed: nothing of it in the clear.
    const sealed = remote.docs.get(await indexDocId(keys))!;
    expect(atob(sealed.ct).includes('Update the CV')).toBe(false);

    on('laptop');
    await syncFiles(deps());
    expect(await LOCAL.getStored(f.id)).toMatchObject({ name: 'Cover letter.jpg', upkeep: 'Update the CV after each new job', dir: a });
    expect((await F.listFolders()).dirs[a].s).toBe('w');
    await wait();
    await F.setUpkeep(f.id, '');
    await F.finishFiles([f.id]);
    await syncFiles(deps());

    on('phone');
    await syncFiles(deps());
    const t = await F.listFolders();
    const there = await LOCAL.getStored(f.id);
    expect(there?.upkeep).toBeUndefined();
    expect(t.dirs[there!.dir!]).toMatchObject({ name: 'Finished', s: 'f', p: a });
  });
});

describe('older apps', () => {
  it('an app from before the tree lists every version as a file, loses none, and what it drops comes back', async () => {
    on('phone');
    const v1 = await F.putFile(bytes(10), { name: 'plan.md', sameName: true });
    await wait();
    const v2 = await F.putFile(bytes(11, 2), { name: 'plan.md', sameName: true });
    await F.setUpkeep(v2.id, 'Look at it each Monday');
    await syncFiles(deps());
    const raw = await indexOf();
    expect(raw.schema).toBe(1); // the index's own schema is unchanged
    expect(Object.keys(cleanFilesIndex(raw).files).sort()).toEqual([v1.id, v2.id].sort());
    await writeBack(beforeTree);

    on('laptop');
    await syncFiles(deps());
    // Not known here yet: both show, nothing is hidden or lost...
    expect(ids(await F.listFiles()).sort()).toEqual([v1.id, v2.id].sort());
    on('phone');
    await syncFiles(deps()); // ...until the phone, which knows, puts the tree back
    expect((await indexOf()).tree.files[v2.id]).toMatchObject({ v: v1.id, u: 'Look at it each Monday' });
    on('laptop');
    await syncFiles(deps());
    expect(ids(await F.listFiles())).toEqual([v2.id]);
    expect(await LOCAL.getStored(v2.id)).toMatchObject({ upkeep: 'Look at it each Monday' });
  });

  it('an app from 1.35 to 1.38 writes the tree back without them: they stay, and a device updated since learns them', async () => {
    on('phone');
    const a = await F.makeFolder('Old jobs');
    await F.setFolderState(a, 'f');
    const v1 = await F.putFile(bytes(10), { name: 'CV.docx', dir: a, sameName: true });
    await wait();
    const v2 = await F.putFile(bytes(11, 2), { name: 'CV.docx', dir: a, sameName: true });
    await F.renameFile(v2.id, 'CV 2026.docx');
    await syncFiles(deps());
    await writeBack(withOldTree);

    // The laptop ran the older app then: it got the files, where they are, and the same times.
    on('laptop');
    await syncFiles(deps());
    expect(ids(await F.listFiles()).sort()).toEqual([v1.id, v2.id].sort());
    expect((await F.listFolders()).dirs[a].s).toBeUndefined();

    on('phone');
    await syncFiles(deps());
    // What the phone knew stayed, and went back into the tree.
    expect(ids(await F.listFiles())).toEqual([v2.id]);
    expect((await F.listFolders()).dirs[a].s).toBe('f');
    const tree = (await indexOf()).tree;
    expect(tree.files[v2.id]).toMatchObject({ n: 'CV 2026.docx', v: v1.id, k: expect.any(Number) });
    expect(tree.dirs[a].s).toBe('f');

    // The laptop, updated now, takes them in.
    on('laptop');
    await syncFiles(deps());
    expect(ids(await F.listFiles())).toEqual([v2.id]);
    expect((await LOCAL.getStored(v2.id))?.name).toBe('CV 2026.docx');
    expect((await F.listFolders()).dirs[a].s).toBe('f');
  });

  it('a move made later in an older app keeps the versions and the note here', async () => {
    on('phone');
    const box = await F.makeFolder('Box');
    const v1 = await F.putFile(bytes(10), { name: 'a.txt', sameName: true });
    await wait();
    const v2 = await F.putFile(bytes(11, 2), { name: 'a.txt', sameName: true });
    await F.setUpkeep(v2.id, 'Keep it short');
    await syncFiles(deps());
    // The older app moves it, later, and writes only where it sits.
    await writeBack((raw) => {
      const r = withOldTree(raw) as { tree: { files: Record<string, Rec> } };
      r.tree.files[v2.id] = { d: box, m: Date.now() + 1000 };
      return r;
    });
    await syncFiles(deps());
    expect(await LOCAL.getStored(v2.id)).toMatchObject({ dir: box, vg: v1.id, upkeep: 'Keep it short' });
    expect(ids(await F.listFiles())).toEqual([v2.id]);
  });
});
