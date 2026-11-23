// Your own calendar events: checked field by field, merged per event (the later change wins,
// deletions too), repeats worked out on the wall clock of their time zone (through the clocks
// changing in London and Los Angeles), times left out or changed on their own, and reminders.
// Run with TZ=UTC (as `npm test` is in CI), so "this device" is on UTC.

import { describe, expect, it } from 'vitest';
import { cleanEvent, cleanEvents, isTimeOf, mergeEvents, MAX_EVENTS, nextTime, occurrences, onDay, reminders, reminderText, remindLabel, repeatLabel, type CalEvent, type CalEvents } from './events';

const NOW = Date.UTC(2026, 9, 1, 12); // 1 October 2026
const DAY = 86_400_000;
const ev = (id: string, extra: Partial<CalEvent> & Record<string, unknown> = {}) => ({ id, title: `Event ${id}`, start: '2026-10-05T09:00', end: '2026-10-05T10:00', created: NOW - DAY, at: NOW - DAY, ...extra }) as CalEvent;
const pool = (...list: CalEvent[]) => cleanEvents(Object.fromEntries(list.map((e) => [e.id, e])), NOW);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);
const between = (events: CalEvents, a: string, b: string) => occurrences(events, Date.parse(`${a}Z`), Date.parse(`${b}Z`));

describe('an event', () => {
  it('keeps only what it may have', () => {
    expect(cleanEvent({ ...ev('a'), title: '  Team\nlunch ', location: ' The\tPark ', notes: 'Line one\r\nLine two\u0000', color: 'red', tz: 'Europe/London', remind: [10, 10, 0, -5, 99999], extra: 1 })).toEqual({
      id: 'a',
      title: 'Team lunch',
      start: '2026-10-05T09:00',
      end: '2026-10-05T10:00',
      tz: 'Europe/London',
      location: 'The Park',
      notes: 'Line one\nLine two',
      color: 'red',
      remind: [0, 10],
      created: NOW - DAY,
      at: NOW - DAY,
    });
    expect(cleanEvent({ ...ev('a'), title: '' })).toBeNull();
    expect(cleanEvent({ ...ev('a'), start: '2026-02-30T09:00' })).toBeNull();
    expect(cleanEvent({ ...ev('a'), start: '2026-10-05' })).toBeNull(); // a day only with allDay
    expect(cleanEvent({ ...ev('a'), id: 'a b' })).toBeNull();
    expect(cleanEvent({ ...ev('a'), color: 'chartreuse', tz: 'Not a zone!' })).not.toHaveProperty('color');
    expect(cleanEvent({ ...ev('a'), tz: 'Not a zone!' })).not.toHaveProperty('tz');
    // An end before the start goes.
    expect(cleanEvent({ ...ev('a'), end: '2026-10-05T08:00' })).not.toHaveProperty('end');
    // A whole day: days only, and no time zone.
    expect(cleanEvent({ ...ev('d'), allDay: true, start: '2026-10-05', end: '2026-10-07', tz: 'Europe/London' })).toEqual({ id: 'd', title: 'Event d', allDay: true, start: '2026-10-05', end: '2026-10-07', created: NOW - DAY, at: NOW - DAY });
    expect(cleanEvent({ id: 'g', at: NOW, gone: true, title: 'secret', start: 'x' })).toEqual({ id: 'g', title: '', start: '', created: NOW, at: NOW, gone: true });
  });

  it('keeps a repeat, the times left out and the ones changed, when they fit', () => {
    const e = cleanEvent({
      ...ev('r'),
      repeat: { freq: 'weekly', days: [3, 1, 1, 9], every: 2, until: '2026-12-31', count: 4 },
      skip: ['2026-10-12T09:00', 'nonsense', '2026-10-12'],
      changes: { '2026-10-19T09:00': { start: '2026-10-20T11:00', end: '2026-10-20T12:00', title: 'Moved', junk: 1 }, bad: { start: '2026-10-20T11:00' }, '2026-10-26T09:00': { start: 'no' } },
    })!;
    expect(e.repeat).toEqual({ freq: 'weekly', days: [1, 3], every: 2, until: '2026-12-31' }); // until wins over a count
    expect(e.skip).toEqual(['2026-10-12T09:00']);
    expect(e.changes).toEqual({ '2026-10-19T09:00': { start: '2026-10-20T11:00', end: '2026-10-20T12:00', title: 'Moved' } });
    expect(cleanEvent({ ...ev('r'), repeat: { freq: 'hourly' }, skip: ['2026-10-12T09:00'] })).not.toHaveProperty('skip'); // no repeat, nothing to skip
  });

  it('lets old deletions go, keeps at most the newest events, in a fixed order', () => {
    const raw = { old: { id: 'old', at: NOW - 200 * DAY, gone: true }, keep: ev('keep'), wrong: ev('other') };
    expect(Object.keys(cleanEvents(raw, NOW))).toEqual(['keep']);
    const many = Object.fromEntries(Array.from({ length: MAX_EVENTS + 3 }, (_, i) => [`e${i}`, ev(`e${i}`, { at: NOW - i })]));
    const kept = cleanEvents({ ...many, g: { id: 'g', at: NOW - 10 * DAY, gone: true } }, NOW);
    expect(Object.keys(kept)).toHaveLength(MAX_EVENTS + 1);
    expect(kept).not.toHaveProperty(`e${MAX_EVENTS + 2}`);
    expect(kept.g).toMatchObject({ gone: true }); // deletions aren't pushed out
    expect(JSON.stringify(cleanEvents({ b: ev('b'), a: ev('a') }, NOW))).toBe(JSON.stringify(cleanEvents({ a: ev('a'), b: ev('b') }, NOW)));
  });
});

