// @vitest-environment jsdom
// Your places and Your world on screen: the map's list and sheet, naming a place (kept in the
// synced state, and shown on Your days), the street map only when it's turned on, places never to
// note left out, the way in from Days and Me, and the three views of Your world.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));

const NOW = new Date(2026, 10, 20, 18); // Friday 20 November 2026, 6 pm
const T = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();
const MIN = 60_000;
const HOME = { lat: 41.3111, lon: 69.2797 };
const LAB = { lat: 41.35, lon: 69.2 };
const stay = (id: string, at: number, mins: number, spot: { lat: number; lon: number }): LifeEvent => ({
  id: `maps:stay:android:${id}`,
  source: 'maps',
  kind: 'place',
  at,
  end: at + mins * MIN,
  title: `At a place for ${mins >= 60 ? `${mins / 60} h` : `${mins} min`}`,
  tier: 3,
  meta: { ...spot, via: 'stay', device: 'android' },
});
const EVENTS: LifeEvent[] = [
  stay('1', T(1), 240, HOME),
  stay('2', T(9), 120, LAB),
  stay('3', T(12), 60, HOME),
  { id: 'whatsapp:sam1', source: 'whatsapp', kind: 'message', at: T(1, 30), title: 'Chatted with Sam', tier: 3, meta: { chat: 'Sam' } },
];

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(view: string, { events = EVENTS, data = {} as Record<string, unknown>, local = {} as Record<string, string> } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  for (const [k, v] of Object.entries(local)) localStorage.setItem(k, v);
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, ...data }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const L = await import('./log');
  await L.addEvents(events);
  const S = await import('../store');
  await import('../app.js');
  return { S, L };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const rows = () => [...document.querySelectorAll('#pmList .pm-row b')].map((b) => b.textContent);
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
  // No canvas in jsdom: the screens draw nothing and the rest still works.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
afterEach(() => vi.useRealTimers());

