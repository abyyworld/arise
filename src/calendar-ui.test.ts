// @vitest-environment jsdom
// The Calendar screen: in the main navigation and from Today; Month, Week, Day and List views with
// Today and back and forth; your events made, changed (one time of a repeat, or every time) and
// deleted in their sheet; to-dos and other calendars' events beside them, each opening what it
// is (other calendars' read-only); the filter; and a calendar file in and out.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

const NOW = new Date(2026, 10, 13, 10); // Friday 13 November 2026, 10:00
const at = NOW.getTime();

async function boot({ events = {}, todos = {}, linked = [] as object[], view = 'calendar' } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem("arise-tabs-shown", JSON.stringify(["goals", "coach"])); // the full tab bar (tabs.js)
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, todos, events }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  if (linked.length) await (await import('./life/log')).addEvents(linked as never);
  const S = await import('./store');
  await import('./app.js');
  return { S, CAL: await import('./calendar-ui.js'), AI: await import('./ai.js') };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const click = (sel: string) => {
  const el = $(sel);
  if (!el) throw new Error(`No ${sel}`);
  el.click();
};
const set = (sel: string, v: string) => {
  const el = $(sel) as HTMLInputElement;
  el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const tick = (sel: string, on = true) => {
  const el = $(sel) as HTMLInputElement;
  el.checked = on;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const submit = () => $('.ev-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const view = (v: string) => click(`[data-act="cal-view"][data-v="${v}"]`);
const whats = (sel: string) => $$(`${sel} .cal-what`).map((x) => x.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
  window.confirm = () => true;
});
afterEach(() => vi.useRealTimers());

const EVENTS = {
  standup: { id: 'standup', title: 'Standup', start: '2026-11-09T09:00', end: '2026-11-09T09:15', repeat: { freq: 'weekly', days: [1, 3, 5] }, color: 'teal', created: at, at },
  dentist: { id: 'dentist', title: 'Dentist', start: '2026-11-17T15:30', end: '2026-11-17T16:30', location: 'Clinic', color: 'red', remind: [60], created: at, at },
  trip: { id: 'trip', title: 'Trip to Rome', allDay: true, start: '2026-11-19', end: '2026-11-21', color: 'purple', created: at, at },
};
const TODOS = { rent: { id: 'rent', title: 'Pay rent', day: '2026-11-17', created: at, at }, call: { id: 'call', title: 'Call mum', day: '2026-11-13', time: '18:00', created: at, at } };
const LINKED = [
  { id: 'calendar:g1', source: 'calendar', kind: 'event', at: new Date(2026, 10, 17, 12).getTime(), end: new Date(2026, 10, 17, 13).getTime(), title: 'Team lunch', tier: 2, meta: { app: 'google-calendar', calendar: 'Work', location: 'Cafe' } },
  { id: 'calendar:ics:h:abc:1', source: 'calendar', kind: 'event', at: new Date(2026, 10, 17).getTime(), end: new Date(2026, 10, 18).getTime(), title: 'Holiday', tier: 2, meta: { app: 'ics', calendar: 'Holidays', allDay: true } },
];

describe('the Calendar screen', () => {
  it('is in the main navigation and opens from Today', async () => {
    await boot({ view: 'today' });
    expect($$('#tabs [data-v]').map((b) => b.dataset.v)).toEqual(['today', 'calendar', 'days', 'progress', 'goals', 'coach', 'settings']);
    click('#tabs [data-v="calendar"]');
    await vi.waitFor(() => expect(text('h1')).toBe('Calendar'));
    expect($('#tabs [data-v="calendar"]')!.classList.contains('on')).toBe(true);
    click('[data-act="nav"][data-v="today"]');
    click('#todoCard [data-act="nav"][data-v="calendar"]');
    await vi.waitFor(() => expect(text('h1')).toBe('Calendar'));
    expect(text('.cal-foot')).toContain('Your events are locked on your device before they sync. Not even Arise or its cloud providers can read them.');
  });

  it('shows the month with your events, to-dos and other calendars, and the picked day', async () => {
    await boot({ events: EVENTS, todos: TODOS, linked: LINKED });
    expect(text('.cal-title')).toBe(new Date(2026, 10, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    expect($$('.cal-grid .cal-cell:not(.blank)')).toHaveLength(30);
    await vi.waitFor(() => expect($('[data-d="2026-11-17"] .dot.ev')).not.toBeNull());
    expect($('[data-d="2026-11-17"]')!.getAttribute('aria-label')).toContain('1 event, 1 to do, 2 in your calendar');
    expect($('[data-d="2026-11-20"] .dot.own')).not.toBeNull(); // the trip, on its middle day
    // Today: the standup (a Friday), and the call.
    expect(whats('#calDay .cal-list')).toEqual(['Standup']);
    click('[data-d="2026-11-17"]');
    expect(whats('#calDay .cal-list')).toEqual(['Dentist']);
    expect(text('#calDay .qlist')).toContain('Pay rent');
    expect(whats('#calDay .cal-events')).toEqual(['Holiday', 'Team lunch']);
    // Next month and back.
    click('[data-act="cal-move"][data-n="1"]');
    expect($$('.cal-grid .cal-cell:not(.blank)')).toHaveLength(31);
    click('[data-act="cal-today"]');
    expect($('[data-d="2026-11-13"]')!.classList.contains('on')).toBe(true);
  });

  it('has week, day and list views, which go back and forth by their own length', async () => {
    await boot({ events: EVENTS, todos: TODOS });
    view('week');
    expect($$('.cal-dh').map((b) => b.querySelector('b')!.textContent)).toEqual(['9', '10', '11', '12', '13', '14', '15']);
    expect($$('.cal-col')).toHaveLength(7);
    // Three standups (Mon, Wed, Fri) at 9:00, 9 * 44px down; the call at 18:00 on Friday.
    const standups = $$('.cal-block [data-id="standup"]').map((b) => b.parentElement!.style.top);
    expect(standups).toEqual(['396px', '396px', '396px']);
    expect(whats('.cal-col[data-d="2026-11-13"]')).toEqual(['Standup', 'Call mum']);
    click('[data-act="cal-move"][data-n="1"]');
    expect(whats('.cal-ad')).toEqual(['Pay rent', 'Trip to Rome', 'Trip to Rome', 'Trip to Rome']);
    expect(whats('.cal-col[data-d="2026-11-17"]')).toEqual(['Dentist']);
    // A day from the week.
    click('.cal-dh[data-d="2026-11-17"]');
    expect($('[data-act="cal-view"][data-v="day"]')!.getAttribute('aria-pressed')).toBe('true');
    expect($$('.cal-col')).toHaveLength(1);
    expect(whats('#calDayHours .cal-ad')).toEqual(['Pay rent']);
    click('[data-act="cal-move"][data-n="1"]');
    expect($('.cal-col')!.dataset.d).toBe('2026-11-18');
    view('list');
    expect($$('.cal-agenda-day').length).toBeGreaterThan(5);
    expect(text('.cal-agenda-day')).toContain('Standup');
    // The view is kept for next time on this device.
    expect(JSON.parse(localStorage.getItem('arise-cal')!).view).toBe('list');
  });

  it('two overlapping events sit side by side', async () => {
    await boot({ events: { a: { ...EVENTS.dentist, id: 'a', start: '2026-11-13T12:00', end: '2026-11-13T13:00' }, b: { ...EVENTS.dentist, id: 'b', title: 'Call', start: '2026-11-13T12:30', end: '2026-11-13T13:30' } } });
    view('day');
    const blocks = $$('.cal-block');
    expect(blocks.map((b) => [b.style.left, b.style.width])).toEqual([
      ['0%', '50%'],
      ['50%', '50%'],
    ]);
  });

  it('filters by where things come from', async () => {
    await boot({ events: EVENTS, todos: TODOS, linked: LINKED });
    click('[data-d="2026-11-17"]');
    await vi.waitFor(() => expect(whats('#calDay .cal-events')).toHaveLength(2));
    click('[data-act="cal-filter"][data-v="google"]');
    expect(whats('#calDay .cal-events')).toEqual(['Holiday']);
    click('[data-act="cal-filter"][data-v="own"]');
    expect($('#calDay .cal-list')).toBeNull();
    expect($('[data-act="cal-filter"][data-v="own"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(localStorage.getItem('arise-cal')!).hide).toEqual(['google', 'own']);
    click('[data-act="cal-filter"][data-v="own"]');
    expect(whats('#calDay .cal-list')).toEqual(['Dentist']);
  });
});

describe('your events', () => {
  it('makes one with a repeat and reminders, and it reaches the coach', async () => {
    const { S, AI } = await boot();
    click('.cal-bar [data-act="cal-new"]');
    expect(text('.ev-sheet h2')).toBe('New event');
    expect(($('#evStartDay') as HTMLInputElement).value).toBe('2026-11-13');
    expect(($('#evStartTime') as HTMLInputElement).value).toBe('11:00'); // the next hour
    submit();
    expect(text('#toast')).toBe('Write a title first.');
    set('#evTitle', 'Piano lesson');
    set('#evStartTime', '17:00');
    set('#evEndTime', '16:00');
    submit();
    expect(text('#toast')).toBe('The end is before the start.');
    set('#evEndTime', '18:00');
    set('#evPlace', 'Music school');
    tick('input[name="evColor"][value="green"]');
    set('#evRepeat', 'weekly');
    expect($('.ev-form')!.dataset.repeat).toBe('weekly');
    tick('input[name="evDay"][value="1"]');
    set('#evEnds', 'after');
    set('#evCount', '6');
    tick('input[name="evRemind"][value="10"]');
    tick('input[name="evRemind"][value="1440"]');
    submit();
    expect(text('#toast')).toBe('Saved.');
    expect(document.getElementById('sheet')!.hidden).toBe(true);
    const [e] = Object.values(S.state.events);
    expect(e).toMatchObject({ title: 'Piano lesson', start: '2026-11-13T17:00', end: '2026-11-13T18:00', location: 'Music school', color: 'green', repeat: { freq: 'weekly', days: [1, 5], count: 6 }, remind: [10, 1440] });
    expect(e.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(whats('#calDay .cal-list')).toEqual(['Piano lesson']);
    expect(AI.buildContext()).toContain('## Calendar, next 7 days\n- 2026-11-13 17:00-18:00: Piano lesson\n- 2026-11-16 17:00-18:00: Piano lesson\n\n'); // (the 20th is a week away)
  });

  it('makes a whole-day one from an empty hour, and changes and deletes one that does not repeat', async () => {
    const { S } = await boot({ events: EVENTS });
    view('day');
    click('.cal-slot[data-h="14"]');
    expect(($('#evStartTime') as HTMLInputElement).value).toBe('14:00');
    set('#evTitle', 'Day off');
    tick('#evAllDay');
    expect($('.ev-form')!.dataset.allday).toBe('1');
    submit();
    const off = Object.values(S.state.events).find((e) => e.title === 'Day off')!;
    expect(off).toMatchObject({ allDay: true, start: '2026-11-13' });
    expect(off).not.toHaveProperty('tz');
    expect(whats('#calDayHours .cal-ad')).toEqual(['Day off']);
    // Change the dentist (no repeat: no "this time only").
    view('month');
    click('[data-d="2026-11-17"]');
    click('#calDay [data-act="cal-ev"][data-id="dentist"]');
    expect($('[data-act="ev-scope"]')).toBeNull();
    expect(($('#evPlace') as HTMLInputElement).value).toBe('Clinic');
    set('#evTitle', 'Dentist check-up');
    submit();
    expect(S.state.events.dentist).toMatchObject({ title: 'Dentist check-up', location: 'Clinic', remind: [60] });
    click('#calDay [data-act="cal-ev"][data-id="dentist"]');
    click('[data-act="ev-del"]');
    expect(S.state.events.dentist).toMatchObject({ gone: true, title: '' });
    expect(text('#toast')).toBe('Deleted "Dentist check-up".');
  });

  it('changes or deletes one time of a repeat, or every time', async () => {
    const { S } = await boot({ events: EVENTS });
    click('#calDay [data-act="cal-ev"][data-id="standup"]');
    expect($('[data-act="ev-scope"][data-v="one"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(text('.ev-sheet')).toContain('This changes only this time.');
    expect($('#evRepeat')).toBeNull();
    set('#evStartTime', '10:00');
    set('#evEndTime', '10:15');
    submit();
    expect(S.state.events.standup.changes).toEqual({ '2026-11-13T09:00': { start: '2026-11-13T10:00', end: '2026-11-13T10:15', title: 'Standup' } });
    expect($('#calDay .cal-when')!.textContent).toBe('10:00');
    // Delete next Monday's only.
    click('[data-d="2026-11-16"]');
    click('#calDay [data-act="cal-ev"][data-id="standup"]');
    click('[data-act="ev-del"]');
    expect(S.state.events.standup.skip).toEqual(['2026-11-16T09:00']);
    expect($('#calDay .cal-list')).toBeNull();
    expect(text('#toast')).toBe('Deleted this time.');
    // Every time: a new title for all of them.
    click('[data-d="2026-11-18"]');
    click('#calDay [data-act="cal-ev"][data-id="standup"]');
    click('[data-act="ev-scope"][data-v="all"]');
    expect(($('#evStartDay') as HTMLInputElement).value).toBe('2026-11-09'); // the first time
    expect(($('#evRepeat') as HTMLSelectElement).value).toBe('weekly');
    set('#evTitle', 'Team standup');
    submit();
    expect(S.state.events.standup).toMatchObject({ title: 'Team standup', skip: ['2026-11-16T09:00'], repeat: { freq: 'weekly', days: [1, 3, 5] } });
    expect(whats('#calDay .cal-list')).toEqual(['Team standup']);
    click('#calDay [data-act="cal-ev"][data-id="standup"]');
    click('[data-act="ev-scope"][data-v="all"]');
    click('[data-act="ev-del"]');
    expect(S.state.events.standup.gone).toBe(true);
  });

  it("opens a to-do's own sheet, and another calendar's event read-only", async () => {
    await boot({ events: EVENTS, todos: TODOS, linked: LINKED });
    view('week');
    click('[data-act="cal-move"][data-n="1"]');
    await vi.waitFor(() => expect($('[data-act="cal-linked"][data-id="calendar:g1"]')).not.toBeNull());
    click('.cal-ad [data-act="todo-edit"][data-id="rent"]');
    await vi.waitFor(() => expect($('.todo-sheet')).not.toBeNull());
    click('[data-act="cal-linked"][data-id="calendar:g1"]');
    await vi.waitFor(() => expect($('.ev-linked')).not.toBeNull());
    expect(text('.ev-linked')).toContain('Google Calendar: Work');
    expect(text('.ev-linked')).toContain('Team lunch');
    expect(text('.ev-linked')).toContain('Cafe');
    expect(text('.ev-linked')).toContain('Change it there.');
    expect($('.ev-linked input, .ev-linked [data-act="ev-del"], .ev-linked [data-act="life-ev-del"]')).toBeNull();
  });
});

describe('calendar files', () => {
  const FILE = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Work\r\nBEGIN:VEVENT\r\nUID:x1@example.com\r\nDTSTART;TZID=Europe/London:20261118T100000\r\nDTEND;TZID=Europe/London:20261118T110000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

  it('brings a file in as events of your own, and the same file again changes them', async () => {
    const { S, CAL } = await boot();
    expect(await CAL.importFile(new File([FILE], 'work.ics'))).toBe(1);
    expect(text('#toast')).toBe('Added 1 event from Work.');
    expect(Object.values(S.state.events)).toMatchObject([{ title: 'Planning', tz: 'Europe/London', repeat: { freq: 'weekly', count: 3 } }]);
    await CAL.importFile(new File([FILE], 'work.ics'));
    expect(Object.keys(S.state.events)).toHaveLength(1);
    expect(await CAL.importFile(new File(['not a calendar'], 'x.txt'))).toBe(0);
    expect(text('#toast')).toBe("That isn't a calendar file (.ics).");
  });

  it('gives your events as a file', async () => {
    await boot();
    click('[data-act="cal-export"]');
    expect(text('#toast')).toBe('No events of your own to export yet.');
    const { S } = await boot({ events: EVENTS });
    const made: Blob[] = [];
    URL.createObjectURL = ((b: Blob) => {
      made.push(b);
      return 'blob:x';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    const clicked: string[] = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    click('[data-act="cal-export"]');
    await vi.waitFor(() => expect(clicked).toEqual(['arise-calendar.ics']));
    const out = await made[0].text();
    expect(out).toContain('SUMMARY:Standup');
    expect(out).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(Object.keys(S.state.events).length);
  });
});

describe('inviting people', () => {
  it('saves who is coming and sends the invite through the email app with the file saved', async () => {
    const { S, CAL } = await boot();
    const created: string[] = [];
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      created.push(this.download);
    });
    S.addEvent({ id: 'ev1', title: 'Lab lunch', start: '2026-12-02T12:30', end: '2026-12-02T13:30' });
    const e = S.state.events.ev1;
    S.updateEvent('ev1', { ...e, guests: ['sam@example.com', 'Jo'] });
    const how = await CAL.sendInvite(S.state.events.ev1);
    expect(how).toBe('email');
    expect(created).toEqual(['Lab-lunch.ics']);
    expect(document.querySelector('#toast')!.textContent).toContain('Attach it to the email');
    expect(await CAL.sendInvite({ ...S.state.events.ev1, guests: ['Jo'] })).toBe('none');
    clicks.mockRestore();
  });
});
