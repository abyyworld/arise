// @vitest-environment jsdom
// Money on screen: the way in from Me (next to Your world), what shows with no statements yet,
// this month against the usual, month by month, where it went, the biggest payments,
// subscriptions found, money owed, changing a merchant's category (kept in the synced state), and
// what the coach reads (only an AI that may read money).

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));

const NOW = new Date(2026, 10, 25, 10); // Wednesday 25 November 2026
let n = 0;
const at = (m: number, d: number) => new Date(2026, m - 1, d, 12).getTime();
const spent = (m: number, d: number, amount: number, desc: string, cur = 'GBP'): LifeEvent => ({ id: `bank:t${++n}`, source: 'bank', kind: 'purchase', at: at(m, d), title: `Spent ${amount.toFixed(2)} ${cur} at ${desc}`, value: -amount, unit: cur, tier: 3 });
const received = (m: number, d: number, amount: number, desc: string): LifeEvent => ({ id: `bank:r${++n}`, source: 'bank', kind: 'purchase', at: at(m, d), title: `Received ${amount.toFixed(2)} GBP: ${desc}`, value: amount, unit: 'GBP', tier: 3, meta: { in: true } });
const BANK: LifeEvent[] = [
  ...[8, 9, 10, 11].map((m) => spent(m, 3, 10.99, 'NETFLIX.COM')),
  ...[62, 58, 71, 60].map((x, i) => spent(8 + i, 6, x, 'TESCO STORES 3456')),
  spent(9, 12, 900, 'RENT LANDLORD LTD'),
  spent(10, 12, 900, 'RENT LANDLORD LTD'),
  spent(11, 12, 900, 'RENT LANDLORD LTD'),
  spent(11, 20, 25, 'CAFE NERO'),
  ...[8, 9, 10].map((m) => received(m, 28, 2000, 'SALARY ACME')),
  spent(11, 21, 5, 'CAFE PARIS', 'EUR'),
];

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(view: string, { events = BANK, data = {} as Record<string, unknown> } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, ...data }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const L = await import('./log');
  if (events.length) await L.addEvents(events);
  const S = await import('../store');
  await import('../app.js');
  return { S, AI: await import('../ai.js'), MO: await import('./money') };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};
