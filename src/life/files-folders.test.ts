// The file manager's storage on one device: folders (made, renamed, nested, moved, deleted only
// when empty, a goal's project folder), moving files, the trash (30 days, put back, emptied), and
// exact copies found by a SHA-256 of their bytes.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as F from './files';
import * as LOCAL from './files-store';
import { sha256Hex } from '../lib/s3';

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  LOCAL.closeFilesDB();
  globalThis.indexedDB = new IDBFactory();
  F._setImageTools({ scale: async () => null });
});

const bytes = (n: number, seed = 1) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) & 255;
  return b;
};
const DAY = 864e5;

describe('folders', () => {
  it('makes, renames and nests folders, one inside another', async () => {
    const trips = await F.makeFolder('Trips');
    const y = await F.makeFolder('2026', { in: trips });
    const rome = await F.makeFolder('Rome', { in: y });
    await F.renameFolder(rome, '  Rome and Naples ');
    const t = await F.listFolders();
    expect(t.dirs[trips]).toMatchObject({ name: 'Trips' });
    expect(t.dirs[y]).toMatchObject({ name: '2026', p: trips });
    expect(t.dirs[rome]).toMatchObject({ name: 'Rome and Naples', p: y });
    await expect(F.makeFolder('   ')).rejects.toMatchObject({ code: 'no-name' });
    await expect(F.renameFolder('zzzzzzzzzzzzzzzzzzzzzz', 'x')).rejects.toMatchObject({ code: 'no-folder' });
  });

  it('moves a folder, but never into itself or a folder inside it', async () => {
    const a = await F.makeFolder('A');
    const b = await F.makeFolder('B', { in: a });
    const c = await F.makeFolder('C');
    await expect(F.moveFolder(a, b)).rejects.toMatchObject({ code: 'loop' });
    await expect(F.moveFolder(a, a)).rejects.toMatchObject({ code: 'loop' });
    await F.moveFolder(a, c);
    expect((await F.listFolders()).dirs[a].p).toBe(c);
    await F.moveFolder(a);
    expect((await F.listFolders()).dirs[a].p).toBeUndefined();
  });

  it('deletes only an empty folder', async () => {
    const a = await F.makeFolder('A');
    const b = await F.makeFolder('B', { in: a });
    const f = await F.putFile(bytes(10), { name: 'x', dir: b });
    await expect(F.deleteFolder(a)).rejects.toMatchObject({ code: 'not-empty' });
    await expect(F.deleteFolder(b)).rejects.toMatchObject({ code: 'not-empty' });
    // A file in the trash doesn't keep it: put back, it goes to the top.
    await F.trashFile(f.id);
    await F.deleteFolder(b);
    await F.deleteFolder(a);
    const t = await F.listFolders();
    expect(t.dirs).toEqual({});
    expect(Object.keys(t.gone).sort()).toEqual([a, b].sort());
    await F.restoreFiles([f.id]);
    expect((await LOCAL.getStored(f.id))?.dir).toBeUndefined();
  });

  it("links a folder to a goal as its project folder, and unlinks it", async () => {
    const a = await F.makeFolder('Spanish', { goal: 'g1' });
    const b = await F.makeFolder('Other');
    await F.linkFolder(b, 'g1');
    expect(await F.foldersForGoal('g1')).toEqual([
      { id: b, name: 'Other' },
      { id: a, name: 'Spanish' },
    ]);
    await F.linkFolder(b);
    expect((await F.foldersForGoal('g1')).map((x) => x.id)).toEqual([a]);
  });
});

describe('moving files', () => {
  it('adds a file into a folder, and moves several at once', async () => {
    const a = await F.makeFolder('A');
    const b = await F.makeFolder('B');
    const f = await F.putFile(bytes(10), { name: 'f', dir: a });
    const g = await F.putFile(bytes(10, 2), { name: 'g' });
    expect(f.dir).toBe(a);
    expect(g.dir).toBeUndefined();
    expect(await F.moveFiles([f.id, g.id], b)).toBe(2);
    for (const id of [f.id, g.id]) expect(await LOCAL.getStored(id)).toMatchObject({ dir: b, moved: expect.any(Number) });
    expect(await F.moveFiles([f.id], b)).toBe(0); // already there
    await F.moveFiles([f.id]);
    expect((await LOCAL.getStored(f.id))?.dir).toBeUndefined();
    await expect(F.moveFiles([g.id], 'zzzzzzzzzzzzzzzzzzzzzz')).rejects.toMatchObject({ code: 'no-folder' });
  });
});

