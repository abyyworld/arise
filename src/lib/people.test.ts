// People (lib/people.ts): cleaning what comes from storage and sync, the per-person merge with
// tombstones, who is overdue, the next birthday (29 February too), the reminders planned for
// dates, birthdays read from calendar titles, the order of the list, and what the coach reads.

import { describe, expect, it } from 'vitest';
import * as P from './people';

const DAY = 86_400_000;
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const mid = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const NOW = at(2026, 11, 25, 10); // Wednesday 25 November 2026, 10:00

describe('cleaning', () => {
  it('keeps only what it should', () => {
    const raw = {
      mum: { name: ' Mum ', at: 5, close: 'week', since: 4, last: 3, until: '2026-12-01', dates: [{ label: '', md: '03-14' }, { label: 'Birthday', md: '03-14' }, { label: 'x', md: '02-30' }], hidden: true, own: true, extra: 1 },
      'tel:700900123': { name: '+44 7700 900123', at: 2, close: 'yearly' },
      bad: { name: '', at: 1 },
      notime: { name: 'Sam' },
      __proto__x: { name: 'Al', at: 1 },
    } as Record<string, unknown>;
    const out = P.cleanPeople({ ...raw, ['__proto__']: { name: 'Evil', at: 1 } }, NOW);
    expect(out.mum).toEqual({ name: 'Mum', at: 5, close: 'week', since: 4, last: 3, until: '2026-12-01', dates: [{ label: 'Birthday', md: '03-14' }], hidden: true, own: true });
    expect(out['tel:700900123']).toEqual({ name: '+44 7700 900123', at: 2 });
    expect(out.bad).toBeUndefined();
    expect(out.notime).toBeUndefined();
    expect(Object.keys(out)).not.toContain('__proto__');
    expect(P.cleanPeople('nope')).toEqual({});
    expect(P.cleanPeople([])).toEqual({});
  });

  it('drops old tombstones and keeps no more than the most', () => {
    const out = P.cleanPeople({ a: { name: '', at: NOW - 200 * DAY, gone: true }, b: { name: '', at: NOW - DAY, gone: true } }, NOW);
    expect(Object.keys(out)).toEqual(['b']);
    const many = Object.fromEntries(Array.from({ length: P.MAX_PEOPLE + 5 }, (_, i) => [`p${i}`, { name: `P${i}`, at: i + 1 }]));
    const kept = P.cleanPeople(many, NOW);
    expect(Object.keys(kept)).toHaveLength(P.MAX_PEOPLE);
    expect(kept.p0).toBeUndefined();
  });

  it('only takes month days that exist, 29 February included', () => {
    expect(P.isMonthDay('02-29')).toBe(true);
    expect(P.isMonthDay('02-30')).toBe(false);
    expect(P.isMonthDay('04-31')).toBe(false);
    expect(P.isMonthDay('13-01')).toBe(false);
    expect(P.isMonthDay('1-01')).toBe(false);
  });
});

describe('merging', () => {
  it('takes each person from the copy that changed them last, removals too', () => {
    const a: P.People = { mum: { name: 'Mum', at: 10, close: 'week', since: 10 }, sam: { name: 'Sam', at: 5 } };
    const b: P.People = { mum: { name: 'Mum', at: 8, hidden: true }, sam: { name: '', at: 6, gone: true }, jo: { name: 'Jo', at: 3, dates: [{ label: 'Birthday', md: '07-01' }] } };
    const m = P.mergePeople(a, b, 100);
    expect(m.mum).toEqual(a.mum);
    expect(m.sam.gone).toBe(true);
    expect(m.jo.dates).toEqual([{ label: 'Birthday', md: '07-01' }]);
    // The same both ways round.
    expect(P.mergePeople(b, a, 100)).toEqual(m);
    // An older copy without the field changes nothing.
    expect(P.mergePeople(m, undefined as unknown as P.People, 100)).toEqual(m);
  });

  it('changes and removes one person with a later time', () => {
    let ps = P.setPerson({}, 'mum', { name: 'Mum', close: 'week' }, NOW)!;
    expect(ps.mum).toEqual({ name: 'Mum', at: NOW, close: 'week', since: NOW });
    ps = P.setPerson(ps, 'mum', { until: '2026-12-02' }, NOW)!;
    expect(ps.mum.at).toBe(NOW + 1);
    expect(ps.mum.until).toBe('2026-12-02');
    // Not close any more: the snooze and the start go with it.
    ps = P.setPerson(ps, 'mum', { close: null }, NOW)!;
    expect(ps.mum).toEqual({ name: 'Mum', at: NOW + 2 });
    expect(P.setPerson({}, 'x', { close: 'week' }, NOW)).toBeNull(); // a new person needs a name
    expect(P.setPerson({}, ' bad', { name: 'Bad' }, NOW)).toBeNull();
    const gone = P.removePerson(ps, 'mum', NOW);
    expect(gone.mum).toEqual({ name: '', at: NOW + 3, gone: true });
    // Back again after a removal: a new person.
    expect(P.setPerson(gone, 'mum', { name: 'Mum' }, NOW)!.mum).toEqual({ name: 'Mum', at: NOW + 4 });
  });
});

