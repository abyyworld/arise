// @vitest-environment jsdom
// Which tabs show (tabs.js): Coach and Goals are off the tab bar unless turned on in Settings, and
// their screens open from Me, with Me lit.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(view = 'today') {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true } }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  await import('./app.js');
}
const tabs = () => [...document.querySelectorAll<HTMLElement>('#tabs [data-v]')].map((b) => b.dataset.v);
const lit = () => document.querySelector<HTMLElement>('#tabs .on')?.dataset.v;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});

describe('the tab bar', () => {
  it('leaves Coach and Goals off, and opens them from Me with Me lit', async () => {
    await boot('progress');
    expect(tabs()).toEqual(['today', 'calendar', 'days', 'progress', 'settings']);
    const more = document.querySelector('.more-card')!;
    expect(more.textContent).toContain('More of Arise');
    expect([...more.querySelectorAll<HTMLElement>('[data-v]')].map((b) => b.dataset.v)).toEqual(['goals', 'coach']);
    more.querySelector<HTMLElement>('[data-v="goals"]')!.click();
    await tick();
    expect(location.hash).toBe('#goals');
    expect(lit()).toBe('progress');
    document.querySelector<HTMLElement>('#tabs [data-v="progress"]')!.click();
    await tick();
    document.querySelector<HTMLElement>('.more-card [data-v="coach"]')!.click();
    await tick();
    expect(location.hash).toBe('#coach');
    expect(lit()).toBe('progress');
  });

  it('puts a tab back from Settings, on this device', async () => {
    await boot('settings');
    const box = document.querySelector<HTMLInputElement>('[data-tab-shown="goals"]')!;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(tabs()).toEqual(['today', 'calendar', 'days', 'progress', 'goals', 'settings']);
    expect(JSON.parse(localStorage.getItem('arise-tabs-shown')!)).toEqual(['goals']);
    // Me no longer lists Goals under More of Arise.
    document.querySelector<HTMLElement>('#tabs [data-v="progress"]')!.click();
    await tick();
    expect([...document.querySelectorAll<HTMLElement>('.more-card [data-v]')].map((b) => b.dataset.v)).toEqual(['coach']);
  });
});
