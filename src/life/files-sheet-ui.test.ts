// @vitest-environment jsdom
// A file's sheet and the file manager with versions, a clearer name, the note on keeping a file up
// to date, previews made from the bytes, and folders being worked on or finished.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));

const SHEET = `<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div>`;
const tick = () => new Promise((r) => setTimeout(r, 40));
const wait = () => new Promise((r) => setTimeout(r, 3));

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
  document.body.innerHTML = `${SHEET}<main id="app"></main>`;
  globalThis.confirm = () => true;
});

async function load() {
  const F = await import('./files');
  F._setImageTools({ scale: async () => null });
  const UI = await import('./files-ui.js');
  return { F, UI };
}
type UIMod = Awaited<ReturnType<typeof load>>['UI'];
const tap = async (UI: UIMod, act: string, data: Record<string, string> = {}) => {
  const b = document.createElement('button');
  Object.assign(b.dataset, data);
  await UI.handleAction(act, b);
  await tick();
};
const sheet = () => document.querySelector('.sheet-body')?.textContent?.replace(/\s+/g, ' ') || '';
const toastText = () => document.querySelector('#toast')?.textContent || '';
const text = (s: string) => new TextEncoder().encode(s);

describe('versions in the sheet', () => {
  it('lists older versions with their dates, restores one, and deletes one', async () => {
    const { F, UI } = await load();
    const a = await F.putFile(text('one'), { name: 'plan.txt', type: 'text/plain' });
    await wait();
    const b = await F.putFile(text('two'), { name: 'plan.txt', type: 'text/plain', versionOf: a.id });
    await wait();
    const c = await F.putFile(text('three'), { name: 'plan.txt', type: 'text/plain', versionOf: a.id });
    await tap(UI, 'myfiles-file', { id: c.id });
    expect(sheet()).toContain('Versions');
    expect(sheet()).toContain('Upload a new version');
    const rows = [...document.querySelectorAll('#myfilesVersions .file-bin-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('[data-act="myfiles-v-restore"]')?.getAttribute('data-id')).toBe(b.id);
    expect((document.querySelector('#myfilesVersion') as HTMLInputElement).dataset.id).toBe(c.id);

    await tap(UI, 'myfiles-v-restore', { id: a.id });
    expect(toastText()).toContain('Restored.');
    expect((await F.listFiles()).map((f) => f.id)).toEqual([a.id]);
    expect(document.querySelectorAll('#myfilesVersions .file-bin-row')).toHaveLength(2);

    await tap(UI, 'myfiles-v-del', { id: b.id });
    expect((await F.versionsOf(a.id)).map((f) => f.id)).toEqual([c.id]);
    expect(toastText()).toContain('Version moved to the trash.');
  });

  it("an older version's sheet says so, with Restore and the way back", async () => {
    const { F, UI } = await load();
    const a = await F.putFile(text('one'), { name: 'a.txt', type: 'text/plain' });
    await wait();
    const b = await F.putFile(text('two'), { name: 'a.txt', type: 'text/plain', versionOf: a.id });
    await tap(UI, 'myfiles-file', { id: a.id });
    expect(sheet()).toContain('An older version of a.txt');
    expect(document.querySelector('[data-act="myfiles-v-restore"]')?.textContent).toBe('Restore this version');
    expect(document.querySelector('[data-act="myfiles-file"]')?.getAttribute('data-id')).toBe(b.id);
    expect(document.querySelector('[data-act="myfiles-del"]')).toBeNull();
  });

  it('a file added with the same name in the same folder becomes a new version, and says so', async () => {
    const { F, UI } = await load();
    await tap(UI, 'myfiles-open');
    const a = await F.putFile(text('old'), { name: 'CV.txt', type: 'text/plain' });
    await tick();
    const input = document.querySelector('#myfilesPlace') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File([text('new')], 'CV.txt', { type: 'text/plain' })], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(toastText()).toBe('Kept as a new version of CV.txt. The old one is in its versions.');
    const list = await F.listFiles();
    expect(list).toHaveLength(1);
    expect((await F.versionsOf(list[0].id)).map((f) => f.id)).toEqual([a.id]);
    // The file manager shows it once, and the trash counts it with its versions as one.
    expect(document.querySelectorAll('#myfilesMain .file-tile')).toHaveLength(1);
    await F.trashFiles([list[0].id]);
    await tap(UI, 'myfiles-bin');
    expect(document.querySelectorAll('#myfilesMain .file-bin-row')).toHaveLength(1);
    expect(document.querySelector('#myfilesMain')?.textContent).toContain('with 1 older version');
  });
});

describe('names and notes', () => {
  it('suggests a clearer name from the date, and Rename takes it', async () => {
    const { F, UI } = await load();
    const f = await F.putFile(new Uint8Array(30), { name: 'IMG_1234.jpg', type: 'image/jpeg', day: '2026-11-20' });
    await tap(UI, 'myfiles-file', { id: f.id });
    const box = document.querySelector('#myfilesSuggest') as HTMLElement;
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain('Photo 20 Nov 2026.jpg');
    expect(box.textContent).toContain('From the day it was added.');
    await tap(UI, 'myfiles-name-use', { id: f.id, name: 'Photo 20 Nov 2026.jpg' });
    expect((await F.listFiles())[0].name).toBe('Photo 20 Nov 2026.jpg');
    expect(document.querySelector('.sheet-title')?.textContent).toBe('Photo 20 Nov 2026.jpg');
    expect((document.querySelector('#myfilesSuggest') as HTMLElement).hidden).toBe(true);
  });

  it("takes a text file's first heading, and Keep puts the suggestion away for good", async () => {
    const { F, UI } = await load();
    const f = await F.putFile(text('# Shopping list\n- milk\n- eggs'), { name: 'document (3).md', type: 'text/markdown' });
    await tap(UI, 'myfiles-file', { id: f.id });
    await tick();
    expect(document.querySelector('#myfilesSuggest')?.textContent).toContain('Shopping list.md');
    expect(document.querySelector('#myfilesSuggest')?.textContent).toContain('From its first heading.');
    await tap(UI, 'myfiles-name-keep', { id: f.id });
    expect((document.querySelector('#myfilesSuggest') as HTMLElement).hidden).toBe(true);
    await tap(UI, 'myfiles-file', { id: f.id });
    await tick();
    expect((document.querySelector('#myfilesSuggest') as HTMLElement).hidden).toBe(true);
    expect((await F.listFiles())[0].name).toBe('document (3).md');
  });

  it('saves a note on keeping it up to date, shown in the sheet and on the file in the list', async () => {
    const { F, UI } = await load();
    const f = await F.putFile(text('cv'), { name: 'CV.txt', type: 'text/plain' });
    await tap(UI, 'myfiles-file', { id: f.id });
    (document.querySelector('#myfilesUpkeep') as HTMLInputElement).value = 'Update the CV after each new job';
    await tap(UI, 'myfiles-upkeep', { id: f.id });
    expect(toastText()).toBe('Note saved.');
    expect(document.querySelector('.file-upkeep-note')?.textContent?.trim()).toBe('Update the CV after each new job');
    await tap(UI, 'myfiles-open');
    expect(document.querySelector('#myfilesMain .file-tile')?.getAttribute('aria-label')).toContain('To keep it up to date: Update the CV after each new job');
    await tap(UI, 'myfiles-view', { v: 'list' });
    expect(document.querySelector('#myfilesMain .file-upkeep')?.textContent?.trim()).toBe('Update the CV after each new job');
  });
});

describe('previews from the bytes', () => {
  it('shows a text file and a Markdown file inline', async () => {
    const { F, UI } = await load();
    const t = await F.putFile(text('first line\n<b>not bold</b>'), { name: 'notes.txt', type: 'text/plain' });
    await tap(UI, 'myfiles-file', { id: t.id });
    const pre = document.querySelector('#myfilesPreview pre.file-text');
    expect(pre?.textContent).toBe('first line\n<b>not bold</b>');
    expect(pre?.querySelector('b')).toBeNull();
    const m = await F.putFile(text('## Plan\nSome **strong** words'), { name: 'plan.md', type: 'text/markdown' });
    await tap(UI, 'myfiles-file', { id: m.id });
    expect(document.querySelector('#myfilesPreview .file-md b')?.textContent).toBe('Plan');
  });

  it('gives sound and video a player, and a PDF its first page to tap', async () => {
    const { F, UI } = await load();
    const s = await F.putFile(new Uint8Array(40), { name: 'memo.m4a', type: 'audio/mp4' });
    await tap(UI, 'myfiles-file', { id: s.id });
    expect(document.querySelector('#myfilesPreview audio')?.getAttribute('src')).toMatch(/^blob:/);
    const v = await F.putFile(new Uint8Array(40), { name: 'clip.mp4', type: 'video/mp4' });
    await tap(UI, 'myfiles-file', { id: v.id });
    expect(document.querySelector('#myfilesPreview video')?.hasAttribute('controls')).toBe(true);
    const p = await F.putFile(text('%PDF-1.4\n%%EOF'), { name: 'lease.pdf', type: 'application/pdf' });
    await tap(UI, 'myfiles-file', { id: p.id });
    expect(document.querySelector('#myfilesPreview .file-pdf img')?.getAttribute('alt')).toBe('The first page of lease.pdf');
    const opened: string[] = [];
    globalThis.open = ((u: string) => (opened.push(u), null)) as typeof open;
    await tap(UI, 'myfiles-pdf', { id: p.id });
    expect(opened[0]).toMatch(/^blob:/);
  });

  it('shows no preview for a file it cannot draw, like a zip', async () => {
    const { F, UI } = await load();
    const z = await F.putFile(new Uint8Array(40), { name: 'a.zip', type: 'application/zip' });
    await tap(UI, 'myfiles-file', { id: z.id });
    expect(document.querySelector('#myfilesPreview')?.innerHTML).toBe('');
  });
});

describe('working on, and finished', () => {
  it('marks the open folder; finished folders are tucked below, working ones first', async () => {
    const { F, UI } = await load();
    const a = await F.makeFolder('Alpha');
    const b = await F.makeFolder('Beta');
    await F.makeFolder('Gamma');
    await F.setFolderState(b, 'w');
    await tap(UI, 'myfiles-open');
    const open = () => [...document.querySelectorAll('#myfilesMain > .folder-grid [data-act="myfiles-dir"] b')].map((x) => x.textContent);
    expect(open()).toEqual(['Beta', 'Alpha', 'Gamma']);
    await tap(UI, 'myfiles-dir', { id: a });
    await tap(UI, 'myfiles-folder-state', { s: 'f' });
    expect(toastText()).toContain('Marked finished.');
    expect((await F.listFolders()).dirs[a].s).toBe('f');
    await tap(UI, 'myfiles-dir', { id: '' });
    expect(open()).toEqual(['Beta', 'Gamma']);
    expect(document.querySelector('#myfilesMain .files-finished summary')?.textContent).toBe('Finished (1)');
    expect(document.querySelector('#myfilesMain .files-finished b')?.textContent).toBe('Alpha');
  });

  it('moves a file to Finished in one tap from its sheet, and chosen files from the file manager', async () => {
    const { F, UI } = await load();
    const job = await F.makeFolder('Job hunt');
    const f = await F.putFile(text('a'), { name: 'a.txt', type: 'text/plain', dir: job });
    const g = await F.putFile(text('b'), { name: 'b.txt', type: 'text/plain', dir: job });
    await tap(UI, 'myfiles-file', { id: f.id });
    await tap(UI, 'myfiles-finish', { id: f.id });
    expect(toastText()).toBe('Moved to Finished.');
    expect(document.querySelector('[data-act="myfiles-finish"]')).toBeNull(); // it's there now
    await tap(UI, 'myfiles-open');
    await tap(UI, 'myfiles-dir', { id: job });
    await tap(UI, 'myfiles-pick-start');
    await tap(UI, 'myfiles-pick', { id: g.id });
    await tap(UI, 'myfiles-finish-picked');
    expect(toastText()).toBe('1 file moved to Finished.');
    const t = await F.listFolders();
    const done = Object.keys(t.dirs).find((id) => t.dirs[id].s === 'f')!;
    expect(t.dirs[done]).toMatchObject({ name: 'Finished', p: job });
    expect((await F.listFiles()).every((x) => x.dir === done)).toBe(true);
  });
});
