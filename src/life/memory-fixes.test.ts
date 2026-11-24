// @vitest-environment jsdom
// "This isn't right, teach it": the Player's words take the place of a fact, or it goes, and the
// AI never learns the old words again, even after the memory is made again from the log. Also the
// snapshots of what Arise knew, for Look back.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { LifeEvent } from './types';

type Ask = { instructions: string; prompt: string };
const ai = vi.hoisted(() => ({ ask: null as unknown as Mock<(o: Ask) => Promise<unknown>> }));
vi.mock('../ai.js', () => ({
  engine: () => 'private',
  isPrivate: () => true,
  ready: () => true,
  askMemory: async (o: Ask) => ({ by: 'private:gpt-oss-120b', ...((await ai.ask(o)) as object) }),
  useMemory: vi.fn(),
  memoryStrength: () => 'strong',
  trustedModel: () => false,
}));

async function load() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  const L = await import('./log');
  const M = await import('./memory');
  const FS = await import('./fix-store');
  const LB = await import('./lookback');
  return { L, M, FS, LB };
}

const T = (k: string, h = 12) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h).getTime();
};
const walk = (k: string): LifeEvent => ({ id: `manual:${k}`, source: 'manual', kind: 'note', at: T(k, 9), title: `Walked Rex in the park on ${k}`, tier: 2 });
const answer = (facts: object[] = []) => ({ json: { summary: 'You walked a dog.', facts, confirm: [] } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 20, 10));
  localStorage.clear();
  ai.ask = vi.fn(async () => answer());
});
afterEach(() => vi.useRealTimers());

describe('teaching Arise', () => {
  it("puts the Player's words in place of a fact, and the AI never learns the old words again, even after the memory is made again", async () => {
    const { L, M, FS } = await load();
    await L.addEvents([walk('2026-10-14'), walk('2026-10-15'), walk('2026-10-16')]);
    ai.ask = vi.fn(async () => answer([{ op: 'add', id: '', text: 'You have a dog called Rex.' }]));
    await M.learn({ days: ['2026-10-16'] });
    const learned = M.allFacts().find((f) => f.text === 'You have a dog called Rex.')!;
    expect(learned.from).toBe('ai');

    expect(await M.teachFact(learned.id, "Rex is my sister's dog. I walk him on weekdays.")).toBe('replaced');
    expect(M.allFacts().map((f) => [f.text, f.from])).toEqual([["Rex is my sister's dog. I walk him on weekdays.", 'you']]);
    expect(await FS.readFixes()).toEqual([expect.objectContaining({ id: `fact:${learned.id}`, wrong: 'You have a dog called Rex.', right: "Rex is my sister's dog. I walk him on weekdays." })]);

    // The memory is made again from the log ("Forget what Arise learned"); the AI says the old thing in other words.
    await M.eraseMemory();
    expect(M.allFacts()).toEqual([]);
    ai.ask = vi.fn(async () => answer([{ op: 'add', id: '', text: 'You have a dog named Rex.' }, { op: 'add', id: '', text: 'You walk in the park.' }]));
    await M.learn({ days: ['2026-10-15'] });
    expect(M.allFacts().map((f) => f.text)).toEqual(['You walk in the park.']);
    // And it was told, as far as it may read it.
    expect(ai.ask.mock.calls[0][0].prompt).toContain('The Player said these are not right');
    expect(ai.ask.mock.calls[0][0].prompt).toContain("- You have a dog called Rex. (what's true: Rex is my sister's dog. I walk him on weekdays.)");
  });

  it("takes a fact away when it just isn't true, and it isn't learned again or changed into it", async () => {
    const { L, M } = await load();
    await L.addEvents([walk('2026-10-15'), walk('2026-10-16')]);
    ai.ask = vi.fn(async () => answer([{ op: 'add', id: '', text: 'You run every morning.' }, { op: 'add', id: '', text: 'You like parks.' }]));
    await M.learn({ days: ['2026-10-16'] });
    const run = M.allFacts().find((f) => f.text === 'You run every morning.')!;
    expect(await M.teachFact(run.id, '   ')).toBe('removed');
    expect(M.allFacts().map((f) => f.text)).toEqual(['You like parks.']);
    const parks = M.allFacts()[0];
    ai.ask = vi.fn(async (o: Ask) => {
      const id = /F(\d+): You like parks\./.exec(o.prompt)?.[1];
      return answer([
        { op: 'add', id: '', text: 'You go running every morning.' },
        { op: 'update', id: `F${id}`, text: 'You run in the mornings.' },
      ]);
    });
    await M.learn({ days: ['2026-10-15'] });
    expect(M.allFacts().map((f) => f.text)).toEqual(['You like parks.']);
    expect(M.allFacts()[0].id).toBe(parks.id);
  });
});

describe('what Arise knew, day by day', () => {
  it('keeps a snapshot when the facts change, and says when it started for days before', async () => {
    const { M, FS, LB } = await load();
    expect(await M.noteKnew()).toBe(false); // nothing known yet
    await M.addFact('You live in Leeds.');
    expect(await M.noteKnew()).toBe(true);
    expect(await M.noteKnew()).toBe(false); // the same as the last one
    const list = await FS.readKnew();
    expect(list.map((k) => [k.day, k.facts.map((f) => f.text)])).toEqual([['2026-10-20', ['You live in Leeds.']]]);

    // A month later, after more was learned.
    vi.setSystemTime(new Date(2026, 10, 25, 10));
    await M.addFact('You swim on Tuesdays.');
    const leeds = M.allFacts().find((f) => f.text === 'You live in Leeds.')!;
    await M.editFact(leeds.id, 'You live in York.');
    await M.noteKnew();
    const later = await FS.readKnew();
    const then = LB.knewThen(later, 'month', '2026-10', M.knewNow());
    expect(then.knew?.day).toBe('2026-10-20');
    expect(then.changes).toEqual({ added: ['You swim on Tuesdays.'], changed: [{ was: 'You live in Leeds.', now: 'You live in York.' }], dropped: [] });
    const before = LB.knewThen(later, 'year', '2025', M.knewNow());
    expect(before).toEqual({ knew: null, first: '2026-10-20', changes: null });
  });
});
