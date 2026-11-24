// What matters, and when (lib/priorities.ts): the next 14 days in four boxes.

import { describe, expect, it } from 'vitest';
import { grid, matters } from './priorities';

describe('the priority grid', () => {
  const today = '2026-11-24';

  it('sorts by how much it matters and how soon it is due', () => {
    const g = grid(
      [
        { id: 'a', kind: 'todo', title: 'Revise for the maths exam', day: '2026-11-25' },
        { id: 'b', kind: 'milestone', title: 'First draft done', day: '2026-12-05', note: 'For Write a book' },
        { id: 'c', kind: 'todo', title: 'Buy a birthday card', day: '2026-11-24' },
        { id: 'd', kind: 'todo', title: 'Sort the photos' },
        { id: 'e', kind: 'todo', title: 'Call the bank', big: true },
        { id: 'f', kind: 'event', title: 'Team lunch', day: '2026-11-30' },
        { id: 'g', kind: 'debt', title: 'Pay Sam back £20', day: '2026-11-20' },
        { id: 'h', kind: 'todo', title: 'Far away', day: '2027-03-01' },
        { id: 'i', kind: 'event', title: 'Yesterday', day: '2026-11-23' },
      ],
      today,
    );
    expect(g.now.map((x) => x.id)).toEqual(['g', 'a']);
    expect(g.plan.map((x) => x.id)).toEqual(['b', 'e']);
    expect(g.light.map((x) => x.id)).toEqual(['c']);
    expect(g.wait.map((x) => x.id)).toEqual(['f', 'd']);
  });

  it('knows the words that usually matter', () => {
    expect(matters({ id: 'x', kind: 'todo', title: 'Pay the rent' })).toBe(true);
    expect(matters({ id: 'x', kind: 'todo', title: 'Water the plants' })).toBe(false);
  });
});
