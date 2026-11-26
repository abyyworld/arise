// Files for an AI app on the web: sealed parts that open only in their own place, what a page may
// list, and what a saved file may be.

import { describe, expect, it } from 'vitest';
import { b64Size, cleanMeFile, cleanMeFiles, cleanSaved, FILE_MAX, filesKey, INLINE_MAX, newUpload, openPart, partCount, partId, PART_BYTES, SAVE_MAX, sealPart, toB64 } from './me-files';
import { cleanEntry } from './feed';
import { buildMe, cleanMe, cleanRules, FORMAT, ruleOf, rulesText } from './me';
import { newShareRef } from './share';

const ID = 'a'.repeat(22);

describe('shared files', () => {
  it('seals each part so it opens only with its page, file, upload and place', async () => {
    const ref = await newShareRef();
    const key = await filesKey(ref.id, ref.key);
    const v = newUpload();
    const bytes = new Uint8Array(PART_BYTES).fill(7);
    const s = await sealPart(key, ref.id, ID, v, 0, 2, bytes);
    // A full part still fits in a page (20,000 characters of ciphertext).
    expect(s.ct.length).toBeLessThanOrEqual(20_000);
    expect(await openPart(key, ref.id, ID, v, 0, 2, s)).toEqual(bytes);
    await expect(openPart(key, ref.id, ID, v, 1, 2, s)).rejects.toMatchObject({ say: expect.stringContaining("doesn't open") });
    await expect(openPart(key, ref.id, 'b'.repeat(22), v, 0, 2, s)).rejects.toThrow();
    await expect(openPart(key, ref.id, ID, newUpload(), 0, 2, s)).rejects.toThrow();
    await expect(openPart(await filesKey(ref.id, (await newShareRef()).key), ref.id, ID, v, 0, 2, s)).rejects.toThrow();
    // Part ids: a page's, and only someone with the key finds them.
    const id = await partId(ref.id, ref.key, ID, v, 0);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await partId(ref.id, ref.key, ID, v, 1)).not.toBe(id);
    expect(await partId(ref.id, (await newShareRef()).key, ID, v, 0)).not.toBe(id);
  });

  it('lists a file small enough in the page, a bigger one by its parts, and one too big without either', () => {
    const at = Date.UTC(2026, 10, 1);
    expect(cleanMeFile({ id: ID, name: 'a/b.txt', type: 'text/plain', size: 3, at, data: toB64(new Uint8Array([1, 2, 3])) })).toEqual({ id: ID, name: 'a b.txt', type: 'text/plain', size: 3, at, data: 'AQID' });
    expect(cleanMeFile({ id: ID, name: 'x', type: 'text/plain', size: 4, at, data: 'AQID' })).toBeNull(); // the size doesn't match
    expect(cleanMeFile({ id: ID, name: 'x', type: 'text/plain', size: INLINE_MAX + 3, at, data: toB64(new Uint8Array(INLINE_MAX + 3)) })).toBeNull();
    expect(cleanMeFile({ id: ID, name: 'x', type: 'BAD', size: PART_BYTES + 1, at, p: { v: 'abcdefghijkl', n: 2 } })).toEqual({ id: ID, name: 'x', type: 'application/octet-stream', size: PART_BYTES + 1, at, p: { v: 'abcdefghijkl', n: 2 } });
    expect(cleanMeFile({ id: ID, name: 'x', type: 'text/plain', size: PART_BYTES + 1, at, p: { v: 'abcdefghijkl', n: 3 } })).toBeNull();
    expect(cleanMeFile({ id: ID, name: 'x', type: 'text/plain', size: FILE_MAX + 1, at, p: { v: 'abcdefghijkl', n: partCount(FILE_MAX + 1) } })).toBeNull();
    expect(cleanMeFile({ id: ID, name: 'x', type: 'video/mp4', size: 5e9, at, big: true })).toMatchObject({ big: true });
    expect(cleanMeFile({ id: 'short', name: 'x', type: 'text/plain', size: 1, at, big: true })).toBeNull();
    expect(cleanMeFiles(Array.from({ length: 60 }, () => ({ id: ID, name: 'x', type: 'text/plain', size: 1, at, big: true })))).toHaveLength(40);
  });

  it('takes a saved file up to its limit, with a name and a type', () => {
    expect(cleanSaved({ name: ' plan.md ', type: 'text/markdown', data: toB64(new TextEncoder().encode('# Plan')) })).toEqual({ name: 'plan.md', type: 'text/markdown', data: toB64(new TextEncoder().encode('# Plan')) });
    expect(cleanSaved({ name: '', type: 'text/plain', data: 'AQID' })).toBeNull();
    expect(cleanSaved({ name: 'x', type: 'text/plain', data: 'not base64!' })).toBeNull();
    const max = toB64(new Uint8Array(SAVE_MAX));
    expect(b64Size(max)).toBe(SAVE_MAX);
    expect(cleanSaved({ name: 'x', type: 'text/plain', data: max })).not.toBeNull();
    expect(cleanSaved({ name: 'x', type: 'text/plain', data: toB64(new Uint8Array(SAVE_MAX + 1)) })).toBeNull();
  });

  it('keeps a saved file in the log only as far as it checks out', () => {
    const file = { name: 'plan.md', type: 'text/markdown', data: 'AQID' };
    expect(cleanEntry({ at: 1, tool: 'save_file', ok: true, file })).toEqual({ at: 1, tool: 'save_file', ok: true, file });
    expect(cleanEntry({ at: 1, tool: 'save_file', ok: true, file: { name: 'plan.md', type: 'text/markdown' } })).toEqual({ at: 1, tool: 'save_file', ok: true, file: { name: 'plan.md', type: 'text/markdown' } });
    expect(cleanEntry({ at: 1, tool: 'ask', want: 'save_file', ok: true, note: 'plan.md', file })).toMatchObject({ want: 'save_file', file });
    expect(cleanEntry({ at: 1, tool: 'ask', want: 'save_file', ok: true, note: 'plan.md' })).toBeNull(); // a request to save nothing
    expect(cleanEntry({ at: 1, tool: 'read_file', ok: true, file })).toEqual({ at: 1, tool: 'read_file', ok: true }); // only a save carries one
    expect(cleanEntry({ at: 1, tool: 'list_files', ok: false })).toEqual({ at: 1, tool: 'list_files', ok: false });
  });

  it('puts the switches and the files in an app web page only when they are on, and reads them back', () => {
    const src = { name: 'Sam', goals: [{ title: 'Run', why: '', streak: 1 }], facts: [], today: null, days: [] };
    const files = [{ id: ID, name: 'list.txt', type: 'text/plain', size: 3, at: 1, data: 'AQID' }];
    const choice = { sections: ['name' as const, 'goals' as const], tier: 2 as const };
    // As before: no switches, no files.
    const plain = buildMe(src, choice, 5, { notes: false, feed: '0'.repeat(64) }, undefined, files);
    expect(plain.web).toEqual({ notes: false, feed: '0'.repeat(64) });
    expect(plain).not.toHaveProperty('files');
    // Saving only: the folder, no files.
    const writer = buildMe(src, choice, 5, { notes: false, files: { read: false, write: true, folder: 'For Claude' } }, undefined, files);
    expect(writer.web).toEqual({ notes: false, files: { read: false, write: true, folder: 'For Claude' } });
    expect(writer).not.toHaveProperty('files');
    const reader = buildMe(src, choice, 5, { notes: false, read: false, files: { read: true, write: false, folder: 'For Claude' } }, undefined, files);
    expect(reader.files).toEqual(files);
    expect(cleanMe(JSON.parse(JSON.stringify(reader)))).toEqual(reader);
    // A page that says files aren't read keeps none, whatever else it holds.
    expect(cleanMe({ format: FORMAT, facts: [], goals: [], updated: 5, web: { notes: false }, files })).not.toHaveProperty('files');
  });

  it("has a rule for saving files like the others", () => {
    const r = cleanRules({ ask: ['file'], never: [], house: '' });
    expect(ruleOf(r, 'file')).toBe('ask');
    expect(rulesText(r)).toBe('Ask me first: save a file.');
    expect(ruleOf(cleanRules({ ask: ['file'], never: ['file'], house: '' }), 'file')).toBe('never');
  });
});
