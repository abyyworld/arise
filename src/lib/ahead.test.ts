import { describe, expect, it } from 'vitest';
import { changes, freeGaps, isQuiet, nudgesFor, planDay, planText, planWeek, shortNight, sleepSummary, warnings, type AheadInput, type Task } from './ahead';

const MIN = 60_000;
const mid = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const at = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return mid(day) + (h * 60 + m) * MIN;
};
const hm = (t: number) => `${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}`;
const DAY = '2026-11-24';
const prev = (n: number) => {
  const d = new Date(mid(DAY) + 12 * 3600_000 - n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const task = (id: string, o: Partial<Task> = {}): Task => ({ id, title: id, min: 60, hard: false, weight: 3, why: 'test', ...o });
const input = (o: Partial<AheadInput> = {}): AheadInput => ({
  today: DAY,
  now: at(DAY, '07:00'),
  midnight: mid,
  tasks: [],
  weekTasks: [],
  busy: [],
  milestones: [],
  nights: [],
  wake: 7 * 60,
  bed: 23 * 60,
  people: [],
  ...o,
});

describe('the day plan', () => {
  it('fits tasks around what is fixed, hard work first in the hours they think best', () => {
    const plan = planDay(
      input({
        busy: [{ start: at(DAY, '09:00'), end: at(DAY, '12:00'), title: 'Lectures' }],
        tasks: [task('Laundry', { min: 30 }), task('Study', { hard: true, weight: 5 })],
      }),
    );
    const study = plan.blocks.find((b) => b.title === 'Study')!;
    const fixed = plan.blocks.find((b) => b.kind === 'fixed')!;
    expect(fixed.title).toBe('Lectures');
    expect(study.kind).toBe('hard');
    // In the free time that overlaps the morning window (from 8:00), before the lectures with a
    // gap kept free.
    expect(hm(study.start)).toBe('07:30');
    expect(study.end).toBeLessThanOrEqual(at(DAY, '08:50'));
    expect(plan.blocks.find((b) => b.title === 'Laundry')).toBeTruthy();
    for (const b of plan.blocks.filter((x) => x.kind !== 'fixed')) expect(b.end <= fixed.start - 10 * MIN || b.start >= fixed.end + 10 * MIN).toBe(true);
    expect(plan.left).toEqual([]);
  });

  it('plans from now on, and says what did not fit', () => {
    const plan = planDay(input({ now: at(DAY, '20:30'), tasks: [task('Long', { min: 180 })] }));
    expect(plan.blocks).toEqual([]);
    expect(plan.left.map((t) => t.id)).toEqual(['Long']);
    expect(plan.notes.join(' ')).toContain("didn't fit");
  });

  it('after a short night makes the day lighter and puts hard work first', () => {
    const nights = [{ day: DAY, min: 300 }, ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ day: prev(n), min: 450 }))];
    const plan = planDay(input({ nights, best: 'evening', tasks: [task('Study', { hard: true })] }));
    expect(plan.notes[0]).toMatch(/^Short night \(5 h\)/);
    expect(hm(plan.blocks[0].start)).toBe('07:30');
  });

  it('says what moved since the plan they saw', () => {
    const a = planDay(input({ tasks: [task('Study', { hard: true })] }));
    const b = planDay(input({ busy: [{ start: at(DAY, '07:30'), end: at(DAY, '10:00'), title: 'Dentist' }], tasks: [task('Study', { hard: true })] }));
    const c = changes(a.blocks, b.blocks);
    expect(c.some((x) => x.startsWith('Study moved from 08:00 to'))).toBe(true);
    expect(c).toContain('Dentist at 07:30 is new or moved in your calendar.');
  });

  it('finds free time around busy times', () => {
    const gaps = freeGaps([{ start: at(DAY, '10:00'), end: at(DAY, '11:00'), title: 'x' }], at(DAY, '09:00'), at(DAY, '12:00'));
    expect(gaps.map((g) => [hm(g.start), hm(g.end)])).toEqual([
      ['09:00', '09:50'],
      ['11:10', '12:00'],
    ]);
  });

  it('writes the plan for the coach', () => {
    const plan = planDay(input({ tasks: [task('Study', { hard: true })] }));
    expect(planText(plan, [])).toContain('- 08:00 to 09:00: Study (needs focus)');
  });
});

describe('the week', () => {
  it('puts what is left on the freest days before it is due, two a day at most', () => {
    const busy = [1, 2].map((i) => ({ start: mid(prev(-i)) + 8 * 3600_000, end: mid(prev(-i)) + 20 * 3600_000, title: 'Work' }));
    const days = planWeek(input({ busy, weekTasks: [task('a'), task('b'), task('c'), task('d', { due: prev(-3) })] }));
    expect(days).toHaveLength(7);
    expect(days[1].items).toEqual([]); // packed
    expect(days[2].items).toEqual([]);
    expect(days[3].items.map((x) => x.id)).toContain('d');
    expect(days.every((d) => d.items.length <= 2)).toBe(true);
    expect(days.reduce((n, d) => n + d.items.length, 0)).toBe(4);
  });
});

