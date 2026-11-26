// Versions of a file on one device (kept, restored, capped at 20, deleted, trashed and put back
// with their file), the note on keeping a file up to date, renaming, and folders marked
// "Working on" or "Finished".

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as F from './files';
import * as LOCAL from './files-store';
import * as T from './files-tree';
import * as V from './files-versions';

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
const wait = () => new Promise((r) => setTimeout(r, 3));
const ids = (list: { id: string }[]) => list.map((f) => f.id);

describe('versions', () => {
  it('keeps the old file as a version when one with the same name goes in the same folder', async () => {
    const work = await F.makeFolder('Work');
    const v1 = await F.putFile(bytes(10, 1), { name: 'CV.docx', dir: work, sameName: true });
    await F.setUpkeep(v1.id, 'Update the CV after each new job');
    await wait();
    const v2 = await F.putFile(bytes(12, 2), { name: 'cv.docx', dir: work, sameName: true });
    expect(v2).toMatchObject({ name: 'CV.docx', dir: work, vg: v1.id, upkeep: 'Update the CV after each new job' });
    // Only the current one is listed; the old one is its version.
    expect(ids(await F.listFiles())).toEqual([v2.id]);
    expect(ids(await F.versionsOf(v2.id))).toEqual([v1.id]);
    expect(ids(await F.listFiles({ versions: true })).sort()).toEqual([v1.id, v2.id].sort());
    // Elsewhere, or without sameName, the same name is just another file.
    const other = await F.putFile(bytes(14, 3), { name: 'CV.docx', sameName: true });
    const plain = await F.putFile(bytes(16, 4), { name: 'CV.docx', dir: work });
    expect(other.vg).toBeUndefined();
    expect(plain.vg).toBeUndefined();
    expect((await F.listFiles()).length).toBe(3);
  });

  it("doesn't chain camera photos (they all have names like image.jpg), and says when the bytes are the same", async () => {
    const a = await F.putFile(bytes(10, 1), { name: 'image.jpg', type: 'image/jpeg', sameName: true });
    const b = await F.putFile(bytes(10, 2), { name: 'image.jpg', type: 'image/jpeg', sameName: true });
    expect(b.vg).toBeUndefined();
    expect((await F.listFiles()).length).toBe(2);
    await expect(F.putFile(bytes(10, 1), { versionOf: a.id })).rejects.toMatchObject({ code: 'same' });
    await expect(F.putFile(bytes(10, 9), { versionOf: 'zzzzzzzzzzzzzzzzzzzzzz' })).rejects.toMatchObject({ code: 'no-file' });
  });

  it('"Upload a new version" keeps the name unless the new one is another kind of file', async () => {
    const a = await F.putFile(bytes(10), { name: 'Lease.pdf', type: 'application/pdf' });
    await wait();
    const b = await F.putFile(bytes(11, 2), { name: 'lease signed.pdf', type: 'application/pdf', versionOf: a.id });
    expect(b.name).toBe('Lease.pdf');
    await wait();
    const c = await F.putFile(bytes(12, 3), { name: 'Lease.docx', versionOf: a.id });
    expect(c.name).toBe('Lease.docx');
    expect(ids(await F.versionsOf(c.id))).toEqual([b.id, a.id]);
  });

  it('restores an old version: it becomes the current one, and the current one a version', async () => {
    const box = await F.makeFolder('Box');
    const a = await F.putFile(bytes(10), { name: 'notes.txt', type: 'text/plain' });
    await wait();
    const b = await F.putFile(bytes(11, 2), { name: 'notes.txt', type: 'text/plain', versionOf: a.id });
    await F.moveFiles([b.id], box);
    await F.setUpkeep(b.id, 'Add to it each Friday');
    await wait();
    await F.restoreVersion(a.id);
    expect(ids(await F.listFiles())).toEqual([a.id]);
    expect(await LOCAL.getStored(a.id)).toMatchObject({ dir: box, upkeep: 'Add to it each Friday' });
    expect(ids(await F.versionsOf(a.id))).toEqual([b.id]);
    expect(await F.versionsOf(b.id)).toEqual([]);
    expect((await F.currentVersion(b.id))?.id).toBe(a.id);
    // And back again.
    await wait();
    await F.restoreVersion(b.id);
    expect(ids(await F.listFiles())).toEqual([b.id]);
  });

  it(`keeps at most ${F.MAX_VERSIONS} older versions; past that, the oldest go to the trash`, async () => {
    const first = await F.putFile(bytes(10, 0), { name: 'plan.md' });
    let last = first;
    for (let i = 1; i <= F.MAX_VERSIONS + 2; i++) {
      await wait();
      last = await F.putFile(bytes(10, i), { name: 'plan.md', sameName: true });
    }
    const older = await F.versionsOf(last.id);
    expect(older).toHaveLength(F.MAX_VERSIONS);
    const binned = await F.listFiles({ trash: true });
    expect(binned).toHaveLength(2);
    expect(ids(binned)).toContain(first.id);
    // The newest older versions are the ones kept.
    expect(Math.min(...older.map(V.rankOf))).toBeGreaterThan(Math.max(...binned.map(V.rankOf)));
    expect(await F.listFiles()).toHaveLength(1);
  });

  it('deletes one version to the trash on its own; put back, it is a version again', async () => {
    const a = await F.putFile(bytes(10), { name: 'a.txt' });
    await wait();
    const b = await F.putFile(bytes(11, 2), { name: 'a.txt', versionOf: a.id });
    expect(await F.deleteVersion(b.id)).toBe(false); // the current one isn't a version
    expect(await F.deleteVersion(a.id)).toBe(true);
    expect(await F.versionsOf(b.id)).toEqual([]);
    expect(ids(await F.listFiles({ trash: true }))).toEqual([a.id]);
    await F.restoreFiles([a.id]);
    expect(ids(await F.listFiles())).toEqual([b.id]);
    expect(ids(await F.versionsOf(b.id))).toEqual([a.id]);
  });

  it('a file goes to the trash, back, to another folder and for good with its versions', async () => {
    const box = await F.makeFolder('Box');
    const a = await F.putFile(bytes(10), { name: 'a.txt' });
    await wait();
    const b = await F.putFile(bytes(11, 2), { name: 'a.txt', versionOf: a.id });
    expect(await F.moveFiles([b.id], box)).toBe(1);
    expect((await LOCAL.getStored(a.id))?.dir).toBe(box);
    expect(await F.trashFiles([b.id])).toBe(1);
    expect(await F.listFiles()).toEqual([]);
    expect(V.trashBundles(await F.listFiles({ trash: true })).map(ids)).toEqual([[b.id, a.id]]);
    expect(await F.restoreFiles([b.id])).toBe(1);
    expect(ids(await F.versionsOf(b.id))).toEqual([a.id]);
    await F.trashFiles([b.id]);
    expect(await F.deleteForGood(b.id)).toBe(2);
    expect(await F.listFiles({ trash: 'all' })).toEqual([]);
  });

  it('day and note lists show only the current version', async () => {
    const a = await F.putFile(bytes(10), { name: 'a.txt', day: '2026-11-01' });
    await wait();
    const b = await F.putFile(bytes(11, 2), { name: 'a.txt', day: '2026-11-20', versionOf: a.id });
    expect(await F.listFiles({ day: '2026-11-01' })).toEqual([]);
    expect(ids(await F.listFiles({ day: '2026-11-20' }))).toEqual([b.id]);
    expect(ids(await F.listFiles({ day: '2026-11-01', versions: true }))).toEqual([a.id]);
  });
});

