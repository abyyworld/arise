// Habits that learn (lib/habits.ts): good days against the rest, the wording ("came with", how
// many times out of how many, how sure), the thresholds, what's put away, and what the coach gets.

import { describe, expect, it } from 'vitest';
import { addDays } from '../life/dates';
import { checkinDays, findHabits, goodDay, habitsText, HABIT_DAYS, outcomeOf, sureOf, sureText, type HabitDay } from './habits';

const TODAY = '2026-11-25';
// `n` days before today, oldest first, each made by `fn(i)`.
const daysBack = (n: number, fn: (i: number) => Partial<HabitDay>): HabitDay[] => Array.from({ length: n }, (_, i) => ({ day: addDays(TODAY, i - n), ...fn(i) }));

describe('a good day', () => {
  it('is high energy or a good mood in the check-in, or every quest done', () => {
    expect(goodDay({ day: TODAY, e: 4 })).toBe(true);
    expect(goodDay({ day: TODAY, m: 5 })).toBe(true);
    expect(goodDay({ day: TODAY, e: 2, due: 3, done: 3 })).toBe(true);
    expect(goodDay({ day: TODAY, e: 3, m: 2, due: 2, done: 1 })).toBe(false);
    expect(goodDay({ day: TODAY })).toBeNull(); // the day doesn't say
    expect(outcomeOf({ day: TODAY, m: 5 }, 'energy')).toBeNull();
    expect(outcomeOf({ day: TODAY, e: 3 }, 'energy')).toBe(false);
    expect(outcomeOf({ day: TODAY, due: 2, done: 2 }, 'quests')).toBe(true);
  });

  it('counts the days with a check-in', () => {
    expect(checkinDays([{ day: 'a', e: 3 }, { day: 'b', m: 4 }, { day: 'c', due: 1, done: 1 }, { day: 'd', e: 9 }])).toBe(2);
  });
});