const ready = () => until(() => !!$('.mn-now') || !!$('.mn-empty'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
afterEach(() => vi.useRealTimers());

// (The first boot loads the whole app, which can take a few seconds on a busy machine.)
describe('Money', { timeout: 20000 }, () => {
  it('is on Me next to Your world, and opens with the Me tab lit', async () => {
    await boot('progress');
    expect(text('.money-entry')).toContain('Where your money went, from your bank statements.');
    expect($('.world-entry')!.nextElementSibling).toBe($('.money-entry'));
    ($('.money-entry [data-v="money"]') as HTMLElement).click();
    expect(text('h1')).toBe('Money');
    expect(document.querySelector('#tabs [data-v="progress"]')?.classList.contains('on')).toBe(true);
    await ready();
  });

  it('with no statements: how to bring one in, and money owed still shows', async () => {
    const debts = { d1: { id: 'd1', who: 'Sam', amount: 20, cur: 'GBP', dir: 'owed', created: 1, at: 1 }, d2: { id: 'd2', who: 'Ali', amount: 5, cur: 'GBP', dir: 'owe', created: 1, at: 1 } };
    await boot('money', { events: [], data: { debts } });
    await ready();
    expect(text('.mn-empty')).toContain('No bank statements yet');
    expect($('.mn-empty [data-act="nav"]')!.dataset.v).toBe('life-import');
    expect(text('.mn-owed')).toContain('People owe you £20. You owe others £5.');
    expect(text('#mnBody')).toContain('Nothing is sent.');
  });

  it('this month against the usual, month by month, where it went, the biggest, subscriptions', async () => {
    await boot('money');
    await ready();
    // November so far: Netflix, Tesco, rent and a coffee.
    expect(text('.mn-now .body-stats b')).toBe('£996');
    // By the 25th: August had £73, September £969, October £982 (August is in: it starts on the 3rd).
    expect(text('.mn-now')).toContain('By this day of the month you usually spend £675.');
    expect(text('.mn-now')).toContain('£321 more than usual by now.');
    const months = [...document.querySelectorAll('.mn-month b')].map((b) => b.textContent);
    expect(months).toEqual(['November 2026', 'October 2026', 'September 2026', 'August 2026']);
    expect(text('.mn-months')).toContain('In £2,000');
    const cats = [...document.querySelectorAll('.mn-cat summary b')].map((b) => b.textContent);
    expect(cats).toEqual(['Home and rent', 'Groceries', 'Apps and streaming', 'Eating out']);
    expect(text('.mn-big li')).toContain('Landlord');
    expect(text('.mn-big li')).toContain('Home and rent');
    expect(text('.mn-subs')).toContain('Netflix');
    expect(text('.mn-subs')).toContain('£10.99 a month');
    expect(text('.mn-subs')).toContain('about £132 a year');
    expect(text('.mn-subs')).not.toContain('Tesco'); // a different amount each month
    expect(text('.mn-subs')).toContain('Landlord'); // the same rent each month is a regular payment too
    expect(text('#mnBody')).toContain("1 payment is in another currency, so it isn't counted here.");
    expect(text('#mnBody')).not.toMatch(/invest|interest/i);
  });

  it("changes a merchant's category, kept in the synced state, and back to Arise's guess", async () => {
    const { S } = await boot('money');
    await ready();
    const tesco = [...document.querySelectorAll<HTMLElement>('[data-act="mn-merchant"]')].find((b) => b.dataset.k === 'tesco')!;
    tesco.click();
    expect(text('.sheet-title')).toBe('Tesco');
    expect(text('.mn-sheet')).toContain('Arise put it in Groceries.');
    expect($('.mn-picks [data-v="groceries"]')!.getAttribute('aria-pressed')).toBe('true');
    ($('.mn-picks [data-v="eating"]') as HTMLElement).click();
    expect(S.state.moneyCats.tesco.cat).toBe('eating');
    expect(JSON.parse(localStorage.getItem('pit-data-v1')!).moneyCats.tesco.cat).toBe('eating');
    expect(text('#toast')).toBe('Tesco is in Eating out now.');
    expect($('#sheet')!.hidden).toBe(true);
    const cats = [...document.querySelectorAll('.mn-cat summary b')].map((b) => b.textContent);
    expect(cats).not.toContain('Groceries');
    expect(text('.mn-cats')).toContain('(your category)');
    // Back to the guess.
    ([...document.querySelectorAll<HTMLElement>('[data-act="mn-merchant"]')].find((b) => b.dataset.k === 'tesco') as HTMLElement).click();
    expect(text('.mn-sheet')).toContain('You put it in Eating out.');
    ($('.mn-sheet [data-v=""]') as HTMLElement).click();
    expect(S.state.moneyCats.tesco.gone).toBe(true);
    expect([...document.querySelectorAll('.mn-cat summary b')].map((b) => b.textContent)).toContain('Groceries');
  });

  it('the coach reads a short monthly summary, only an AI that may read money', async () => {
    const { AI, MO } = await boot('money');
    await ready();
    expect(MO.contextFor(3).text).toContain('November 2026 so far: spent £996');
    expect(MO.contextFor(3).tier).toBe(3);
    expect(MO.contextFor(2).text).toBe('');
    expect(MO.contextFor(1).text).toBe('');
    expect(AI.buildContext({ e: 'private' })).toContain("## Money, from the Player's bank statements");
    expect(AI.buildContext({ e: 'free' })).not.toContain('## Money, from');
    // Never on a text for the lock screen.
    expect(AI.buildContext({ e: 'private', saw: false })).not.toContain('## Money, from');
  });
});