describe('the rules for versions', () => {
  const f = (id: string, at: number, more: Partial<{ vg: string; cur: number; bin: number }> = {}) => ({ id, at, ...more });
  it('the one that became current last is the current one; ties go by id', () => {
    const list = [f('a', 1), f('b', 2, { vg: 'a' }), f('c', 3, { vg: 'a' }), f('x', 5)];
    expect(V.currentOnly(list).map((x) => x.id)).toEqual(['c', 'x']);
    const restored = [f('a', 1, { cur: 10 }), f('b', 2, { vg: 'a' }), f('c', 3, { vg: 'a' })];
    expect(V.currentOnly(restored).map((x) => x.id)).toEqual(['a']);
    expect(V.olderOf(restored, 'a').map((x) => x.id)).toEqual(['c', 'b']);
    expect(V.olderOf(restored, 'b')).toEqual([]);
    expect(V.overCap(restored, 'a', 1).map((x) => x.id)).toEqual(['b']);
    // The current one in the trash: the newest left shows (nothing is ever hidden).
    expect(V.currentOnly([f('a', 1), f('b', 2, { vg: 'a', bin: 9 })]).map((x) => x.id)).toEqual(['a']);
  });
});

describe('a name, and how to keep it up to date', () => {
  it('renames, keeps a name, and keeps a short note', async () => {
    const a = await F.putFile(bytes(10), { name: 'IMG_1234.jpg' });
    await F.renameFile(a.id, ' Passport / scan ');
    expect(await LOCAL.getStored(a.id)).toMatchObject({ name: 'Passport   scan', renamed: expect.any(Number) });
    await expect(F.renameFile(a.id, '   ')).rejects.toMatchObject({ code: 'no-name' });
    const b = await F.putFile(bytes(10, 2), { name: 'scan.pdf' });
    await F.keepName(b.id);
    expect(await LOCAL.getStored(b.id)).toMatchObject({ name: 'scan.pdf', renamed: expect.any(Number) });
    await F.setUpkeep(b.id, '  Renew   it every\nyear ');
    expect((await LOCAL.getStored(b.id))?.upkeep).toBe('Renew it every year');
    await F.setUpkeep(b.id, 'x'.repeat(500));
    expect((await LOCAL.getStored(b.id))?.upkeep).toHaveLength(200);
    await F.setUpkeep(b.id, '');
    expect((await LOCAL.getStored(b.id))?.upkeep).toBeUndefined();
  });
});

