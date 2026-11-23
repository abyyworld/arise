// Calendars by link: reading iCalendar text into life events, with time zones, whole days,
// repeats, days left out, moved and cancelled times.

import { describe, expect, it } from 'vitest';
import * as ICS from './ics';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const FEED = { id: 'f1', name: 'Work' };

const cal = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'X-WR-CALNAME:Team calendar', ...events, 'END:VCALENDAR'].join('\r\n');
const ev = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const read = (text: string, now = NOW) => ICS.readCalendar(text, FEED, now).events;
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe('reading the text', () => {
  it('joins folded lines, reads parameters (quoted too) and undoes escapes', () => {
    expect(ICS.unfold('A:one\r\n two\r\nB:x\n\tY\n')).toEqual(['A:onetwo', 'B:xY']);
    expect(ICS.parseLine('DTSTART;TZID="America/New_York";VALUE=DATE-TIME:20261101T090000')).toEqual({ name: 'DTSTART', params: { TZID: 'America/New_York', VALUE: 'DATE-TIME' }, value: '20261101T090000' });
    expect(ICS.parseLine('ATTENDEE;CN="Doe, Jane: boss":mailto:j@example.com')?.params.CN).toBe('Doe, Jane: boss');
    expect(ICS.parseLine('no colon here')).toBeNull();
    expect(ICS.unescape('Lunch\\, then a walk\\nby the sea\\; ok \\\\')).toBe('Lunch, then a walk\nby the sea; ok \\');
  });

  it('reads durations', () => {
    expect(ICS.parseDuration('PT1H30M')).toBe(90 * 60_000);
    expect(ICS.parseDuration('P1D')).toBe(86_400_000);
    expect(ICS.parseDuration('P2W')).toBe(14 * 86_400_000);
    expect(ICS.parseDuration('-PT15M')).toBe(-15 * 60_000);
    expect(ICS.parseDuration('soon')).toBeNull();
  });

  it("says when it isn't a calendar at all", () => {
    expect(() => read('<html><body>Sign in</body></html>')).toThrow(ICS.NotACalendar);
  });
});

