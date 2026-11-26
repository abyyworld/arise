// @vitest-environment jsdom
// On screen: "How well Arise knows you" and "What was sent to an AI" on What Arise knows, the way
// into the list from Settings, AI coach, and how many quick questions are left today on Today.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));

const T = (k: string, h = 12) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h).getTime();
};
const EVENTS: LifeEvent[] = [
  { id: 'google:s1', source: 'google', kind: 'search', at: T('2026-10-16', 14), title: 'Searched "protein bars"', tier: 3 },
  { id: 'netflix:n1', source: 'netflix', kind: 'watch', at: T('2026-10-12', 21), title: 'Watched Dark: S1E1', tier: 2 },
];

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(view: string, { data = {}, summaries = [] as object[] } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-tabs-shown', JSON.stringify(['goals', 'coach']));
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, ...data }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const L = await import('./log');
  await L.addEvents(EVENTS);
  if (summaries.length) {
    const db = await (await import('./db')).open();
    const tx = db.transaction('summaries', 'readwrite');
    for (const x of summaries) tx.objectStore('summaries').put(x);
    await new Promise((r) => (tx.oncomplete = r));
  }
  const S = await import('../store');
  await import('../app.js');
  return { S, SENT: await import('../ai-log'), KY: await import('./knows-you-ui.js') };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const click = (sel: string) => $(sel)!.click();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

describe('How well Arise knows you', () => {
  it('shows right first time from the fixes, what it would like to learn, and the questions left today', async () => {
    const { S, KY } = await boot('knows', { summaries: [{ id: 'd:2026-10-16', kind: 'day', key: '2026-10-16', text: 'You looked up protein bars.', tier: 3, cap: 3, sig: 'x', n: 1, at: 1 }] });
    expect(text('#kyPanel .panel-title')).toBe('How well Arise knows you');
    await vi.waitFor(() => expect(text('#kyBody')).toContain('100% right first time'));
    expect(text('#kyBody')).toContain('1 written, 0 fixed by you.');

    // "Not quite? Fix it" on something Arise wrote down.
    await (await import('./fix-store')).saveFix({ id: 'google:s1', at: Date.now(), title: 'Searched "protein powder"' });
    await KY.fill();
    expect(text('#kyBody')).toContain('50% right first time');
    expect(text('#kyBody')).toContain('2 written, 1 fixed by you.');

    const gaps = [...document.querySelectorAll('#kyBody [data-gap]')].map((el) => el.getAttribute('data-gap'));
    expect(gaps.slice(0, 3)).toEqual(['values', 'best-time', 'checkins']);
    expect(text('#kyBody [data-gap="values"]')).toContain('What matters most to you.');
    expect($('#kyBody [data-gap="values"] [data-act="life-checkin"]')).not.toBeNull();
    expect(text('#kyLeft')).toBe('Quick questions left today: 6 of 6. It never asks more than that.');

    click('#kyBody [data-act="knowsyou-best"][data-v="morning"]');
    expect(S.state.settings.bestTime).toBe('morning');
    await vi.waitFor(() => expect($('#kyBody [data-gap="best-time"]')).toBeNull());
    expect(text('#kyBody')).not.toMatch(/\u2014/);
  });
});

describe('What was sent to an AI', () => {
  it('lists every request, filters by AI, keeps the full text only when asked, and deletes all', async () => {
    const { SENT } = await boot('knows');
    expect(text('#sentPanel .panel-title')).toBe('What was sent to an AI');
    expect(text('#sentSummary')).toContain('Nothing sent yet.');
    SENT.noteSent({ ai: 'private', for: 'chat', context: '## Profile\nName: Sam', messages: [{ role: 'user', content: 'Hi' }], cap: 3 });
    SENT.noteSent({ ai: 'own', who: 'Groq', for: 'write', messages: [{ role: 'user', content: 'meet at 3' }], error: { code: 'server', message: 'Groq is busy.' } });

    click('#sentPanel [data-act="sent-open"]');
    await vi.waitFor(() => expect(text('#sheet .sheet-title')).toBe('What was sent to an AI'));
    expect(document.querySelectorAll('#sentList .sent-row')).toHaveLength(2);
    expect(text('#sentList')).toContain('Write it my way to Groq');
    expect(text('#sentList')).toContain('No answer: Groq is busy.');
    expect(text('#sentList')).toContain('Coach chat to Private AI');
    expect([...document.querySelectorAll('#sheet [data-act="sent-filter"]')].map((b) => b.textContent)).toEqual(['All', 'Private AI', 'Your own key']);

    click('#sheet [data-act="sent-filter"][data-v="own"]');
    await vi.waitFor(() => expect(document.querySelectorAll('#sentList .sent-row')).toHaveLength(1));
    expect(text('#sentCount')).toContain('1 request');

    // The full text: off by default, and on only when switched on.
    expect($('#sheet [data-act="sent-full"]')!.getAttribute('aria-pressed')).toBe('false');
    click('#sheet [data-act="sent-full"]');
    await vi.waitFor(() => expect(SENT.fullText()).toBe(true));
    SENT.noteSent({ ai: 'own', who: 'Groq', for: 'write', messages: [{ role: 'user', content: 'lunch friday' }] });
    await vi.waitFor(() => expect(text('#sentList .sent-text')).toContain('lunch friday'));

    window.confirm = () => true;
    click('#sheet [data-act="sent-del-all"]');
    await vi.waitFor(() => expect(text('#sentCount')).toBe('Nothing here yet.'));
    expect(SENT.sentList()).toEqual([]);
    expect(text('#sentSummary')).toContain('Nothing sent yet.');
  });

  it('opens from Settings, AI coach too', async () => {
    await boot('settings');
    expect($('#aiSettings [data-act="sent-open"]')).not.toBeNull();
    click('#aiSettings [data-act="sent-open"]');
    await vi.waitFor(() => expect(text('#sheet .sheet-title')).toBe('What was sent to an AI'));
    expect(text('#sentCount')).toBe('Nothing here yet.');
  });
});

describe('A quick one, at most 6 a day', () => {
  const today = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q:late:t${i}:2026-10-01`, Date.now() - i * 60_000]));

  it('says how many are left, and stops after 6', async () => {
    await boot('today');
    await vi.waitFor(() => expect(text('#askCard')).toContain('When do you think best?'));
    expect(text('#askCard .ask-left')).toBe('Up to 5 more today.');

    await boot('today', { data: { dismissed: today(5) } });
    await vi.waitFor(() => expect(text('#askCard')).toContain('When do you think best?'));
    expect(text('#askCard .ask-left')).toBe('Last one for today.');

    await boot('today', { data: { dismissed: today(6) } });
    await vi.waitFor(() => expect($('#askCard')).not.toBeNull());
    expect(text('#askCard')).toBe('');
  });
});
