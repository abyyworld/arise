// @vitest-environment jsdom
// The page someone without Arise sees when they open a plan's link: the plan, Yes and No sealed
// back, a calendar file, a plan called off or turned off, and nothing kept on their device.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud, restFetch } from './test/fake-firebase';
import * as L from './lib/plans';
import type { CalEvent } from './lib/events';

const XSS = '"><img src=x onerror=alert(1)>';
const at = Date.UTC(2026, 10, 20, 12);
const dinner: CalEvent = { id: 'dinner', title: "Dinner at Lia's", start: '2026-12-04T19:00', end: '2026-12-04T21:00', location: '4 Hill Street', notes: 'Bring the cake', created: at, at };

async function up(e: CalEvent, opts: { host?: string; cancelled?: boolean } = { host: 'Akbar' }) {
  const ref = await L.newPlanRef();
  const s = await L.sealPage(ref, L.pageOf(e, { now: at, ...opts }));
  cloud.docs.set(`shares/${ref.id}`, { owner: 'uid1', iv: s.iv, ct: s.ct, v: 1, updated: at });
  return ref;
}

const text = () => document.getElementById('app')!.textContent!.replace(/\s+/g, ' ');
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
let touched: string[] = [];
let view: typeof import('./plan-view');

// Each page opened here starts afresh: the last one's listeners go.
const added: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions) => {
    added.push([target, type, fn]);
    add(type, fn, opts);
  }) as typeof target.addEventListener;
}

async function open(hash: string) {
  for (const [target, type, fn] of added.splice(0)) target.removeEventListener(type, fn);
  history.replaceState(null, '', `/arise/${hash}`);
  vi.resetModules();
  view = await import('./plan-view');
  return view.shown;
}

beforeEach(() => {
  resetCloud();
  localStorage.clear();
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="toast"></div>';
  vi.stubGlobal('fetch', vi.fn(restFetch));
  touched = [];
  for (const store of [localStorage, sessionStorage]) vi.spyOn(Object.getPrototypeOf(store), 'setItem').mockImplementation(() => touched.push('storage'));
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get: () => (touched.push('indexedDB'), undefined) });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: () => (touched.push('service worker'), Promise.resolve()) } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

describe('a plan, for someone without Arise', () => {
  it('shows the plan, and Yes and No go back sealed under the name they give', async () => {
    const ref = await up(dinner);
    expect(await open(`#plan=${ref.id}.${ref.key}`)).toBe('shown');
    const t = text();
    expect(t).toContain("Akbar's plan");
    expect(t).toContain("Dinner at Lia's");
    expect(t).toContain('19:00 to 21:00');
    expect(t).toContain('4 Hill Street');
    expect(t).toContain('Can you come?');
    expect(t).not.toContain('Bring the cake');
    expect(document.getElementById('tabs')!.hidden).toBe(true);

    // No name: it asks for one, and nothing is sent.
    $('[data-plan-answer="yes"]')!.click();
    await vi.waitFor(() => expect($('#planSaid')!.textContent).toBe('Write your name first, so they know who answered.'));
    expect([...cloud.docs.keys()].some((k) => k.includes('/replies/'))).toBe(false);

    ($('#planName') as HTMLInputElement).value = 'Jo';
    $('[data-plan-answer="yes"]')!.click();
    await vi.waitFor(() => expect($('#planSaid')!.textContent).toBe("Thanks, Jo. Akbar will see you're coming."));
    expect((await L.readAnswers(ref, { projectId: 'p', apiKey: 'k' }, restFetch as typeof fetch)).map((a) => [a.name, a.says])).toEqual([['Jo', 'yes']]);
    // Again with No: the same answer changes.
    expect(await view.sendAnswer('no')).toBe("Thanks, Jo. Akbar will see you can't make it.");
    expect((await L.readAnswers(ref, { projectId: 'p', apiKey: 'k' }, restFetch as typeof fetch)).map((a) => [a.name, a.says])).toEqual([['Jo', 'no']]);
    // The key never left the browser, and nothing was kept on it.
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0])).join()).not.toContain(ref.key);
    expect(touched).toEqual([]);
  });

  it('offers it as a calendar file', async () => {
    const ref = await up(dinner);
    await open(`#plan=${ref.id}.${ref.key}`);
    const ics = view.icsOf(ref, (await L.openPage(ref, (await L.fetchPage(ref.id, { projectId: 'p', apiKey: 'k' }, restFetch as typeof fetch))!))!);
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain("SUMMARY:Dinner at Lia's");
    expect(ics).toContain('LOCATION:4 Hill Street');
    expect(ics).toContain(`UID:${L.guestEventId(ref.id)}@arise`);
    expect(ics).not.toContain('cake');
    const made: string[] = [];
    URL.createObjectURL = vi.fn(() => (made.push('file'), 'blob:x'));
    URL.revokeObjectURL = vi.fn();
    $('[data-plan-ics]')!.click();
    expect(made).toEqual(['file']);
  });

  it('says when it was called off, with nothing to answer', async () => {
    const ref = await up(dinner, { host: 'Akbar', cancelled: true });
    expect(await open(`#plan=${ref.id}.${ref.key}`)).toBe('cancelled');
    expect(text()).toContain('Called off');
    expect(text()).toContain('Akbar called this off.');
    expect($('[data-plan-answer]')).toBeNull();
  });

  it('says when it is no longer shared, the link is broken, or the cloud is out of reach', async () => {
    const ref = await up(dinner);
    cloud.docs.set(`shares/${ref.id}`, { v: 1, off: true });
    expect(await open(`#plan=${ref.id}.${ref.key}`)).toBe('gone');
    expect(text()).toContain('This plan is no longer shared.');
    expect(await open(`#plan=${ref.id}.${ref.key.slice(2)}`)).toBe('broken');
    const other = await L.newPlanRef();
    const live = await up(dinner);
    expect(await open(`#plan=${live.id}.${other.key}`)).toBe('broken');
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await open(`#plan=${live.id}.${live.key}`)).toBe('offline');
    expect($('[data-plan-retry]')).not.toBeNull();
  });

  it('escapes what it shows', async () => {
    const ref = await up({ ...dinner, title: XSS, location: XSS }, { host: XSS });
    await open(`#plan=${ref.id}.${ref.key}`);
    expect(document.querySelector('#app img')).toBeNull();
  });
});
