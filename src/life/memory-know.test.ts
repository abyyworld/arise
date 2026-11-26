// @vitest-environment jsdom
// The flags on facts and the notes in the parts of life, with the memory (memory.ts): "Never send
// to an AI" keeps a fact out of what the memory's AI reads and out of the coach's profile, facts
// learned from imports wait to be confirmed, checks come due, duplicates merge, a fact that
// disagrees goes for good, and all of it goes to the Player's other devices.

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

async function load(fresh = true) {
  vi.resetModules();
  if (fresh) globalThis.indexedDB = new IDBFactory();
  const L = await import('./log');
  const M = await import('./memory');
  const P = await import('./policy');
  const FS = await import('./fix-store');
  const KS = await import('./know-store');
  const LOCAL = await import('./local');
  const PK = await import('./packs');
  const AN = await import('./area-notes');
  return { L, M, P, FS, KS, LOCAL, PK, AN };
}

const T = (k: string, h = 12) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h).getTime();
};
const walk = (k: string): LifeEvent => ({ id: `manual:${k}`, source: 'manual', kind: 'note', at: T(k, 9), title: `Walked Rex in the park on ${k}`, tier: 2 });
const chat = (k: string, i: number): LifeEvent => ({ id: `whatsapp:${k}:${i}`, source: 'whatsapp', kind: 'message', at: T(k, 9 + i), title: `Chatted with Sam: ${i + 3} messages`, tier: 3 });
const answer = (facts: object[] = []) => ({ json: { summary: 'You walked a dog.', facts, confirm: [] } });
const ENGINES = ['private', 'device', 'local', 'free', 'own', 'tab'] as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 20, 10));
  localStorage.clear();
  ai.ask = vi.fn(async () => answer());
});
afterEach(() => vi.useRealTimers());

describe('never send to an AI', () => {
  it('keeps the fact out of the profile for every AI, whatever the settings, and out of what the memory reads', async () => {
    const { L, M, P } = await load();
    P.setPrefs({ lessPrivate: true }); // every AI may read every tier
    const asthma = (await M.addFact('You have asthma.'))!;
    await M.addFact('You walk Rex every morning.');
    for (const e of ENGINES) expect(M.profileText(e)).toContain('You have asthma.');
    await M.flagFact(asthma.id, { noAI: true });
    expect(M.isHeld(asthma.id)).toBe(true);
    for (const e of ENGINES) {
      expect(M.profileText(e)).not.toContain('asthma');
      expect(M.profileText(e, true)).not.toContain('asthma');
      expect(M.profileText(e)).toContain('You walk Rex every morning.');
    }
    expect(M.buildProfile(M.allFacts(), { cap: 3, chars: 1500 }).join('\n')).not.toContain('asthma');
    expect(M.forAI(M.allFacts()).map((f) => f.text)).toEqual(['You walk Rex every morning.']);

    // The memory's AI never sees it, can't change it, and doesn't learn it again in other words.
    await L.addEvents([walk('2026-10-16')]);
    ai.ask = vi.fn(async (o: Ask) => {
      expect(o.prompt).not.toContain('asthma');
      return answer([
        { op: 'add', id: '', text: 'You suffer from asthma.' }, // the same, in other words
        { op: 'retire', id: asthma.id, text: '' },
        { op: 'update', id: asthma.id, text: 'You had asthma as a child.' },
      ]);
    });
    await M.learn({ days: ['2026-10-16'] });
    expect(ai.ask).toHaveBeenCalled(); // (the day, then its week and month: none of them saw it)
    expect(ai.ask.mock.calls[0][0].prompt).toContain('You walk Rex every morning.');
    expect(M.allFacts().map((f) => [f.text, f.until || ''])).toEqual([
      ['You have asthma.', ''],
      ['You walk Rex every morning.', ''],
    ]);

    // Let AIs read it again: back in the profile.
    await M.flagFact(asthma.id, { noAI: false });
    expect(M.profileText('private')).toContain('You have asthma.');
  });

  it("doesn't tell the memory's AI what's true when that fact is held back", async () => {
    const { L, M } = await load();
    await L.addEvents([walk('2026-10-15'), walk('2026-10-16')]);
    ai.ask = vi.fn(async () => answer([{ op: 'add', id: '', text: 'You have a dog called Rex.' }]));
    await M.learn({ days: ['2026-10-16'] });
    const rex = M.allFacts()[0];
    await M.teachFact(rex.id, 'Rex is my sister’s dog. Her address is 4 Elm Street.');
    await M.flagFact(rex.id, { noAI: true });
    ai.ask = vi.fn(async () => answer());
    await M.learn({ days: ['2026-10-15'] });
    const prompt = ai.ask.mock.calls[0][0].prompt;
    expect(prompt).toContain('- You have a dog called Rex.'); // the old words, never to be learned again
    expect(prompt).not.toContain('Elm Street');
  });
});

