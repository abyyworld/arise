// @vitest-environment jsdom
// Habits that help, on Me: until there are 14 days with a check-in it says so plainly; then what
// came with the good days (times out of how many, how sure), one small habit, "Make it a quest"
// (on a new Habits goal or a goal they pick) and "Not for me" (put away, synced). And what the
// coach reads of it. The whole app started on some data.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './life/types';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const NOW = new Date(2026, 10, 25, 10); // Wednesday 25 November 2026
const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// The `n` days before today, oldest first.
const before = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() - n + i);
    return keyOf(d);
  });
const T = (k: string, h = 12) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d, h).getTime();
};
const stepsOn = (k: string, n: number): LifeEvent => ({ id: `health:day:${k}`, source: 'health', kind: 'steps', at: T(k, 0), end: T(k, 23) + 59 * 60000, title: `${n} steps`, value: n, unit: 'steps', tier: 2 });

// 40 days: walking days had high energy, the others low.
const DAYS = before(40);
const LOGS = Object.fromEntries(DAYS.map((k, i) => [k, { e: i % 2 ? 2 : 4, at: 1 }]));
const STEPS = DAYS.map((k, i) => stepsOn(k, i % 2 ? 2500 : 9000));

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot({ data = {} as Record<string, unknown>, events = [] as LifeEvent[] } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-tabs-shown', JSON.stringify(['goals', 'coach']));
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, ...data }));
  localStorage.setItem('arise-look-hint', 'seen');
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', '#progress');
  const L = await import('./life/log');
  if (events.length) await L.addEvents(events);
  const S = await import('./store');
  await import('./app.js');
  return { S, AI: await import('./ai.js') };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

// (The first boot loads the whole app, which can take a few seconds on a busy machine.)
describe('Habits that help, on Me', { timeout: 20000 }, () => {
  it('says plainly what it needs until there are 14 days with a check-in', async () => {
    const few = Object.fromEntries(before(5).map((k) => [k, { e: 4, at: 1 }]));
    await boot({ data: { logs: few } });
    expect(text('#habitsPanel .panel-title')).toBe('Habits that help');
    await until(() => text('#habitsPanel').includes('so far'));
    expect(text('#habitsPanel')).toContain('This needs at least 14 days with a check-in in the last 8 weeks');
    expect(text('#habitsPanel')).toContain('You have 5 days so far.');
    expect($('[data-act="habit-quest"]')).toBeNull();
  });

  it('shows what came with the good days, how sure, and one small habit, never a cause', async () => {
    await boot({ data: { logs: LOGS }, events: STEPS });
    await until(() => !!$('[data-act="habit-quest"]'));
    const t = text('#habitsPanel');
    expect(t).toContain('On days you walked 6,000 steps or more, your energy was high 20 times out of 20.');
    expect(t).toContain('On other days, 0 times out of 20.');
    expect(t).toContain('Fairly sure: it rests on 40 days.');
    expect(t).toContain('Try a 20 minute walk on weekdays?');
    expect(t).toContain("that doesn't mean one caused the other");
    expect(t).not.toMatch(/because|thanks to/i);
  });

  it('makes it a quest on a new Habits goal, and puts it away', async () => {
    const { S } = await boot({ data: { logs: LOGS }, events: STEPS });
    await until(() => !!$('[data-act="habit-quest"]'));
    $('[data-act="habit-quest"]')!.click();
    expect(text('.sheet-title')).toBe('20 minute walk');
    expect(text('.habit-sheet')).toContain('Weekdays.');
    const picked = document.querySelector<HTMLInputElement>('input[name="habitGoal"]:checked')!;
    expect(picked.value).toBe('new');
    expect(picked.parentElement!.textContent).toContain('A new goal: Habits');
    $('[data-act="habit-add"]')!.click();
    const g = S.state.goals.find((x) => x.title === 'Habits')!;
    expect(g.category).toBe('habits');
    expect(g.quests.map((q) => [q.title, q.schedule])).toEqual([['20 minute walk', { kind: 'days', days: [0, 1, 2, 3, 4] }]]);
    expect(S.state.dismissed['habit:walk']).toBeGreaterThan(0);
    expect($('#sheet')!.hidden).toBe(true);
    expect(text('#toast')).toBe('Added to Habits.');
    expect(text('#habitsPanel')).not.toContain('walked');
  });

  it('adds the quest to a goal they pick', async () => {
    const goal = { id: 'g1', title: 'Feel better', category: 'health', why: '', by: '', created: '2026-10-01', updated: 1, status: 'active', quests: [{ id: 'q1', title: 'Stretch', schedule: { kind: 'daily' }, created: '2026-10-01' }], measures: [], milestones: [] };
    const { S } = await boot({ data: { logs: LOGS, goals: [goal] }, events: STEPS });
    await until(() => !!$('[data-act="habit-quest"]'));
    $('[data-act="habit-quest"]')!.click();
    document.querySelector<HTMLInputElement>('input[name="habitGoal"][value="g1"]')!.click();
    $('[data-act="habit-add"]')!.click();
    expect(S.goalById('g1')!.quests.map((q) => q.title)).toEqual(['Stretch', '20 minute walk']);
    expect(S.state.goals.some((x) => x.title === 'Habits')).toBe(false);
    expect(text('#toast')).toBe('Added to Feel better.');
  });

  it('"Not for me" puts it away for good, kept in the synced state', async () => {
    const { S } = await boot({ data: { logs: LOGS }, events: STEPS });
    await until(() => !!$('[data-act="habit-off"]'));
    $('[data-act="habit-off"]')!.click();
    expect(S.state.dismissed['habit:walk']).toBeGreaterThan(0);
    expect(JSON.parse(localStorage.getItem('pit-data-v1')!).dismissed['habit:walk']).toBeGreaterThan(0);
    expect(text('#habitsPanel')).not.toContain('walked');
    expect(S.state.goals).toHaveLength(0);
  });

  it('the coach reads it, as far as its AI may', async () => {
    const { AI } = await boot({ data: { logs: LOGS }, events: STEPS });
    await until(() => !!$('[data-act="habit-quest"]'));
    const HB = await import('./life/habits');
    expect(HB.contextFor(3).text).toContain('On days you walked 6,000 steps or more');
    expect(HB.contextFor(2).text).toContain('walked'); // steps are everyday activity (tier 2)
    expect(HB.contextFor(1).text).not.toContain('walked');
    const ctx = AI.buildContext();
    expect(ctx).toContain("## What came with the Player's good days");
  });
});
