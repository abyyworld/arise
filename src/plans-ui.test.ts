// @vitest-environment jsdom
// Plans between people on the Calendar screen: Plan it with someone in an event's sheet, the link
// copied, answers showing who's in and who can't, "Tell them?" on a change and on Delete; and on
// the other side, a plan link opened in Arise, I'm in, the event marked as shared, then called off;
// and Open a plan link for a link pasted in.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud, restFetch } from './test/fake-firebase';
import * as L from './lib/plans';
import type { CalEvent } from './lib/events';
import { version } from '../package.json';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

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
const PROJECT = { projectId: 'p', apiKey: 'k' };
const get = restFetch as typeof fetch;
const PW = 'correct horse battery';

async function boot({ events = {}, settings = {}, hash = 'calendar' } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-tabs-shown', JSON.stringify(['goals', 'coach']));
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('arise-version-seen', version); // no "What's new" on top
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, settings, events }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close" data-act="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `/arise/#${hash}`);
  const S = await import('./store');
  await import('./app.js');
  return { S, SYNC: await import('./sync'), PLANUI: await import('./plans-ui.js') };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const sheet = () => text('#sheet .sheet-body');
const toasted = () => $('#toast')!.textContent;
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
const submit = (sel = '.ev-form') => $(sel)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const pageNow = async (ref: L.PlanRef) => {
  const s = await L.fetchPage(ref.id, PROJECT, get);
  return s && L.openPage(ref, s);
};

const DINNER = { id: 'dinner', title: 'Dinner at Lia and Tom', start: '2026-11-20T19:00', end: '2026-11-20T21:00', location: '4 Hill Street', notes: 'Bring the cake', guests: ['sam@example.com'], color: 'red', created: at, at };

