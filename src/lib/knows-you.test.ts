// How well Arise knows you (lib/knows-you.ts): right first time from the Player's corrections, and
// what it would like to learn next.

import { describe, expect, it } from 'vitest';
import { hitRate, hitWeeks, learnNext, noName, type GapInput } from './knows-you';

const T = (k: string, h = 12) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10), h);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const TODAY = '2026-11-26'; // a Thursday; this week starts on 2026-11-23

describe('right first time', () => {
  it('counts what Arise wrote each week against what was put right', () => {
    const weeks = hitWeeks({
      today: TODAY,
      weeks: 3,
      dayOf,
      facts: [
        { from: 'ai', since: '2026-11-24' },
        { from: 'ai', since: '2026-11-17' },
        { from: 'you', since: '2026-11-24' }, // their own: not a guess
        { from: 'ai', since: '2026-10-01' }, // too long ago
      ],
      summaries: [
        { kind: 'day', key: '2026-11-23' },
        { kind: 'journal', key: '2026-11-23' },
        { kind: 'journal', key: '2026-11-22', edited: true }, // their words now
        { kind: 'week', key: '2026-11-16' }, // roll-ups don't count
        { kind: 'day', key: '2026-11-10' },
      ],
      fixes: [
        { id: 'fact:f1', at: T('2026-11-25') }, // "This isn't right"
        { id: 'google:e1', at: T('2026-11-18') }, // "Not quite? Fix it"
        { id: 'area:sleep', at: T('2026-11-18') },
      ],
    });
    expect(weeks.map((w) => [w.monday, w.wrote, w.fixed])).toEqual([
      ['2026-11-09', 1, 0],
      ['2026-11-16', 3, 2],
      ['2026-11-23', 4, 1],
    ]);
    expect(weeks[2].rate).toBe(0.75);
    expect(hitRate(weeks)).toEqual({ wrote: 8, fixed: 3, percent: 63 });
    expect(hitRate(weeks, 1)).toEqual({ wrote: 4, fixed: 1, percent: 75 });
  });

  it('has nothing to say with nothing written', () => {
    const weeks = hitWeeks({ today: TODAY, facts: [], summaries: [], fixes: [] });
    expect(weeks).toHaveLength(8);
    expect(weeks.every((w) => w.rate === null)).toBe(true);
    expect(hitRate(weeks).percent).toBeNull();
  });
});

describe('what it would like to learn next', () => {
  const known: GapInput = { values: ['Family'], bestTime: 'morning', checkins: 8, people: ['Maya'], quiet: [] };

  it('finds nothing when it knows enough', () => {
    expect(learnNext(known)).toEqual([]);
  });

  it('lists each gap, most useful first', () => {
    const gaps = learnNext({
      values: [],
      bestTime: '',
      checkins: 1,
      people: ['Maya', '+44 7700 900123', 'sam@example.com', '@runner'],
      quiet: [
        { id: 'money', label: 'Money' },
        { id: 'fun', label: 'Fun and rest' },
      ],
    });
    expect(gaps.map((g) => g.id)).toEqual(['values', 'best-time', 'checkins', 'names', 'areas']);
    expect(gaps[2].hint).toBe('1 check-in in the last 30 days. One a week is plenty.');
    expect(gaps[3].text).toBe('Who 3 people are in your calls and messages.');
    expect(gaps[4].text).toBe('More about these parts of your life: Money · Fun and rest.');
    // No em dashes, and no filler.
    for (const g of gaps) expect(`${g.text} ${g.hint || ''}`).not.toMatch(/\u2014/);
  });

  it('uses the way to fill a single quiet part of life', () => {
    const [g] = learnNext({ ...known, quiet: [{ id: 'sleep', label: 'Sleep', help: 'Connect your phone (Health).' }] });
    expect(g).toEqual({ id: 'areas', text: 'More about your sleep.', hint: 'Connect your phone (Health).' });
  });

  it('tells a name from a number or a handle', () => {
    expect(['Maya', 'José', 'Dad', '李雷'].map(noName)).toEqual([false, false, false, false]);
    expect(['', '+1 (555) 010-9999', 'a@b.co', '1234', '…'].map(noName)).toEqual([true, true, true, true, true]);
  });
});
