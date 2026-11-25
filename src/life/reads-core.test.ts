// @vitest-environment jsdom
// "Arise reads it for you" without the database or the AI (reads-core.ts): what is never sent to
// which AI, the question and how its answer is checked, the queue's order, its daily count and
// its retries, and how its packs sync (packs.ts).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as C from './reads-core';
import { canonical, cleanContent, emptyContent, isPackKey, mergeContent, readPack, type Content } from './packs';
import { cleanLifeRead, cleanReadPrefs, cleanReadQueue, type LifeRead, type ReadQueue } from '../lib/validate';
import type { Engine } from './policy';

const ENGINES: Engine[] = ['private', 'device', 'local', 'free', 'own'];
const allow = { health: false, money: false, id: false };
const note = (text: string, tier: 1 | 2 | 3 = 2) => ({ tier, title: 'A note', text });
const PLAIN = 'We walked by the river and talked about the garden for the spring.';

describe('the gate: which AI may read a record', () => {
  it('sends a note only to the private AI, the AI on the device or your own computer by default', () => {
    for (const tier of [2, 3] as const) {
      const out = Object.fromEntries(ENGINES.map((e) => [e, C.gate(note(PLAIN, tier), e, { lessPrivateOk: false, allow })]));
      expect(out).toEqual({ private: null, device: null, local: null, free: 'less-private', own: 'less-private' });
    }
  });

  it('sends nothing at all without an AI', () => {
    expect(C.gate(note(PLAIN), null, { lessPrivateOk: true, allow })).toBe('no-ai');
    expect(C.gate(note(PLAIN), undefined, { lessPrivateOk: true, allow })).toBe('no-ai');
  });

  it('lets a less private AI read only once the life log is allowed for it', () => {
    for (const e of ['free', 'own'] as const) {
      expect(C.gate(note(PLAIN, 3), e, { lessPrivateOk: false, allow })).toBe('less-private');
      expect(C.gate(note(PLAIN, 3), e, { lessPrivateOk: true, allow })).toBeNull();
    }
  });

  it('holds back health, money and ID-looking records unless the person allows them', () => {
    const health = note('Saw the doctor today, new medication for my blood pressure, twice a day.');
    const money = note('Paid the mortgage and moved some money between bank accounts this morning.');
    const id = note('My passport number and the ID card are in the blue folder in the drawer.');
    for (const e of ['private', 'device', 'local'] as const) {
      expect(C.gate(health, e, { lessPrivateOk: false, allow })).toBe('health');
      expect(C.gate(money, e, { lessPrivateOk: false, allow })).toBe('money');
      expect(C.gate(id, e, { lessPrivateOk: false, allow })).toBe('id');
      expect(C.gate(health, e, { lessPrivateOk: false, allow: { ...allow, health: true } })).toBeNull();
      expect(C.gate(money, e, { lessPrivateOk: false, allow: { ...allow, money: true } })).toBeNull();
      expect(C.gate(id, e, { lessPrivateOk: false, allow: { ...allow, id: true } })).toBeNull();
    }
  });

  it('never sends ID papers to a less private AI, whatever the switches say', () => {
    const all = { health: true, money: true, id: true };
    for (const e of ['free', 'own'] as const) {
      expect(C.gate(note('Passport number 123456789 and my date of birth for the form.'), e, { lessPrivateOk: true, allow: all })).toBe('id');
      expect(C.gate(note('My card is 4111 1111 1111 1111 for the trip booking next week.'), e, { lessPrivateOk: true, allow: all })).toBe('id');
      expect(C.gate(note(PLAIN), e, { lessPrivateOk: true, allow: all })).toBeNull();
    }
  });

  it('finds what looks like health, money or ID papers', () => {
    expect(C.sensitive(PLAIN)).toEqual([]);
    expect(C.sensitive('Therapy at 5, felt anxious after')).toContain('health');
    expect(C.sensitive('Invoice for £40 sent')).toContain('money');
    expect(C.sensitive('IBAN GB33 BUKB 2020 1555 5555 55')).toContain('money');
    expect(C.sensitive('SSN 123-45-6789')).toContain('id');
  });
});

