// A quick one (lib/questions.ts): short questions from the coach, worked out on the device.

import { describe, expect, it } from 'vitest';
import { KNOW, questions, threeThings, type QInput } from './questions';
import { looseEnds, looseIn } from './loose';

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
  dismissed: { 'q:know-day:2026-11-25': 1 }, // today's getting-to-know-you question was asked
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
    expect(questions({ ...base, bestTime: '', dismissed: { ...base.dismissed, 'q:best-time': 1 } })).toEqual([]);
  });

  it('asks one question a day to get to know them, when nothing else is open', () => {
    const q = questions({ ...base, dismissed: {} });
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ write: { act: 'q-know' } });
    expect(KNOW).toContain(q[0].text);
    // Answered ones don't come back, and the next day brings another.
    const answered = { [`q:${q[0].id}`]: 1 };
    const next = questions({ ...base, today: '2026-11-26', dismissed: answered })[0];
    expect(next.text).not.toBe(q[0].text);
    // Not while something else is open.
    expect(questions({ ...base, dismissed: {}, bestTime: '' }).map((x) => x.id)).toEqual(['best-time']);
  });

  it('asks whether a loose end in their notes happened, a day after', () => {
    const now = new Date(2026, 10, 25, 10).getTime();
    const loose = [{ id: 'l1', text: 'Email Eyal about the reference', at: now - 2 * 86_400_000 }, { id: 'l2', text: 'Book the dentist', at: now - 3_600_000 }];
    const out = questions({ ...base, loose, now });
    expect(out.map((q) => q.id)).toEqual(['loose:l1']);
    expect(out[0].text).toBe('You wrote "Email Eyal about the reference". Did it happen?');
    expect(out[0].choices.map((c) => c.act)).toEqual(['q-loose-done', 'q-loose-todo', 'q-skip']);
  });

  it('reads the 3 things from a few lines', () => {
    expect(threeThings('1. Finish the essay\n- Email Eyal\n\n• Book the dentist\nA fourth')).toEqual(['Finish the essay', 'Email Eyal', 'Book the dentist']);
  });
});

describe('loose ends in notes', () => {
  it('finds what they meant to do, and leaves out feelings', () => {
    const got = looseIn({ id: 'n1', at: 1, text: "Long day. I'll email Eyal about the reference tomorrow. I need to book the dentist, because my tooth hurts. I should relax more. Remind me to call mum!" });
    expect(got.map((l) => l.text)).toEqual(['Email Eyal about the reference tomorrow', 'Book the dentist', 'Call mum']);
    expect(new Set(got.map((l) => l.id)).size).toBe(3);
    expect(looseIn({ id: 'n1', at: 1, text: "I'll email Eyal about the reference tomorrow." })[0].id).toBe(got[0].id); // stable
  });

  it('leaves out what is already a to-do or was put away, newest first', () => {
    const notes = [
      { id: 'a', at: 10, text: 'Need to book the dentist soon.' },
      { id: 'b', at: 20, text: "I'll send the essay draft to Daniele." },
      { id: 'c', at: 30, text: 'Have to renew my railcard.' },
    ];
    const all = looseEnds(notes, [], {});
    expect(all.map((l) => l.text)).toEqual(['Renew my railcard', 'Send the essay draft to Daniele', 'Book the dentist soon']);
    const left = looseEnds(notes, [{ title: 'Book dentist' }], { [`q:loose:${all[0].id}`]: 1 });
    expect(left.map((l) => l.text)).toEqual(['Send the essay draft to Daniele']);
  });
});
