// @vitest-environment jsdom
// "Arise reads it for you" on screen (reads-ui.js): a note's and a file's sheet with the
// description, the note refined and the original, "Not quite? Fix it" and "Describe again", and
// its switches in Settings.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));
// The first test loads the screens' whole set of modules.
vi.setConfig({ testTimeout: 20_000 });

const SHEET = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main>';
const tick = () => new Promise((r) => setTimeout(r, 30));
const sheet = () => document.querySelector('.sheet-body')?.textContent?.replace(/\s+/g, ' ').trim() || '';
const el = (data: Record<string, string> = {}) => ({ dataset: data }) as unknown as HTMLElement;

const T = new Date(2026, 10, 20, 9, 0).getTime();
const NOTE: LifeEvent = { id: 'manual:n1', source: 'manual', kind: 'note', at: T, title: 'Walk', detail: 'walked by teh river with Sam, talked garden, garden plans for spring', tier: 2 };

beforeEach(() => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  document.body.innerHTML = SHEET;
});

async function load() {
  const L = await import('./log');
  const R = await import('./reads');
  const UI = await import('./reads-ui.js');
  const LIFE = await import('./screens.js');
  return { L, R, UI, LIFE };
}

const aiRead = (id: string, extra = {}) => ({ id, at: T + 1000, tier: 2 as const, desc: 'A walk by the river with Sam <b>', tidy: 'Walked by the river with Sam. Talked about garden plans for spring.', tags: ['walks', 'garden'], src: 'abc', from: 'ai' as const, rat: T, source: 'manual' as const, ...extra });

describe("a note's sheet", () => {
  it('shows the description, the note refined and the original, with ways to put it right', async () => {
    const { L, R, LIFE } = await load();
    await L.addEvents([NOTE]);
    await R.saveReads([aiRead('e:manual:n1')]);
    await LIFE.handleAction('life-ev', el({ id: 'manual:n1' }));
    await tick();
    const text = sheet();
    expect(text).toContain('Description (AI-written)');
    expect(text).toContain('A walk by the river with Sam <b>'); // as text, never as HTML
    expect(document.querySelector('.sheet-body b')).toBeNull();
    expect(text).toMatch(/Your note, refined ?Walked by the river with Sam\./);
    expect(text).toContain('The original');
    expect(text).toContain('walked by teh river'); // the note as written, below
    expect(text.indexOf('Description (AI-written)')).toBeLessThan(text.indexOf('walked by teh river'));
    expect([...document.querySelectorAll('.sheet-body .tag')].map((t) => t.textContent)).toEqual(['walks', 'garden']);
    expect(document.querySelector('[data-act="reads-fix"]')?.textContent).toBe('Not quite? Fix it');
    expect(document.querySelector('[data-act="reads-again"]')?.textContent).toBe('Describe again');
    // One "Not quite? Fix it" on the sheet: the note's own fix is reached from it.
    expect([...document.querySelectorAll<HTMLElement>('.sheet-body [data-act="fix-ev"]')].every((b) => b.hidden)).toBe(true);
  });

  it("keeps the person's fix as theirs, and the note's own fix is one tap away", async () => {
    const { L, R, UI, LIFE } = await load();
    await L.addEvents([NOTE]);
    await R.saveReads([aiRead('e:manual:n1')]);
    await LIFE.handleAction('life-ev', el({ id: 'manual:n1' }));
    await tick();
    await UI.handleAction('reads-fix', el());
    expect(sheet()).toContain('Arise wrote: “A walk by the river with Sam <b>”');
    // The 1.35 fix for the note itself (its title and time).
    expect(document.querySelector('[data-act="fix-ev"]')?.getAttribute('data-id')).toBe('manual:n1');
    (document.getElementById('readsDesc') as HTMLInputElement).value = 'Sunday walk with Sam';
    (document.getElementById('readsTags') as HTMLInputElement).value = 'Walks, sam, ';
    await UI.handleAction('reads-fix-save', el({ id: 'e:manual:n1' }));
    expect(R.readOf('e:manual:n1')).toMatchObject({ desc: 'Sunday walk with Sam', tags: ['walks', 'sam'], from: 'you' });
    await LIFE.handleAction('life-ev', el({ id: 'manual:n1' }));
    await tick();
    expect(sheet()).toContain('Description (yours) Sunday walk with Sam');
  });

  it('offers to describe one with nothing yet, only once it is on', async () => {
    const { L, R, UI, LIFE } = await load();
    await L.addEvents([NOTE]);
    await LIFE.handleAction('life-ev', el({ id: 'manual:n1' }));
    await tick();
    expect(document.getElementById('readsBox')?.innerHTML).toBe('');
    await R.setPrefs({ on: true });
    await LIFE.handleAction('life-ev', el({ id: 'manual:n1' }));
    await tick();
    expect(sheet()).toContain("Arise hasn't described this yet.");
    R.queue().jobs.length = 0;
    await UI.handleAction('reads-again', el());
    expect(R.queue().jobs).toEqual([expect.objectContaining({ id: 'e:manual:n1', again: true })]);
  });

  it('is not on a sheet that is not a note', async () => {
    const { L, LIFE } = await load();
    await L.addEvents([{ id: 'spotify:s1', source: 'spotify', kind: 'listen', at: T, title: 'Listened to a song', tier: 2 }]);
    await LIFE.handleAction('life-ev', el({ id: 'spotify:s1' }));
    await tick();
    expect(document.getElementById('readsBox')).toBeNull();
  });
});

describe("a file's sheet", () => {
  it('shows what was written about a file with words in it, and its words', async () => {
    const { R } = await load();
    const F = await import('./files');
    const FUI = await import('./files-ui.js');
    const f = await F.putFile(new TextEncoder().encode('Packing list: tent, stove, maps for the lakes trip.'), { name: 'packing.txt', type: 'text/plain', day: '2026-11-20' });
    await R.saveReads([aiRead(`f:${f.id}`, { tier: 3, desc: 'A packing list for a trip', tidy: undefined, source: undefined })]);
    await FUI.handleAction('myfiles-file', el({ id: f.id }));
    await tick();
    const text = sheet();
    expect(text).toContain('Description (AI-written) A packing list for a trip');
    expect(text).not.toContain('Your note, refined');
    expect(document.querySelector('.sheet-body details summary')?.textContent).toBe('The original');
    expect(text).toContain('Packing list: tent, stove');
  });
});

describe('Settings, Your life log', () => {
  it('is off until turned on, with how many a day, the held-back kinds and Run now', async () => {
    const { R, UI } = await load();
    document.getElementById('app')!.innerHTML = UI.settingsBlock();
    expect(document.querySelector('[data-act="reads-on"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-act="reads-run"]')).toBeNull();
    await UI.handleAction('reads-on', el({ on: 'true' }));
    expect(R.prefs()).toMatchObject({ on: true, perDay: 20, health: false, money: false, id: false });
    expect(document.querySelector('[data-act="reads-per-day"][aria-pressed="true"]')?.textContent).toBe('20');
    expect(document.querySelector('[data-act="reads-run"]')?.textContent).toBe('Run now');
    await UI.handleAction('reads-per-day', el({ v: '5' }));
    await UI.handleAction('reads-allow', el({ k: 'health', on: 'true' }));
    expect(R.prefs()).toMatchObject({ perDay: 5, health: true, money: false });
    await UI.handleAction('reads-on', el({ on: 'false' }));
    expect(R.prefs().on).toBe(false);
    expect(R.queue().jobs).toEqual([]);
  });
});