describe('two copies', () => {
  it('take each event from the copy that changed it last, deletions too', () => {
    const a = pool(ev('x', { title: 'Newer here', at: NOW - 10 }), ev('y', { at: NOW - 5 }), ev('z'));
    const b = pool(ev('x', { title: 'Older there', at: NOW - 20 }), { id: 'y', at: NOW - 1, gone: true } as CalEvent, ev('w'));
    const m = mergeEvents(a, b, NOW);
    expect(m.x.title).toBe('Newer here');
    expect(m.y.gone).toBe(true);
    expect(Object.keys(m)).toEqual(['w', 'x', 'y', 'z']);
    expect(mergeEvents(b, a, NOW)).toEqual(m);
    // A deletion that's older than a change elsewhere doesn't win.
    const c = pool({ id: 'z', at: NOW - 2 * DAY, gone: true } as CalEvent);
    expect(mergeEvents(a, c, NOW).z.gone).toBeUndefined();
  });
});

describe('repeats', () => {
  it('keeps a weekly 9:00 in London at 9:00 there when the clocks go back', () => {
    const e = pool(ev('w', { start: '2026-10-19T09:00', end: '2026-10-19T09:30', tz: 'Europe/London', repeat: { freq: 'weekly', days: [1, 3] } }));
    const list = between(e, '2026-10-19T00:00', '2026-11-03T00:00');
    expect(list.map((o) => iso(o.start))).toEqual(['2026-10-19T08:00', '2026-10-21T08:00', '2026-10-26T09:00', '2026-10-28T09:00', '2026-11-02T09:00']);
    expect(list.map((o) => o.key)).toEqual(['2026-10-19T09:00', '2026-10-21T09:00', '2026-10-26T09:00', '2026-10-28T09:00', '2026-11-02T09:00']);
    expect(list.every((o) => o.end - o.start === 30 * 60_000)).toBe(true);
    // And forward again in spring.
    expect(between(e, '2026-03-23T00:00', '2026-04-02T00:00')).toEqual([]); // (it starts in October)
    const spring = pool(ev('s', { start: '2026-03-23T09:00', tz: 'Europe/London', repeat: { freq: 'weekly' } }));
    expect(between(spring, '2026-03-23T00:00', '2026-04-07T00:00').map((o) => iso(o.start))).toEqual(['2026-03-23T09:00', '2026-03-30T08:00', '2026-04-06T08:00']);
  });

  it('keeps a daily 9:00 in Los Angeles at 9:00 there, in March and November', () => {
    const e = pool(ev('la', { start: '2026-03-06T09:00', end: '2026-03-06T10:00', tz: 'America/Los_Angeles', repeat: { freq: 'daily' } }));
    expect(between(e, '2026-03-07T00:00', '2026-03-10T00:00').map((o) => iso(o.start))).toEqual(['2026-03-07T17:00', '2026-03-08T16:00', '2026-03-09T16:00']);
    expect(between(e, '2026-10-31T00:00', '2026-11-03T00:00').map((o) => iso(o.start))).toEqual(['2026-10-31T16:00', '2026-11-01T17:00', '2026-11-02T17:00']);
    // The day it's on, on this device (UTC here): 9:00 in LA is the same day.
    expect(between(e, '2026-11-01T00:00', '2026-11-02T00:00')[0].day).toBe('2026-11-01');
    // A late one in LA falls on the next day here.
    const late = pool(ev('n', { start: '2026-11-05T20:00', end: '2026-11-05T21:00', tz: 'America/Los_Angeles' }));
    expect(onDay(late, '2026-11-06').map((o) => iso(o.start))).toEqual(['2026-11-06T04:00']);
    expect(onDay(late, '2026-11-05')).toEqual([]);
  });

  it('stops after so many times or on a day, and leaves out and changes single times', () => {
    const counted = pool(ev('c', { start: '2026-10-05T09:00', repeat: { freq: 'daily', count: 3 } }));
    expect(between(counted, '2026-10-01T00:00', '2026-10-31T00:00').map((o) => o.key)).toEqual(['2026-10-05T09:00', '2026-10-06T09:00', '2026-10-07T09:00']);
    const until = pool(ev('u', { start: '2026-10-05T09:00', repeat: { freq: 'weekly', every: 2, until: '2026-11-02' } }));
    expect(between(until, '2026-10-01T00:00', '2026-12-31T00:00').map((o) => o.key)).toEqual(['2026-10-05T09:00', '2026-10-19T09:00', '2026-11-02T09:00']);
    const changed = pool(
      ev('m', {
        start: '2026-10-05T09:00',
        end: '2026-10-05T10:00',
        repeat: { freq: 'weekly' },
        skip: ['2026-10-12T09:00'],
        changes: { '2026-10-19T09:00': { start: '2026-10-23T15:00', end: '2026-10-23T16:00', title: 'Moved to Friday', location: 'Room 2' }, '2026-10-20T09:00': { start: '2026-10-20T09:00' } },
      }),
    );
    const list = between(changed, '2026-10-01T00:00', '2026-10-31T00:00');
    expect(list.map((o) => [o.key, iso(o.start), o.title, o.changed])).toEqual([
      ['2026-10-05T09:00', '2026-10-05T09:00', 'Event m', false],
      ['2026-10-19T09:00', '2026-10-23T15:00', 'Moved to Friday', true],
      ['2026-10-26T09:00', '2026-10-26T09:00', 'Event m', false],
    ]);
    expect(list[1].location).toBe('Room 2');
    // A change for a time the repeat doesn't have (a Tuesday) never shows.
    expect(isTimeOf(changed.m, '2026-10-20T09:00')).toBe(false);
    expect(isTimeOf(changed.m, '2026-10-26T09:00')).toBe(true);
    // A time moved from outside the window into it shows; one moved out of it doesn't.
    expect(between(changed, '2026-10-23T00:00', '2026-10-24T00:00').map((o) => o.title)).toEqual(['Moved to Friday']);
    expect(between(changed, '2026-10-19T00:00', '2026-10-20T00:00')).toEqual([]);
  });

  it('skips months without the day, and 29 February in other years', () => {
    const monthly = pool(ev('m31', { start: '2026-01-31T18:00', repeat: { freq: 'monthly' } }));
    expect(between(monthly, '2026-01-01T00:00', '2026-06-01T00:00').map((o) => o.key.slice(0, 10))).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    const leap = pool(ev('feb', { allDay: true, start: '2028-02-29', end: undefined, repeat: { freq: 'yearly' } } as never));
    expect(between(leap, '2028-01-01T00:00', '2033-01-01T00:00').map((o) => o.key)).toEqual(['2028-02-29', '2032-02-29']);
  });

  it('spans whole days, and finds the next time', () => {
    const trip = pool(ev('t', { allDay: true, start: '2026-10-09', end: '2026-10-11' } as never));
    const o = onDay(trip, '2026-10-10')[0];
    expect([o.day, o.lastDay, iso(o.start), iso(o.end)]).toEqual(['2026-10-09', '2026-10-11', '2026-10-09T00:00', '2026-10-12T00:00']);
    expect(onDay(trip, '2026-10-12')).toEqual([]);
    const weekly = pool(ev('n', { start: '2026-10-05T09:00', repeat: { freq: 'weekly' } }));
    expect(nextTime(weekly.n, Date.parse('2026-10-20T00:00Z'))!.key).toBe('2026-10-26T09:00');
    expect(repeatLabel(weekly.n.repeat)).toBe('Every week');
    expect(repeatLabel({ freq: 'weekly', every: 2, days: [1, 3], count: 5 })).toMatch(/^Every 2 weeks on .+, .+, 5 times$/);
  });
});

