// What the Player says about facts (know.ts): the flags and how two devices' copies come together,
// checks that are due, facts from imports, and facts that say the same thing or disagree.

import { describe, expect, it } from 'vitest';
import * as K from './know';
import { canonical, cleanContent, emptyContent, MEM, mergeContent } from './packs';
import type { LifeFact, LifeFactFlag } from '../lib/validate';

let n = 0;
const fact = (text: string, extra: Partial<LifeFact> = {}): LifeFact => ({ id: `f${(++n).toString(36)}`, text, since: '2026-10-01', from: 'ai', tier: 2, sources: ['2026-10-01'], at: 100, ...extra });
const map = (l: LifeFactFlag[]) => K.flagMap(l);

describe('the flags', () => {
  it('keeps the time each part changed, so a change on one device never undoes another', () => {
    const a = K.patchFlag(undefined, 'fa', { noAI: true }, 100);
    expect(a).toEqual({ id: 'fa', at: 100, noAI: true, ta: 100 });
    // Another device that never saw it sets a check later.
    const b = K.patchFlag(undefined, 'fa', { check: '2027-01-01' }, 200);
    const both = K.mergeFlags([a], [b]);
    expect(both).toEqual([{ id: 'fa', at: 200, noAI: true, ta: 100, check: '2027-01-01', tc: 200 }]);
    expect(K.mergeFlags([b], [a])).toEqual(both);
    // Turned off later on one device: off everywhere.
    const off = K.patchFlag(both[0], 'fa', { noAI: false }, 300);
    expect(K.mergeFlags(both, [off])[0]).not.toHaveProperty('noAI');
    // A tie keeps it from AIs.
    expect(K.combineFlags({ id: 'fa', at: 5, ta: 5 }, { id: 'fa', at: 5, ta: 5, noAI: true }).noAI).toBe(true);
    // "They're different" adds up from both.
    expect(K.mergeFlags([K.patchFlag(undefined, 'fa', { apart: 'fb' }, 1)], [K.patchFlag(undefined, 'fa', { apart: 'fc' }, 2)])[0].apart).toEqual(['fb', 'fc']);
  });

  it('go with the facts when the memory is wiped, and travel in the memory pack', () => {
    const f = K.patchFlag(undefined, 'fa', { noAI: true }, 100);
    expect(K.mergeFlags([f], [], [{ at: 150, what: 'memory' }])).toEqual([]);
    expect(K.mergeFlags([f], [], [{ at: 50, what: 'all' }])).toEqual([f]);
    const back = cleanContent(MEM, JSON.parse(canonical(MEM, { ...emptyContent(), flags: [f] })));
    expect(back.flags).toEqual([f]);
    expect(mergeContent(MEM, emptyContent(), { ...emptyContent(), flags: [f] }, { now: 1000 }).flags).toEqual([f]);
  });

  it('leaves out the facts held back from every AI', () => {
    const a = fact('You run.');
    const b = fact('You swim.');
    const flags = map([K.patchFlag(undefined, a.id, { noAI: true }, 1)]);
    expect(K.sendable([a, b], flags)).toEqual([b]);
    expect([...K.heldIds(flags)]).toEqual([a.id]);
  });
});

describe('check again on a day', () => {
  it('is due on its day, for a fact that is still true', () => {
    const a = fact('You live in Leeds.');
    const b = fact('You work at Acme.', { until: '2026-11-01' });
    const flags = map([K.patchFlag(undefined, a.id, { check: '2026-12-01' }, 1), K.patchFlag(undefined, b.id, { check: '2026-11-01' }, 1)]);
    expect(K.dueChecks([a, b], flags, '2026-11-30')).toEqual([]);
    expect(K.dueChecks([a, b], flags, '2026-12-01')).toEqual([{ id: a.id, text: 'You live in Leeds.', due: '2026-12-01' }]);
  });
});

