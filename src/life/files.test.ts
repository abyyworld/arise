// The storage API for photos and files on this device: keep, get back, list, delete, previews.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as F from './files';
import * as LOCAL from './files-store';
import { PART_BYTES } from './files-seal';

// Megabytes through a database in memory: more time than the default when every test file runs at once.
vi.setConfig({ testTimeout: 20_000 });

// Pictures without a browser: "scaling" gives a blob of a size that says how far it was scaled.
const scaled: number[] = [];
const fakeTools: F.ImageTools = {
  async scale(_blob, max) {
    scaled.push(max);
    return { blob: new Blob([new Uint8Array(max === F.THUMB_PX ? 200 : 5000)], { type: 'image/jpeg' }), w: 4000, h: 3000 };
  },
};

beforeEach(() => {
  LOCAL.closeFilesDB();
  globalThis.indexedDB = new IDBFactory();
  scaled.length = 0;
  F._setImageTools(fakeTools);
});
afterEach(() => F._setImageTools(null));

const bytes = (n: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i & 255;
  return b;
};
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const read = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe('keeping files', () => {
  it('keeps a file and gives the same bytes back, in parts when it is big', async () => {
    const data = bytes(PART_BYTES * 2 + 10);
    const f = await F.putFile(data, { name: 'notes.pdf', type: 'application/pdf', day: '2026-11-20' });
    expect(f).toMatchObject({ name: 'notes.pdf', type: 'application/pdf', size: data.length, day: '2026-11-20', here: true, up: false, sync: true });
    expect(f.thumb).toBeUndefined();
    expect(await LOCAL.readParts(f.id, 3)).toHaveLength(3);
    const got = await F.getFile(f.id);
    expect(got?.info.id).toBe(f.id);
    expect(got?.blob.type).toBe('application/pdf');
    expect(same(await read(got!.blob), data)).toBe(true);
  });

  it('takes a Blob or File with its own name and type, and the day of when it was added', async () => {
    const file = new File([bytes(50)], 'list.txt', { type: 'text/plain' });
    const at = Date.UTC(2026, 9, 3, 12);
    const f = await F.putFile(file, { at });
    expect(f).toMatchObject({ name: 'list.txt', type: 'text/plain', size: 50, at, day: '2026-10-03' });
  });

  it('makes a preview for a photo and saves a big one smaller, as JPEG', async () => {
    const f = await F.putFile(new Blob([bytes(100_000)], { type: 'image/png' }), { name: 'beach.png' });
    expect(scaled).toEqual([F.SHRINK_TO, F.THUMB_PX]);
    expect(f).toMatchObject({ type: 'image/jpeg', name: 'beach.jpg', size: 5000, w: 4000, h: 3000 });
    expect(f.thumb?.length).toBe(200);
    const kept = await F.putFile(new Blob([bytes(100_000)], { type: 'image/png' }), { name: 'full.png', shrink: false });
    expect(kept).toMatchObject({ type: 'image/png', size: 100_000 });
    expect(kept.thumb?.length).toBe(200);
  });

  it('keeps a photo as it is when the browser cannot read it, without a preview', async () => {
    F._setImageTools({ scale: async () => null });
    const f = await F.putFile(new Blob([bytes(3000)], { type: 'image/heic' }), { name: 'a.heic' });
    expect(f).toMatchObject({ type: 'image/heic', size: 3000 });
    expect(f.thumb).toBeUndefined();
  });

  it('refuses an empty file', async () => {
    await expect(F.putFile(new Uint8Array(0))).rejects.toMatchObject({ code: 'empty' });
  });
});

describe('listing and notes', () => {
  it("lists every file or one day, newest first, and a note's files", async () => {
    const a = await F.putFile(bytes(10), { name: 'a', day: '2026-11-01', at: 1000 });
    const b = await F.putFile(bytes(10), { name: 'b', day: '2026-11-02', at: 2000 });
    const c = await F.attachToNote('manual:n1', bytes(10), { name: 'c', day: '2026-11-02', at: 3000 });
    expect((await F.listFiles()).map((f) => f.id)).toEqual([c.id, b.id, a.id]);
    expect((await F.listFiles({ day: '2026-11-02' })).map((f) => f.name)).toEqual(['c', 'b']);
    expect((await F.filesForNote('manual:n1')).map((f) => f.id)).toEqual([c.id]);
  });

  it('says how much is kept here', async () => {
    await F.putFile(bytes(1000), { name: 'a' });
    await F.putFile(bytes(500), { name: 'b', sync: false });
    const u = await F.usage();
    expect(u).toMatchObject({ count: 2, here: 1500, synced: 0 });
    expect(F.sizeText(1500)).toBe('1 KB');
    expect(F.sizeText(3 * 1048576)).toBe('3.0 MB');
  });
});

