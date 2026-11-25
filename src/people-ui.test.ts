// @vitest-environment jsdom
// People on screen: the way in from Me, the list from calls, messages, calendar events and notes
// (the ones to reach out to first), keeping in touch with someone, the nudge on Today with Done,
// Later and Stop for them, birthdays added by hand and found in the calendar, their reminders on
// the device, hiding someone for good, and what the coach may read.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './life/types';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const NOW = new Date(2026, 10, 25, 10); // Wednesday 25 November 2026, 10:00
const ago = (days: number, h = 12) => new Date(2026, 10, 25 - days, h).getTime();
const msg = (who: string, days: number, n = 0): LifeEvent => ({ id: `whatsapp:${who}${days}-${n}`, source: 'whatsapp', kind: 'message', at: ago(days), title: `Chatted with ${who}`, tier: 3, meta: { chat: who } });

const EVENTS: LifeEvent[] = [
  // Mum: most weeks until three weeks ago.
  ...[21, 28, 35, 42, 49, 56, 63].map((d) => msg('Mum', d)),
  // Sam: every few days, the last two days ago.
  ...[2, 5, 8, 11, 14, 17, 20].map((d) => msg('Sam', d)),
  // Kim (added in Arise): named in a calendar event and a note.
  { id: 'calendar:lunch', source: 'calendar', kind: 'event', at: ago(10), end: ago(10) + 3600_000, title: 'Lunch with Kim', tier: 2 },
  { id: 'manual:note1', source: 'manual', kind: 'note', at: ago(40), title: 'A note', detail: 'Kim said the new flat is great.', tier: 2 },
  // A birthday in the calendar, coming up.
  { id: 'calendar:dad', source: 'calendar', kind: 'event', at: new Date(2026, 11, 2).getTime(), end: new Date(2026, 11, 3).getTime(), title: "Dad's birthday", tier: 2, meta: { allDay: true } },
];

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

const PEOPLE = {
  mum: { name: 'Mum', at: 1, close: 'week', since: ago(80) },
  kim: { name: 'Kim', at: 1, own: true },
};

async function boot(view: string, { events = EVENTS, data = {} as Record<string, unknown> } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, people: PEOPLE, ...data }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const L = await import('./life/log');
  await L.addEvents(events);
  const S = await import('./store');
  await import('./app.js');
  const PP = await import('./people');
  await PP.refresh({ maxAge: 0 });
  return { S, L, PP };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const names = () => [...document.querySelectorAll('#peopleList .people-row b')].map((b) => b.textContent);