describe('the trash', () => {
  it('hides a file from the lists, keeps its bytes, and puts it back', async () => {
    const a = await F.makeFolder('A');
    const f = await F.putFile(bytes(50), { name: 'f', dir: a, day: '2026-11-20' });
    expect(await F.trashFile(f.id)).toBe(true);
    expect(await F.trashFile(f.id)).toBe(false); // already there
    expect(await F.listFiles()).toEqual([]);
    expect(await F.listFiles({ day: '2026-11-20' })).toEqual([]);
    expect((await F.listFiles({ trash: true })).map((x) => x.id)).toEqual([f.id]);
    expect(await LOCAL.readParts(f.id, 1)).toHaveLength(1);
    // Nothing is noted for the cloud to delete yet.
    expect(await LOCAL.tombs()).toEqual([]);
    expect(await F.restoreFiles([f.id])).toBe(1);
    expect(await LOCAL.getStored(f.id)).toMatchObject({ dir: a });
    expect((await LOCAL.getStored(f.id))?.bin).toBeUndefined();
    expect((await F.listFiles()).map((x) => x.id)).toEqual([f.id]);
  });

  it('empties: everything there goes for good, and the cloud is told', async () => {
    const f = await F.putFile(bytes(10), { name: 'f' });
    const g = await F.putFile(bytes(10, 2), { name: 'g', sync: false });
    const keep = await F.putFile(bytes(10, 3), { name: 'keep' });
    await F.trashFiles([f.id, g.id]);
    expect(await F.emptyTrash()).toBe(2);
    expect(await F.listFiles({ trash: 'all' })).toEqual([await LOCAL.getStored(keep.id)]);
    expect((await LOCAL.tombs()).map((t) => t.id)).toEqual([f.id]);
  });

  it('lets files go by themselves after 30 days', async () => {
    const f = await F.putFile(bytes(10), { name: 'old' });
    const g = await F.putFile(bytes(10, 2), { name: 'new' });
    await F.trashFiles([f.id]);
    await LOCAL.patchFile(f.id, { bin: Date.now() - 31 * DAY });
    await F.trashFiles([g.id]);
    expect(await F.clearOldTrash()).toBe(1);
    expect((await F.listFiles({ trash: true })).map((x) => x.id)).toEqual([g.id]);
    expect(await F.clearOldTrash(Date.now() + 30 * DAY)).toBe(1);
    expect(await F.listFiles({ trash: 'all' })).toEqual([]);
  });
});

describe('copies', () => {
  it('keeps a SHA-256 of the bytes it keeps, made on the device', async () => {
    const data = bytes(1000);
    const f = await F.putFile(data, { name: 'a' });
    expect(f.hash).toBe(await sha256Hex(data));
  });

  it('finds files with exactly the same bytes, and keeping one sends the rest to the trash', async () => {
    const a = await F.putFile(bytes(300), { name: 'a.pdf', at: 1000 });
    const b = await F.putFile(bytes(300), { name: 'b.pdf', at: 2000 });
    const c = await F.putFile(bytes(300), { name: 'c.pdf', at: 3000 });
    await F.putFile(bytes(300, 9), { name: 'other.pdf' });
    const groups = await F.findCopies();
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([[a.id, b.id, c.id]]);
    expect(await F.keepOne(b.id)).toBe(2);
    expect((await F.listFiles({ trash: true })).map((x) => x.id).sort()).toEqual([a.id, c.id].sort());
    expect(await F.findCopies()).toEqual([]);
  });

  it('works out the SHA-256 later for files kept before there was one', async () => {
    const a = await F.putFile(bytes(200), { name: 'a' });
    const b = await F.putFile(bytes(200), { name: 'b' });
    for (const id of [a.id, b.id]) {
      const { hash: _h, ...old } = (await LOCAL.getStored(id))!;
      await LOCAL.saveFile(old);
    }
    expect((await LOCAL.getStored(a.id))?.hash).toBeUndefined();
    expect((await F.findCopies()).map((g) => g.length)).toEqual([2]);
    expect((await LOCAL.getStored(a.id))?.hash).toBe(await sha256Hex(bytes(200)));
    // Opening one works it out too.
    const { hash: _h, ...old } = (await LOCAL.getStored(a.id))!;
    await LOCAL.saveFile(old);
    await F.getFile(a.id);
    expect((await LOCAL.getStored(a.id))?.hash).toBe(await sha256Hex(bytes(200)));
  });
});