describe('imported, not confirmed', () => {
  it('marks what is learned from a day that came mostly from imports, until they say it is right', async () => {
    const { L, M } = await load();
    await L.addEvents([chat('2026-10-16', 0), chat('2026-10-16', 1), walk('2026-10-16'), walk('2026-10-15')]);
    ai.ask = vi.fn(async () => answer([{ op: 'add', id: '', text: 'You talk to Sam most days.' }]));
    await M.learn({ days: ['2026-10-16'] });
    const sam = M.allFacts().find((f) => f.text === 'You talk to Sam most days.')!;
    expect(sam.imp).toBe(true);
    expect(M.isUnconfirmed(sam)).toBe(true);
    expect(M.profileText('private')).toContain('- You talk to Sam most days. (from an import, not confirmed by them)');
    await M.confirmFact(sam.id);
    expect(M.isUnconfirmed(sam)).toBe(false);
    expect(M.profileText('private')).toContain('- You talk to Sam most days.');
    expect(M.profileText('private')).not.toContain('not confirmed');
    // A day from their own notes: nothing to confirm.
    ai.ask = vi.fn(async () => answer([{ op: 'add', id: '', text: 'You walk in the park.' }]));
    await M.learn({ days: ['2026-10-15'] });
    expect(M.allFacts().find((f) => f.text === 'You walk in the park.')?.imp).toBeUndefined();
  });
});

describe('check again on a day', () => {
  it('comes due on its day; "Still true" confirms it, "Not any more" keeps it as no longer true', async () => {
    const { M } = await load();
    const a = (await M.addFact('You live in Leeds.'))!;
    const b = (await M.addFact('You work at Acme.'))!;
    await M.flagFact(a.id, { check: '2026-11-01' });
    await M.flagFact(b.id, { check: '2026-11-01' });
    expect(M.checksDue('2026-10-31')).toEqual([]);
    // (The same day: in the order of their ids.)
    expect(M.checksDue('2026-11-01').map((c) => c.text)).toEqual([a, b].sort((x, y) => (x.id < y.id ? -1 : 1)).map((f) => f.text));
    await M.confirmFact(a.id);
    expect(M.flagOf(a.id)).toMatchObject({ ok: true });
    expect(M.flagOf(a.id)).not.toHaveProperty('check');
    await M.retireFact(b.id);
    expect(M.allFacts().find((f) => f.id === b.id)?.until).toBe('2026-10-20');
    expect(M.checksDue('2026-11-01')).toEqual([]);
  });
});

describe('duplicates and facts that disagree', () => {
  it('merges two that say the same, keeping the more careful flag', async () => {
    const { M } = await load();
    const a = (await M.addFact('You run every Sunday morning.'))!;
    const b = (await M.addFact('You go running on Sunday mornings.'))!;
    await M.flagFact(b.id, { noAI: true });
    expect(M.factPairs().dupes.map((p) => [p.a.id, p.b.id].sort())).toEqual([[a.id, b.id].sort()]);
    await M.mergeFacts(a.id, b.id);
    expect(M.allFacts().map((f) => f.text)).toEqual(['You run every Sunday morning.']);
    expect(M.isHeld(a.id)).toBe(true);
    expect(M.factPairs()).toEqual({ dupes: [], clashes: [] });
  });

  it('asks which is right: the other goes and is never learned again; or both stay and it never asks again', async () => {
    const { L, M, FS } = await load();
    const a = (await M.addFact('You drink coffee.'))!;
    const b = (await M.addFact("You don't drink coffee."))!;
    expect(M.factPairs().clashes).toHaveLength(1);
    await M.pickRight(b.id, a.id);
    expect(M.allFacts().map((f) => f.text)).toEqual(["You don't drink coffee."]);
    expect(M.flagOf(b.id)).toMatchObject({ ok: true });
    expect((await FS.readFixes()).map((f) => [f.id, f.wrong])).toEqual([[`fact:${a.id}`, 'You drink coffee.']]);
    await L.addEvents([walk('2026-10-16')]);
    ai.ask = vi.fn(async () => answer([{ op: 'add', id: '', text: 'You drink coffee every day.' }]));
    await M.learn({ days: ['2026-10-16'] });
    expect(M.allFacts().map((f) => f.text)).toEqual(["You don't drink coffee."]);

    const x = (await M.addFact('You live in Leeds.'))!;
    const y = (await M.addFact('You live in York.'))!;
    expect(M.factPairs().clashes).toHaveLength(1);
    await M.keepApart(x.id, y.id);
    expect(M.factPairs().clashes).toEqual([]);
    expect(M.allFacts()).toHaveLength(3);
  });
});