describe('what came with the good days', () => {
  it('says so plainly until there are 14 days with a check-in', () => {
    const r = findHabits(daysBack(30, (i) => (i < 13 ? { e: 4, steps: 9000 } : { steps: 3000 })), TODAY);
    expect(r).toEqual({ checkins: 13, ready: false, findings: [] });
    expect(findHabits(daysBack(30, (i) => (i < 14 ? { e: 2 } : {})), TODAY).ready).toBe(true);
  });

  it('finds the walk, with times out of how many, how sure, and one small habit', () => {
    // 40 days: walking days (9,000 steps) had high energy 18 times out of 20; the others 4 of 20.
    const days = daysBack(40, (i) => {
      const walked = i % 2 === 0;
      const k = Math.floor(i / 2);
      return { steps: walked ? 9000 : 2500, e: walked ? (k < 18 ? 4 : 2) : k < 4 ? 4 : 2 };
    });
    const r = findHabits(days, TODAY);
    expect(r.ready).toBe(true);
    expect(r.checkins).toBe(40);
    const f = r.findings[0];
    expect(f.id).toBe('walk');
    expect(f.outcome).toBe('energy');
    // Steps around the middle of their own (2,500 and 9,000: 5,750 rounds to 6,000).
    expect(f.text).toBe('On days you walked 6,000 steps or more, your energy was high 18 times out of 20.');
    expect(f.other).toBe('On other days, 4 times out of 20.');
    expect(f.sure).toBe('strong');
    expect(f.sureText).toBe('Fairly sure: it rests on 40 days.');
    expect(f.try).toBe('Try a 20 minute walk on weekdays?');
    expect(f.quest).toEqual({ title: '20 minute walk', schedule: { kind: 'days', days: [0, 1, 2, 3, 4] } });
    expect(f.tier).toBe(2); // steps are everyday activity
    // Never a cause.
    expect(f.text + f.other).not.toMatch(/because|cause|made|thanks to/i);
  });

  it('needs a clear gap and enough days on each side', () => {
    // Walking or not, energy is the same: nothing.
    const same = daysBack(40, (i) => ({ steps: i % 2 ? 9000 : 2500, e: i % 4 < 2 ? 4 : 2 }));
    expect(findHabits(same, TODAY).findings).toEqual([]);
    // Only 4 walking days: too few.
    const few = daysBack(40, (i) => ({ steps: i < 4 ? 9000 : 2500, e: i < 4 ? 5 : 2 }));
    expect(findHabits(few, TODAY).findings.map((f) => f.id)).not.toContain('walk');
  });

  it('keeps the two strongest, each with its best way a day was good', () => {
    // Asleep before midnight came with a good mood; talking with someone with quests done.
    const days = daysBack(42, (i) => {
      const early = i % 2 === 0;
      const talked = i % 3 === 0;
      return { bedtime: early ? -30 : 45, m: early ? 4 : 2, e: 3, talked, due: 2, done: talked ? 2 : i % 5 === 0 ? 2 : 0 };
    });
    const r = findHabits(days, TODAY);
    expect(r.findings).toHaveLength(2);
    const ids = r.findings.map((f) => f.id);
    expect(ids).toEqual(['sleepEarly', 'people']);
    expect(r.findings[0].text).toBe('On days after you were asleep before midnight, your mood was good 21 times out of 21.');
    expect(r.findings[0].tier).toBe(3); // sleep is sensitive
    expect(r.findings[1].text).toMatch(/^On days you talked with someone \(a call or messages\), you finished your quests 14 times out of 14\.$/);
    expect(r.findings[0].score).toBeGreaterThanOrEqual(r.findings[1].score);
  });

  it('leaves out what was put away, and days outside the 8 weeks', () => {
    const days = daysBack(40, (i) => ({ steps: i % 2 ? 2500 : 9000, e: i % 2 ? 2 : 4 }));
    expect(findHabits(days, TODAY).findings[0].id).toBe('walk');
    expect(findHabits(days, TODAY, new Set(['walk'])).findings.map((f) => f.id)).not.toContain('walk');
    // The same days, but over 8 weeks ago: not enough check-ins left.
    expect(findHabits(days, addDays(TODAY, HABIT_DAYS + 40)).ready).toBe(false);
  });

  it('uses their own usual for screens and waking', () => {
    const days = daysBack(40, (i) => ({ screenMin: i % 2 ? 300 : 120, wake: i % 2 ? 540 : 360, e: i % 2 ? 2 : 4 }));
    const r = findHabits(days, TODAY);
    const texts = r.findings.map((f) => f.text);
    expect(texts.some((t) => t.startsWith('On days with under 3 h 30 min on screens,'))).toBe(true);
    expect(texts.some((t) => t.startsWith('On days you were up by 7:30,'))).toBe(true);
    const early = r.findings.find((f) => f.id === 'early');
    expect(early?.quest.title).toBe('Up by 7:30');
  });

  it('says how sure, from the days it rests on', () => {
    expect(sureOf(40, 15, 0.5)).toBe('strong');
    expect(sureOf(40, 15, 0.25)).toBe('some');
    expect(sureOf(22, 6, 0.6)).toBe('some');
    expect(sureOf(12, 4, 0.9)).toBe('early');
    expect(sureText('early', 12)).toBe('An early sign: it rests on only 12 days.');
    expect(sureText('some', 22)).toBe('Somewhat sure: it rests on 22 days.');
  });
});

describe('what the coach gets', () => {
  const days = daysBack(42, (i) => ({ bedtime: i % 2 ? 45 : -30, m: i % 2 ? 2 : 4, steps: i % 3 ? 2500 : 9000, e: i % 3 ? 2 : 4 }));
  const r = findHabits(days, TODAY);

  it('only what its AI may read', () => {
    expect(r.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['sleepEarly', 'walk']));
    const all = habitsText(r, 3);
    expect(all.tier).toBe(3);
    expect(all.text).toContain('not proof');
    expect(all.text).toContain('asleep before midnight');
    expect(all.text).toContain('Arise suggested: Try a 20 minute walk on weekdays?');
    const some = habitsText(r, 2);
    expect(some.tier).toBe(2);
    expect(some.text).not.toContain('midnight');
    expect(some.text).toContain('left out');
    expect(habitsText(r, 1).text).not.toContain('walked');
    expect(habitsText(r, 3, true).text.split('\n- ')).toHaveLength(2); // one for a small model
    expect(habitsText(null, 3)).toEqual({ text: '', tier: 1 });
  });
});
