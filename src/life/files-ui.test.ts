// @vitest-environment jsdom
// Photos and files on screen: a day's photos on Days, a file's sheet, deleting from there.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));

const SHEET = `<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div>`;
const tick = () => new Promise((r) => setTimeout(r, 30));

// Each test loads the screen again: the listeners the last one added go first, so only this
// test's screen answers a change or a key.
const added: [string, EventListenerOrEventListenerObject][] = [];
const addListener = document.addEventListener.bind(document);
document.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
  added.push([type, fn]);
  addListener(type, fn, opts);
}) as typeof document.addEventListener;

beforeEach(() => {
  for (const [type, fn] of added.splice(0)) document.removeEventListener(type, fn);
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

// ---------- the file manager

describe('the file manager in Photos and files', () => {
  // A tap on a button with these data attributes.
  const tap = async (UI: Awaited<ReturnType<typeof load>>['UI'], act: string, data: Record<string, string> = {}) => {
    const b = document.createElement('button');
    Object.assign(b.dataset, data);
    await UI.handleAction(act, b);
    await tick();
  };
  const body = () => document.querySelector('#myfilesMain')?.textContent?.replace(/\s+/g, ' ') || '';
  const set = async (sel: string, value: string, type = 'change') => {
    const el = document.querySelector(sel) as HTMLInputElement | HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new Event(type, { bubbles: true }));
    await tick();
  };
  const names = (sel = '#myfilesMain .file-tile, #myfilesMain .file-row') => [...document.querySelectorAll<HTMLElement>(sel)].map((t) => t.getAttribute('aria-label')?.split(',')[0] || t.querySelector('b')?.textContent);

  it('makes a folder, opens it, adds into it, renames it, and deletes it only when empty', async () => {
    const { F, UI } = await load();
    await tap(UI, 'myfiles-open');
    await tap(UI, 'myfiles-mkdir');
    await set('#myfilesName', 'Trips', 'input');
    await tap(UI, 'myfiles-name-save');
    // The new folder opens.
    expect(document.querySelector('.files-path')?.textContent).toContain('Trips');
    expect(body()).toContain('This folder is empty.');
    const [id] = Object.keys((await F.listFolders()).dirs);
    expect((document.querySelector('#myfilesPlace') as HTMLInputElement).dataset.dir).toBe(id);
    await F.putFile(new Uint8Array(20), { name: 'ticket.pdf', type: 'application/pdf', dir: id });
    await tick();
    expect(names()).toEqual(['ticket.pdf']);

    await tap(UI, 'myfiles-rename');
    expect((document.querySelector('#myfilesName') as HTMLInputElement).value).toBe('Trips');
    await set('#myfilesName', 'Rome', 'input');
    await tap(UI, 'myfiles-name-save');
    expect((await F.listFolders()).dirs[id].name).toBe('Rome');

    await tap(UI, 'myfiles-rmdir');
    expect(document.querySelector('#toast')?.textContent).toContain('Only an empty folder can be deleted');
    // At the top: the folder, and no file.
    await tap(UI, 'myfiles-dir', { id: '' });
    expect(document.querySelectorAll('#myfilesMain .folder-tile').length).toBe(1);
    expect(document.querySelector('#myfilesMain .folder-tile')?.textContent).toContain('1 file');
    expect(names()).toEqual([]);
  });

  it('searches by name in every folder, sorts, and shows a grid or a list', async () => {
    const { F, UI } = await load();
    const work = await F.makeFolder('Work');
    await F.putFile(new Uint8Array(300), { name: 'Budget 2026.xlsx', type: 'application/vnd.ms-excel', dir: work, at: 1000 });
    await F.putFile(new Uint8Array(20), { name: 'budget notes.txt', type: 'text/plain', at: 3000 });
    await F.putFile(new Uint8Array(50), { name: 'Apples.txt', type: 'text/plain', at: 2000 });
    await tap(UI, 'myfiles-open');
    expect(names()).toEqual(['budget notes.txt', 'Apples.txt']); // newest first, at the top only
    await set('#myfilesSort', 'name');
    expect(names()).toEqual(['Apples.txt', 'budget notes.txt']);
    await set('#myfilesSort', 'size');
    expect(names()).toEqual(['Apples.txt', 'budget notes.txt']);

    await set('#myfilesFind', 'BUDGET', 'input');
    expect(body()).toContain('in all your folders');
    expect(names().sort()).toEqual(['Budget 2026.xlsx', 'budget notes.txt']);

    await tap(UI, 'myfiles-view', { v: 'list' });
    expect(document.querySelectorAll('#myfilesMain .file-tile').length).toBe(0);
    const first = document.querySelector('#myfilesMain .file-row');
    expect(first?.querySelector('b')?.textContent).toBe('Budget 2026.xlsx'); // biggest first
    expect(first?.querySelector('small')?.textContent).toMatch(/^300 bytes · .* · Work$/); // with its folder
    await tap(UI, 'myfiles-view', { v: 'grid' });
    expect(document.querySelectorAll('#myfilesMain .file-tile').length).toBe(2);
  });

  it('chooses several files to move into a folder, or to the trash', async () => {
    const { F, UI } = await load();
    const box = await F.makeFolder('Box');
    const a = await F.putFile(new Uint8Array(10), { name: 'a' });
    const b = await F.putFile(new Uint8Array(11), { name: 'b' });
    const c = await F.putFile(new Uint8Array(12), { name: 'c' });
    await tap(UI, 'myfiles-open');
    await tap(UI, 'myfiles-pick-start');
    await tap(UI, 'myfiles-pick', { id: a.id });
    await tap(UI, 'myfiles-pick', { id: b.id });
    expect(document.querySelector('.files-pickbar')?.textContent).toContain('2 chosen');
    expect(document.querySelectorAll('#myfilesMain [data-act="myfiles-pick"][aria-pressed="true"]').length).toBe(2);
    await set('#myfilesMoveTo', box);
    await tap(UI, 'myfiles-move');
    expect(document.querySelector('#toast')?.textContent).toBe('2 files moved.');
    expect((await F.listFiles()).filter((f) => f.dir === box).map((f) => f.name).sort()).toEqual(['a', 'b']);
    expect(names()).toEqual(['c']);

    await tap(UI, 'myfiles-pick-start');
    await tap(UI, 'myfiles-pick-all');
    await tap(UI, 'myfiles-trash');
    expect(document.querySelector('#toast')?.textContent).toContain('1 file moved to the trash');
    expect((await F.listFiles({ trash: true })).map((f) => f.id)).toEqual([c.id]);
  });

  it('shows the trash: put back, and empty it after a plain warning', async () => {
    const { F, UI } = await load();
    const a = await F.putFile(new Uint8Array(10), { name: 'a' });
    const b = await F.putFile(new Uint8Array(11), { name: 'b' });
    const c = await F.putFile(new Uint8Array(12), { name: 'c' });
    await F.trashFiles([a.id, b.id, c.id]);
    await tap(UI, 'myfiles-open');
    expect(document.querySelector('[data-act="myfiles-bin"]')?.textContent).toContain('Trash (3)');
    await tap(UI, 'myfiles-bin');
    expect(body()).toContain('Deleted files wait here for 30 days');
    expect(body()).toContain('goes for good in 30 days');
    await tap(UI, 'myfiles-restore', { id: a.id });
    expect((await F.listFiles()).map((f) => f.id)).toEqual([a.id]);

    let asked = '';
    globalThis.confirm = (q?: string) => ((asked = q || ''), false);
    await tap(UI, 'myfiles-empty');
    expect(asked).toBe("Delete all 2 files in the trash for good, from all your devices? This can't be undone.");
    expect(await F.listFiles({ trash: true })).toHaveLength(2);
    globalThis.confirm = () => true;
    await tap(UI, 'myfiles-empty');
    expect(await F.listFiles({ trash: 'all' })).toHaveLength(1);
    expect(body()).toContain('The trash is empty.');
  });

  it('finds copies, and keeping one sends the others to the trash', async () => {
    const { F, UI } = await load();
    const same = () => new Uint8Array([1, 2, 3, 4, 5]);
    const a = await F.putFile(same(), { name: 'a.txt', type: 'text/plain', at: 1000 });
    await F.putFile(same(), { name: 'a copy.txt', type: 'text/plain', at: 2000 });
    await F.putFile(new Uint8Array([9]), { name: 'other.txt', type: 'text/plain' });
    await tap(UI, 'myfiles-open');
    await tap(UI, 'myfiles-copies');
    await tick();
    expect(body()).toContain('2 copies of the same file');
    expect(document.querySelectorAll('[data-act="myfiles-keep"]').length).toBe(2);
    await tap(UI, 'myfiles-keep', { id: a.id });
    expect(document.querySelector('#toast')?.textContent).toBe('Kept one. The copy went to the trash.');
    expect((await F.listFiles()).map((f) => f.name).sort()).toEqual(['a.txt', 'other.txt']);
    await tick();
    expect(body()).toContain('No copies found.');
  });

  it("shows a goal's project folders on the goal, and makes one from there", async () => {
    const { F, UI } = await load();
    const S = await import('../store');
    S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [] });
    document.body.insertAdjacentHTML('beforeend', `<section class="goal">${UI.goalSlot('g1')}</section>`);
    await tick();
    expect(document.querySelector('.goal-files')?.textContent).toContain('Add a project folder');
    await tap(UI, 'myfiles-project', { goal: 'g1' });
    const [id] = Object.keys((await F.listFolders()).dirs);
    expect((await F.listFolders()).dirs[id]).toMatchObject({ name: 'Learn Spanish', g: 'g1' });
    // It opens, ready for files.
    expect(document.querySelector('.files-path')?.textContent).toContain('Learn Spanish');
    expect(body()).toContain('The project folder of Learn Spanish');
    await F.putFile(new Uint8Array(10), { name: 'verbs.pdf', type: 'application/pdf', dir: id });
    await UI.fillGoalSlots();
    expect(document.querySelector('.goal-files')?.textContent?.replace(/\s+/g, ' ')).toContain('Learn Spanish · 1 file');
  });

  it("moves one file from its sheet, and puts one back from the trash there", async () => {
    const { F, UI } = await load();
    const box = await F.makeFolder('Box');
    const f = await F.putFile(new Uint8Array(10), { name: 'a' });
    await tap(UI, 'myfiles-file', { id: f.id });
    await set('#myfilesFileDir', box);
    expect((await F.listFiles())[0].dir).toBe(box);
    await F.trashFile(f.id);
    await tap(UI, 'myfiles-file', { id: f.id });
    expect(document.querySelector('.sheet-body')?.textContent).toContain('In the trash.');
    await tap(UI, 'myfiles-restore', { id: f.id });
    expect((await F.listFiles()).map((x) => x.id)).toEqual([f.id]);
  });
});