const tick = () => new Promise((r) => setTimeout(r, 0));
const tap = async (sel: string) => {
  $(sel)!.click();
  await tick();
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
afterEach(() => vi.useRealTimers());

describe('People', () => {
  it('opens from Me and lists who to reach out to first', async () => {
    await boot('progress');
    expect(text('.people-entry')).toContain('Keeping in touch with 1.');
    await tap('.people-entry [data-v="people"]');
    expect(location.hash).toBe('#people');
    await until(() => names().length === 3);
    // Mum is close and overdue; Sam was in touch 2 days ago, Kim 10 days ago (named in the calendar).
    expect(names()).toEqual(['Mum', 'Kim', 'Sam']);
    const rows = [...document.querySelectorAll('#peopleList .people-row')].map((r) => r.textContent!.replace(/\s+/g, ' ').trim());
    expect(rows[0]).toContain('In touch 3 weeks ago');
    expect(rows[0]).toContain('Every week');
    expect(rows[2]).toContain('In touch 2 days ago');
    expect(rows[2]).toContain('A few times a month');
    expect(rows[1]).toContain('In touch 10 days ago');
    // The birthday in the calendar, to add.
    expect(text('.people-found')).toContain("Dad's birthday, 2 December");
    await tap('[data-act="people-found-add"]');
    expect(text('.people-dates')).toContain("Dad's birthday");
    expect(text('.people-dates')).toContain('2 December, in 7 days');
    expect($('.people-found')).toBeNull();
  });

  it('keeps in touch with someone, and takes it back', async () => {
    const { S } = await boot('people');
    await until(() => names().includes('Sam'));
    await tap('[data-act="people-open"][data-key="sam"]');
    expect(text('.people-sheet h2')).toBe('Sam');
    expect(text('.people-sheet')).toContain('From calls and messages.');
    await tap('.people-sheet [data-act="people-close"][data-v="2weeks"]');
    expect(S.state.people.sam).toMatchObject({ name: 'Sam', close: '2weeks' });
    expect(text('#toast')).toContain('Keeping in touch with Sam: every 2 weeks.');
    // Saved for sync.
    expect(JSON.parse(localStorage.getItem('pit-data-v1')!).people.sam.close).toBe('2weeks');
    await tap('.people-sheet [data-act="people-close"][data-v=""]');
    expect(S.state.people.sam.close).toBeUndefined();
  });

  it('adds a birthday by hand and reminds the evening before and on the day', async () => {
    const { S, PP } = await boot('people');
    ($('#peopleName') as HTMLInputElement).value = 'Jo';
    ($('#peopleBirthday') as HTMLInputElement).value = '1990-11-26';
    ($('#peopleOften') as HTMLSelectElement).value = 'month';
    $('.people-add')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(S.state.people.jo).toMatchObject({ name: 'Jo', own: true, close: 'month', dates: [{ label: 'Birthday', md: '11-26' }] });
    expect(text('.people-dates')).toContain("Jo's birthday");
    // Plain on the lock screen.
    const plain = PP.nudges(Date.now(), 3).filter((n) => n.tag.startsWith('date-jo'));
    expect(plain.map((n) => [new Date(n.at).getDate(), new Date(n.at).getHours(), n.title])).toEqual([
      [25, 18, 'A date coming up'],
      [26, 9, 'A date today'],
    ]);
    // In the phone's own reminders, among the next-step messages.
    const N = await import('./native.js');
    const up = N.upcoming(new Date(NOW));
    expect(up.some((r: { id: number; title: string }) => r.id >= 8000 && r.id < 9000 && r.title === 'A date coming up')).toBe(true);
    // With details on, it says whose.
    S.state.settings.notifyDetails = true;
    expect(PP.nudges(Date.now(), 3)[0].title).toBe("Jo's birthday is tomorrow");
    // Today shows it the day before.
    document.body.insertAdjacentHTML('beforeend', '<button id="goToday" data-act="nav" data-v="today"></button>');
    await tap('#goToday');
    expect(text('#peopleToday')).toContain("Tomorrow: Jo's birthday.");
  });

  it('hides someone for good, and shows them again', async () => {
    const { S } = await boot('people');
    await until(() => names().includes('Sam'));
    await tap('[data-act="people-open"][data-key="sam"]');
    await tap('.people-sheet [data-act="people-hide"]');
    expect($('#sheet')!.hidden).toBe(true);
    expect(S.state.people.sam.hidden).toBe(true);
    expect(names()).not.toContain('Sam');
    expect(text('.people-hidden summary')).toBe('Hidden (1)');
    await tap('[data-act="people-unhide"][data-key="sam"]');
    expect(names()).toContain('Sam');
    expect($('.people-hidden')).toBeNull();
  });

  it('removes someone added by hand who is nowhere else', async () => {
    const { S } = await boot('people', { events: [] });
    await tap('[data-act="people-open"][data-key="kim"]');
    expect($('.people-sheet [data-act="people-hide"]')).toBeNull();
    await tap('.people-sheet [data-act="people-remove"]');
    expect(S.state.people.kim.gone).toBe(true);
    expect(names()).toEqual(['Mum']);
  });
});

describe('the nudge on Today', () => {
  const card = () => text('#peopleToday');

  it("asks about a close person it's been too long with: Done", async () => {
    const { S } = await boot('today');
    await until(() => card().includes('Mum'));
    expect(card()).toContain("You haven't been in touch with Mum for 3 weeks. Call or message?");
    await tap('#peopleToday [data-act="people-done"]');
    expect(S.state.people.mum.last).toBe(NOW.getTime());
    expect($('#peopleToday')!.hidden).toBe(true);
  });

  it('Later waits a week', async () => {
    const { S } = await boot('today');
    await until(() => card().includes('Mum'));
    await tap('#peopleToday [data-act="people-later"]');
    expect(S.state.people.mum.until).toBe('2026-12-02');
    expect($('#peopleToday')!.hidden).toBe(true);
    expect(text('#toast')).toBe('Arise asks again about Mum in a week.');
  });

  it('Stop for them takes the nudges away', async () => {
    const { S } = await boot('today');
    await until(() => card().includes('Mum'));
    await tap('#peopleToday [data-act="people-stop"]');
    expect(S.state.people.mum.close).toBeUndefined();
    expect($('#peopleToday')!.hidden).toBe(true);
  });

  it('says when a date is today or tomorrow', async () => {
    await boot('today', { events: [], data: { people: { ...PEOPLE, mum: { name: 'Mum', at: 1, dates: [{ label: 'Birthday', md: '11-26' }] } } } });
    expect(card()).toContain("Tomorrow: Mum's birthday.");
    expect($('#peopleToday [data-act="people-done"]')).toBeNull();
  });
});

describe('the coach', () => {
  it('reads close people and dates, names and dates only, only when its AI may read people', async () => {
    await boot('today', { data: { people: { ...PEOPLE, mum: { ...PEOPLE.mum, dates: [{ label: 'Birthday', md: '12-01' }] } } } });
    const AI = await import('./ai.js');
    const priv = AI.buildContext({ e: 'private' });
    expect(priv).toContain('Close people they want to keep in touch with: Mum.');
    expect(priv).toContain("Mum's birthday: 1 December (in 6 days, 2026-12-01)");
    expect(priv).not.toContain('Sam');
    for (const e of ['free', 'own'] as const) expect(AI.buildContext({ e })).not.toContain('keep in touch');
    // Not on the lock screen's texts.
    expect(AI.buildContext({ e: 'private', saw: false })).not.toContain('keep in touch');
  });
});
