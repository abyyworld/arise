// A quick one, at most 6 a day (lib/questions.ts): every kind together, counted from what was
// answered or put away today, without changing the order the kinds come in.

import { describe, expect, it } from 'vitest';
import { DAILY_QUESTIONS, askedSince, questions, questionsLeft, type QInput } from './questions';

const START = Date.UTC(2026, 10, 25); // the start of today (tests run in UTC)
const NOW = START + 10 * 3_600_000;

const busy: QInput = {
  today: '2026-11-25', // a Wednesday
  hour: 10,
  weekday: 3,
  monday: '2026-11-23',
  todos: [
    { id: 't1', title: 'Call the bank', day: '2026-11-20' },
    { id: 't2', title: 'Pay the rent', day: '2026-11-19' },
  ],
  goals: [{ id: 'g1', title: 'Run', quests: 1, lastTick: null, created: '2026-10-01' }],
  owed: [{ id: 'd1', who: 'Sam', text: '£12', due: '2026-11-20' }],
  bestTime: '',
  weekBig: 0,
  dismissed: {},
  loose: [{ id: 'n1', text: 'call mum', at: NOW - 3 * 86_400_000 }],
  now: NOW,
};

const ids = (q: QInput) => questions(q).map((x) => x.id);

describe('the daily budget of quick questions', () => {
  it('keeps the order of the kinds, with or without the budget', () => {
    const order = ['week:2026-11-23', 'owed:d1', 'late:t1:2026-11-20', 'late:t2:2026-11-19', 'loose:n1', 'quiet:g1:2026-11-23', 'best-time'];
    expect(ids(busy)).toEqual(order);
    expect(ids({ ...busy, dayStart: START })).toEqual(order);
  });

  it('counts what was answered or put away today, of every kind, but not the getting-to-know-you marker', () => {
    const dismissed = {
      'q:week:2026-11-23': START + 1,
      'q:owed:d1': START + 2,
      'q:loose:n1': START + 3,
      'q:know:0': START + 4,
      'q:know-day:2026-11-25': START + 4,
      'q:late:t9:2026-11-01': START - 1, // yesterday
      'review:2026-11-23': START + 5, // not a quick one
    };
    expect(askedSince(dismissed, START)).toBe(4);
    expect(questionsLeft(dismissed, START)).toBe(DAILY_QUESTIONS - 4);
  });

  it('asks nothing more once 6 are done today, across kinds, and starts again tomorrow', () => {
    const six = { 'q:week:2026-11-23': START + 1, 'q:owed:d1': START + 2, 'q:late:t1:2026-11-20': START + 3, 'q:loose:n1': START + 4, 'q:know:3': START + 5, 'q:x:1': START + 6 };
    const five = Object.fromEntries(Object.entries(six).slice(0, 5));
    expect(ids({ ...busy, dismissed: five, dayStart: START })).toEqual(['late:t2:2026-11-19', 'quiet:g1:2026-11-23', 'best-time']);
    expect(questionsLeft(five, START)).toBe(1);
    expect(questions({ ...busy, dismissed: six, dayStart: START })).toEqual([]);
    expect(questionsLeft(six, START)).toBe(0);
    // The next day, the same ones still put away, but the budget is new.
    const tomorrow = START + 86_400_000;
    expect(questionsLeft(six, tomorrow)).toBe(DAILY_QUESTIONS);
    expect(ids({ ...busy, today: '2026-11-26', weekday: 4, dismissed: six, dayStart: tomorrow })).toEqual(['late:t2:2026-11-19', 'quiet:g1:2026-11-23', 'best-time']);
  });

  it('applies to getting-to-know-you questions too', () => {
    const quiet: QInput = { ...busy, todos: [], goals: [], owed: [], loose: [], weekBig: 1, bestTime: 'morning' };
    expect(ids({ ...quiet, dayStart: START })[0]).toMatch(/^know:/);
    const six = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`q:late:t${i}:2026-11-01`, START + i]));
    expect(questions({ ...quiet, dismissed: six, dayStart: START })).toEqual([]);
  });
});
