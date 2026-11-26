// @vitest-environment jsdom
// Plans between people, between two people's Arise (and someone without it): the link made, the
// plan opened and answered, the answers coming back, a change and a calling-off reaching the other
// side, either side stopping, and the answers syncing end-to-end encrypted with the event.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud, restFetch } from './test/fake-firebase';
import * as L from './lib/plans';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

interface Device {
  S: typeof import('./store');
  SYNC: typeof import('./sync');
  P: typeof import('./plans');
  name: string;
}

const PROJECT = { projectId: 'p', apiKey: 'k' };
const get = restFetch as typeof fetch;
const storage = new Map<string, Map<string, string>>();
const databases = new Map<string, IDBFactory>();
let current = '';
const devices: Device[] = [];

function use(name: string) {
  if (current) storage.set(current, new Map(Object.entries({ ...localStorage })));
  localStorage.clear();
  for (const [k, v] of storage.get(name) || []) localStorage.setItem(k, v);
  if (!databases.has(name)) databases.set(name, new IDBFactory());
  globalThis.indexedDB = databases.get(name)!;
  current = name;
}
async function device(name: string, data: object = {}): Promise<Device> {
  use(name);
  if (!localStorage.getItem('pit-data-v1')) localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true }, ...data }));
  vi.resetModules();
  const S = await import('./store');
  const SYNC = await import('./sync');
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  const d = { S, SYNC, P: await import('./plans'), name };
  devices.push(d);
  return d;
}
async function on<T>(d: Device, fn: () => Promise<T> | T): Promise<T> {
  use(d.name);
  return fn();
}

const PW = 'correct horse battery';
const cloudText = () => JSON.stringify([...cloud.docs.values()]) + JSON.stringify([...cloud.docs.keys()]);
const DINNER = { id: 'dinner', title: 'Dinner at Lia and Tom', start: '2026-12-04T19:00', end: '2026-12-04T21:00', tz: 'Europe/London', location: '4 Hill Street', notes: 'Bring the cake. Surprise for Jonathan.', guests: ['sam@example.com'], color: 'red' as const };

// Akbar, with an account, and his dinner planned with someone.
async function host() {
  const h = await device('host', { settings: { name: 'Akbar Juraev' } });
  h.S.addEvent(DINNER);
  await h.SYNC.submit('up', { email: 'akbar@example.com', password: PW, password2: PW });
  expect(h.SYNC.status.error).toBe('');
  const plan = (await h.P.start('dinner'))!;
  return { h, plan };
}

beforeEach(() => {
  resetCloud();
  storage.clear();
  databases.clear();
  current = '';
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
  vi.stubGlobal('fetch', vi.fn(restFetch));
});
afterEach(() => {
  for (const d of devices.splice(0)) d.SYNC.status.user = null;
  vi.unstubAllGlobals();
});

