// @vitest-environment jsdom
// Calendars by link in Accounts: adding one by its link (with a name or not), what it shows (its
// server, never the link), the helper switch on the web marked less private, rename and remove.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALENDAR } from '../calendar-config';
import { fakeNet, useNative, useWeb, type Net } from '../test/fake-http';
import { fakeLife } from '../test/fake-life';
import * as P from './panel';
import * as F from './ics-feeds';
import * as IDS from './ids';

const URL1 = 'webcal://cal.example.com/private/abc123secret/basic.ics';
const BODY = ['BEGIN:VCALENDAR', 'X-WR-CALNAME:Family', 'BEGIN:VEVENT', 'UID:a', `DTSTART:${new Date(Date.now() + 86_400_000).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, 'SUMMARY:Dentist', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
let net: Net;
let life: ReturnType<typeof fakeLife>;

const show = () => {
  document.getElementById('app')!.innerHTML = P.settingsPanel();
};
const panel = () => document.getElementById('accountsPanel')!.textContent!.replace(/\s+/g, ' ');
const sheet = () => document.querySelector('.sheet-body')!;
const tap = async (act: string, data: Record<string, string> = {}) => {
  const b = document.createElement('button');
  b.dataset.act = act;
  Object.assign(b.dataset, data);
  document.body.append(b);
  const handled = await P.handleAction(act, b);
  b.remove();
  return handled;
};
const type = (id: string, v: string) => ((document.getElementById(id) as HTMLInputElement).value = v);

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<main id="app"></main><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div>';
  net = fakeNet();
  life = fakeLife();
  IDS.resetForTests();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  CALENDAR.server = '';
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.restoreAllMocks();
});

describe('calendars by link', () => {
  it('in the phone app: adds one, shows its server and events, renames and removes it', async () => {
    useNative(net);
    net.on(/cal\.example\.com/, { body: BODY });
    P.initConnect();
    show();
    expect(panel()).toContain('Calendars by link');
    expect(await tap('ics-add')).toBe(true);
    expect(sheet().textContent).toContain('Add a calendar by link');
    expect(document.getElementById('icsHelper')).toBeNull(); // the phone apps need no helper
    await tap('ics-go');
    expect(document.getElementById('icsErr')!.textContent).toBe('Paste the calendar link first.');
    type('icsUrl', URL1);
    await tap('ics-go');
    await vi.waitFor(() => expect(life.titles()).toEqual(['Dentist']));
    show();
    const [f] = F.feeds();
    expect(panel()).toContain('Family');
    expect(panel()).toContain('From cal.example.com');
    expect(panel()).toContain('1 event');
    expect(document.getElementById('accountsPanel')!.innerHTML).not.toContain('abc123secret');

    await tap('ics-rename', { id: f.id });
    type('icsName', 'Home');
    await tap('ics-rename-save', { id: f.id });
    expect(F.get(f.id)!.name).toBe('Home');

    await tap('ics-del', { id: f.id });
    expect(F.feeds()).toEqual([]);
    await vi.waitFor(() => expect(life.list()).toEqual([]));
  });

  it('on the web: the helper is a choice, marked less private, and off until it is set up', async () => {
    useWeb(net);
    show();
    await tap('ics-add');
    const box = document.getElementById('icsHelper') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(sheet().textContent).toContain('Less private');
    expect(sheet().textContent).toContain("The helper isn't set up yet");

    CALENDAR.server = 'https://arise-calendar.example.workers.dev';
    await tap('ics-add');
    const on = document.getElementById('icsHelper') as HTMLInputElement;
    expect(on.disabled).toBe(false);
    net.on(/cal\.example\.com/, () => {
      throw new TypeError('Failed to fetch');
    });
    net.on(/workers\.dev\/fetch/, { body: BODY });
    on.checked = true;
    type('icsName', 'Kids');
    type('icsUrl', URL1);
    await tap('ics-go');
    await vi.waitFor(() => expect(life.titles()).toEqual(['Dentist']));
    show();
    expect(panel()).toContain('Kids Less private');
  });
});
