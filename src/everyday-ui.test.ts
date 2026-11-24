// @vitest-environment jsdom
// On screen: the box on Today that works out what you wrote and saves it, money owed and
// groceries on Today, the priority grid, and Write it my way on Coach.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(data: object = {}, view = 'today') {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, ...data }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const S = await import('./store');
  await import('./app.js');
  return { S, AI: await import('./ai.js') };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const tick = () => new Promise((r) => setTimeout(r, 0));
const tap = async (sel: string) => {
  $(sel)!.click();
  await tick();
};
const write = async (value: string) => {
  const box = $('#captureIn') as HTMLTextAreaElement;
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
};
const submit = async (sel: string) => {
  $(sel)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await tick();
};
const NOW = new Date(2026, 10, 24, 10, 0); // Tuesday 24 November 2026, 10:00

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

describe('the box on Today', () => {
  it('shows what it will save, and saves a to-do, groceries and money owed where they go', async () => {
    const { S } = await boot();
    expect($('#captureCard')).toBeTruthy();

    await write('Call mum tomorrow at 5');
    expect(text('#captureWhat')).toBe('A to-do: "Call mum", Tomorrow at 17:00.');
    await submit('[data-form="capture"]');
    const todo = Object.values(S.state.todos)[0];
    expect(todo).toMatchObject({ title: 'Call mum', day: '2026-11-25', time: '17:00' });
    expect(text('#todoCard')).toContain('Call mum');
    expect(($('#captureIn') as HTMLTextAreaElement).value).toBe('');

    await write('buy milk, 2 bread and eggs');
    expect(text('#captureWhat')).toBe('Groceries: milk, 2 bread, eggs.');
    await submit('[data-form="capture"]');
    expect(S.groceriesList().map((g) => g.name)).toEqual(['milk', 'bread', 'eggs']);
    expect(text('#everydayCard')).toContain('Groceries (3)');
    expect(text('#everydayCard')).toContain('2 bread');

    await write('Sam owes me £12.50 for lunch');
    expect(text('#captureWhat')).toBe('Sam owes you £12.50 for lunch.');
    await submit('[data-form="capture"]');
    expect(text('#everydayCard')).toContain('Sam owes you £12.50');
  });

  it('can save the words as another kind, picked by hand', async () => {
    const { S } = await boot();
    await write('milk tomorrow');
    expect(text('#captureWhat')).toContain('A to-do');
    await tap('[data-act="capture-kind"][data-v="grocery"]');
    expect(text('#captureWhat')).toBe('Groceries: milk tomorrow.');
    expect($('[data-act="capture-kind"][data-v="grocery"]')!.getAttribute('aria-pressed')).toBe('true');
    await submit('[data-form="capture"]');
    expect(S.groceriesList().map((g) => g.name)).toEqual(['milk tomorrow']);
    expect(Object.keys(S.state.todos)).toEqual([]);
  });

  it('asks money owed with no amount in a sheet', async () => {
    const { S } = await boot();
    await write('I owe Ali');
    await tap('[data-act="capture-kind"][data-v="debt"]');
    expect(text('#captureWhat')).toBe('Money owed: you fill in who and how much next.');
    await submit('[data-form="capture"]');
    expect($('.debt-sheet')).toBeTruthy();
    (document.querySelector('#debtWho') as HTMLInputElement).value = 'Ali';
    (document.querySelector('#debtAmount') as HTMLInputElement).value = '50000';
    (document.querySelector('#debtCur') as HTMLSelectElement).value = 'UZS';
    await tap('.debt-sheet [data-act="debt-dir"][data-v="owe"]');
    await submit('[data-form="debt-save"]');
    expect(S.balances()).toMatchObject([{ who: 'Ali', net: -50000, cur: 'UZS' }]);
    expect(text('#everydayCard')).toContain('You owe Ali 50,000 UZS');
    expect(S.state.settings.currency).toBe('UZS');
  });
});

describe('money owed and groceries', () => {
  it('settles what was paid back, and clears what was bought', async () => {
    const { S } = await boot();
    S.addDebt({ who: 'Sam', amount: 10, cur: 'GBP', dir: 'owed', what: 'cinema' });
    S.addDebt({ who: 'Sam', amount: 4, cur: 'GBP', dir: 'owe' });
    S.addGroceries([{ name: 'Milk' }, { name: 'Eggs' }]);
    (await import('./everyday-ui.js')).repaint();
    expect(text('#everydayCard')).toContain('Sam owes you £6');
    expect(text('#everydayCard')).toContain('In all: owed £6.');

    await tap('[data-act="money-person"]');
    expect(text('.person-sheet')).toContain('Sam owes you £10');
    expect(text('.person-sheet')).toContain('cinema');
    await tap('[data-act="debt-settle-all"]');
    expect(S.balances()).toEqual([]);
    expect(text('#everydayCard')).toContain('No one owes anyone');

    await tap('[data-act="everyday-tab"][data-v="groceries"]');
    await tap('[data-act="grocery-tick"]');
    expect(S.groceriesList().filter((g) => g.got).map((g) => g.name)).toEqual(['Milk']);
    await tap('[data-act="grocery-clear"]');
    expect(S.groceriesList().map((g) => g.name)).toEqual(['Eggs']);
    // The tab stays where it was left.
    await boot({ groceries: S.state.groceries });
  });
});

describe('what matters, and when', () => {
  it('puts the next 14 days in four boxes, with a to-do moved up by hand', async () => {
    const { S } = await boot();
    S.addTodo({ title: 'Revise for the maths exam', day: '2026-11-25' });
    const t = S.addTodo({ title: 'Call the bank' })!;
    S.editTodo(t.id, { big: true });
    S.addTodo({ title: 'Water the plants', day: '2026-11-24' });
    S.addDebt({ who: 'Jo', amount: 20, cur: 'GBP', dir: 'owe', due: '2026-12-01' });
    (await import('./everyday-ui.js')).repaint();
    const AHEAD = await import('./ahead-ui.js');
    AHEAD.mattersSheet();
    await tick();
    const boxes = [...document.querySelectorAll('.grid4 > section')].map((s) => s.textContent!.replace(/\s+/g, ' ').trim());
    expect(boxes[0]).toContain('Do now');
    expect(boxes[0]).toContain('Revise for the maths exam');
    expect(boxes[1]).toContain('Call the bank');
    expect(boxes[1]).toContain('Pay Jo back £20');
    expect(boxes[2]).toContain('Water the plants');
  });
});

describe('Write it my way', () => {
  it('writes from rough notes on Coach, keeps the sample of how you write, and copies the result', async () => {
    const { S, AI } = await boot({}, 'coach');
    const writeSpy = vi.spyOn(AI, 'writeMyWay').mockResolvedValue('Hey Sam! Can’t make Friday, sorry.');
    vi.spyOn(AI, 'ready').mockReturnValue(true);
    expect($('#writeCard')).toBeTruthy();
    await tap('[data-act="write-open"]');
    await tap('[data-act="write-kind"][data-v="email"]');
    (document.querySelector('#writeNotes') as HTMLTextAreaElement).value = 'tell sam cant make fri';
    (document.querySelector('#writeVoice') as HTMLTextAreaElement).value = 'hey!! so sorry about that lol';
    await submit('[data-form="write-go"]');
    await vi.waitFor(() => expect(text('#writeText')).toBe('Hey Sam! Can’t make Friday, sorry.'));
    expect(writeSpy).toHaveBeenCalledWith('tell sam cant make fri', 'email', expect.objectContaining({ to: '' }));
    expect(S.state.settings.voice).toBe('hey!! so sorry about that lol');
  });
});
