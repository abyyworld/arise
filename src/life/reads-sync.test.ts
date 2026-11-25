// @vitest-environment jsdom
// What an AI wrote about notes (reads.ts) between two of the Player's devices: sealed like the rest
// of the life log, the person's own words winning over an AI's, and deletions reaching every
// device. Two simulated devices share one in-memory cloud (test/fake-firebase.ts), as in
// sync.test.ts.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from '../test/fake-firebase';
import type { LifeEvent } from './types';
import type { LifeRead } from '../lib/validate';

vi.setConfig({ testTimeout: 20_000 });

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));
vi.mock('../lib/crypto', async (orig) => {
  const real = await orig<typeof import('../lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});
vi.mock('../ai.js', () => ({
  engine: () => null,
  isPrivate: () => true,
  ready: () => false,
  askMemory: async () => null,
  askRead: async () => null,
  useMemory: () => {},
  memoryStrength: () => 'none',
  trustedModel: () => false,
}));

interface Device {
  name: string;
  SYNC: typeof import('../sync');
  LIFE: typeof import('./cloud');
  L: typeof import('./log');
  R: typeof import('./reads');
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
  const d = { name, SYNC: await import('../sync'), LIFE: await import('./cloud'), L: await import('./log'), R: await import('./reads') };
  await d.SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  devices.push(d);
  return d;
}
async function on<T>(d: Device, fn: () => Promise<T> | T): Promise<T> {
  use(d.name);
  return fn();
}
const settle = (d: Device) => on(d, () => d.LIFE.whenIdle());
const reopen = async (d: Device) => {
  await on(d, () => d.SYNC.syncNow());
  await settle(d);
};
const PW = 'correct horse battery';
const EMAIL = 'me@example.com';

const T = Date.parse('2026-11-20T09:00Z');
const note = (id: string): LifeEvent => ({ id: `manual:${id}`, source: 'manual', kind: 'note', at: T, title: `Note ${id}`, detail: 'My secret walk with Sam by the river.', tier: 2 });
const read = (id: string, at: number, extra: Partial<LifeRead> = {}): LifeRead => ({ id, at, tier: 2, desc: 'A private walk by the lake', tidy: 'Walked with Sam.', tags: ['walks', 'lakeside'], src: 'abc', from: 'ai', rat: T, source: 'manual', ...extra });
const readOn = (d: Device, id: string) => on(d, async () => (await d.R.load(true), d.R.readOf(id)));

beforeEach(() => {
  resetCloud();
  storage.clear();
  databases.clear();
  current = '';
  localStorage.clear();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
});
afterEach(() => {
  for (const d of devices.splice(0)) {
    d.SYNC.status.user = null;
    d.LIFE.stop();
  }
});

async function pair() {
  const a = await device('phone');
  await on(a, async () => {
    await a.L.addEvents([note('a')]);
    await a.R.saveReads([read('e:manual:a', Date.now())]);
  });
  await on(a, () => a.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW }));
  await settle(a);
  const b = await device('laptop');
  await on(b, () => b.SYNC.submit('in', { id: EMAIL, password: PW }));
  await settle(b);
  return { a, b };
}

describe('descriptions between two devices', () => {
  it('reach the other device, sealed', async () => {
    const { b } = await pair();
    expect(await readOn(b, 'e:manual:a')).toMatchObject({ desc: 'A private walk by the lake', tags: ['walks', 'lakeside'], from: 'ai' });
    const sealed = JSON.stringify([...cloud.docs.values()]);
    for (const secret of ['private walk', 'lakeside', 'Walked with Sam', 'e:manual:a']) expect(sealed).not.toContain(secret);
    // And search finds the note by them there too.
    expect(await on(b, async () => (await b.L.search('lakeside')).map((e) => e.id))).toEqual(['manual:a']);
  });

  it("keep the person's own words over an AI's, from either device", async () => {
    const { a, b } = await pair();
    await on(b, () => b.R.fixRead('e:manual:a', { desc: 'Sunday walk with Sam', tags: ['sam'] }));
    await settle(b);
    // Meanwhile the phone's AI describes it again, later by the clock.
    await on(a, () => a.R.saveReads([read('e:manual:a', Date.now() + 60_000, { desc: 'An AI rewrite' })]));
    await settle(a);
    await reopen(b);
    await reopen(a);
    expect((await readOn(a, 'e:manual:a'))?.desc).toBe('Sunday walk with Sam');
    expect((await readOn(b, 'e:manual:a'))?.desc).toBe('Sunday walk with Sam');
  });

  it('go from every device when deleted on one', async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      await a.R.load();
      await a.R.dropReads(['e:manual:a']);
    });
    await settle(a);
    await reopen(b);
    expect(await readOn(b, 'e:manual:a')).toBeNull();
  });
});