describe('early warnings', () => {
  it('a deadline close with nothing done, not one with work going on', () => {
    const w = warnings(
      input({
        milestones: [
          { id: 'm1', goal: 'Pass the exam', title: 'Mock test', due: prev(-2), doneLately: false },
          { id: 'm2', goal: 'Run', title: '10 km', due: prev(-1), doneLately: true },
          { id: 'm3', goal: 'Save', title: 'Far away', due: prev(-30), doneLately: false },
        ],
      }),
    );
    expect(w.map((x) => x.id)).toEqual([`deadline:m1:${prev(-2)}`]);
    expect(w[0].title).toBe('Mock test is due in 2 days');
    expect(w[0].lock).not.toContain('Mock');
  });

  it('sleep sliding, with an exam coming up', () => {
    const nights = [...[0, 1, 2, 3, 4].map((n) => ({ day: prev(n), min: 360 })), ...[8, 9, 10, 11, 12, 13, 14, 15].map((n) => ({ day: prev(n), min: 450 }))];
    expect(sleepSummary(nights, DAY).week).toBe(360);
    const w = warnings(input({ nights, busy: [{ start: at(prev(-3), '09:00'), end: at(prev(-3), '11:00'), title: 'Maths exam' }] }));
    expect(w[0].kind).toBe('sleep');
    expect(w[0].body).toContain('Maths exam');
    expect(w[0].lock).not.toMatch(/sleep/i);
    expect(shortNight(nights, DAY)).toBe(360);
  });

  it('someone important gone quiet, and nothing once put away', () => {
    const people = [
      { who: 'tel:1', name: 'Max', last: prev(25), weeks: 6 },
      { who: 'tel:2', name: 'Sam', last: prev(3), weeks: 7 },
      { who: 'tel:3', name: 'Rare', last: prev(40), weeks: 2 },
    ];
    const w = warnings(input({ people }));
    expect(w.map((x) => x.title)).toEqual(['Max has gone quiet']);
    expect(w[0].lock).not.toContain('Max');
    expect(warnings(input({ people, dismissed: { [w[0].id]: 1 } }))).toEqual([]);
  });
});

describe('next-step messages', () => {
  const rules = { max: 2, quietFrom: '22:00', quietTo: '08:00', details: false };
  it('a few, never in the quiet hours, spaced out, plain on the lock screen', () => {
    const plan = planDay(input({ tasks: [task('Study', { hard: true }), task('Walk', { min: 30 }), task('Read', { min: 30 })] }));
    const warns = warnings(input({ milestones: [{ id: 'm1', goal: 'Exam', title: 'Essay', due: DAY, doneLately: false }] }));
    const now = at(DAY, '07:00');
    const plan2 = planDay(input({ now, busy: [{ start: at(DAY, '07:30'), end: at(DAY, '09:30'), title: 'Class' }], tasks: [task('Study', { hard: true }), task('Walk', { min: 30 }), task('Read', { min: 30 })] }));
    const out = nudgesFor(plan2, warns, rules, now, mid(DAY));
    expect(out.length).toBe(2);
    expect(out.every((n) => !isQuiet(n.at, rules))).toBe(true);
    expect(Math.abs(out[1].at - out[0].at)).toBeGreaterThanOrEqual(90 * MIN);
    expect(out.map((n) => hm(n.at))).toEqual(['08:30', '10:40']);
    expect(out[0].tag.startsWith('warn-deadline:m1')).toBe(true);
    // Once the morning has passed, the warning is on Today instead.
    expect(nudgesFor(plan2, warns, rules, at(DAY, '09:00'), mid(DAY)).some((n) => n.tag.startsWith('warn-'))).toBe(false);
    expect(JSON.stringify(out)).not.toContain('Essay');
    expect(JSON.stringify(out)).not.toContain('Study');
    const detailed = nudgesFor(plan, [], { ...rules, details: true, max: 5 }, at(DAY, '07:00'), mid(DAY));
    expect(detailed.some((n) => n.title.startsWith('Next: '))).toBe(true);
    expect(nudgesFor(plan, warns, { ...rules, max: 0 }, at(DAY, '07:00'), mid(DAY))).toEqual([]);
  });

  it('knows quiet hours across midnight', () => {
    expect(isQuiet(at(DAY, '23:30'), rules)).toBe(true);
    expect(isQuiet(at(DAY, '07:59'), rules)).toBe(true);
    expect(isQuiet(at(DAY, '08:00'), rules)).toBe(false);
    expect(isQuiet(at(DAY, '13:00'), { quietFrom: '12:00', quietTo: '14:00' })).toBe(true);
  });
});