describe('imported, not confirmed', () => {
  it('knows a day that came mostly from imports', () => {
    const wa = { id: 'whatsapp:1', source: 'whatsapp' as const };
    const note = { id: 'manual:1', source: 'manual' as const };
    expect(K.mostlyImported([wa, wa, note])).toBe(true);
    expect(K.mostlyImported([wa, note])).toBe(false);
    expect(K.mostlyImported([])).toBe(false);
    expect(K.fromImport({ id: 'maps:visit:1', source: 'maps' })).toBe(false); // the phone's places
    expect(K.fromImport({ id: 'maps:t:1', source: 'maps' })).toBe(true); // a Timeline export
  });

  it('stays unconfirmed until they say it is right', () => {
    const a = fact('You talk to Sam most days.', { imp: true });
    expect(K.unconfirmed(a, map([]))).toBe(true);
    expect(K.unconfirmed(a, map([K.patchFlag(undefined, a.id, { ok: true }, 1)]))).toBe(false);
    expect(K.unconfirmed(fact('You run.'), map([]))).toBe(false);
  });
});

describe('duplicates and facts that disagree', () => {
  it('finds two that say the same thing, and offers them once', () => {
    const a = fact('You run every Sunday morning.');
    const b = fact('You go running on Sunday mornings.', { from: 'you' });
    const c = fact('You swim on Tuesdays.');
    const { dupes, clashes } = K.pairs([a, b, c], map([]));
    expect(clashes).toEqual([]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].a.id).toBe(b.id); // the Player's own words first
    // "They're different": not offered again.
    expect(K.pairs([a, b, c], map([K.patchFlag(undefined, b.id, { apart: a.id }, 1)])).dupes).toEqual([]);
  });

  it('finds two that disagree: "not", another number, or another answer to a one-answer thing', () => {
    expect(K.disagree(fact('You drink coffee.'), fact("You don't drink coffee."))).toBe(true);
    expect(K.disagree(fact('You never drink coffee.'), fact('You drink coffee.'))).toBe(true);
    expect(K.disagree(fact('You sleep about 7 hours a night.'), fact('You sleep about 5 hours a night.'))).toBe(true);
    expect(K.disagree(fact('You live in Tel Aviv.'), fact('You live in Haifa.'))).toBe(true);
    expect(K.disagree(fact('You work at Acme.'), fact('You work at Globex.'))).toBe(true);
    expect(K.disagree(fact("You're married."), fact('You are single.'))).toBe(true);
    expect(K.disagree(fact('Your favourite food is sushi.'), fact('Your favourite food is pizza.'))).toBe(true);
    // Not these.
    expect(K.disagree(fact('You live in Tel Aviv.'), fact('You live in Tel Aviv with Dana.'))).toBe(false);
    expect(K.disagree(fact('You drink coffee.'), fact('You swim on Tuesdays.'))).toBe(false);
    expect(K.disagree(fact('Your favourite food is sushi.'), fact('Your favourite band is Radiohead.'))).toBe(false);
    // Two that disagree are never offered as the same.
    const [x, y] = [fact('You drink coffee.'), fact('You do not drink coffee.')];
    const p = K.pairs([x, y], map([]));
    expect(p.dupes).toEqual([]);
    expect(p.clashes.map((c) => [c.a.text, c.b.text])).toEqual([['You drink coffee.', 'You do not drink coffee.']]);
    expect(K.sameFact(x, y)).toBe(false);
    // Nor a fact that's no longer true.
    expect(K.pairs([x, { ...y, until: '2026-11-01' }], map([])).clashes).toEqual([]);
  });

  it('merges two into one with the days of both and the more careful flags', () => {
    const keep = fact('You run on Sundays.', { sources: ['2026-10-01'], since: '2026-10-01', tier: 2, by: 'private:x', imp: true });
    const drop = fact('You go running on Sundays.', { sources: ['2026-09-01', '2026-10-05'], since: '2026-09-01', tier: 3, pinned: true });
    const m = K.mergedFact(keep, drop, 999, (f) => f.share ?? f.tier);
    expect(m).toMatchObject({ id: keep.id, text: 'You run on Sundays.', since: '2026-09-01', sources: ['2026-09-01', '2026-10-01', '2026-10-05'], from: 'you', tier: 3, share: 3, pinned: true, at: 999 });
    expect(m).not.toHaveProperty('by');
    expect(m).not.toHaveProperty('imp'); // only when both came from imports
    expect(K.mergedFlags(undefined, { id: drop.id, at: 1, noAI: true, check: '2027-01-01' })).toEqual({ noAI: true, check: '2027-01-01' });
    expect(K.mergedFlags({ id: keep.id, at: 1, noAI: true }, { id: drop.id, at: 1 })).toBeNull();
  });
});