describe('reminders', () => {
  const base = { start: '2026-10-05T09:00', end: '2026-10-05T10:00', tz: 'Europe/London', location: 'Clinic' };
  it('come at each time chosen before each time of the event, soonest first', () => {
    const e = pool(ev('a', { ...base, title: 'Dentist', remind: [10, 60] }), ev('b', { title: 'No reminders' }), ev('c', { allDay: true, start: '2026-10-06', end: undefined, title: 'Birthday', remind: [0, 1440] } as never));
    const list = reminders(e, Date.parse('2026-10-05T06:00Z'), Date.parse('2026-10-07T00:00Z'));
    expect(list.map((r) => [r.tag, iso(r.at)])).toEqual([
      ['ev-a-2026-10-05T09:00-60', '2026-10-05T07:00'], // 9:00 in London is 8:00 UTC in October
      ['ev-a-2026-10-05T09:00-10', '2026-10-05T07:50'],
      ['ev-c-2026-10-06-1440', '2026-10-05T09:00'], // a whole day: 9:00 the day before
      ['ev-c-2026-10-06-0', '2026-10-06T09:00'], // and 9:00 on the day
    ]);
    // Only what's still to come.
    expect(reminders(e, Date.parse('2026-10-05T07:55Z'), Date.parse('2026-10-05T12:00Z')).map((r) => r.tag)).toEqual(['ev-c-2026-10-06-1440']);
  });

  it('follow a repeat through the clocks changing, without times left out', () => {
    const e = pool(ev('w', { ...base, start: '2026-10-19T09:00', end: '2026-10-19T09:30', repeat: { freq: 'weekly' }, skip: ['2026-11-02T09:00'], remind: [5] }));
    expect(reminders(e, Date.parse('2026-10-18T00:00Z'), Date.parse('2026-11-10T00:00Z')).map((r) => iso(r.at))).toEqual(['2026-10-19T07:55', '2026-10-26T08:55', '2026-11-09T08:55']);
  });

  it('say what and when only with details on', () => {
    const [r] = reminders(pool(ev('a', { ...base, title: 'Dentist', remind: [10] })), Date.parse('2026-10-05T00:00Z'), Date.parse('2026-10-06T00:00Z'));
    expect(reminderText(r, false)).toEqual({ title: 'Something in your calendar', body: 'Open Arise to see it.' });
    expect(reminderText(r, true)).toEqual({ title: 'Dentist', body: 'At 08:00, Clinic.' }); // (this device's clock: UTC)
    expect(remindLabel(0)).toBe('At the time');
    expect(remindLabel(30)).toBe('30 minutes before');
    expect(remindLabel(60)).toBe('1 hour before');
    expect(remindLabel(1440)).toBe('1 day before');
  });
});