describe('keeping in touch', () => {
  const mum: P.Person = { name: 'Mum', at: 1, close: 'week', since: at(2026, 10, 1) };

  it('is overdue only past the time they picked', () => {
    expect(P.overdueDays(mum, at(2026, 11, 18), NOW)).toBeNull(); // 7 days: not past a week
    expect(P.overdueDays(mum, at(2026, 11, 17), NOW)).toBe(8);
    expect(P.overdueDays({ ...mum, close: 'month' }, at(2026, 11, 1), NOW)).toBeNull();
    expect(P.overdueDays({ ...mum, close: 'month' }, at(2026, 10, 20), NOW)).toBe(36);
    // Nothing from the life log: counted from when they were marked close.
    expect(P.overdueDays(mum, undefined, NOW)).toBe(55);
    // "Done" in Arise counts like a call.
    expect(P.overdueDays({ ...mum, last: at(2026, 11, 24) }, at(2026, 10, 1), NOW)).toBeNull();
  });

  it('waits after "Later", and never nudges for someone not close or hidden', () => {
    expect(P.overdueDays({ ...mum, until: '2026-12-02' }, undefined, NOW)).toBeNull();
    expect(P.overdueDays({ ...mum, until: '2026-11-25' }, undefined, NOW)).toBe(55);
    expect(P.overdueDays({ ...mum, close: undefined }, undefined, NOW)).toBeNull();
    expect(P.overdueDays({ ...mum, hidden: true }, undefined, NOW)).toBeNull();
    expect(P.overdueDays(undefined, 1, NOW)).toBeNull();
  });

  it('says it in plain words', () => {
    expect(P.nudgeText('Mum', 21)).toBe("You haven't been in touch with Mum for 3 weeks. Call or message?");
    expect(P.sinceText(1)).toBe('1 day');
    expect(P.sinceText(9)).toBe('9 days');
    expect(P.sinceText(90)).toBe('3 months');
    expect(P.agoText(at(2026, 11, 24, 23), NOW)).toBe('Yesterday');
    expect(P.oftenText(80)).toBe('Most days');
    expect(P.oftenText(26)).toBe('About 2 times a week');
    expect(P.oftenText(12)).toBe('About once a week');
    expect(P.oftenText(2)).toBe('Now and then');
  });

  it('lists the ones to reach out to first', () => {
    const people: P.People = { mum: { ...mum }, jo: { name: 'Jo', at: 1, close: 'month', since: at(2026, 11, 1) }, gone: { name: '', at: 1, gone: true } };
    const seen = new Map<string, P.Seen>([
      ['mum', { name: 'Mum', last: at(2026, 11, 1), days: 20, calls: 40, named: 0 }],
      ['sam', { name: 'Sam', last: at(2026, 11, 5), days: 30, calls: 60, named: 2 }], // usually every 3 days, quiet 20
      ['kim', { name: 'Kim', last: at(2026, 11, 24), days: 2, calls: 2, named: 0 }],
      ['jo', { name: 'Jo', last: at(2026, 11, 20), days: 3, calls: 3, named: 0 }],
    ]);
    const r = P.rows(people, seen, NOW);
    expect(r.map((x) => x.key)).toEqual(['mum', 'jo', 'sam', 'kim']);
    expect(r[0].overdue).toBe(24);
    expect(r[1].overdue).toBeNull();
  });
});

