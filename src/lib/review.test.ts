// Your week in review (lib/review.ts): what went well, the numbers, one thing to try, next week.

import { describe, expect, it } from 'vitest';
import { review, type ReviewInput } from './review';

const base: ReviewInput = { monday: '2026-11-23', todosDone: [], todosLate: 0, quests: [], workouts: 0, milestones: [], sleep: [], mood: [], energy: [], focusMin: 0, nextDeadlines: [], nextEvents: 0 };

describe('the weekly review', () => {
  it('says what went well, the numbers and what is next', () => {
    const r = review({
      ...base,
      todosDone: ['Email Eyal', 'Pay rent'],
      quests: [
        { title: 'Study maths', done: 5, due: 5 },
        { title: 'Read', done: 1, due: 4 },
      ],
      workouts: 3,
      milestones: ['First draft done'],
      sleep: [420, 450, 400],
      mood: [4, 3, 4],
      energy: [3, 4],
      focusMin: 600,
      nextDeadlines: [{ title: 'UIST abstract', due: '2026-12-02' }],
      nextEvents: 4,
    });
    expect(r.wins).toEqual(['2 to-dos done: Email Eyal, Pay rent.', 'Milestone reached: First draft done.', 'Every time this week: Study maths.', '3 workouts.']);
    expect(r.numbers).toEqual(['Quests: 6 of 9 (67%).', 'Sleep: 7 h 3 min a night on average.', 'Mood: 3.7 out of 5, energy 3.5.', 'Focused work: 10 h.']);
    expect(r.try).toBe('"Read" happened 1 of 4 times. Make it smaller, or move it to the time of day that works best for you.');
    expect(r.ahead).toEqual(['4 events on your calendar.', 'Due 2026-12-02: UIST abstract.']);
  });

  it('puts short sleep first, and is kind about a quiet week', () => {
    expect(review({ ...base, sleep: [330, 360, 340], quests: [{ title: 'Read', done: 0, due: 4 }] }).try).toContain('Sleep was short');
    const quiet = review(base);
    expect(quiet.wins).toEqual(['A quiet week. That counts too.']);
    expect(quiet.ahead).toEqual(['Nothing fixed yet. A good week to get ahead.']);
  });
});
