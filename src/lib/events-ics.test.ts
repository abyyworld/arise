// Your own events in and out of a calendar file: written for any calendar app, read back the same
// (a round trip), and files from other apps read into events of your own, with their repeats, time
// zones, days left out, single times changed, and reminders. Run with TZ=UTC.

import { describe, expect, it } from 'vitest';
import { cleanEvents, occurrences, type CalEvent, type CalEvents } from './events';
import { fromIcs, toIcs } from './events-ics';
import { parseIcs } from '../connect/ics';

const NOW = Date.UTC(2026, 9, 1, 12);
const pool = (list: object[]): CalEvents => cleanEvents(Object.fromEntries(list.map((e) => [(e as CalEvent).id, { created: NOW, at: NOW, ...e }])), NOW);
const strip = (e: CalEvent) => {
  const { at: _a, created: _c, ...rest } = e;
  return rest;
};

const MINE = pool([
  { id: 'e1', title: 'Team lunch, with Sam; and Jo', start: '2026-10-05T12:30', end: '2026-10-05T13:30', tz: 'Europe/London', location: 'The Park', notes: 'Bring:\nsandwiches', color: 'green', remind: [10, 60] },
  { id: 'e2', title: 'Standup', start: '2026-10-05T09:00', end: '2026-10-05T09:15', tz: 'America/Los_Angeles', repeat: { freq: 'weekly', days: [1, 3, 5], until: '2026-12-18' }, skip: ['2026-10-07T09:00'], changes: { '2026-10-09T09:00': { start: '2026-10-09T11:00', end: '2026-10-09T11:30', title: 'Standup, later' } }, remind: [5] },
  { id: 'e3', title: 'Trip to Rome', allDay: true, start: '2026-10-09', end: '2026-10-11', remind: [1440] },
  { id: 'e4', title: 'Birthday', allDay: true, start: '2026-03-02', repeat: { freq: 'yearly' }, remind: [0] },
  { id: 'e5', title: 'Pay rent', start: '2026-10-01T08:00', repeat: { freq: 'monthly', every: 1, count: 12 } },
  { id: 'e6', title: 'Floating', start: '2026-10-06T07:00', end: '2026-10-06T08:00', repeat: { freq: 'daily', every: 2, until: '2026-10-20' } },
  { id: 'gone', at: NOW, gone: true },
]);

describe('writing a calendar file', () => {
  it('has each event of your own, not deleted ones, in lines any calendar app reads', () => {
    const text = toIcs(MINE, NOW);
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Arise//Calendar//EN\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(text).not.toContain('gone@arise');
    const root = parseIcs(text);
    const vevents = root.comps[0].comps.filter((c) => c.type === 'VEVENT');
    expect(vevents).toHaveLength(7); // six events and one changed time
    expect(text).toContain('DTSTART;TZID=Europe/London:20261005T123000');
    expect(text).toContain('SUMMARY:Team lunch\\, with Sam\\; and Jo');
    expect(text).toContain('DESCRIPTION:Bring:\\nsandwiches');
    expect(text).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261219T075959Z'); // the end of 18 December in LA
    expect(text).toContain('EXDATE;TZID=America/Los_Angeles:20261007T090000');
    expect(text).toContain('RECURRENCE-ID;TZID=America/Los_Angeles:20261009T090000');
    expect(text).toContain('DTSTART;VALUE=DATE:20261009\r\nDTEND;VALUE=DATE:20261012'); // the day after the last
    expect(text).toContain('TRIGGER:-PT10M');
    expect(text).toContain('TRIGGER:-PT900M'); // a whole day's "1 day before": 9:00 the day before
    expect(text).toContain('TRIGGER:PT540M'); // a whole day's "at the time": 9:00 that day
  });

  it('reads back as the same events (a round trip), with the same times', () => {
    const back = fromIcs(toIcs(MINE, NOW), NOW + 5, 'Europe/Paris');
    expect(back.name).toBe('Arise');
    const theirs = Object.fromEntries(back.events.map((e) => [e.id, strip(e)]));
    const ours = Object.fromEntries(Object.values(MINE).filter((e) => !e.gone).map((e) => [e.id, strip(e)]));
    expect(theirs).toEqual(ours);
    expect(back.events.every((e) => e.at === NOW + 5)).toBe(true);
    const a = occurrences(MINE, Date.UTC(2026, 9, 1), Date.UTC(2027, 3, 1));
    const b = occurrences(pool(back.events), Date.UTC(2026, 9, 1), Date.UTC(2027, 3, 1));
    expect(b.map((o) => [o.id, o.key, o.start, o.end])).toEqual(a.map((o) => [o.id, o.key, o.start, o.end]));
  });
});