describe('working on, and finished', () => {
  it('marks folders; finished ones are apart, working ones first', async () => {
    const a = await F.makeFolder('Alpha');
    const b = await F.makeFolder('Beta');
    const c = await F.makeFolder('Gamma');
    await F.setFolderState(c, 'w');
    await F.setFolderState(a, 'f');
    const t = await F.listFolders();
    expect(T.foldersByState(t.dirs)).toEqual({ open: [c, b], finished: [a] });
    await F.setFolderState(a);
    expect((await F.listFolders()).dirs[a].s).toBeUndefined();
  });

  it('moves files to Finished in one go: the finished folder next to them, made the first time', async () => {
    const job = await F.makeFolder('Job hunt');
    await F.setFolderState(job, 'w');
    const a = await F.putFile(bytes(10), { name: 'a.pdf', dir: job });
    const b = await F.putFile(bytes(10, 2), { name: 'b.pdf', dir: job });
    const top = await F.putFile(bytes(10, 3), { name: 'c.pdf' });
    expect(await F.finishFiles([a.id])).toBe(1);
    const t = await F.listFolders();
    const done = T.finishedFolderIn(t.dirs, job);
    expect(t.dirs[done]).toMatchObject({ name: 'Finished', s: 'f', p: job });
    expect((await LOCAL.getStored(a.id))?.dir).toBe(done);
    // The second time, the same folder; one already there stays.
    expect(await F.finishFiles([b.id, a.id])).toBe(1);
    expect(Object.keys((await F.listFolders()).dirs)).toHaveLength(2);
    expect((await LOCAL.getStored(b.id))?.dir).toBe(done);
    // At the top, a finished folder at the top.
    await F.finishFiles([top.id]);
    const t2 = await F.listFolders();
    expect(t2.dirs[T.finishedFolderIn(t2.dirs)]).toMatchObject({ name: 'Finished', s: 'f' });
  });

  it('a folder written back by an app from before Finished, with the same time, keeps its mark', () => {
    const mine = { dirs: { aaaaaaaaaaaaaaaaaaaaaa: { name: 'A', e: 5, s: 'f' as const } }, gone: {} };
    const old = { dirs: { aaaaaaaaaaaaaaaaaaaaaa: { name: 'A', e: 5 } }, gone: {} };
    expect(T.mergeFolders(mine, old).dirs.aaaaaaaaaaaaaaaaaaaaaa.s).toBe('f');
    expect(T.mergeFolders(old, mine).dirs.aaaaaaaaaaaaaaaaaaaaaa.s).toBe('f');
    // Unmarked later: that wins.
    expect(T.mergeFolders(mine, { dirs: { aaaaaaaaaaaaaaaaaaaaaa: { name: 'A', e: 6 } }, gone: {} }).dirs.aaaaaaaaaaaaaaaaaaaaaa.s).toBeUndefined();
  });
});
