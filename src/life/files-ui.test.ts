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

describe('your own storage', () => {
  const ACC = '0123456789abcdef0123456789abcdef';
  const fill = (v: Record<string, string>) => {
    for (const [id, val] of Object.entries(v)) (document.querySelector(`#${id}`) as HTMLInputElement).value = val;
  };
  it('sets up with steps and the CORS policy to paste, checks the bucket before saving, and can be removed', async () => {
    const { UI } = await load();
    const S = await import('../store');
    document.body.insertAdjacentHTML('beforeend', `<div id="host">${UI.ownPart()}</div>`);
    expect(document.querySelector('#ownStorage')?.textContent).toContain('10 GB free');
    await UI.handleAction('myfiles-own-edit', document.createElement('button'));
    const text = document.querySelector('#ownStorage')?.textContent || '';
    expect(text).toContain('Create bucket');
    expect(text).toContain('https://abyyworld.github.io');
    expect(text).toContain('Object Read & Write');

    // A bucket that says no: nothing is saved.
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return new Response(null, { status: 403 });
    }) as unknown as typeof fetch;
    fill({ ownAccount: ACC, ownBucket: 'arise-files', ownKeyId: 'abcdef0123456789abcd', ownSecret: 'Zy/x+0123456789abcdefghijklmnop' });
    await UI.handleAction('myfiles-own-save', null);
    expect(document.querySelector('#toast')?.textContent).toContain('Your own storage said no.');
    expect(S.ownStorage()).toBeNull();
    expect(calls[0]).toMatch(new RegExp(`^PUT https://${ACC}\\.r2\\.cloudflarestorage\\.com/arise-files/arise/check-`));

    // One that works: written, read back and deleted, then saved.
    const objects = new Map<string, string>();
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (init.method === 'PUT') objects.set(url, new TextDecoder().decode(init.body as Uint8Array));
      if (init.method === 'GET') return objects.has(url) ? new Response(objects.get(url)) : new Response(null, { status: 404 });
      if (init.method === 'DELETE') objects.delete(url);
      return new Response(null, { status: init.method === 'DELETE' ? 204 : 200 });
    }) as unknown as typeof fetch;
    await UI.handleAction('myfiles-own-save', null);
    expect(S.ownStorage()).toMatchObject({ account: ACC, bucket: 'arise-files' });
    expect(objects.size).toBe(0);
    expect(document.querySelector('#ownStorage')?.textContent).toContain('On: new photos and files go to the bucket arise-files');
    // Never in a backup file.
    expect(JSON.stringify(S.exportData())).not.toContain('Zy/x');

    globalThis.confirm = () => true;
    await UI.handleAction('myfiles-own-remove', null);
    expect(S.ownStorage()).toBeNull();
    expect(S.state.storage?.off).toBe(true);
  });
});
