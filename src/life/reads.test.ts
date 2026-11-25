// @vitest-environment jsdom
// The queue at work (reads.ts), on a life log on the device: the order it reads in, the daily
// count, trying again, stopping when there's no AI, what's never sent to which AI, the person's own
// words, deletions, and search finding a note by what was written about it.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';
import type { Engine } from './policy';

const ai = vi.hoisted(() => ({ engine: null as string | null }));
vi.mock('../ai.js', () => ({
  engine: () => ai.engine,
  isPrivate: () => ai.engine !== 'free' && ai.engine !== 'own',
  askRead: async () => {
    throw new Error('Tests pass their own AI.');
  },
}));

import * as L from './log';
import * as R from './reads';
import * as C from './reads-core';
import { closeDB } from './db';
import { buildPack } from './local';
import { readPack } from './packs';
import { setPrefs as setLifePrefs } from './prefs';

const T = (s: string) => new Date(s).getTime();
const NOW = T('2026-11-25T10:00');
const words = (n: number) => `We walked by the river and talked about the garden, ${n} times over the spring.`;
const note = (id: string, when: string, detail = words(1), extra: Partial<LifeEvent> = {}): LifeEvent => ({ id: `manual:${id}`, source: 'manual', kind: 'note', at: T(when), title: `Note ${id}`, detail, tier: 2, ...extra });

interface Asked {
  id: string;
  engine: Engine;
  prompt: string;
}

// A pretend AI and clock, for run().
function deps(o: { engine?: Engine | null; fail?: (id: string) => Error | null; now?: () => number; lessPrivate?: boolean } = {}) {
  const asked: Asked[] = [];
  let clock = NOW;
  const d: R.RunDeps & { asked: Asked[]; tick(ms: number): void } = {
    asked,
    tick(ms) {
      clock += ms;
    },
    engine: () => (o.engine === undefined ? 'private' : o.engine),
    now: o.now ?? (() => clock),
    lessPrivateOk: () => !!o.lessPrivate,
    candidate: R.candidate,
    ask: async ({ prompt, engine }) => {
      const id = /Note (\w+)/.exec(prompt)?.[1] || '?';
      asked.push({ id, engine, prompt });
      const err = o.fail?.(id);
      if (err) throw err;
      return { json: { description: `About note ${id}`, refined: 'We walked by the river.', tags: ['walks', `n${id}`] }, by: 'private:gpt-oss-120b' };
    },
  };
  return d;
}

const ids = (list: { id: string }[]) => list.map((x) => x.id);