const GOOGLE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
X-WR-CALNAME:Work
BEGIN:VTIMEZONE
TZID:Custom/Zone
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0300
TZOFFSETTO:+0300
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly-1@google.com
DTSTART;TZID=Europe/London:20261005T100000
DTEND;TZID=Europe/London:20261005T110000
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH;UNTIL=20261130T235959Z
EXDATE;TZID=Europe/London:20261008T100000
SUMMARY:Planning
LOCATION:Room 4
DESCRIPTION:Agenda\\nfirst
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT30M
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:weekly-1@google.com
RECURRENCE-ID;TZID=Europe/London:20261012T100000
DTSTART;TZID=Europe/London:20261013T140000
DTEND;TZID=Europe/London:20261013T150000
SUMMARY:Planning (moved)
END:VEVENT
BEGIN:VEVENT
UID:weekly-1@google.com
RECURRENCE-ID;TZID=Europe/London:20261015T100000
STATUS:CANCELLED
DTSTART;TZID=Europe/London:20261015T100000
SUMMARY:Planning
END:VEVENT
BEGIN:VEVENT
UID:utc-1@google.com
DTSTART:20261020T170000Z
DTEND:20261020T180000Z
SUMMARY:Call with the US
END:VEVENT
BEGIN:VEVENT
UID:custom-1@google.com
DTSTART;TZID=Custom/Zone:20261021T120000
DURATION:PT45M
SUMMARY:In a zone only the file knows
END:VEVENT
BEGIN:VEVENT
UID:holiday-1@google.com
DTSTART;VALUE=DATE:20261224
DTEND;VALUE=DATE:20261227
SUMMARY:Christmas
END:VEVENT
BEGIN:VEVENT
UID:last-friday@google.com
DTSTART;TZID=America/Los_Angeles:20261030T160000
DTEND;TZID=America/Los_Angeles:20261030T170000
RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3
SUMMARY:Drinks
END:VEVENT
END:VCALENDAR`;

describe('reading a calendar file from another app', () => {
  const { events, name } = fromIcs(GOOGLE, NOW, 'Europe/London');
  const by = (title: string) => events.filter((e) => e.title === title);

  it('keeps a repeat with its days left out, its times changed, its zone and its reminders', () => {
    expect(name).toBe('Work');
    const [p] = by('Planning');
    expect(strip(p)).toMatchObject({ start: '2026-10-05T10:00', end: '2026-10-05T11:00', tz: 'Europe/London', location: 'Room 4', notes: 'Agenda\nfirst', remind: [30], repeat: { freq: 'weekly', days: [1, 4], until: '2026-11-30' } });
    expect(p.skip).toEqual(['2026-10-08T10:00', '2026-10-15T10:00']);
    expect(p.changes).toEqual({ '2026-10-12T10:00': { start: '2026-10-13T14:00', end: '2026-10-13T15:00', title: 'Planning (moved)' } });
    const times = occurrences(pool([p]), Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 20)).map((o) => [o.title, new Date(o.start).toISOString().slice(0, 16)]);
    expect(times).toEqual([
      ['Planning', '2026-10-05T09:00'],
      ['Planning (moved)', '2026-10-13T13:00'],
      ['Planning', '2026-10-19T09:00'],
    ]);
  });

  it("turns UTC and zones the device doesn't know into this device's, and keeps whole days", () => {
    expect(by('Call with the US')[0]).toMatchObject({ start: '2026-10-20T18:00', end: '2026-10-20T19:00', tz: 'Europe/London' });
    expect(by('In a zone only the file knows')[0]).toMatchObject({ start: '2026-10-21T10:00', end: '2026-10-21T10:45', tz: 'Europe/London' });
    expect(by('Christmas')[0]).toMatchObject({ allDay: true, start: '2026-12-24', end: '2026-12-26' });
  });

  it("brings a repeat Arise can't say in as its times, one by one", () => {
    const drinks = by('Drinks').sort((a, b) => (a.start < b.start ? -1 : 1));
    expect(drinks.map((e) => [e.start, e.end, e.repeat])).toEqual([
      ['2026-10-30T23:00', '2026-10-31T00:00', undefined], // 16:00 in LA is 23:00 in London, a week after London's clocks went back
      ['2026-11-28T00:00', '2026-11-28T01:00', undefined], // and midnight once LA's went back too
      ['2026-12-26T00:00', '2026-12-26T01:00', undefined],
    ]);
  });

  it('gives the same file the same ids, so reading it again changes events instead of adding more', () => {
    const again = fromIcs(GOOGLE, NOW + 1000, 'Europe/London');
    expect(again.events.map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort());
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it('says when a file is not a calendar', () => {
    expect(() => fromIcs('hello', NOW)).toThrow();
  });
});

describe('to-dos in a calendar file', () => {
  const file = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Hackathons and events\r\n${body}END:VCALENDAR\r\n`;
  it('come in as to-dos of your own: the title, the day (and time) due, done, and the calendar they came from', () => {
    const { todos, events } = fromIcs(
      file(
        [
          'BEGIN:VTODO\r\nUID:hx-todo-a@example\r\nDUE;VALUE=DATE:20261124\r\nSUMMARY:Decide 28 Nov: one event\\, or the other \r\n (a folded line)\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\n',
          'BEGIN:VTODO\r\nUID:hx-todo-b@example\r\nDUE:20261125T170000Z\r\nSUMMARY:Send the form\r\nEND:VTODO\r\n',
          'BEGIN:VTODO\r\nUID:hx-todo-c@example\r\nSUMMARY:Done already\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261120T100000Z\r\nEND:VTODO\r\n',
          'BEGIN:VTODO\r\nUID:hx-todo-d@example\r\nSUMMARY:Called off\r\nSTATUS:CANCELLED\r\nEND:VTODO\r\n',
          'BEGIN:VTODO\r\nUID:hx-todo-e@example\r\nEND:VTODO\r\n',
        ].join(''),
      ),
      NOW,
    );
    expect(events).toEqual([]);
    expect(todos.map(({ created: _c, at: _a, ...t }) => t)).toEqual([
      { id: expect.stringMatching(/^i/), title: 'Decide 28 Nov: one event, or the other (a folded line)', day: '2026-11-24', from: 'Hackathons and events' },
      { id: expect.stringMatching(/^i/), title: 'Send the form', day: '2026-11-25', time: '17:00', from: 'Hackathons and events' },
      { id: expect.stringMatching(/^i/), title: 'Done already', done: Date.UTC(2026, 10, 20, 10), from: 'Hackathons and events' },
    ]);
    // The same file read again makes the same ids, so it changes them instead of adding them twice.
    expect(fromIcs(file('BEGIN:VTODO\r\nUID:hx-todo-a@example\r\nSUMMARY:Renamed\r\nEND:VTODO\r\n'), NOW).todos[0].id).toBe(todos[0].id);
  });
});

