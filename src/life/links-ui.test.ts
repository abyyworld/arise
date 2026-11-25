// @vitest-environment jsdom
// Your links on screen: the way in from Your days, the links from notes and the journal with
// where and when, search, saving a pasted link, and "Keep a copy" (nothing fetched without the
// helper; with it, only the helper is asked, and the copy is kept and read back).

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));

const NOW = new Date(2026, 10, 25, 18);
const T = (d: number, h = 12) => new Date(2026, 10, d, h).getTime();
const EVENTS: LifeEvent[] = [
  { id: 'manual:n1', source: 'manual', kind: 'note', at: T(20), title: 'Pie recipe', detail: 'Pie recipe https://food.example.com/pie', tier: 2 },
  { id: 'manual:n2', source: 'manual', kind: 'note', at: T(22), title: 'News', detail: 'Read https://news.example.com/story later.', tier: 2 },
];

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(view: string, { server = '' } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, logs: { '2026-11-23': { t: 'This song https://music.example.com/song' } } }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  (await import('../calendar-config')).CALENDAR.server = server;
  history.replaceState(null, '', `#${view}`);
  const L = await import('./log');
  await L.addEvents(EVENTS);
  await import('../app.js');
  return { L };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const titles = () => [...document.querySelectorAll('#lkList .lk-title')].map((a) => a.textContent);
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Your links', { timeout: 20_000 }, () => {
  it('opens from Your days and lists the links in notes and the journal, newest first, with where and when', async () => {
    await boot('days');
    ($('[data-act="nav"][data-v="links"]') as HTMLElement).click();
    expect(text('h1')).toBe('Your links');
    expect(document.querySelector('#tabs [data-v="days"]')?.classList.contains('on')).toBe(true);
    await until(() => titles().length === 3);
    expect(titles()).toEqual(['music.example.com/song', 'news.example.com/story', 'food.example.com/pie']);
    expect(text('#lkList .lk-item')).toMatch(/^music\.example\.com\/song music\.example\.com\. Your journal, (23 Nov|Nov 23)\./);
    const a = $('#lkList .lk-title') as HTMLAnchorElement;
    expect(a.href).toBe('https://music.example.com/song');
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
  });

  it('searches as you type', async () => {
    await boot('links');
    await until(() => titles().length === 3);
    const q = $('#lkQ') as HTMLInputElement;
    q.value = 'pie';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    expect(titles()).toEqual(['food.example.com/pie']);
    q.value = 'nothing like it';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    expect(text('#lkList')).toContain('No link has "nothing like it"');
  });

  it('saves a pasted link with a note, into the life log', async () => {
    const { L } = await boot('links');
    await until(() => titles().length === 3);
    ($('#lkUrl') as HTMLInputElement).value = 'https://guide.example.com/trip';
    ($('#lkNote') as HTMLInputElement).value = 'For the summer';
    $('#lkSave')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => titles().length === 4);
    expect(titles()[0]).toBe('guide.example.com/trip');
    expect(text('#lkList .lk-item')).toContain('Saved in Arise');
    expect(text('#lkList .lk-item')).toContain('For the summer');
    const [e] = (await L.eventsBetween(0, 8.64e15, { kinds: ['note'] })).filter((x) => x.meta?.saved);
    expect(e).toMatchObject({ source: 'manual', url: 'https://guide.example.com/trip', detail: 'For the summer' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says Keep a copy needs the helper, and fetches nothing, when it is not set up', async () => {
    await boot('links');
    await until(() => titles().length === 3);
    expect(text('.small-print')).toContain("needs Arise's helper, which isn't set up yet");
    ($('#lkList [data-act="lk-copy"]') as HTMLElement).click();
    await until(() => text('#toast').includes("needs Arise's helper"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with the helper, keeps a copy of the page and reads it back', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ url: 'https://music.example.com/song', html: '<title>A song</title><nav>Menu</nav><article><p>Lyrics are not here, only words about it.</p></article>' }), { status: 200 }));
    await boot('links', { server: 'https://helper.example.dev' });
    await until(() => titles().length === 3);
    expect(text('.small-print')).toContain("the helper sees that page's address");
    ($('#lkList [data-act="lk-copy"]') as HTMLElement).click();
    await until(() => text('#toast').startsWith('Kept a copy of A song'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://helper.example.dev/page');
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://music.example.com/song' });
    await until(() => !!$('#lkList [data-act="lk-read"]'));
    expect(titles()[0]).toBe('A song'); // the page's own name, once a copy is kept
    ($('#lkList [data-act="lk-read"]') as HTMLElement).click();
    expect(text('.sheet-title')).toBe('A song');
    expect(text('.lk-copy')).toBe('Lyrics are not here, only words about it.');
    expect(text('.lk-copy')).not.toContain('Menu');
    ($('[data-act="lk-drop"]') as HTMLElement).click();
    await until(() => text('#toast').startsWith('The copy is deleted'));
    await until(() => !$('#lkList [data-act="lk-read"]'));
  });
});