describe('deleting', () => {
  it('takes the file and its bytes away, and notes it for the cloud when it syncs', async () => {
    let told = 0;
    const off = F.onFilesChange(() => told++);
    const f = await F.putFile(bytes(PART_BYTES + 1), { name: 'a' });
    const g = await F.putFile(bytes(10), { name: 'b', sync: false });
    expect(await F.deleteFile(f.id)).toBe(true);
    expect(await F.deleteFile(g.id)).toBe(true);
    expect(await F.getFile(f.id)).toBeNull();
    expect(await LOCAL.readParts(f.id, 2)).toBeNull();
    expect(await F.listFiles()).toEqual([]);
    // Only the one that syncs is noted for the cloud.
    expect((await LOCAL.tombs()).map((t) => t.id)).toEqual([f.id]);
    expect(await F.deleteFile(f.id)).toBe(false);
    expect(told).toBe(4);
    off();
  });

  it('erases everything on this device', async () => {
    await F.putFile(bytes(10));
    await LOCAL.eraseFilesHere();
    expect(await F.listFiles()).toEqual([]);
  });
});

describe('what syncs', () => {
  it('says which files stay on this device', () => {
    expect(F.staysHere({ size: 10, sync: true })).toBe('');
    expect(F.staysHere({ size: 10, sync: false })).toBe('Only on this device.');
    expect(F.staysHere({ size: F.SYNC_FILE_MAX + 1, sync: true })).toMatch(/don't sync/);
  });

  it('turns syncing off and on for a file kept here', async () => {
    const f = await F.putFile(bytes(10));
    expect((await F.setSynced(f.id, false))?.sync).toBe(false);
    expect((await F.setSynced(f.id, true))?.sync).toBe(true);
  });

  it('cannot get back a file that is only in the cloud when not signed in', async () => {
    const f = await F.putFile(bytes(10));
    await LOCAL.saveFile({ ...f, here: false, up: true }, []);
    expect(await F.getFile(f.id)).toBeNull();
  });
});

describe('what comes from storage or the cloud (lib/validate.ts)', async () => {
  const { cleanFileMeta, cleanFilesIndex } = await import('../lib/validate');
  const ok = { id: 'abcdefghijklmnopqrstuv', name: 'a.jpg', type: 'image/jpeg', size: 10, at: 1000, day: '2026-11-20', sync: true };

  it('keeps a good file record and tidies its name and type', () => {
    expect(cleanFileMeta(ok)).toEqual(ok);
    expect(cleanFileMeta({ ...ok, name: '../x\u0000.jpg', type: '<script>' })).toMatchObject({ name: '.. x .jpg', type: 'application/octet-stream' });
    expect(cleanFileMeta({ ...ok, thumb: btoa('abc') })?.thumb).toEqual(new Uint8Array([97, 98, 99]));
    expect(cleanFileMeta({ ...ok, sync: undefined })?.sync).toBe(true);
  });

  it('refuses a bad id, day, size or time', () => {
    for (const bad of [{ id: 'x' }, { day: '2026-13-01' }, { size: -1 }, { size: 1e12 }, { size: 1.5 }, { at: 0 }]) expect(cleanFileMeta({ ...ok, ...bad })).toBeNull();
  });

  it('keeps a good index, and a file listed as both there and deleted counts as there', () => {
    const id = 'abcdefghijklmnopqrstuv';
    const idx = cleanFilesIndex({ schema: 1, seq: 3, files: { [id]: { n: 2, size: 600000 }, bad: { n: 1, size: 1 } }, gone: { [id]: { at: 5, n: 2 }, zzzzzzzzzzzzzzzzzzzzzz: { at: 9, n: 1 } } });
    expect(idx).toEqual({ schema: 1, seq: 3, files: { [id]: { n: 2, size: 600000 } }, gone: { zzzzzzzzzzzzzzzzzzzzzz: { at: 9, n: 1 } } });
    expect(cleanFilesIndex(null)).toEqual({ schema: 1, seq: 0, files: {}, gone: {} });
  });
});