describe('inviting people to an event', () => {
  it('keeps who is coming, and makes an invite they can accept', async () => {
    const { cleanEvent, guestsFrom } = await import('./events');
    const { inviteIcs, fromIcs } = await import('./events-ics');
    expect(guestsFrom('sam@example.com, Jo; "Ali" <ali@example.org>\nsam@example.com')).toEqual(['sam@example.com', 'Jo', 'ali@example.org']);
    const e = cleanEvent({ id: 'e1', title: 'Lab lunch', start: '2026-12-02T12:30', end: '2026-12-02T13:30', tz: 'Europe/London', guests: ['sam@example.com', 'Jo', ''], created: 1, at: 1 })!;
    expect(e.guests).toEqual(['sam@example.com', 'Jo']);
    const raw = inviteIcs(e, { organizer: 'me@example.com', now: Date.UTC(2026, 10, 25) });
    const text = raw.replace(/\r\n /g, ''); // long lines are folded
    expect(text).toContain('METHOD:REQUEST');
    expect(text).toContain('ORGANIZER:mailto:me@example.com');
    expect(text).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:sam@example.com');
    expect(text).not.toContain('Jo'); // a name with no address can't be invited by the file
    expect(inviteIcs(e)).toContain('METHOD:PUBLISH');
    // Read back: the guests come with it.
    expect(fromIcs(raw).events[0].guests).toEqual(['sam@example.com']);
  });
});
