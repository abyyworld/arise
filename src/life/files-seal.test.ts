// Photos and files sealed for the cloud: parts that open only as themselves, ids that say nothing.

import { describe, expect, it } from 'vitest';
import { newDataKey } from '../lib/crypto';
import { newLifeKey } from './seal';
import { DOC_CHARS, fileDocIds, indexDocId, isFileId, joinBytes, metaDocId, newFileId, openFilesIndex, openMeta, openPart, PART_BYTES, partCount, partDocId, sealFilesIndex, sealMeta, sealPart, splitBytes } from './files-seal';

const keys = async () => (await newLifeKey(await newDataKey(), 'uid1')).keys;
const bytes = (n: number, seed = 7) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255;
  return b;
};
// Big byte arrays compared at once (toEqual goes one by one).
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe('cutting a file into parts', () => {
  it('splits into parts of PART_BYTES and joins back the same', () => {
    const b = bytes(PART_BYTES * 2 + 5);
    const parts = splitBytes(b);
    expect(parts.map((p) => p.length)).toEqual([PART_BYTES, PART_BYTES, 5]);
    expect(same(joinBytes(parts), b)).toBe(true);
    expect(partCount(b.length)).toBe(3);
    expect(partCount(PART_BYTES)).toBe(1);
  });

  it('gives an empty file one empty part', () => {
    expect(splitBytes(new Uint8Array(0))).toEqual([new Uint8Array(0)]);
    expect(partCount(0)).toBe(1);
  });
});

describe('sealing', () => {
  it('opens a part sealed for this file, account, place and count, and nothing else', async () => {
    const k = await keys();
    const b = bytes(1000);
    const s = await sealPart(k, 'uid1', 'f1', 0, 2, b);
    expect(await openPart(k, 'uid1', 'f1', 0, 2, s)).toEqual(b);
    await expect(openPart(k, 'uid1', 'f1', 1, 2, s)).rejects.toMatchObject({ code: 'bad-data' });
    await expect(openPart(k, 'uid1', 'f1', 0, 1, s)).rejects.toMatchObject({ code: 'bad-data' });
    await expect(openPart(k, 'uid1', 'f2', 0, 2, s)).rejects.toMatchObject({ code: 'bad-data' });
    await expect(openPart(k, 'uid2', 'f1', 0, 2, s)).rejects.toMatchObject({ code: 'bad-data' });
    await expect(openPart(await keys(), 'uid1', 'f1', 0, 2, s)).rejects.toMatchObject({ code: 'bad-data' });
  });

  it('keeps a full part within one document of the database rules, with no plain bytes', async () => {
    const k = await keys();
    const s = await sealPart(k, 'uid1', 'f1', 0, 1, bytes(PART_BYTES));
    expect(s.ct.length).toBeLessThanOrEqual(DOC_CHARS);
    expect(s.ct).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(s.iv).toMatch(/^[A-Za-z0-9+/]{16}$/);
    const plain = btoa(String.fromCharCode(...bytes(300)));
    expect(s.ct.includes(plain.slice(8, 60))).toBe(false);
  });

  it('seals the details and the index apart from the parts', async () => {
    const k = await keys();
    const m = await sealMeta(k, 'uid1', 'f1', '{"name":"beach.jpg"}');
    expect(await openMeta(k, 'uid1', 'f1', m)).toBe('{"name":"beach.jpg"}');
    await expect(openMeta(k, 'uid1', 'f2', m)).rejects.toMatchObject({ code: 'bad-data' });
    await expect(openFilesIndex(k, 'uid1', m)).rejects.toMatchObject({ code: 'bad-data' });
    const i = await sealFilesIndex(k, 'uid1', '{}');
    expect(await openFilesIndex(k, 'uid1', i)).toBe('{}');
  });
});

describe('document ids', () => {
  it('are 43 characters of base64url, the same on every device, and differ by file and part', async () => {
    const dk = await newDataKey();
    const made = await newLifeKey(dk, 'uid1');
    const { openLifeKey } = await import('./seal');
    const again = await openLifeKey(dk, 'uid1', made.sealed);
    const a = await partDocId(made.keys, 'f1', 0);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await partDocId(again, 'f1', 0)).toBe(a);
    expect(await partDocId(made.keys, 'f1', 1)).not.toBe(a);
    expect(await metaDocId(made.keys, 'f1')).not.toBe(a);
    expect(await indexDocId(made.keys)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await fileDocIds(made.keys, 'f1', 2)).toEqual([await metaDocId(made.keys, 'f1'), a, await partDocId(made.keys, 'f1', 1)]);
  });

  it('makes file ids of 22 characters', () => {
    const id = newFileId();
    expect(isFileId(id)).toBe(true);
    expect(newFileId()).not.toBe(id);
    expect(isFileId('short')).toBe(false);
  });
});
