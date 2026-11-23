// @vitest-environment jsdom
// Photos and files on screen: a day's photos on Days, a file's sheet, deleting from there.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));

const SHEET = `<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div>`;
const tick = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  let n = 0;
  URL.createObjectURL = () => `blob:test/${n++}`;
  URL.revokeObjectURL = () => {};
  document.body.innerHTML = `${SHEET}<main id="app"><div id="lifeFiles"></div></main>`;
});

async function load() {
  const F = await import('./files');
  F._setImageTools({ scale: async () => ({ blob: new Blob([new Uint8Array(40)], { type: 'image/jpeg' }), w: 8, h: 6 }) });
  const UI = await import('./files-ui.js');
  return { F, UI };
}

describe('a day in Your days', () => {
  it("shows that day's photos and files, and a way to add more", async () => {
    const { F, UI } = await load();
    await F.putFile(new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), { name: 'sea.jpg', day: '2026-11-20' });
    await F.putFile(new Uint8Array(20), { name: 'ticket.pdf', type: 'application/pdf', day: '2026-11-20' });
    await F.putFile(new Uint8Array(20), { name: 'other.txt', type: 'text/plain', day: '2026-11-21' });
    await UI.fillDay('2026-11-20');
    const tiles = [...document.querySelectorAll<HTMLElement>('#lifeFiles .file-tile')];
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^ticket\.pdf, /), expect.stringMatching(/^Photo, /)]);
    expect(tiles[1].querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
    const input = document.querySelector<HTMLInputElement>('#myfilesDay');
    expect(input?.type).toBe('file');
    expect(input?.dataset.day).toBe('2026-11-20');
    expect(document.querySelector('#lifeFiles .file-add')?.textContent?.trim()).toBe('Add more');
  });

  it('offers to add photos on a day with none', async () => {
    const { UI } = await load();
    await UI.fillDay('2026-11-22');
    expect(document.querySelectorAll('#lifeFiles .file-tile').length).toBe(0);
    expect(document.querySelector('#lifeFiles .file-add')?.textContent?.trim()).toBe('Add photos or files');
  });
});

describe('one file', () => {
  it('opens in a sheet, and Delete takes it from everywhere after asking', async () => {
    const { F, UI } = await load();
    const f = await F.putFile(new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), { name: 'sea.jpg', day: '2026-11-20' });
    const btn = document.createElement('button');
    btn.dataset.id = f.id;
    expect(await UI.handleAction('myfiles-file', btn)).toBe(true);
    await tick();
    expect(document.querySelector('.sheet-title')?.textContent).toBe('sea.jpg');
    expect(document.querySelector('[data-act="myfiles-del"]')?.textContent).toBe('Delete from all your devices');
    globalThis.confirm = () => false;
    await UI.handleAction('myfiles-del', btn);
    expect(await F.listFiles()).toHaveLength(1);
    globalThis.confirm = () => true;
    await UI.handleAction('myfiles-del', btn);
    expect(await F.listFiles()).toHaveLength(0);
  });

  it('lists everything in Photos and files, with how much is kept here', async () => {
    const { F, UI } = await load();
    await F.putFile(new Uint8Array(2048), { name: 'a.bin', day: '2026-11-20' });
    await UI.handleAction('myfiles-open', document.createElement('button'));
    const text = document.querySelector('.sheet-body')?.textContent || '';
    expect(text).toContain('Photos and files');
    expect(text).toContain('On this device: 2 KB in 1 file');
    expect(document.querySelectorAll('.sheet-body .file-tile').length).toBe(1);
  });
});
