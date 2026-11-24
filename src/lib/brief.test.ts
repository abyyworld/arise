// The morning brief (lib/brief.ts): the day in a few lines, and plain words for the lock screen.

import { describe, expect, it } from 'vitest';
import { brief } from './brief';

const at = (h: number, m = 0) => new Date(2026, 10, 25, h, m).getTime();

describe('the morning brief', () => {
  it('says the day in a few lines, first event and late to-dos included', () => {
    const b = brief({
      day: '2026-11-25',
      events: [
        { start: at(0), title: 'Mum birthday', allDay: true },
        { start: at(10, 30), title: 'Lab meeting', allDay: false },
      ],
      todos: [
        { title: 'Email Eyal', late: true },
        { title: 'Pay rent', late: false },
      ],
      deadlines: [{ title: 'UIST abstract', due: '2026-11-27', goal: 'Omni-Connect paper' }],
      quests: 2,
      owe: [{ text: 'pay Jo back £5', due: '2026-11-24' }],
      groceries: 3,
    });
    expect(b.lines).toEqual([
      '2 events. First at 10:30: Lab meeting.',
      '2 to-dos, 1 late: Email Eyal, Pay rent.',
      '2 quests for your goals.',
      'Due 2026-11-27: UIST abstract (Omni-Connect paper).',
      'Was due: pay Jo back £5.',
      '3 things on your grocery list.',
    ]);
    expect(b.plain).toBe('Your day: 2 events, 2 to-dos, 1 deadline.');
    expect(b.plain).not.toContain('Lab');
    expect(b.body).toContain('Lab meeting');
  });

  it('says so when the day is clear', () => {
    const b = brief({ day: '2026-11-25', events: [], todos: [], deadlines: [], quests: 0, owe: [], groceries: 0 });
    expect(b.lines).toEqual(['Nothing planned. A good day to get ahead on a goal.']);
    expect(b.plain).toBe('Your day is clear so far.');
  });
});