describe('the question and its answer', () => {
  it('asks with only the record, cut for the AI on the device', () => {
    const long = 'word '.repeat(2000);
    const p = C.readPrompt({ kind: 'note', title: 'Trip', text: long }, 'device');
    expect(p).toContain('The note, "Trip"');
    expect(p).toContain('(The rest is left out.)');
    expect(p.length).toBeLessThan(C.INPUT.device + 1200);
    expect(C.readPrompt({ kind: 'note', title: 'Trip', text: long }, 'private')).not.toContain('(The rest is left out.)');
    expect(p).toContain('Never add a fact');
    expect(p).not.toMatch(/[\u2014]/);
  });

  it('asks for exactly a description, the note refined and tags', () => {
    expect(C.READ_SCHEMA.required).toEqual(['description', 'refined', 'tags']);
    expect(C.READ_SCHEMA.additionalProperties).toBe(false);
  });

  it('keeps a good answer, tidy', () => {
    const out = C.parseRead({ description: '  A walk by the river \u2014 with Sam  ', refined: 'We walked by the river.', tags: ['#Walks', 'river', 'walks', 'Sam', 'spring', 'garden', 'extra'] }, PLAIN);
    expect(out).toEqual({ desc: 'A walk by the river, with Sam', tidy: 'We walked by the river.', tags: ['walks', 'river', 'sam', 'spring', 'garden'] });
  });

  it('turns down answers it can not use', () => {
    for (const bad of [null, 'text', [], { description: '', refined: 'x', tags: ['a'] }, { description: 'Fine', refined: 'x', tags: [] }, { description: 'Fine', refined: 'x' }]) expect(C.parseRead(bad, PLAIN)).toBeNull();
  });

  it('leaves out a refined note that adds to the original, and keeps the rest', () => {
    const added = C.parseRead({ description: 'A walk', refined: 'We walked 12 km by the river.', tags: ['walk'] }, PLAIN);
    expect(added).toEqual({ desc: 'A walk', tags: ['walk'] });
    const longer = C.parseRead({ description: 'A walk', refined: `${PLAIN} ${PLAIN} ${PLAIN}`, tags: ['walk'] }, PLAIN);
    expect(longer?.tidy).toBeUndefined();
    expect(C.keepsToOriginal('Paid 40, then 12.', 'paid 12 and 40')).toBe(true);
    expect(C.keepsToOriginal('Paid 41.', 'paid 40')).toBe(false);
  });
});

describe('the queue', () => {
  const q = (jobs: ReadQueue['jobs'], done = 0): ReadQueue => ({ jobs, day: '2026-11-25', done });

  it('reads what was asked for again first, then the newest noticed', () => {
    const list = C.ordered(
      [
        { id: 'e:manual:a', added: 100, n: 0, next: 0 },
        { id: 'e:manual:b', added: 300, n: 0, next: 0 },
        { id: 'e:manual:c', added: 200, n: 0, next: 0, again: true },
        { id: 'e:manual:d', added: 400, n: 1, next: 5000 }, // waiting to try again
        { id: 'e:manual:e', added: 500, n: 4, next: 0, failed: true },
      ],
      1000,
    );
    expect(list.map((j) => j.id)).toEqual(['e:manual:c', 'e:manual:b', 'e:manual:a']);
  });

  it('adds each record once', () => {
    let x = C.enqueue(q([]), ['e:manual:a', 'e:manual:b', 'e:manual:a'], 10);
    x = C.enqueue(x, ['e:manual:a'], 20);
    expect(x.jobs.map((j) => [j.id, j.added])).toEqual([
      ['e:manual:a', 10],
      ['e:manual:b', 10],
    ]);
    x = C.enqueue(x, ['e:manual:a'], 30, { again: true });
    expect(x.jobs.find((j) => j.id === 'e:manual:a')).toEqual({ id: 'e:manual:a', added: 30, n: 0, next: 0, again: true });
  });

  it('counts the day, and starts again the next day', () => {
    expect(C.left(q([], 18), 20)).toBe(2);
    expect(C.left(q([], 25), 20)).toBe(0);
    expect(C.today(q([], 20), '2026-11-25').done).toBe(20);
    expect(C.today(q([], 20), '2026-11-26')).toEqual({ jobs: [], day: '2026-11-26', done: 0 });
  });

  it('tries again later, longer each time, then waits for the person', () => {
    let x = q([{ id: 'f:AAAAAAAAAAAAAAAAAAAAAA', added: 1, n: 0, next: 0, again: true }]);
    const now = 1_000_000;
    for (let i = 0; i < C.TRIES - 1; i++) {
      x = C.failed(x, 'f:AAAAAAAAAAAAAAAAAAAAAA', now);
      expect(x.jobs[0]).toEqual({ id: 'f:AAAAAAAAAAAAAAAAAAAAAA', added: 1, n: i + 1, next: now + C.BACKOFF[i] });
    }
    x = C.failed(x, 'f:AAAAAAAAAAAAAAAAAAAAAA', now);
    expect(x.jobs[0]).toEqual({ id: 'f:AAAAAAAAAAAAAAAAAAAAAA', added: 1, n: C.TRIES, next: 0, failed: true });
    expect(C.ordered(x.jobs, now * 10)).toEqual([]);
  });

  it('says how it is going in plain words', () => {
    const s = (p: Partial<C.Status>): C.Status => ({ state: 'done', notes: 0, files: 0, held: 0, failed: 0, done: 0, perDay: 20, error: '', ...p });
    expect(C.statusText(s({ state: 'reading', notes: 3 }))).toBe('Arise is reading 3 notes.');
    expect(C.statusText(s({ state: 'reading', notes: 1, files: 2 }))).toBe('Arise is reading 1 note and 2 files.');
    expect(C.statusText(s({ state: 'waiting', notes: 2 }))).toMatch(/^Waiting for the private AI\./);
    expect(C.statusText(s({ state: 'plan', notes: 2 }))).toMatch(/^Waiting for the private AI\. On the free plan/);
    expect(C.statusText(s({ state: 'done' }))).toBe('Done.');
    expect(C.statusText(s({ state: 'cap', done: 20, notes: 4 }))).toBe('Done for today: 20 of 20. 4 notes wait for tomorrow.');
    expect(C.statusText(s({ state: 'done', held: 2 }))).toContain('2 held back');
    expect(C.statusText(s({ state: 'off' }))).toMatch(/^Off\./);
  });

  it('keeps its choices and queue only in a clean shape', () => {
    expect(cleanReadPrefs({ on: 'yes', perDay: 7 })).toEqual({ on: false, perDay: 20, health: false, money: false, id: false, since: 0 });
    expect(cleanReadPrefs({ on: true, perDay: 50, health: true }).perDay).toBe(50);
    const back = cleanReadQueue({ jobs: [{ id: 'e:manual:a', added: 1, n: 2, next: 3 }, { id: '<script>', added: 1 }, { id: 'e:manual:a' }], day: 'nope', done: -4 });
    expect(back).toEqual({ jobs: [{ id: 'e:manual:a', added: 1, n: 2, next: 3 }], day: '', done: 0 });
  });
});

