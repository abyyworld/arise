// @vitest-environment jsdom
// Your own calendar events and sync: end-to-end encrypted (nothing about an event readable in the
// cloud), merged per event between two devices that both changed something (deletions don't come
// back), and gone from a device with "Erase all data" or signing out with the data removed.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from './test/fake-firebase';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

type Store = typeof import('./store');
type Sync = typeof import('./sync');
interface Device {
  S: Store;
  SYNC: Sync;
  name: string;
}

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
async function device(name: string): Promise<Device> {
  use(name);
  vi.resetModules();
  const S = await import('./store');
  const SYNC = await import('./sync');
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  const d = { S, SYNC, name };
  devices.push(d);
  return d;
}
async function on<T>(d: Device, fn: () => Promise<T> | T): Promise<T> {
  use(d.name);
  return fn();
}

const PW = 'correct horse battery';
const cloudText = () => JSON.stringify([...cloud.docs.values()]) + JSON.stringify([...cloud.docs.keys()]);
const titles = (S: Store) =>
  Object.values(S.state.events)
    .filter((e) => !e.gone)
    .map((e) => e.title)
    .sort();

beforeEach(() => {
  resetCloud();
  storage.clear();
  databases.clear();
  current = '';
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
});
afterEach(() => {
  for (const d of devices.splice(0)) d.SYNC.status.user = null;
});

async function pair() {
  const a = await device('phone');
  a.S.addEvent({ id: 'dentist', title: 'Secret dentist visit', start: '2026-11-20T15:30', end: '2026-11-20T16:00', tz: 'Europe/London', location: 'Hidden Street 4', notes: 'private notes', color: 'red', remind: [30], repeat: { freq: 'weekly', days: [5] } });
  a.S.addEvent({ id: 'lunch', title: 'Lunch with Sam', start: '2026-11-21T12:00', end: '2026-11-21T13:00' });
  await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
  const b = await device('laptop');
  await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
  return { a, b };
}

describe('your events and sync', () => {
  it('reach the other device, and nothing about them is readable in the cloud', async () => {
    const { a, b } = await pair();
    expect(a.SYNC.status.error).toBe('');
    expect(titles(b.S)).toEqual(['Lunch with Sam', 'Secret dentist visit']);
    expect(b.S.state.events.dentist).toMatchObject({ tz: 'Europe/London', location: 'Hidden Street 4', remind: [30], repeat: { freq: 'weekly', days: [5] } });
    for (const secret of ['Secret dentist', 'Hidden Street', 'private notes', 'dentist', 'Lunch', '2026-11-20', '15:30', 'Europe/London', 'weekly', 'remind']) expect(cloudText()).not.toContain(secret);
  });

  it('merge per event when both devices changed something, and a deletion never comes back', async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      a.S.removeEvent('lunch');
      a.S.skipEventTime('dentist', '2026-11-27T15:30');
      await a.SYNC.syncNow();
    });
    await on(b, async () => {
      b.S.addEvent({ id: 'gym', title: 'Gym', start: '2026-11-22T08:00', end: '2026-11-22T09:00' });
      await b.SYNC.syncNow();
      expect(titles(b.S)).toEqual(['Gym', 'Secret dentist visit']);
      expect(b.S.state.events.lunch.gone).toBe(true);
      expect(b.S.state.events.dentist.skip).toEqual(['2026-11-27T15:30']);
    });
    await on(a, async () => {
      await a.SYNC.syncNow();
      expect(titles(a.S)).toEqual(['Gym', 'Secret dentist visit']);
    });
  });

  it('go from this device with Erase all data, like to-dos', async () => {
    const { a } = await pair();
    await on(a, async () => {
      a.S.addTodo({ title: 'Pay rent' });
      await a.SYNC.syncNow();
      expect(await a.SYNC.eraseThisDevice()).toBe(true);
      expect(a.S.state.events).toEqual({});
      expect(a.S.state.todos).toEqual({});
      expect(JSON.parse(localStorage.getItem('pit-data-v1') || '{}').events || {}).toEqual({});
    });
  });

  it('go when signed out with no account too', async () => {
    const a = await device('phone');
    a.S.addEvent({ title: 'Alone', start: '2026-11-21T12:00' });
    expect(a.S.isEmpty()).toBe(false); // an event is data: sync never takes this device for an empty one
    expect(await a.SYNC.eraseThisDevice()).toBe(true);
    expect(a.S.state.events).toEqual({});
  });
});