describe('birthdays and dates', () => {
  it('finds the next day, with 29 February on the 28th in other years', () => {
    expect(P.nextDate('12-01', '2026-11-25')).toBe('2026-12-01');
    expect(P.nextDate('11-25', '2026-11-25')).toBe('2026-11-25');
    expect(P.nextDate('11-24', '2026-11-25')).toBe('2027-11-24');
    expect(P.nextDate('02-29', '2026-11-25')).toBe('2027-02-28');
    expect(P.nextDate('02-29', '2027-02-28')).toBe('2027-02-28');
    expect(P.nextDate('02-29', '2027-03-01')).toBe('2028-02-29');
    expect(P.nextDate('02-29', '2028-01-10')).toBe('2028-02-29');
    expect(P.nextDate('02-29', '2099-03-01')).toBe('2100-02-28'); // 2100 isn't a leap year
    expect(P.nextDate('01-01', '2026-12-31')).toBe('2027-01-01');
  });

  it('lists what is coming up, soonest first, without hidden people', () => {
    const people: P.People = {
      mum: { name: 'Mum', at: 1, dates: [{ label: 'Birthday', md: '12-03' }, { label: 'Anniversary', md: '11-25' }] },
      sam: { name: 'Sam', at: 1, dates: [{ label: 'Birthday', md: '11-24' }] },
      kim: { name: 'Kim', at: 1, hidden: true, dates: [{ label: 'Birthday', md: '11-26' }] },
    };
    const c = P.coming(people, '2026-11-25');
    expect(c.map((x) => [x.name, x.label, x.in])).toEqual([
      ['Mum', 'Anniversary', 0],
      ['Mum', 'Birthday', 8],
      ['Sam', 'Birthday', 364],
    ]);
    expect(P.coming(people, '2026-11-25', 7)).toHaveLength(1);
    expect(P.dateName('Mum', 'Birthday')).toBe("Mum's birthday");
    expect(P.dateName('Mum', 'Anniversary')).toBe('Anniversary (Mum)');
    expect(P.mdText('03-14')).toBe('14 March');
  });

  it('reads birthdays in calendar titles', () => {
    expect(P.birthdayIn("Mum's birthday")).toBe('Mum');
    expect(P.birthdayIn('Sam’s Birthday 🎂')).toBe('Sam');
    expect(P.birthdayIn('Birthday: Jo Smith')).toBe('Jo Smith');
    expect(P.birthdayIn('Birthday of Kim')).toBe('Kim');
    expect(P.birthdayIn("Dad's 60th birthday")).toBe('Dad');
    expect(P.birthdayIn('Alex Birthday')).toBe('Alex');
    expect(P.birthdayIn('My birthday')).toBe('');
    expect(P.birthdayIn('Birthday party at the park')).toBe('');
    expect(P.birthdayIn('Team lunch')).toBe('');
  });

  it('plans reminders the evening before and on the day, plain unless details are on', () => {
    const people: P.People = { mum: { name: 'Mum', at: 1, dates: [{ label: 'Birthday', md: '11-26' }] }, kim: { name: 'Kim', at: 1, hidden: true, dates: [{ label: 'Birthday', md: '11-26' }] } };
    const rules = { quietFrom: '22:00', quietTo: '07:00', details: false };
    const plain = P.dateNudges(people, { now: NOW, days: 3, rules, midnight: mid });
    expect(plain.map((n) => [new Date(n.at).toString(), n.title, n.body])).toEqual([
      [new Date(at(2026, 11, 25, 18)).toString(), 'A date coming up', 'Open Arise to see it.'],
      [new Date(at(2026, 11, 26, 9)).toString(), 'A date today', 'Open Arise to see it.'],
    ]);
    expect(new Set(plain.map((n) => n.tag)).size).toBe(2);
    const told = P.dateNudges(people, { now: NOW, days: 3, rules: { ...rules, details: true }, midnight: mid });
    expect(told.map((n) => n.title)).toEqual(["Mum's birthday is tomorrow", "Mum's birthday is today"]);
    // Past ones and ones beyond the days asked for are left out.
    expect(P.dateNudges(people, { now: at(2026, 11, 25, 19), days: 3, rules, midnight: mid })).toHaveLength(1);
    expect(P.dateNudges(people, { now: at(2026, 11, 20), days: 2, rules, midnight: mid })).toHaveLength(0);
    // Never in the quiet hours: the day's one moves to just after them, the evening's before them.
    const late = P.dateNudges(people, { now: NOW, days: 3, rules: { quietFrom: '17:00', quietTo: '10:00', details: false }, midnight: mid });
    expect(late.map((n) => new Date(n.at).getHours() * 60 + new Date(n.at).getMinutes())).toEqual([16 * 60, 10 * 60 + 30]);
  });
});

describe('for the coach', () => {
  it('gives names and dates only', () => {
    const people: P.People = {
      mum: { name: 'Mum', at: 1, close: 'week', last: 5, dates: [{ label: 'Birthday', md: '12-03' }] },
      sam: { name: 'Sam', at: 1, close: 'month', hidden: true },
      jo: { name: 'Jo', at: 1, dates: [{ label: 'Birthday', md: '06-01' }] },
    };
    const t = P.coachText(people, '2026-11-25');
    expect(t).toContain('Close people they want to keep in touch with: Mum.');
    expect(t).toContain("Mum's birthday: 3 December (in 8 days, 2026-12-03)");
    expect(t).not.toContain('Sam');
    expect(t).not.toContain('Jo'); // too far off
    expect(t).not.toMatch(/week|month/i);
    expect(P.coachText({}, '2026-11-25')).toBe('');
  });
});