describe('Your places', () => {
  it('lists where the time went, with no street map and nothing sent', async () => {
    await boot('places');
    expect(text('h1')).toBe('Your places');
    await until(() => rows().length === 2);
    expect(rows()).toEqual(['Near 41.311, 69.280', 'Near 41.350, 69.200']);
    expect(text('#pmList')).toContain('5 h · 2 visits');
    expect(text('#pmSum')).toBe('2 places, 7 h in all. Brighter means more time there.');
    expect($('#pmTiles')!.children).toHaveLength(0);
    expect($('.pm-credit')).toBeNull();
    expect($('[data-act="pm-street"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(text('[data-act="pm-street"]')).toContain("OpenStreetMap's tile server sees which areas you look at");
    expect(text('#pmScale span')).toMatch(/^\d+ (m|km)$/);
    expect(document.querySelector('#tabs [data-v="days"]')?.classList.contains('on')).toBe(true);
  });

  it('opens a place with its visits, and names it so it syncs and shows on Your days', async () => {
    const { S } = await boot('places');
    await until(() => rows().length === 2);
    ($('#pmList .pm-row') as HTMLElement).click();
    expect(text('.sheet-title')).toBe('Near 41.311, 69.280');
    expect(text('.sheet-body')).toContain('5 h here in the last 30 days, 2 visits.');
    expect(document.querySelectorAll('.pm-visits li')).toHaveLength(2);
    ($('#pmName') as HTMLInputElement).value = 'Home';
    $('form[data-form="pm-name"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(text('#toast')).toBe('Named it Home.');
    expect($('#sheet')!.hidden).toBe(true);
    const names = Object.values(S.state.placeNames);
    expect(names).toEqual([{ name: 'Home', at: NOW.getTime() }]);
    expect(JSON.parse(localStorage.getItem('pit-data-v1')!).placeNames).toBeTruthy();
    expect(rows()[0]).toBe('Home');
    // Taken away again.
    ($('#pmList .pm-row') as HTMLElement).click();
    ($('[data-act="pm-unname"]') as HTMLElement).click();
    expect(text('#toast')).toBe('Name taken away.');
    expect(Object.values(S.state.placeNames)[0].gone).toBe(true);
    expect(rows()[0]).toBe('Near 41.311, 69.280');
  });

  it('shows the name on Your days and to the coach', async () => {
    const key = '41.311,69.280';
    await boot('days', { data: { placeNames: { [key]: { name: 'Home', at: 1 } } } });
    await until(() => text('#lifeDay').includes('At Home for 4 h'));
    expect(text('#lifePlaces')).toContain('At Home for 1 h');
    expect(text('#lifeDay')).toContain('At a place for 2 h');
    const M = await import('./memory');
    expect(M.eventLine(EVENTS[0])).toContain('At Home for 4 h');
    ($('[data-act="nav"][data-v="places"]') as HTMLElement).click();
    expect(text('h1')).toBe('Your places');
  });

  it('loads street map tiles only once it is turned on, and says so', async () => {
    await boot('places');
    await until(() => rows().length === 2);
    ($('[data-act="pm-street"]') as HTMLElement).click();
    expect(localStorage.getItem('arise-street-map')).toBe('on');
    expect(text('#toast')).toContain('OpenStreetMap sees which areas you look at');
    await until(() => ($('#pmTiles')?.children.length || 0) > 0);
    const srcs = [...document.querySelectorAll<HTMLImageElement>('#pmTiles img')].map((i) => i.src);
    expect(srcs.every((s) => /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(s))).toBe(true);
    expect(text('.pm-credit')).toContain('OpenStreetMap contributors');
    ($('[data-act="pm-street"]') as HTMLElement).click();
    expect(localStorage.getItem('arise-street-map')).toBeNull();
    expect($('#pmTiles')!.children).toHaveLength(0);
  });

  it('leaves out places never to note, and changes the range', async () => {
    await boot('places', { local: { 'arise-location': JSON.stringify({ prefs: { mode: 'places', never: [{ ...HOME, radius: 250, name: 'Home' }] } }) } });
    await until(() => rows().length === 1);
    expect(rows()).toEqual(['Near 41.350, 69.200']);
    ($('[data-act="pm-range"][data-v="week"]') as HTMLElement).click();
    expect(localStorage.getItem('arise-map-range')).toBe('week');
    expect($('[data-act="pm-range"][data-v="week"]')!.getAttribute('aria-pressed')).toBe('true');
    await until(() => rows().length === 1);
  });

  it('says what to do when there are no places', async () => {
    await boot('places', { events: [] });
    await until(() => text('#pmSum').startsWith('No places'));
    expect(text('#pmSum')).toContain('Turn on Location in the phone app');
  });
});

describe('Your world', () => {
  const goals = [{ id: 'g1', title: 'See Sam more', category: 'relationships', why: '', by: '', created: '2026-11-01', updated: 1, status: 'active', quests: [], measures: [], milestones: [] }];

  it('is on Me, and opens on the constellation', async () => {
    await boot('progress', { data: { goals } });
    expect(text('.world-entry')).toContain('Your world');
    ($('.world-entry [data-v="world"]') as HTMLElement).click();
    expect(text('h1')).toBe('Your world');
    expect(document.querySelector('#tabs [data-v="progress"]')?.classList.contains('on')).toBe(true);
    expect($('#worldCanvas')!.getAttribute('aria-label')).toContain('The outline has the same, as a list.');
    expect($('[data-act="world-mode"][data-v="stars"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(text('.world-key')).toContain('Goals');
  });

  it('shows the outline as a nested list, with the links between them', async () => {
    await boot('world', { data: { goals, placeNames: { '41.311,69.280': { name: 'Home', at: 1 } } } });
    ($('[data-act="world-mode"][data-v="list"]') as HTMLElement).click();
    expect(localStorage.getItem('arise-world-view')).toBe('list');
    await until(() => text('#worldList').includes('Places'));
    const out = text('#worldList');
    expect(out).toContain('See Sam more');
    expect(out).toContain('With Sam');
    const sam = [...document.querySelectorAll('.world-outline li')].find((li) => li.firstChild?.textContent?.trim() === 'Sam')!;
    expect(sam.querySelector('small')?.textContent).toBe('1 call or message');
    expect([...sam.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['At Home', 'Goal: See Sam more']);
    expect(out).not.toContain('Parts of your life'); // nothing worked out for them yet
    expect(out).toContain('Home 5 h');
    expect(document.querySelectorAll('.world-outline ul ul li').length).toBeGreaterThan(3);
  });

  it('turns the globe by hand, and with less motion nothing moves on its own', async () => {
    const raf = vi.fn();
    window.requestAnimationFrame = raf as never;
    try {
      await boot('world', { local: { 'arise-world-view': 'globe', 'arise-motion': 'less' } });
      expect($('.world-stage.globe')).toBeTruthy();
      const W = await import('./world-ui.js');
      expect(W.still()).toBe(true);
      await until(() => !!W._ui.world);
      const before = W._ui.turn ?? 0;
      ($('[data-act="world-turn"][data-d="1"]') as HTMLElement).click();
      expect(((W._ui.turn ?? 0) - before + 360) % 360).toBe(30);
      expect(raf).not.toHaveBeenCalled();
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });
});
