// @vitest-environment jsdom
// Reminders at a to-do's time: in the web app while it's open, and in the phone apps' schedule.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const NOW = new Date(2026, 10, 13, 10);
const at = NOW.getTime();
const TODOS = {
  soon: { id: 'soon', title: 'Dentist', day: '2026-11-13', time: '15:30', created: at, at },
  done: { id: 'done', title: 'Gym', day: '2026-11-13', time: '12:00', done: at, created: at, at },
  past: { id: 'past', title: 'Breakfast', day: '2026-11-13', time: '08:00', created: at, at },
  next: { id: 'next', title: 'Call mum', day: '2026-11-20', time: '18:00', created: at, at },
  any: { id: 'any', title: 'Someday', created: at, at },
};

async function load(details = false, { remindersOn = true } = {}) {
  vi.resetModules();
  localStorage.clear();
  if (remindersOn) localStorage.setItem('arise-push', JSON.stringify({ token: 'tok' }));
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, settings: { notifyDetails: details }, todos: TODOS }));
  return { A: await import('./todo-alerts.js'), N: await import('./native.js') };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('to-do reminders', () => {
  it('on the web: only with reminders on in Settings, even when the browser allows notifications', async () => {
    vi.stubGlobal('Notification', Object.assign(function () {}, { permission: 'granted' }));
    const { A } = await load(false, { remindersOn: false });
    expect(A.allowed()).toBe(false);
    expect(A.planAlerts()).toEqual([]);
  });

  it('on the web: only with notifications allowed, for the next day, plain unless details are on', async () => {
    const shown: [string, object][] = [];
    class Note {
      static permission = 'default';
      constructor(title: string, o: object) {
        shown.push([title, o]);
      }
    }
    vi.stubGlobal('Notification', Note);
    const { A } = await load();
    expect(A.planAlerts()).toEqual([]);
    Note.permission = 'granted';
    expect(A.dueSoon().map((x) => x.id)).toEqual(['soon']);
    expect(A.planAlerts()).toEqual(['soon']);
    await vi.advanceTimersByTimeAsync(5.5 * 3600_000);
    expect(shown).toEqual([['Something on your to-do list', { body: 'Open Arise to see it.', tag: 'todo-soon' }]]);
  });

  it("doesn't remind about one done meanwhile", async () => {
    const shown: string[] = [];
    vi.stubGlobal('Notification', Object.assign(function (this: unknown, t: string) { shown.push(t); }, { permission: 'granted' }));
    const { A } = await load(true);
    const S = await import('./store');
    A.planAlerts();
    S.setTodoDone('soon', true);
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(shown).toEqual([]);
  });

  it('in the phone apps: each one with a time, soonest first, with details only if turned on', async () => {
    const { N } = await load();
    expect(N.todoReminders(NOW).map((r) => [r.title, r.at.getTime()])).toEqual([
      ['Something on your to-do list', new Date(2026, 10, 13, 15, 30).getTime()],
      ['Something on your to-do list', new Date(2026, 10, 20, 18).getTime()],
    ]);
    const more = await load(true);
    expect(more.N.todoReminders(NOW).map((r) => r.title)).toEqual(['Dentist', 'Call mum']);
    expect(more.N.upcoming(NOW).filter((n) => n.id >= 6000).map((n) => n.title)).toEqual(['Dentist', 'Call mum']);
  });
});

describe('reminders for your own calendar events', () => {
  // Fri 13 Nov 2026, 10:00 here. A dentist at 15:30 today (10 minutes and 1 hour before), a weekly
  // class with one week left out, and a birthday tomorrow (9:00 on the day).
  const EVENTS = {
    dentist: { id: 'dentist', title: 'Dentist', start: '2026-11-13T15:30', end: '2026-11-13T16:00', location: 'Clinic', remind: [10, 60], created: at, at },
    klass: { id: 'klass', title: 'Yoga', start: '2026-11-06T18:00', end: '2026-11-06T19:00', repeat: { freq: 'weekly' }, skip: ['2026-11-20T18:00'], remind: [30], created: at, at },
    bday: { id: 'bday', title: "Sam's birthday", allDay: true, start: '2026-11-14', remind: [0], created: at, at },
    none: { id: 'none', title: 'No reminder', start: '2026-11-13T12:00', created: at, at },
  };
  async function loadEvents(details = false) {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem('arise-push', JSON.stringify({ token: 'tok' }));
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, settings: { notifyDetails: details }, events: EVENTS }));
    return { A: await import('./todo-alerts.js'), N: await import('./native.js'), S: await import('./store') };
  }
  const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

  it('on the web: shown at their times while Arise is open, plain unless details are on, and not once deleted', async () => {
    const shown: [string, { body: string; tag: string }][] = [];
    vi.stubGlobal('Notification', Object.assign(function (this: unknown, t: string, o: { body: string; tag: string }) { shown.push([t, o]); }, { permission: 'granted' }));
    const { A, S } = await loadEvents(true);
    expect(A.eventsSoon().map((r) => [r.tag, r.at])).toEqual([
      ['ev-dentist-2026-11-13T15:30-60', local(13, 14, 30)],
      ['ev-dentist-2026-11-13T15:30-10', local(13, 15, 20)],
      ['ev-klass-2026-11-13T18:00-30', local(13, 17, 30)],
      ['ev-bday-2026-11-14-0', local(14, 9)],
    ]);
    expect(A.planAlerts()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(4.6 * 3600_000); // to 14:36
    expect(shown).toEqual([['Dentist', { body: 'At 15:30, Clinic.', tag: 'ev-dentist-2026-11-13T15:30-60' }]]);
    S.removeEvent('dentist');
    A.planAlerts(); // (each save plans them again)
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(shown).toHaveLength(1);
    vi.setSystemTime(NOW);
    const plain = await loadEvents(false);
    plain.A.planAlerts();
    await vi.advanceTimersByTimeAsync(4.6 * 3600_000);
    expect(shown.at(-1)).toEqual(['Something in your calendar', { body: 'Open Arise to see it.', tag: 'ev-dentist-2026-11-13T15:30-60' }]);
  });

  it('in the phone apps: planned on the phone with the rest, without the week left out', async () => {
    const { N } = await loadEvents(true);
    const list = N.eventReminders(NOW, '2026-11-28');
    expect(list.map((r) => [r.title, r.at.getTime()])).toEqual([
      ['Dentist', local(13, 14, 30)],
      ['Dentist', local(13, 15, 20)],
      ['Yoga', local(13, 17, 30)],
      ["Sam's birthday", local(14, 9)],
      ['Yoga', local(27, 17, 30)], // (not on the 20th)
    ]);
    expect(list[3].body).toBe('All day today.');
    expect(N.upcoming(NOW).filter((n) => n.id >= 7000 && n.id < 8000).map((n) => n.title).slice(0, 4)).toEqual(['Dentist', 'Dentist', 'Yoga', "Sam's birthday"]);
  });
});