describe('what was written, in the life log packs', () => {
  const read = (id: string, at: number, extra: Partial<LifeRead> = {}): LifeRead => cleanLifeRead({ id, at, tier: 2, desc: `About ${id} at ${at}`, tags: ['walk'], src: 'abc', from: 'ai', rat: 1_700_000_000_000, source: 'manual', ...extra })!;
  const pack = (c: Partial<Content>): Content => ({ ...emptyContent(), ...c });

  it('files each read in one of 16 packs, the same on every device', () => {
    const k = readPack('e:manual:a');
    expect(k).toMatch(/^r:[0-9a-f]$/);
    expect(readPack('e:manual:a')).toBe(k);
    expect(isPackKey(k)).toBe(true);
    expect(isPackKey('r:g')).toBe(false);
    const ids = Array.from({ length: 200 }, (_, i) => `e:manual:n${i}`);
    expect(new Set(ids.map(readPack)).size).toBe(16);
  });

  it("keeps only a pack's own reads, in a clean shape", () => {
    const k = readPack('e:manual:a');
    const other = ['e:manual:b', 'e:manual:c', 'e:manual:d', 'e:manual:e'].find((id) => readPack(id) !== k)!;
    const c = cleanContent(k, { reads: [read('e:manual:a', 5), read(other, 5), { id: 'e:manual:a', desc: '' }] });
    expect(c.reads.map((x) => x.id)).toEqual(['e:manual:a']);
    expect(cleanContent(k, JSON.parse(canonical(k, c))).reads).toEqual(c.reads);
  });

  it('keeps the newest, and the person’s own words over an AI’s', () => {
    const k = readPack('e:manual:a');
    const ai = read('e:manual:a', 900);
    const mine = read('e:manual:a', 500, { from: 'you', desc: 'My words' });
    const out = mergeContent(k, pack({ reads: [ai] }), pack({ reads: [mine] }), { now: 1000 });
    expect(out.reads.map((x) => x.desc)).toEqual(['My words']);
    expect(canonical(k, mergeContent(k, pack({ reads: [mine] }), pack({ reads: [ai] }), { now: 1000 }))).toBe(canonical(k, out));
    expect(mergeContent(k, pack({ reads: [read('e:manual:a', 100)] }), pack({ reads: [read('e:manual:a', 200)] }), { now: 1000 }).reads[0].at).toBe(200);
  });

  it('lets a deletion win over what is not newer, and a wipe take what it covers', () => {
    const k = readPack('e:manual:a');
    expect(mergeContent(k, pack({ reads: [read('e:manual:a', 100)] }), pack({ tombs: { 'e:manual:a': 200 } }), { now: 1000 }).reads).toEqual([]);
    // Described again after the deletion: it stays.
    expect(mergeContent(k, pack({ reads: [read('e:manual:a', 300)] }), pack({ tombs: { 'e:manual:a': 200 } }), { now: 1000 }).reads).toHaveLength(1);
    const wipes = [{ at: 500, what: 'events' as const, source: 'manual' as const }];
    expect(mergeContent(k, pack({ reads: [read('e:manual:a', 100)] }), pack({}), { now: 1000, wipes }).reads).toEqual([]);
    expect(mergeContent(k, pack({ reads: [read('e:manual:a', 100, { source: 'other' })] }), pack({}), { now: 1000, wipes }).reads).toHaveLength(1);
    expect(mergeContent(k, pack({ reads: [read('e:manual:a', 100)] }), pack({}), { now: 1000, wipes: [{ at: 500, what: 'memory' }] }).reads).toEqual([]);
  });
});

describe('the words', () => {
  it('has no long dashes in the code or what people read', () => {
    for (const f of ['reads-core.ts', 'reads.ts', 'reads-ui.js']) expect(readFileSync(`${process.cwd()}/src/life/${f}`, 'utf8')).not.toContain('\u2014');
  });
});
