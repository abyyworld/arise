// @vitest-environment jsdom
// A note for your day with a title, a mood and a file: a text file's words go into the note, any
// other file only by its name, size and type, and the file store hook keeps it once there is one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Q from './quick-note';
import { cleanLifeEvent } from '../lib/validate';

const AT = Date.UTC(2026, 10, 23, 9, 30);
afterEach(() => Q.setFileStore(null));

describe('a quick note', () => {
  it('knows which files are text', () => {
    expect(Q.isTextFile({ name: 'a.txt', type: 'text/plain', size: 10 })).toBe(true);
    expect(Q.isTextFile({ name: 'plan.md', type: '', size: 10 })).toBe(true);
    expect(Q.isTextFile({ name: 'data.json', type: 'application/json', size: 10 })).toBe(true);
    expect(Q.isTextFile({ name: 'photo.jpg', type: 'image/jpeg', size: 10 })).toBe(false);
    expect(Q.isTextFile({ name: 'huge.txt', type: 'text/plain', size: 5_000_000 })).toBe(false);
  });

  it('is a note of the day: words, a title, a mood', () => {
    const e = Q.makeNote({ text: 'Lunch with Sam.\nNice.', title: '', mood: 4, at: AT, id: 'manual:x1' })!;
    expect(e).toEqual({ id: 'manual:x1', source: 'manual', kind: 'note', at: AT, title: 'Lunch with Sam.', tier: 2, detail: 'Lunch with Sam.\nNice.\n\nMood: Good.', value: 4, unit: 'mood (1-5)', meta: { mood: 'Good' } });
    expect(Q.makeNote({ title: 'Big day', text: 'Moved house.', at: AT })).toMatchObject({ title: 'Big day', detail: 'Moved house.' });
    expect(Q.makeNote({ mood: 2, at: AT })).toMatchObject({ kind: 'mood', title: 'Mood: Meh', value: 2 });
    expect(Q.makeNote({ at: AT })).toBeNull();
  });

  it("puts a text file's words in the note", async () => {
    const file = new File(['﻿Shopping list\r\n- eggs\r\n- bread'], 'list.txt', { type: 'text/plain' });
    const e = (await Q.noteWithFile({ title: 'For the weekend', at: AT }, file))!;
    expect(e.title).toBe('For the weekend');
    expect(e.detail).toBe('list.txt:\nShopping list\n- eggs\n- bread');
    expect(e.meta).toEqual({ file: 'list.txt', fileSize: file.size, fileType: 'text/plain' });
    expect(cleanLifeEvent(e)).toEqual(e);
  });

  it('keeps only the name, size and type of a photo, and is named after it without a title', async () => {
    const photo = new File([new Uint8Array(2_500_000)], 'IMG_0042.jpg', { type: 'image/jpeg' });
    const e = (await Q.noteWithFile({ at: AT }, photo))!;
    expect(e).toMatchObject({ kind: 'note', title: 'IMG_0042.jpg', detail: 'Attached: IMG_0042.jpg (2.5 MB, image/jpeg).', meta: { file: 'IMG_0042.jpg', fileSize: 2_500_000, fileType: 'image/jpeg' } });
    expect(e.meta?.fileRef).toBeUndefined();
  });

  it('hands a file that is not text to the file store, once there is one, and keeps where it went', async () => {
    const store = vi.fn(async () => 'files/abc123');
    Q.setFileStore(store);
    const photo = new File([new Uint8Array(10)], 'cat.png', { type: 'image/png' });
    const e = (await Q.noteWithFile({ text: 'Our cat', at: AT, id: 'manual:c1' }, photo))!;
    expect(store).toHaveBeenCalledWith(photo, { noteId: 'manual:c1', name: 'cat.png', size: 10, type: 'image/png' });
    expect(e.meta?.fileRef).toBe('files/abc123');
    // A store that fails doesn't stop the note.
    Q.setFileStore(async () => {
      throw new Error('full');
    });
    expect((await Q.noteWithFile({ text: 'Our cat', at: AT }, photo))?.meta?.fileRef).toBeUndefined();
  });

  it('keeps about 4,000 characters of a long text file', async () => {
    const file = new File(['word '.repeat(3000)], 'long.md', { type: '' });
    const e = (await Q.noteWithFile({ at: AT }, file))!;
    expect(e.detail!.length).toBeLessThanOrEqual(4000);
    expect(e.detail).toMatch(/The rest of the file isn't kept\.\)$/);
  });
});