beforeEach(async () => {
  closeDB();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  R._test.reset();
  ai.engine = 'private';
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

async function turnOn(perDay = 20, extra = {}) {
  await R.setPrefs({ on: true, perDay, ...extra });
}

describe('the queue', () => {
  it('is off until it is turned on, and then starts with the last few weeks', async () => {
    await L.addEvents([note('a', '2026-11-20T09:00'), note('old', '2026-09-01T09:00')]);
    const d = deps();
    expect(await R.run(d)).toBe(0);
    expect(C.status.state).toBe('off');
    await turnOn();
    expect(ids(R.queue().jobs)).toEqual(['e:manual:a']);
  });

  it('reads the newest first, at most so many a day, and starts again the next day', async () => {
    await turnOn(5);
    await L.addEvents([note('a', '2026-11-20T09:00')]);
    for (const [i, id] of ['b', 'c', 'd', 'e', 'f', 'g'].entries()) {
      vi.setSystemTime(NOW + i * 1000); // each noticed a little later
      await L.addEvents([note(id, '2026-11-21T09:00')]);
      await R.noticeDays(['2026-11-21']);
    }
    vi.setSystemTime(NOW + 10_000);
    await R.noticeDays(['2026-11-20']);
    const d = deps();
    expect(await R.run(d)).toBe(5);
    // The one noticed last first, then the newest noticed.
    expect(d.asked.map((a) => a.id)).toEqual(['a', 'g', 'f', 'e', 'd']);
    expect(R.queue().done).toBe(5);
    expect(R.queue().jobs).toHaveLength(2);
    expect(C.status.state).toBe('cap');
    expect(C.statusText()).toMatch(/^Done for today: 5 of 5\. 2 notes wait for tomorrow\./);
    // More today: nothing.
    expect(await R.run(d)).toBe(0);
    // The next day.
    d.tick(864e5);
    expect(await R.run(d)).toBe(2);
    expect(R.queue().jobs).toEqual([]);
    expect(C.statusText()).toBe('Done.');
    expect(R.readOf('e:manual:a')).toMatchObject({ desc: 'About note a', tidy: 'We walked by the river.', tags: ['walks', 'na'], from: 'ai', tier: 2, source: 'manual', by: 'private:gpt-oss-120b' });
  });

  it('tries again later when the AI fails, and gives up after a few tries', async () => {
    await turnOn();
    await L.addEvents([note('a', '2026-11-20T09:00')]);
    await R.noticeDays(['2026-11-20']);
    const d = deps({ fail: () => Object.assign(new Error('The private AI is busy.'), { code: 'server' }) });
    expect(await R.run(d)).toBe(0);
    expect(R.queue().jobs[0]).toMatchObject({ n: 1, next: NOW + C.BACKOFF[0] });
    // Too soon: not asked again.
    expect(await R.run(d)).toBe(0);
    expect(d.asked).toHaveLength(1);
    for (let i = 1; i < C.TRIES; i++) {
      d.tick(C.BACKOFF[i - 1]);
      await R.run(d);
    }
    expect(d.asked).toHaveLength(C.TRIES);
    expect(R.queue().jobs[0]).toMatchObject({ failed: true, n: C.TRIES });
    d.tick(864e5 * 3);
    await R.run(d);
    expect(d.asked).toHaveLength(C.TRIES);
    // "Describe again" puts it back.
    R.describeAgain('e:manual:a');
    const ok = deps({ now: () => NOW + 864e5 * 5 });
    expect(await R.run(ok)).toBe(1);
  });

  it("counts an answer it can't use against the record, and goes on with the next", async () => {
    await turnOn();
    await L.addEvents([note('a', '2026-11-20T09:00'), note('b', '2026-11-20T10:00')]);
    await R.noticeDays(['2026-11-20']);
    const d = deps();
    const real = d.ask;
    d.ask = async (o) => (o.prompt.includes('Note a') ? { json: { nope: true }, by: '' } : real(o));
    expect(await R.run(d)).toBe(1);
    expect(R.readOf('e:manual:b')).not.toBeNull();
    expect(R.queue().jobs).toEqual([expect.objectContaining({ id: 'e:manual:a', n: 1 })]);
  });

  it('stops when there is no AI, and asks nothing', async () => {
    await turnOn();
    await L.addEvents([note('a', '2026-11-20T09:00')]);
    await R.noticeDays(['2026-11-20']);
    ai.engine = null;
    const d = deps({ engine: null });
    expect(await R.run(d)).toBe(0);
    expect(d.asked).toEqual([]);
    expect(C.status.state).toBe('no-ai');
    // The private AI on the free plan: background work waits for Arise Private.
    ai.engine = 'private';
    expect(await R.run(d)).toBe(0);
    expect(C.status.state).toBe('plan');
    expect(C.statusText()).toMatch(/^Waiting for the private AI\./);
    // The AI changed while it was asking: nothing counted against the day or the record.
    const changed = deps({ fail: () => Object.assign(new Error('changed'), { code: 'changed' }) });
    expect(await R.run(changed)).toBe(0);
    expect(R.queue().done).toBe(0);
    expect(R.queue().jobs[0]).toMatchObject({ n: 0 });
  });
});

describe('what is never sent', () => {
  it('sends nothing to a less private AI unless the life log is allowed for it', async () => {
    await turnOn();
    await L.addEvents([note('a', '2026-11-20T09:00'), note('b', '2026-11-20T10:00', words(2), { source: 'other', id: 'other:note:b', tier: 3, meta: { app: 'Obsidian' } })]);
    await R.noticeDays(['2026-11-20']);
    for (const engine of ['free', 'own'] as const) {
      const d = deps({ engine });
      expect(await R.run(d)).toBe(0);
      expect(d.asked).toEqual([]);
    }
    expect(R.queue().jobs).toHaveLength(2);
    setLifePrefs({ lessPrivate: true });
    const d = deps({ engine: 'free', lessPrivate: true });
    expect(await R.run(d)).toBe(2);
  });

  it('holds back health, money and ID notes until the person allows them', async () => {
    await turnOn();
    await L.addEvents([note('h', '2026-11-20T09:00', 'Saw the doctor about my blood pressure and the new medication plan.'), note('p', '2026-11-20T10:00')]);
    await R.noticeDays(['2026-11-20']);
    const d = deps();
    expect(await R.run(d)).toBe(1);
    expect(d.asked.map((a) => a.id)).toEqual(['p']);
    expect(R.queue().jobs.map((j) => j.id)).toEqual(['e:manual:h']);
    await R.setPrefs({ health: true });
    expect(await R.run(d)).toBe(1);
    expect(d.asked.map((a) => a.id)).toEqual(['p', 'h']);
  });

  it("sends only the note's own words, cut for the AI on the device", async () => {
    await turnOn();
    await L.addEvents([note('a', '2026-11-20T09:00', `${words(3)} `.repeat(200))]);
    await R.noticeDays(['2026-11-20']);
    const d = deps({ engine: 'device' });
    await R.run(d);
    expect(d.asked[0].engine).toBe('device');
    expect(d.asked[0].prompt.length).toBeLessThan(C.INPUT.device + 1200);
  });
});

describe('what was written', () => {
  it("keeps the person's own words, which no AI writes over unless they ask", async () => {
    await turnOn();
    await L.addEvents([note('a', '2026-11-20T09:00')]);
    await R.noticeDays(['2026-11-20']);
    await R.run(deps());
    const mine = await R.fixRead('e:manual:a', { desc: 'Our walk', tags: ['Sam', 'river'] });
    expect(mine).toMatchObject({ desc: 'Our walk', tags: ['sam', 'river'], from: 'you', tidy: 'We walked by the river.' });
    // The note changes: the queue notices, but leaves their words.
    await L.upsertEvents([note('a', '2026-11-20T09:00', words(9))]);
    expect(await R.noticeDays(['2026-11-20'])).toBe(0);
    // "Describe again" writes over it, because they asked.
    R.describeAgain('e:manual:a');
    expect(await R.run(deps())).toBe(1);
    expect(R.readOf('e:manual:a')).toMatchObject({ desc: 'About note a', from: 'ai' });
  });

  it('is found by search, by its description and tags', async () => {
    await turnOn();
    await L.addEvents([note('a', '2026-11-20T09:00'), { id: 'spotify:1', source: 'spotify', kind: 'listen', at: T('2026-11-20T11:00'), title: 'Listened to a song', tier: 2 }]);
    await R.noticeDays(['2026-11-20']);
    await R.run(deps());
    expect(ids(await L.search('na'))).toEqual(['manual:a']);
    expect(ids(await L.search('walks river'))).toEqual(['manual:a']);
    expect(ids(await L.search('walks song', { any: true })).sort()).toEqual(['manual:a', 'spotify:1']);
    expect(await L.search('walks song')).toEqual([]);
  });

  it('goes with its note on every device, and syncs in its own pack', async () => {
    await turnOn();
    await L.addEvents([note('a', '2026-11-20T09:00')]);
    await R.noticeDays(['2026-11-20']);
    await R.run(deps());
    const k = readPack('e:manual:a');
    expect((await buildPack(k, NOW + 1000)).reads.map((x) => x.desc)).toEqual(['About note a']);
    await L.removeIds(['manual:a']);
    await R._test.forgetDeleted(['2026-11-20']);
    expect(R.readOf('e:manual:a')).toBeNull();
    const pack = await buildPack(k, Date.now() + 1000);
    expect(pack.reads).toEqual([]);
    expect(Object.keys(pack.tombs)).toEqual(['e:manual:a']);
  });
});