describe('events', () => {
  it('turns one event into a calendar event in the life log, with its place and the calendar name', () => {
    const [e, ...rest] = read(cal(ev('UID:abc@example.com', 'DTSTART:20261124T090000Z', 'DTEND:20261124T100000Z', 'SUMMARY:Stand-up\\, team', 'LOCATION:Room 4', 'URL:https://example.com/m/1')));
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ source: 'calendar', kind: 'event', tier: 2, title: 'Stand-up, team', detail: 'At Room 4', url: 'https://example.com/m/1', meta: { app: 'ics', calendar: 'Work', feed: 'f1', location: 'Room 4' } });
    expect(iso(e.at)).toBe('2026-11-24T09:00:00Z');
    expect(iso(e.end!)).toBe('2026-11-24T10:00:00Z');
    expect(e.id).toMatch(/^calendar:ics:f1:[0-9a-f]{16}:[0-9a-z]+$/);
    expect(ICS.timeOfId(e.id)).toBe(e.at);
    expect(ICS.readCalendar(cal(), FEED, NOW).name).toBe('Team calendar');
  });

  it('calls an event with no title Busy, and uses DURATION when there is no end', () => {
    const [e] = read(cal(ev('UID:1', 'DTSTART:20261124T090000Z', 'DURATION:PT45M')));
    expect(e.title).toBe('Busy');
    expect(e.end! - e.at).toBe(45 * 60_000);
  });

  it('keeps a whole-day event on its day on this device', () => {
    const [e] = read(cal(ev('UID:2', 'DTSTART;VALUE=DATE:20261125', 'DTEND;VALUE=DATE:20261127', 'SUMMARY:Trip')));
    expect(e.at).toBe(local(2026, 11, 25));
    expect(e.end).toBe(local(2026, 11, 27));
    expect(e.meta?.allDay).toBe(true);
  });

  it('puts a time in a named time zone at the right moment, summer and winter', () => {
    const list = read(cal(ev('UID:3', 'DTSTART;TZID=America/New_York:20260701T090000', 'SUMMARY:Summer'), ev('UID:4', 'DTSTART;TZID=America/New_York:20261201T090000', 'SUMMARY:Winter')));
    expect(list.map((e) => iso(e.at))).toEqual(['2026-07-01T13:00:00Z', '2026-12-01T14:00:00Z']);
  });

  it("reads Outlook's Windows zone names and a calendar's own VTIMEZONE", () => {
    const tz = [
      'BEGIN:VTIMEZONE',
      'TZID:My Office Time',
      'BEGIN:STANDARD',
      'DTSTART:16011028T030000',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:16010325T020000',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
    ].join('\r\n');
    const list = read(
      cal(
        tz,
        ev('UID:5', 'DTSTART;TZID="W. Europe Standard Time":20260615T090000', 'SUMMARY:Windows'),
        ev('UID:6', 'DTSTART;TZID=My Office Time:20260615T090000', 'SUMMARY:Own summer'),
        ev('UID:7', 'DTSTART;TZID=My Office Time:20261215T090000', 'SUMMARY:Own winter'),
        ev('UID:8', 'DTSTART;TZID=/mozilla.org/20050126_1/Europe/London:20261215T090000', 'SUMMARY:Mozilla'),
      ),
    );
    const at = Object.fromEntries(list.map((e) => [e.title, iso(e.at)]));
    expect(at).toEqual({ Windows: '2026-06-15T07:00:00Z', 'Own summer': '2026-06-15T07:00:00Z', 'Own winter': '2026-12-15T08:00:00Z', Mozilla: '2026-12-15T09:00:00Z' });
  });

  it('leaves out cancelled events', () => {
    expect(read(cal(ev('UID:9', 'DTSTART:20261124T090000Z', 'STATUS:CANCELLED', 'SUMMARY:Off')))).toEqual([]);
  });

  it('keeps only the year back and about a year ahead', () => {
    const list = read(cal(ev('UID:a', 'DTSTART:20240101T090000Z', 'SUMMARY:Old'), ev('UID:b', 'DTSTART:20300101T090000Z', 'SUMMARY:Far'), ev('UID:c', 'DTSTART:20260101T090000Z', 'SUMMARY:This year')));
    expect(list.map((e) => e.title)).toEqual(['This year']);
  });
});