describe('a plan between people', () => {
  it('needs an account to make the link', async () => {
    const h = await device('host');
    h.S.addEvent(DINNER);
    await expect(h.P.start('dinner')).rejects.toThrow('Planning with someone needs an account');
    expect(h.S.state.events.dinner.plan).toBeUndefined();
    expect([...cloud.docs.keys()].filter((k) => k.startsWith('shares/'))).toEqual([]);
  });

  it('makes a private link whose page holds only the title, time, place and first name', async () => {
    const { h, plan } = await host();
    expect(plan).toMatchObject({ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(h.S.state.events.dinner.plan).toEqual({ id: plan.id, key: plan.key, at: expect.any(Number), said: L.fingerprint(h.S.state.events.dinner) });
    expect(cloud.docs.get(`shares/${plan.id}`)).toMatchObject({ owner: h.SYNC.status.user!.uid, v: 1 });
    // Nothing in the cloud can be read: not the page, not the event with its link and key.
    for (const secret of ['Dinner at Lia', '4 Hill Street', 'Akbar', 'Bring the cake', 'Jonathan', plan.key, '19:00']) expect(cloudText()).not.toContain(secret);
    const page = await L.openPage(plan, (await L.fetchPage(plan.id, PROJECT, get))!);
    expect(page).toEqual({ v: 1, title: DINNER.title, start: DINNER.start, end: DINNER.end, tz: 'Europe/London', location: '4 Hill Street', host: 'Akbar', updated: expect.any(Number) });
    // Asked again, the same link.
    expect((await h.P.start('dinner'))!.id).toBe(plan.id);
  });

  it('is accepted and declined, the answers come back, and a change of mind replaces the old answer', async () => {
    const { h, plan } = await host();
    // Sam has Arise, but no account.
    const g = await device('sam', { settings: { name: 'Sam Lee' } });
    const look = await g.P.look(plan);
    expect('page' in look && look.page.title).toBe(DINNER.title);
    const copy = await g.P.reply(plan, (look as { page: L.PlanPage }).page, 'yes', 'Sam');
    const id = L.guestEventId(plan.id);
    expect(copy!.id).toBe(id);
    expect(g.S.state.events[id]).toMatchObject({ title: DINNER.title, start: DINNER.start, end: DINNER.end, tz: 'Europe/London', location: '4 Hill Street', plan: { guest: true, host: 'Akbar', name: 'Sam', says: 'yes', id: plan.id } });
    expect(g.S.state.events[id].notes).toBeUndefined();
    expect(g.S.state.events[id].guests).toBeUndefined();
    // Jo has no Arise: the page's No.
    await L.answer(plan, 'Jo', 'no', PROJECT, get);
    // A third opens the link and declines in Arise: nothing goes in their calendar.
    const k = await device('kim');
    expect(await k.P.reply(plan, (look as { page: L.PlanPage }).page, 'no', 'Kim')).toBeNull();
    expect(Object.keys(k.S.state.events)).toEqual([]);

    await on(h, async () => {
      expect(await h.P.pullAnswers('dinner')).toBe(true);
      const a = h.P.answersOf(h.S.state.events.dinner);
      expect(a.yes.map((x) => x.name)).toEqual(['Sam']);
      expect(a.no.map((x) => x.name).sort()).toEqual(['Jo', 'Kim']);
      expect(await h.P.pullAnswers('dinner')).toBe(false); // nothing new
    });
    // Sam can't make it after all.
    await on(g, async () => {
      expect(await g.P.changeAnswer(id, 'no', 'Sam')).toBe(true);
      expect(g.S.state.events[id].plan!.says).toBe('no');
    });
    await on(h, async () => {
      expect(await h.P.pullAnswers('dinner')).toBe(true);
      const a = h.P.answersOf(h.S.state.events.dinner);
      expect(a.yes).toEqual([]);
      expect(a.no.map((x) => x.name).sort()).toEqual(['Jo', 'Kim', 'Sam']);
    });
  });

  it('sends a change only when told, and their copy follows it, keeping their own reminders and notes', async () => {
    const { h, plan } = await host();
    const g = await device('sam');
    const page = ((await g.P.look(plan)) as { page: L.PlanPage }).page;
    await g.P.reply(plan, page, 'yes', 'Sam');
    const id = L.guestEventId(plan.id);
    g.S.updateEvent(id, { ...g.S.state.events[id], remind: [30], notes: 'Take the bus' });

    await on(h, async () => {
      h.S.updateEvent('dinner', { ...h.S.state.events.dinner, start: '2026-12-04T20:00', end: '2026-12-04T22:00', location: 'The Green Cafe' });
      expect(h.S.state.events.dinner.plan).toBeTruthy(); // a change keeps the plan
      expect(h.P.untold(h.S.state.events.dinner)).toBe(true);
    });
    await on(g, async () => expect(await g.P.follow(id)).toBe('same')); // not told yet
    await on(h, async () => {
      expect(await h.P.tell('dinner')).toBe(true);
      expect(h.P.untold(h.S.state.events.dinner)).toBe(false);
    });
    await on(g, async () => {
      expect(await g.P.follow(id)).toBe('changed');
      expect(g.S.state.events[id]).toMatchObject({ start: '2026-12-04T20:00', end: '2026-12-04T22:00', location: 'The Green Cafe', remind: [30], notes: 'Take the bus', plan: { says: 'yes', guest: true } });
      expect(await g.P.follow(id)).toBe('same');
      expect(await g.P.refresh({ force: true })).toBe(false);
    });
  });

  it('called off: their copy is marked so and stays', async () => {
    const { h, plan } = await host();
    const g = await device('sam');
    await g.P.reply(plan, ((await g.P.look(plan)) as { page: L.PlanPage }).page, 'yes', 'Sam');
    const id = L.guestEventId(plan.id);
    await on(h, async () => {
      const e = h.S.state.events.dinner;
      expect(await h.P.cancel(e)).toBe(true);
      h.S.removeEvent('dinner');
    });
    await on(g, async () => {
      expect(await g.P.refresh({ force: true })).toBe(true);
      expect(g.S.state.events[id]).toMatchObject({ title: DINNER.title, plan: { ended: 'cancelled' } });
      // Nobody can answer a plan that was called off.
      const look = (await g.P.look(plan)) as { page: L.PlanPage };
      expect(look.page.cancelled).toBe(true);
      await expect(g.P.reply(plan, look.page, 'yes', 'Sam')).rejects.toThrow('called off');
    });
  });

  it('either side can stop sharing', async () => {
    const { h, plan } = await host();
    const g = await device('sam');
    const page = ((await g.P.look(plan)) as { page: L.PlanPage }).page;
    await g.P.reply(plan, page, 'yes', 'Sam');
    const id = L.guestEventId(plan.id);
    const k = await device('kim');
    await k.P.reply(plan, page, 'yes', 'Kim');
    const kid = L.guestEventId(plan.id);

    // Sam stops: Akbar sees it, and Sam's event stays as Sam's own.
    await on(g, async () => {
      await g.P.leave(id, 'Sam');
      expect(g.S.state.events[id].plan).toBeUndefined();
      expect(g.S.state.events[id].title).toBe(DINNER.title);
    });
    await on(h, async () => {
      await h.P.pullAnswers('dinner');
      expect(h.P.answersOf(h.S.state.events.dinner).left.map((a) => a.name)).toEqual(['Sam']);
      // Akbar stops: the answers go, the page is off for good, the event stays.
      await h.P.stop('dinner');
      expect(h.S.state.events.dinner.plan).toBeUndefined();
      expect(cloud.docs.get(`shares/${plan.id}`)).toEqual({ v: 1, off: true });
      expect([...cloud.docs.keys()].filter((p) => p.includes('/replies/'))).toEqual([]);
    });
    await on(k, async () => {
      expect(await k.P.follow(kid)).toBe('off');
      expect(k.S.state.events[kid]).toMatchObject({ title: DINNER.title, plan: { ended: 'off' } });
      // Nobody can answer it any more.
      await expect(L.answer(plan, 'Kim', 'no', PROJECT, get)).rejects.toMatchObject({ code: 'permission-denied' });
      expect(k.P.problem({ code: 'permission-denied' })).toBe('This plan is no longer shared.');
    });
  });

  it("deleting your copy can tell them you can't make it", async () => {
    const { h, plan } = await host();
    const g = await device('sam');
    await g.P.reply(plan, ((await g.P.look(plan)) as { page: L.PlanPage }).page, 'yes', 'Sam');
    const id = L.guestEventId(plan.id);
    expect(await g.P.tellNo(g.S.state.events[id], 'Sam')).toBe(true);
    g.S.removeEvent(id);
    await on(h, async () => {
      await h.P.pullAnswers('dinner');
      expect(h.P.answersOf(h.S.state.events.dinner).no.map((a) => a.name)).toEqual(['Sam']);
    });
  });

  it("syncs the link and the answers with the event, end-to-end encrypted, to the maker's other device", async () => {
    const { h, plan } = await host();
    await L.answer(plan, 'Jonathan Price', 'yes', PROJECT, get);
    await h.P.pullAnswers('dinner');
    await h.SYNC.syncNow();
    for (const secret of ['Jonathan Price', plan.key]) expect(cloudText()).not.toContain(secret);
    const laptop = await device('laptop');
    await laptop.SYNC.submit('in', { id: 'akbar@example.com', password: PW });
    expect(laptop.S.state.events.dinner.plan).toMatchObject({ id: plan.id, key: plan.key, answers: [{ name: 'Jonathan Price', says: 'yes' }] });
    expect(laptop.P.untold(laptop.S.state.events.dinner)).toBe(false);
  });
});