beforeEach(() => {
  resetCloud();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
  vi.stubGlobal('fetch', vi.fn(restFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Plan it with someone, on your event', () => {
  it('makes the link, shows who is in, asks "Tell them?" on a change and on Delete', async () => {
    const { S, SYNC } = await boot({ events: { dinner: DINNER }, settings: { name: 'Akbar Juraev' } });
    const asked: string[] = [];
    vi.spyOn(window, 'confirm').mockImplementation((m) => (asked.push(String(m)), true));

    click('[data-d="2026-11-20"]');
    click('[data-act="cal-ev"][data-id="dinner"]');
    expect(sheet()).toContain('Plan it with someone');
    expect(sheet()).toContain('They see the title, the time, the place and your first name, and can say if they can come. Not your notes or who else you invited.');
    // Signed out: it says it needs an account, and makes nothing.
    click('[data-act="plan-start"]');
    expect(toasted()).toContain('Planning with someone needs an account');
    expect(S.state.events.dinner.plan).toBeUndefined();

    await SYNC.submit('up', { email: 'akbar@example.com', password: PW, password2: PW });
    expect(SYNC.status.error).toBe('');
    click('[data-act="cal-ev"][data-id="dinner"]');
    click('[data-act="plan-start"]');
    await vi.waitFor(() => expect(($('#planLinkIn') as HTMLInputElement | null)?.value).toContain('#plan='));
    const plan = S.state.events.dinner.plan!;
    expect(($('#planLinkIn') as HTMLInputElement).value).toBe(`${location.origin}/arise/#plan=${plan.id}.${plan.key}`);
    expect(toasted()).toBe('Link made. Send it to the people you mean.');
    expect(sheet()).toContain('No answers yet.');
    expect(await pageNow(plan)).toMatchObject({ title: DINNER.title, host: 'Akbar' });

    // Copy link.
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    click('[data-act="plan-copy"]');
    await vi.waitFor(() => expect(copied).toEqual([`${location.origin}/arise/#plan=${plan.id}.${plan.key}`]));

    // Answers come back: the sheet shows who's in and who can't.
    await L.answer(plan, 'Sam', 'yes', PROJECT, get);
    await L.answer(plan, 'Jo', 'no', PROJECT, get);
    click('[data-act="ev-cancel"]');
    click('[data-act="cal-ev"][data-id="dinner"]');
    await vi.waitFor(() => expect(sheet()).toContain('In: Sam'));
    expect(sheet()).toContain("Can't make it: Jo");
    expect($('[data-act="cal-ev"][data-id="dinner"]')!.getAttribute('aria-label')).toContain(', shared');

    // A new time: "Tell them?", and their page follows.
    set('#evStartTime', '20:00');
    set('#evEndTime', '22:00');
    submit();
    expect(asked).toEqual(['Tell the people you planned this with? Their copy changes to match.']);
    await vi.waitFor(async () => expect((await pageNow(plan))!.start).toBe('2026-11-20T20:00'));
    await vi.waitFor(() => expect(toasted()).toContain('Told them.'));

    // Saved without a change: nothing to ask.
    click('[data-act="cal-ev"][data-id="dinner"]');
    submit();
    expect(asked).toHaveLength(1);

    // Delete: "Tell them it's called off?", and the page says so.
    click('[data-act="cal-ev"][data-id="dinner"]');
    click('[data-act="ev-del"]');
    expect(asked.slice(1)).toEqual(['Delete "Dinner at Lia and Tom"?', "Tell them it's called off? Their copy is marked as called off. If not, the link stops working and their copy stays as theirs."]);
    await vi.waitFor(async () => expect((await pageNow(plan))!.cancelled).toBe(true));
    expect(S.state.events.dinner.gone).toBe(true);
  });

  it('turns the link off without a word when you say no to telling them, and Stop sharing turns it off too', async () => {
    const { S, SYNC } = await boot({ events: { dinner: DINNER, lunch: { ...DINNER, id: 'lunch', title: 'Lunch' } } });
    await SYNC.submit('up', { email: 'akbar@example.com', password: PW, password2: PW });
    const P = await import('./plans');
    const a = (await P.start('dinner'))!;
    const b = (await P.start('lunch'))!;
    vi.spyOn(window, 'confirm').mockImplementation((m) => !String(m).startsWith('Tell them'));
    click('[data-d="2026-11-20"]');
    click('[data-act="cal-ev"][data-id="dinner"]');
    click('[data-act="ev-del"]');
    await vi.waitFor(() => expect(cloud.docs.get(`shares/${a.id}`)).toEqual({ v: 1, off: true }));
    click('[data-act="cal-ev"][data-id="lunch"]');
    click('[data-act="plan-stop"]');
    await vi.waitFor(() => expect(cloud.docs.get(`shares/${b.id}`)).toEqual({ v: 1, off: true }));
    expect(S.state.events.lunch.plan).toBeUndefined();
    await vi.waitFor(() => expect(sheet()).toContain('Plan it with someone'));
  });
});

describe("someone else's plan, opened in Arise", () => {
  async function shared(e: Partial<CalEvent>, opts: { cancelled?: boolean; now?: number } = {}, ref?: L.PlanRef) {
    const r = ref || (await L.newPlanRef());
    const page = L.pageOf({ ...DINNER, ...e } as CalEvent, { host: 'Akbar', now: opts.now || at, cancelled: opts.cancelled });
    const s = await L.sealPage(r, page);
    cloud.docs.set(`shares/${r.id}`, { owner: 'uid9', iv: s.iv, ct: s.ct, v: 1, updated: page.updated });
    return r;
  }

  it("answers I'm in, puts it in the calendar as shared, and marks it when it's called off", async () => {
    const ref = await shared({});
    const { S, PLANUI } = await boot({ settings: { name: 'Sam Lee' }, hash: `plan=${ref.id}.${ref.key}` });
    await vi.waitFor(() => expect(sheet()).toContain('A plan from Akbar'));
    expect(text('h1')).toBe('Calendar');
    expect(sheet()).toContain(DINNER.title);
    expect(sheet()).toContain('19:00 to 21:00');
    expect(sheet()).toContain('4 Hill Street');
    expect(sheet()).not.toContain('Bring the cake');
    expect(($('#planName') as HTMLInputElement).value).toBe('Sam');
    click('[data-act="plan-answer"][data-v="yes"]');
    const id = L.guestEventId(ref.id);
    await vi.waitFor(() => expect(S.state.events[id]).toBeTruthy());
    expect(toasted()).toBe("You're in. It's in your calendar, marked as shared with you.");
    expect((await L.readAnswers(ref, PROJECT, get)).map((a) => [a.name, a.says])).toEqual([['Sam', 'yes']]);
    click('[data-d="2026-11-20"]');
    expect($(`[data-act="cal-ev"][data-id="${id}"]`)!.getAttribute('aria-label')).toContain(', shared');
    click(`[data-act="cal-ev"][data-id="${id}"]`);
    await vi.waitFor(() => expect(sheet()).toContain('Shared with you by Akbar.'));
    expect(sheet()).toContain("You said you're in.");

    // Akbar moves it: the copy follows when the calendar looks again.
    click('[data-act="ev-cancel"]');
    await shared({ start: '2026-11-20T18:00' }, { now: at + 1000 }, ref);
    PLANUI.refresh(true);
    await vi.waitFor(() => expect(S.state.events[id].start).toBe('2026-11-20T18:00'));

    // Akbar calls it off: it stays, marked.
    await shared({ start: '2026-11-20T18:00' }, { now: at + 2000, cancelled: true }, ref);
    PLANUI.refresh(true);
    await vi.waitFor(() => expect($(`[data-act="cal-ev"][data-id="${id}"]`)!.classList.contains('cancelled')).toBe(true));
    expect($(`[data-act="cal-ev"][data-id="${id}"]`)!.getAttribute('aria-label')).toContain(', called off');
    click(`[data-act="cal-ev"][data-id="${id}"]`);
    expect(sheet()).toContain('Akbar called this off.');
  });

  it("says Can't make it without adding anything, and opens a link pasted in", async () => {
    const ref = await shared({});
    const { S } = await boot({});
    click('[data-act="plan-paste"]');
    expect(sheet()).toContain('Open a plan link');
    set('#planPaste', 'https://example.com/nothing');
    submit('[data-form="plan-paste"]');
    expect(toasted()).toBe("That isn't a plan link. It has #plan= in it.");
    set('#planPaste', `Come along: https://abyyworld.github.io/arise/#plan=${ref.id}.${ref.key}`);
    submit('[data-form="plan-paste"]');
    await vi.waitFor(() => expect(sheet()).toContain('A plan from Akbar'));
    // No name yet: it asks.
    click('[data-act="plan-answer"][data-v="no"]');
    expect(toasted()).toBe('Write your name first, so they know who answered.');
    set('#planName', 'Kim');
    click('[data-act="plan-answer"][data-v="no"]');
    await vi.waitFor(() => expect(toasted()).toBe("Told Akbar you can't make it."));
    expect(Object.keys(S.state.events)).toEqual([]);
    expect((await L.readAnswers(ref, PROJECT, get)).map((a) => [a.name, a.says])).toEqual([['Kim', 'no']]);
  });

  it('says when a plan is no longer shared', async () => {
    const ref = await shared({});
    cloud.docs.set(`shares/${ref.id}`, { v: 1, off: true });
    await boot({ hash: `plan=${ref.id}.${ref.key}` });
    await vi.waitFor(() => expect(sheet()).toContain('No longer shared'));
  });
});