describe('repeats', () => {
  const times = (lines: string[], now = NOW) => read(cal(ev('UID:r', 'SUMMARY:R', ...lines)), now).map((e) => iso(e.at));

  it('every other day until a date', () => {
    expect(times(['DTSTART:20261120T070000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261128T070000Z'])).toEqual(['2026-11-20T07:00:00Z', '2026-11-22T07:00:00Z', '2026-11-24T07:00:00Z', '2026-11-26T07:00:00Z', '2026-11-28T07:00:00Z']);
  });

  it('on some weekdays, a number of times', () => {
    expect(times(['DTSTART:20261123T180000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5'])).toEqual(['2026-11-23T18:00:00Z', '2026-11-25T18:00:00Z', '2026-11-27T18:00:00Z', '2026-11-30T18:00:00Z', '2026-12-02T18:00:00Z']);
  });

  it('every two weeks', () => {
    expect(times(['DTSTART:20261102T100000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3'])).toEqual(['2026-11-02T10:00:00Z', '2026-11-16T10:00:00Z', '2026-11-30T10:00:00Z']);
  });

  it('stays at 9:00 on the local clock when the clocks change', () => {
    expect(times(['DTSTART;TZID=Europe/London:20261019T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'])).toEqual(['2026-10-19T08:00:00Z', '2026-10-26T09:00:00Z', '2026-11-02T09:00:00Z']);
  });

  it('on the last Friday of each month, and the second Tuesday', () => {
    expect(times(['DTSTART:20261030T160000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=4'])).toEqual(['2026-10-30T16:00:00Z', '2026-11-27T16:00:00Z', '2026-12-25T16:00:00Z', '2027-01-29T16:00:00Z']);
    expect(times(['DTSTART:20261110T120000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3'])).toEqual(['2026-11-10T12:00:00Z', '2026-12-08T12:00:00Z', '2027-01-12T12:00:00Z']);
  });

  it('on the 31st, skipping shorter months, and the last day of each month', () => {
    expect(times(['DTSTART:20261031T090000Z', 'RRULE:FREQ=MONTHLY;COUNT=3'])).toEqual(['2026-10-31T09:00:00Z', '2026-12-31T09:00:00Z', '2027-01-31T09:00:00Z']);
    expect(times(['DTSTART:20261130T090000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3'])).toEqual(['2026-11-30T09:00:00Z', '2026-12-31T09:00:00Z', '2027-01-31T09:00:00Z']);
  });

  it('the last weekday of a month (BYSETPOS)', () => {
    expect(times(['DTSTART:20261130T090000Z', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3'])).toEqual(['2026-11-30T09:00:00Z', '2026-12-31T09:00:00Z', '2027-01-29T09:00:00Z']);
  });

  it('a birthday every year, as a whole day', () => {
    const list = read(cal(ev('UID:bd', 'SUMMARY:Sam turns', 'DTSTART;VALUE=DATE:19900310', 'RRULE:FREQ=YEARLY')));
    expect(list.map((e) => e.at)).toEqual([local(2026, 3, 10), local(2027, 3, 10)]);
    expect(list.every((e) => e.meta?.allDay)).toBe(true);
  });

  it('the fourth Thursday of November, every year', () => {
    expect(times(['DTSTART:20201126T170000Z', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'])).toEqual(['2025-11-27T17:00:00Z', '2026-11-26T17:00:00Z', '2027-11-25T17:00:00Z']);
  });

  it('counts from the first time even before the year back', () => {
    // 2025-01-06 plus 50 weeks: the last is 2025-12-15, inside the window; 2026 has none.
    expect(times(['DTSTART:20250106T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=50'])).toEqual(['2025-11-24T08:00:00Z', '2025-12-01T08:00:00Z', '2025-12-08T08:00:00Z', '2025-12-15T08:00:00Z']);
  });

  it('a daily repeat with no end gives each day of the window once', () => {
    const list = times(['DTSTART:20200101T060000Z', 'RRULE:FREQ=DAILY']);
    expect(list[0]).toBe('2025-11-24T06:00:00Z');
    expect(list.at(-1)).toBe('2027-12-28T06:00:00Z');
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBe(765);
  });

  it('leaves out the days in EXDATE, and adds those in RDATE', () => {
    expect(times(['DTSTART:20261123T090000Z', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE:20261124T090000Z,20261125T090000Z', 'RDATE:20261201T090000Z'])).toEqual(['2026-11-23T09:00:00Z', '2026-11-26T09:00:00Z', '2026-12-01T09:00:00Z']);
    expect(times(['DTSTART;TZID=Europe/Paris:20261123T090000', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;TZID=Europe/Paris:20261124T090000'])).toEqual(['2026-11-23T08:00:00Z', '2026-11-25T08:00:00Z']);
  });

  it('moves one time of a repeat, and drops one that was cancelled, with stable ids', () => {
    const series = ev('UID:weekly', 'SUMMARY:1:1', 'DTSTART:20261123T150000Z', 'DTEND:20261123T153000Z', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const moved = ev('UID:weekly', 'SUMMARY:1:1 (moved)', 'RECURRENCE-ID:20261130T150000Z', 'DTSTART:20261201T100000Z', 'DTEND:20261201T103000Z');
    const gone = ev('UID:weekly', 'SUMMARY:1:1', 'RECURRENCE-ID:20261207T150000Z', 'DTSTART:20261207T150000Z', 'STATUS:CANCELLED');
    const plain = read(cal(series));
    const list = read(cal(series, moved, gone));
    expect(list.map((e) => [e.title, iso(e.at)])).toEqual([
      ['1:1', '2026-11-23T15:00:00Z'],
      ['1:1 (moved)', '2026-12-01T10:00:00Z'],
    ]);
    expect(iso(list[1].end!)).toBe('2026-12-01T10:30:00Z');
    // The moved one keeps the id of the time it replaced.
    expect(list[1].id).toBe(plain[1].id);
  });

  it('only counts the first time of repeats it does not follow (every hour)', () => {
    expect(times(['DTSTART:20261123T090000Z', 'RRULE:FREQ=HOURLY;COUNT=5'])).toEqual(['2026-11-23T09:00:00Z']);
  });
});