describe('notes in the parts of life, for the coach', () => {
  it('gives key notes first, only to an AI that may read notes, and keeps them when the memory is wiped', async () => {
    const { M, P, AN } = await load();
    const branch = AN.makeNote({ areas: ['work'], title: 'Drone EduTrain', branch: true }, '2026-10-01', 1000)!;
    await M.putAreaNotes([branch, AN.makeNote({ areas: ['fun'], title: 'Guitar' }, '2026-10-19', 1001)!, AN.makeNote({ areas: ['work'], title: 'Launch in March', key: true, parent: branch.id }, '2026-09-01', 1002)!]);
    const text = M.profileText('private');
    expect(text).toContain('## Their life areas');
    expect(text.indexOf('[key] Work or study > Drone EduTrain: Launch in March')).toBeLessThan(text.indexOf('Fun and rest: Guitar'));
    expect(M.profileTier('private')).toBe(2);
    expect(M.profileText('free')).toBe(''); // the free AI reads tier 1 only
    P.setPrefs({ lessPrivate: true });
    expect(M.profileText('free')).toContain('Guitar');
    await M.eraseMemory();
    await M.reload();
    expect(M.areaNotes()).toHaveLength(3);
  });
});

describe('two devices', () => {
  it('sends the flags, the imported mark and the notes to another device, and each part of the flags comes together', async () => {
    // The first device.
    let d = await load();
    await d.L.addEvents([chat('2026-10-16', 0), chat('2026-10-16', 1)]);
    ai.ask = vi.fn(async () => answer([{ op: 'add', id: '', text: 'You talk to Sam most days.' }]));
    await d.M.learn({ days: ['2026-10-16'] });
    const sam = d.M.allFacts()[0];
    const mine = (await d.M.addFact('You have asthma.'))!;
    await d.M.flagFact(mine.id, { noAI: true });
    const note = d.AN.makeNote({ areas: ['work', 'money'], title: 'Pay rise', labels: ['pay'], key: true }, '2026-10-20', Date.now())!;
    await d.M.putAreaNotes([note]);
    const pack = await d.LOCAL.buildPack(d.PK.MEM);
    expect(pack.flags.map((f) => f.id)).toEqual([mine.id]);
    expect(pack.notes.map((n) => n.title)).toEqual(['Pay rise']);

    // The second device: it had set a check on the same fact (from an earlier sync) a bit later.
    vi.setSystemTime(new Date(2026, 9, 20, 11));
    d = await load();
    await d.KS.saveFlags([{ id: mine.id, patch: { check: '2027-01-01' } }]);
    await d.LOCAL.applyPack(d.PK.MEM, pack);
    await d.M.reload();
    expect(d.M.allFacts().map((f) => f.text).sort()).toEqual(['You have asthma.', 'You talk to Sam most days.']);
    expect(d.M.flagOf(mine.id)).toMatchObject({ noAI: true, check: '2027-01-01' });
    expect(d.M.profileText('private')).not.toContain('asthma');
    expect(d.M.isUnconfirmed(d.M.allFacts().find((f) => f.id === sam.id)!)).toBe(true);
    expect(d.M.areaNotes().map((n) => [n.title, n.areas, n.key])).toEqual([['Pay rise', ['work', 'money'], true]]);

    // Deleted there: gone here when it comes back.
    await d.M.putAreaNotes([d.AN.tombstone(note.id, Date.now())]);
    const back = await d.LOCAL.buildPack(d.PK.MEM);
    expect(back.notes).toEqual([expect.objectContaining({ id: note.id, gone: true })]);
    expect(d.AN.live(d.M.areaNotes())).toEqual([]);
  });
});
