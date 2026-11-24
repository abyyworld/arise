// A quick one (lib/questions.ts): short questions from the coach, worked out on the device.

import { describe, expect, it } from 'vitest';
import { questions, threeThings, type QInput } from './questions';

const base: QInput = {
  today: '2026-11-25', // a Wednesday
  hour: 10,
  weekday: 3,
  monday: '2026-11-23',
  todos: [],
  goals: [],
  owed: [],
  bestTime: 'morning',
  weekBig: 1,
  dismissed: {},
};

describe('a quick one', () => {
  it('asks nothing when nothing is unclear', () => {
    expect(questions(base)).toEqual([]);
  });

  it('asks for the 3 things early in the week, until some are marked', () => {
    expect(questions({ ...base, weekBig: 0 })[0]).toMatchObject({ id: 'week:2026-11-23', write: { act: 'q-week' } });
    expect(questions({ ...base, weekBig: 0, weekday: 4 })).toEqual([]);
  });

  it('asks about money past its day, late to-dos, quiet goals and the best time', () => {
    const out = questions({
      ...base,
      bestTime: '',
      owed: [
        { id: 'd1', who: 'Sam', text: '£12 for lunch', due: '2026-11-20' },
        { id: 'd2', who: 'Jo', text: '£5', due: '2026-12-01' },
      ],
      todos: [
        { id: 't1', title: 'Call the bank', day: '2026-11-20' },
        { id: 't2', title: 'Yesterday', day: '2026-11-24' },
        { id: 't3', title: 'Done late', day: '2026-11-01', done: 1 },
      ],
      goals: [
        { id: 'g1', title: 'Run a 10k', quests: 2, lastTick: '2026-11-10', created: '2026-10-01' },
        { id: 'g2', title: 'New one', quests: 1, lastTick: null, created: '2026-11-22' },
        { id: 'g3', title: 'Busy', quests: 1, lastTick: '2026-11-24', created: '2026-10-01' },
      ],
    });
    expect(out.map((q) => q.id)).toEqual(['owed:d1', 'late:t1:2026-11-20', 'quiet:g1:2026-11-23', 'best-time']);
    expect(out[0]).toMatchObject({ text: 'Did Sam pay you back?', hint: '£12 for lunch', choices: [{ act: 'q-paid', v: 'd1' }, { act: 'q-skip' }] });
    expect(out[1].choices.map((c) => c.v)).toEqual(['t1|2026-11-25', 't1|2026-12-02', 't1']);
  });

  it('never asks one that was answered or put away', () => {
    expect(questions({ ...base, bestTime: '', dismissed: { 'q:best-time': 1 } })).toEqual([]);
  });

  it('reads the 3 things from a few lines', () => {
    expect(threeThings('1. Finish the essay\n- Email Eyal\n\n• Book the dentist\nA fourth')).toEqual(['Finish the essay', 'Email Eyal', 'Book the dentist']);
  });
});
