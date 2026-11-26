// @vitest-environment jsdom
// Connected apps on the web, end to end: the Player turns the web connector on for one app, an AI
// app on the web uses it (the connector Worker, run here against the same in-memory cloud), and
// Arise reads back what the app did and takes its notes into the day.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud, restFetch } from './test/fake-firebase';
import { readMe } from '../public/me.js';
import { LINK_DEFAULT } from './lib/me';
import { Feed, forgetPages, handle, type Env, type StorageLike } from '../worker/connector/src/index';
import { CONNECTOR } from './connector-config';
import type { LifeEvent } from './life/types';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

const PW = 'correct horse battery';
const DAY = 86_400_000;
const read = (l: { id: string; key: string }) => readMe(`${l.id}.${l.key}`, { fetch: restFetch as typeof fetch, projectId: 'p', apiKey: 'k' });

// The connector, with its Durable Objects in memory.
function connector() {
  const data = new Map<string, Map<string, unknown>>();
  const feeds = new Map<string, Feed>();
  const env: Env = {
    ALLOWED_ORIGINS: 'http://localhost:3000',
    PER_LINK: { limit: async () => ({ success: true }) },
    PER_IP: { limit: async () => ({ success: true }) },
    FEEDS: {
      idFromName: (n: string) => n,
      get(id: unknown) {
        const name = String(id);
        if (!feeds.has(name)) {
          const m = new Map<string, unknown>();
          data.set(name, m);
          const storage: StorageLike = { get: async <T,>(k: string) => structuredClone(m.get(k)) as T, put: async (k, v) => void m.set(k, structuredClone(v)), delete: async (k) => m.delete(k), deleteAll: async () => m.clear(), setAlarm: async () => {} };
          feeds.set(name, new Feed({ storage }));
        }
        return { fetch: (input: string, init?: RequestInit) => feeds.get(name)!.fetch(new Request(input, init)) };
      },
    },
  };
  const deps = { fetch: restFetch as typeof fetch, projectId: 'p', apiKey: 'k' };
  // What Arise's fetch reaches: the connector, as the browser would.
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(CONNECTOR.server)) throw new Error(`Unexpected fetch: ${url}`);
    return handle(new Request(url, init), env, deps);
  });
  vi.stubGlobal('fetch', fetchStub);
  const ask = async (address: string, name: string, args: object = {}, ua = 'Claude-User') => {
    const res = await handle(new Request(address, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, deps);
    return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
  };
  return { env, data, ask, fetchStub };
}

async function device() {
  vi.resetModules();
  const S = await import('./store');
  const SYNC = await import('./sync');
  const ME = await import('./me');
  const PORT = await import('./life/store-port');
  const added: LifeEvent[] = [];
  PORT.setLifeStore({
    addEvents: async (events) => {
      const fresh = events.filter((e) => !added.some((a) => a.id === e.id));
      added.push(...fresh);
      return fresh.length;
    },
  });
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  ME.initMe();
  await SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
  expect(SYNC.status.error).toBe('');
  SYNC.status.locked = true;
  S.saveGoal({ id: 'g1', title: 'Run a half marathon', category: 'fitness', why: 'Feel strong at 40', created: '2026-10-01', quests: [] });
  return { S, SYNC, ME, added };
}

beforeEach(() => {
  resetCloud();
  forgetPages();
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main>';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an app on the web', () => {
  it('is off until the Player turns it on, and then gets only what that app gets', async () => {
    const c = connector();
    const a = await device();
    const l = await a.ME.connect('Claude', LINK_DEFAULT);
    expect(await read(l)).not.toHaveProperty('web');
    expect(a.ME.connectorAddress(l)).toBe('');
    // The link itself doesn't work through the connector.
    expect((await c.ask(`${CONNECTOR.server}/mcp/${l.id}.${l.key}`, 'my_goals')).isError).toBe(true);

    expect(await a.ME.setWeb(l.id, { notes: false, until: Date.now() + 30 * DAY })).toBe(true);
    const w = a.ME.links()[0].web!;
    // A page of its own, with its own key: the app never gets the link.
    expect(w.id).not.toBe(l.id);
    const address = a.ME.connectorAddress(a.ME.links()[0]);
    expect(address).toBe(`${CONNECTOR.server}/mcp/${w.id}.${w.key}`);
    expect(await read(l)).not.toHaveProperty('web');
    expect((await read(w)).web).toEqual({ notes: false, until: w.until, feed: w.fh });
    expect((await read(w)).goals).toEqual((await read(l)).goals);
    const goals = await c.ask(address, 'my_goals');
    expect(goals.isError).toBeUndefined();
    expect(goals.content[0].text).toContain('Run a half marathon');
    expect((await c.ask(address, 'add_note', { text: 'Ran 5 km' })).isError).toBe(true);

    // Off again: the address's page is emptied for good, so even reading it straight from the
    // cloud fails. The link itself keeps working.
    await a.ME.setWeb(l.id, null);
    forgetPages();
    expect((await c.ask(address, 'my_goals')).isError).toBe(true);
    await expect(read(w)).rejects.toMatchObject({ code: 'off' });
    expect((await read(l)).goals[0].title).toBe('Run a half marathon');
    expect(a.ME.links()[0]).not.toHaveProperty('web');

    // On again: a new address.
    await a.ME.setWeb(l.id, { notes: false });
    expect(a.ME.links()[0].web!.id).not.toBe(w.id);
  });

  it('turns off by itself after 60 days without use, and says so', async () => {
    const c = connector();
    const a = await device();
    const l = await a.ME.connect('Claude', LINK_DEFAULT);
    await a.ME.setWeb(l.id, { notes: false });
    const t0 = Date.now();
    expect(await a.ME.offWhenIdle(t0)).toEqual([]); // first seen now
    // Used on day 30: counted from then.
    await c.ask(a.ME.connectorAddress(a.ME.links()[0]), 'my_goals');
    await a.ME.pullFeeds({ force: true });
    const used = a.ME.feedOf(l.id).at(-1)!.at;
    expect(await a.ME.offWhenIdle(used + 59 * DAY)).toEqual([]);
    expect(a.ME.links()[0].web).toBeTruthy();
    expect(await a.ME.offWhenIdle(used + 61 * DAY)).toEqual(['Claude']);
    expect(a.ME.links()[0]).not.toHaveProperty('web');
    expect(a.ME.lastIdleOff()).toMatchObject({ apps: ['Claude'] });
  });

  it('stops by itself on the date the Player picked', async () => {
    connector();
    const a = await device();
    const l = await a.ME.connect('ChatGPT', LINK_DEFAULT);
    const until = Date.now() + 7 * DAY;
    await a.ME.setWeb(l.id, { notes: true, until });
    expect(a.ME.webNow(a.ME.links()[0], until - 1)).toEqual({ notes: true, until, feed: a.ME.links()[0].web!.fh });
    expect(a.ME.webNow(a.ME.links()[0], until + 1)).toBeNull();
    // The next update after that date empties its page.
    const w = a.ME.links()[0].web!;
    expect((await read(w)).web).toMatchObject({ notes: true, until });
    const later = Date.now() + 8 * DAY;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await a.ME.refresh();
    await expect(read(w)).rejects.toMatchObject({ code: 'off' });
    expect(a.ME.links()[0].web).toMatchObject({ notes: true, until, off: true }); // and Arise still says when it ended
    expect(await read(l)).not.toHaveProperty('web');
  });

  it("takes the app's notes into the day and keeps a log of what it did", async () => {
    const c = connector();
    const a = await device();
    const l = await a.ME.connect('Claude', LINK_DEFAULT);
    await a.ME.setWeb(l.id, { notes: true });
    const w = a.ME.links()[0].web!;
    const address = a.ME.connectorAddress(a.ME.links()[0]);
    expect((await c.ask(address, 'about_me')).isError).toBeUndefined();
    expect((await c.ask(address, 'add_note', { text: 'Ran 5 km before work.\nFelt great.' })).isError).toBeUndefined();

    expect(await a.ME.pullFeeds({ force: true })).toBe(1);
    expect(a.added).toEqual([
      {
        id: expect.stringMatching(new RegExp(`^other:ai-note-${w.id}-\\d+-\\d+$`)),
        source: 'other',
        kind: 'note',
        at: expect.any(Number),
        title: 'Claude: Ran 5 km before work.',
        detail: 'Ran 5 km before work.\nFelt great.\n\nAdded by Claude, through the web connector.',
        tier: 2,
        meta: { from: 'Claude' },
      },
    ]);
    expect(a.ME.feedOf(l.id).map((e) => e.tool)).toEqual(['about_me', 'add_note']);
    // The connector let them go once Arise had them: nothing comes twice.
    expect(await a.ME.pullFeeds({ force: true })).toBe(0);
    expect(a.ME.feedOf(l.id)).toHaveLength(2);
    expect(c.data.get(w.id)!.get('e')).toEqual([]);

    // The app has the address, not the token: it can't wipe what it did.
    const wipe = await handle(new Request(`${CONNECTOR.server}/feed/${w.id}/done`, { method: 'POST', headers: { authorization: `Bearer ${w.key}` }, body: JSON.stringify({ upTo: 99 }) }), c.env, { fetch: restFetch as typeof fetch, projectId: 'p', apiKey: 'k' });
    expect(wipe.status).toBe(403);

    // A note left just before the link goes off still comes in, then the log here is forgotten.
    forgetPages();
    await c.ask(address, 'add_note', { text: 'One more thing.' });
    await a.ME.turnOff(l.id);
    expect(a.added.map((e) => e.title)).toEqual(['Claude: Ran 5 km before work.', 'Claude: One more thing.']);
    expect(a.ME.feedOf(l.id)).toEqual([]);
    await expect(read(w)).rejects.toMatchObject({ code: 'off' });
  });

  it("puts the app's to-dos on the list, once each", async () => {
    const c = connector();
    const a = await device();
    const l = await a.ME.connect('ChatGPT', LINK_DEFAULT);
    await a.ME.setWeb(l.id, { notes: true });
    const address = a.ME.connectorAddress(a.ME.links()[0]);
    expect((await c.ask(address, 'add_todo', { text: 'Call mum', day: '2026-11-20' }, 'openai-mcp/1.0')).isError).toBeUndefined();
    expect(await a.ME.pullFeeds({ force: true })).toBe(1);
    const todos = Object.values(a.S.state.todos);
    expect(todos).toMatchObject([{ title: 'Call mum', day: '2026-11-20', from: 'ChatGPT' }]);
    expect(a.ME.feedOf(l.id).map((e) => e.tool)).toEqual(['add_todo']);
    expect(a.added).toEqual([]); // not a note
    // Once only, even if it came again.
    const again = (await import('./lib/feed')).cleanEntry({ at: Date.now(), tool: 'add_todo', ok: true, note: 'Call mum' });
    expect(again).toMatchObject({ tool: 'add_todo' });
    expect(a.S.addTodo({ id: todos[0].id, title: 'Call mum' })).toBeNull();
  });

  it('never shows an entry twice, even when the connector missed that Arise took it', async () => {
    const c = connector();
    const a = await device();
    const l = await a.ME.connect('Claude', LINK_DEFAULT);
    await a.ME.setWeb(l.id, { notes: true });
    const address = a.ME.connectorAddress(a.ME.links()[0]);
    await c.ask(address, 'add_note', { text: 'Ran 5 km.' });
    // "Done" doesn't reach the connector this time.
    const real = c.fetchStub.getMockImplementation()!;
    c.fetchStub.mockImplementation(async (input, init) => (String(input).endsWith('/done') ? Promise.reject(new TypeError('offline')) : real(input, init)));
    expect(await a.ME.pullFeeds({ force: true })).toBe(1);
    c.fetchStub.mockImplementation(real);
    expect(await a.ME.pullFeeds({ force: true })).toBe(0);
    expect(a.ME.feedOf(l.id)).toHaveLength(1);
    expect(a.added).toHaveLength(1);
  });

  it('leaves notes with the connector on a device without a life log', async () => {
    const c = connector();
    const a = await device();
    const l = await a.ME.connect('Claude', LINK_DEFAULT);
    await a.ME.setWeb(l.id, { notes: true });
    const address = a.ME.connectorAddress(a.ME.links()[0]);
    await c.ask(address, 'about_me');
    await c.ask(address, 'add_note', { text: 'Ran 5 km.' });
    await c.ask(address, 'my_goals');
    (await import('./life/store-port')).setLifeStore(null);
    expect(await a.ME.pullFeeds({ force: true })).toBe(0);
    expect(a.ME.feedOf(l.id).map((e) => e.tool)).toEqual(['about_me']);
    expect((c.data.get(a.ME.links()[0].web!.id)!.get('e') as unknown[]).length).toBe(2); // the note and what came after
  });

  it("asks the Player first when the app's rules say so, and adds it only when they allow it", async () => {
    const c = connector();
    const a = await device();
    const l = await a.ME.connect('Claude', LINK_DEFAULT);
    await a.ME.setWeb(l.id, { notes: true });
    const rules = { ask: ['todo' as const], never: ['note' as const], house: 'Be brief.' };
    expect(await a.ME.setRules(l.id, rules)).toBe(true);
    const w = a.ME.links()[0].web!;
    // Both pages carry them, sealed like the rest.
    expect((await read(w)).rules).toEqual(rules);
    expect((await read(l)).rules).toEqual(rules);
    const address = a.ME.connectorAddress(a.ME.links()[0]);
    expect((await c.ask(address, 'about_me')).content[0].text).toContain('- Be brief.');
    expect((await c.ask(address, 'add_note', { text: 'Ran 5 km' })).isError).toBe(true);
    expect((await c.ask(address, 'add_todo', { text: 'Call mum', day: '2026-11-20' })).content[0].text).toContain("It isn't added yet");
    expect((await c.ask(address, 'add_todo', { text: 'Buy a bike light' })).isError).toBeUndefined();

    expect(await a.ME.pullFeeds({ force: true })).toBe(0); // nothing added yet
    expect(Object.values(a.S.state.todos)).toEqual([]);
    const waiting = a.ME.asksFor(l.id);
    expect(waiting).toMatchObject([
      { want: 'add_todo', text: 'Call mum', day: '2026-11-20', client: 'Claude' },
      { want: 'add_todo', text: 'Buy a bike light' },
    ]);
    expect(a.ME.feedOf(l.id).map((e) => e.tool)).toEqual(['about_me', 'add_note', 'ask', 'ask']);

    expect(await a.ME.allowAsk(a.ME.askKey(waiting[0]))).toBe(true);
    a.ME.dismissAsk(a.ME.askKey(waiting[1]));
    expect(Object.values(a.S.state.todos)).toMatchObject([{ title: 'Call mum', day: '2026-11-20', from: 'Claude' }]);
    expect(a.ME.asks()).toEqual([]);
    expect(await a.ME.allowAsk(a.ME.askKey(waiting[0]))).toBe(false); // once only

    // Turning the link off lets go of what's still waiting.
    await c.ask(address, 'add_todo', { text: 'Water the plants' });
    await a.ME.pullFeeds({ force: true });
    expect(a.ME.asks()).toHaveLength(1);
    await a.ME.turnOff(l.id);
    expect(a.ME.asks()).toEqual([]);
  });

  it('keeps to the rules in Arise too, for a connector from before them, and says it needs the update', async () => {
    const c = connector();
    const a = await device();
    const l = await a.ME.connect('Claude', LINK_DEFAULT);
    await a.ME.setWeb(l.id, { notes: true });
    const address = a.ME.connectorAddress(a.ME.links()[0]);
    // What a connector that doesn't know the rules would take: a note and a to-do, added straight.
    await c.ask(address, 'add_note', { text: 'Ran 5 km.' });
    await c.ask(address, 'add_todo', { text: 'Call mum' });
    await a.ME.setRules(l.id, { ask: ['todo'], never: ['note'], house: '' });
    await a.ME.pullFeeds({ force: true });
    expect(a.added).toEqual([]); // never: let go
    expect(Object.values(a.S.state.todos)).toEqual([]);
    expect(a.ME.asksFor(l.id)).toMatchObject([{ want: 'add_todo', text: 'Call mum' }]); // ask first: waits

    // This connector keeps to them; one from before doesn't say so.
    expect(await a.ME.checkConnector()).toBe(true);
    expect(a.ME.connectorKeepsRules()).toBe(true);
    expect(a.ME.needsConnectorUpdate(a.ME.links()[0])).toBe(false);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, name: 'arise-connector', version: '1.0.0' }), { status: 200 }));
    expect(await a.ME.checkConnector()).toBe(true);
    expect(a.ME.connectorKeepsRules()).toBe(false);
    expect(a.ME.needsConnectorUpdate(a.ME.links()[0])).toBe(true);
    expect(a.ME.needsConnectorUpdate({ ...a.ME.links()[0], rules: undefined })).toBe(false); // no rules, nothing to keep to

    // Never to both: the page says it takes nothing, so no connector offers a way to add.
    await a.ME.setRules(l.id, { ask: [], never: ['note', 'todo'], house: '' });
    expect(a.ME.webNow(a.ME.links()[0])!.notes).toBe(false);
    expect((await read(a.ME.links()[0].web!)).web!.notes).toBe(false);
    expect(a.ME.links()[0].web!.notes).toBe(true); // the switch itself stays as the Player set it
  });

  it('asks the connector nothing when no app is on the web', async () => {
    const c = connector();
    const a = await device();
    await a.ME.connect('Buddy', LINK_DEFAULT);
    expect(await a.ME.pullFeeds({ force: true })).toBe(0);
    expect(c.fetchStub).not.toHaveBeenCalled();
  });
});

describe('files on the web', () => {
  // A folder shared with the app, with a small file, a bigger one (three sealed parts) and one
  // outside it that the app must never see.
  async function withFiles() {
    const c = connector();
    const a = await device();
    const F = await import('./life/files');
    const dir = await F.makeFolder('For Claude');
    await F.putFile(new TextEncoder().encode('Milk, eggs, bread'), { name: 'list.txt', type: 'text/plain', dir });
    const bigBytes = new Uint8Array(40 * 1024).map((_, i) => (i * 7) % 251);
    await F.putFile(bigBytes, { name: 'notes.bin', type: 'application/octet-stream', dir });
    await F.putFile(new TextEncoder().encode('My diary'), { name: 'diary.txt', type: 'text/plain' });
    const l = await a.ME.connect('Claude', LINK_DEFAULT);
    const address = () => a.ME.connectorAddress(a.ME.links()[0]);
    const tools = async () => {
      const res = await handle(new Request(address(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), c.env, { fetch: restFetch as typeof fetch, projectId: 'p', apiKey: 'k' });
      return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    };
    return { c, a, F, dir, bigBytes, l, address, tools };
  }
  type Listed = { id: string; name: string; data?: string; p?: { n: number } };

  it('lets the app read only the files in the folder the Player shares, and only with Read files on', async () => {
    const { c, a, F, dir, bigBytes, l, address, tools } = await withFiles();
    await a.ME.setWeb(l.id, { notes: false, dir, fread: true });
    const w = a.ME.links()[0].web!;
    const page = await read(w);
    expect(page.web).toEqual({ notes: false, feed: w.fh, files: { read: true, write: false, folder: 'For Claude' } });
    const files = page.files as Listed[];
    expect(files.map((f) => f.name).sort()).toEqual(['list.txt', 'notes.bin']);
    const small = files.find((f) => f.name === 'list.txt')!;
    const big = files.find((f) => f.name === 'notes.bin')!;
    expect(atob(small.data!)).toBe('Milk, eggs, bread'); // inside the sealed page
    expect(big).not.toHaveProperty('data');
    expect(big.p!.n).toBe(3);
    // The bigger one's parts are pages of their own, sealed: nothing of the file shows in the cloud.
    const ids = w.parts![big.id].ids;
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      const doc = cloud.docs.get(`shares/${id}`) as { ct: string; owner: string };
      expect(doc.owner).toBe(a.SYNC.status.user!.uid);
      expect(doc.ct.length).toBeLessThanOrEqual(20_000);
      expect(doc.ct).not.toContain(btoa(String.fromCharCode(...bigBytes.subarray(0, 30))));
    }
    // Not the link's own page: only the app on the web gets files.
    expect(await read(l)).not.toHaveProperty('files');

    expect(await tools()).toEqual(['about_me', 'my_goals', 'search', 'fetch', 'list_files', 'read_file']);
    const list = (await c.ask(address(), 'list_files')).content[0].text;
    expect(list).toContain('list.txt');
    expect(list).toContain('notes.bin');
    expect(list).not.toContain('diary');
    expect((await c.ask(address(), 'read_file', { id: small.id })).content[1].text).toBe('Milk, eggs, bread');
    const got = (await c.ask(address(), 'read_file', { id: big.id })) as unknown as { content: { resource?: { blob: string } }[] };
    expect(Uint8Array.from(atob(got.content[1].resource!.blob), (x) => x.charCodeAt(0))).toEqual(bigBytes);
    // A file outside the folder has no id the app could use.
    const diary = (await F.listFiles()).find((f) => f.name === 'diary.txt')!;
    expect((await c.ask(address(), 'read_file', { id: diary.id })).isError).toBe(true);

    // Read files off: nothing listed, the tools go, and the parts are off for good.
    await a.ME.setWeb(l.id, { notes: false, fread: false });
    forgetPages();
    expect(await read(w)).not.toHaveProperty('files');
    expect((await read(w)).web).not.toHaveProperty('files');
    for (const id of ids) expect(cloud.docs.get(`shares/${id}`)).toMatchObject({ off: true });
    expect(a.ME.links()[0].web).not.toHaveProperty('parts');
    expect(await tools()).not.toContain('list_files');
    expect((await c.ask(address(), 'read_file', { id: small.id })).isError).toBe(true);
    // The log names what it did.
    await a.ME.pullFeeds({ force: true });
    expect(a.ME.feedOf(l.id).map((e) => `${e.tool} ${e.ok}`)).toEqual(['list_files true', 'read_file true', 'read_file true', 'read_file false', 'read_file false']);
  });

  it('sends a changed file again, and turns the parts of one that left the folder off', async () => {
    const { a, F, dir, l } = await withFiles();
    await a.ME.setWeb(l.id, { notes: false, dir, fread: true });
    const w = a.ME.links()[0].web!;
    const before = Object.values(w.parts!)[0];
    // The same file, unchanged: the same parts.
    await a.ME.refresh();
    expect(Object.values(a.ME.links()[0].web!.parts!)[0]).toEqual(before);
    // Gone from the folder: its parts go off.
    const big = (await F.listFiles()).find((f) => f.name === 'notes.bin')!;
    await F.moveFiles([big.id]);
    await a.ME.refresh();
    expect(((await read(w)).files as Listed[]).map((f) => f.name)).toEqual(['list.txt']);
    for (const id of before.ids) expect(cloud.docs.get(`shares/${id}`)).toMatchObject({ off: true });
  });

  it('keeps a too-big file listed but never sent, and says so to the app', async () => {
    const { c, a, F, dir, l, address } = await withFiles();
    await F.putFile(new Uint8Array(1024 * 1024 + 1).fill(1), { name: 'huge.bin', type: 'application/octet-stream', dir });
    await a.ME.setWeb(l.id, { notes: false, dir, fread: true });
    const huge = ((await read(a.ME.links()[0].web!)).files as Listed[]).find((f) => f.name === 'huge.bin')!;
    expect(huge).toMatchObject({ big: true });
    expect(huge).not.toHaveProperty('data');
    expect(huge).not.toHaveProperty('p');
    expect((await c.ask(address(), 'list_files')).content[0].text).toContain('huge.bin');
    const res = await c.ask(address(), 'read_file', { id: huge.id });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('too big to read here');
  });

  it('puts a file the app saves into the shared folder, by the rules, and only with Save files on', async () => {
    const { c, a, F, dir, l, address, tools } = await withFiles();
    await a.ME.setWeb(l.id, { notes: false, dir, fwrite: true });
    expect((await read(a.ME.links()[0].web!)).web.files).toEqual({ read: false, write: true, folder: 'For Claude' });
    expect(await tools()).toEqual(['about_me', 'my_goals', 'search', 'fetch', 'save_file']);
    const saved = await c.ask(address(), 'save_file', { name: 'plan.md', content: '# Plan\n- Run' });
    expect(saved.isError).toBeUndefined();
    expect(saved.content[0].text).toContain('Saved as plan.md in their folder "For Claude"');
    const big = await c.ask(address(), 'save_file', { name: 'big.txt', content: 'x'.repeat(256 * 1024 + 1) });
    expect(big.isError).toBe(true);
    expect(big.content[0].text).toContain('too big');

    expect(await a.ME.pullFeeds({ force: true })).toBe(1);
    const plan = (await F.listFiles()).find((f) => f.name === 'plan.md')!;
    expect(plan).toMatchObject({ dir, type: 'text/markdown' });
    expect(new TextDecoder().decode(new Uint8Array(await (await F.getFile(plan.id))!.blob.arrayBuffer()))).toBe('# Plan\n- Run');
    // The log keeps its name, not its bytes.
    expect(a.ME.feedOf(l.id).map((e) => [e.tool, e.ok, e.file])).toEqual([
      ['save_file', true, { name: 'plan.md', type: 'text/markdown' }],
      ['save_file', false, undefined],
    ]);
    // Once only.
    expect(await a.ME.pullFeeds({ force: true })).toBe(0);
    expect((await F.listFiles()).filter((f) => f.name === 'plan.md')).toHaveLength(1);

    // Ask first: it waits for the Player's yes, with the file.
    await a.ME.setRules(l.id, { ask: ['file'], never: [], house: '' });
    forgetPages();
    expect((await c.ask(address(), 'save_file', { name: 'idea.txt', content: 'Paint the shed' })).content[0].text).toContain("idea.txt isn't saved yet");
    expect(await a.ME.pullFeeds({ force: true })).toBe(0);
    const [waiting] = a.ME.asksFor(l.id);
    expect(waiting).toMatchObject({ want: 'save_file', text: 'idea.txt', file: { name: 'idea.txt', type: 'text/plain' } });
    expect((await F.listFiles()).some((f) => f.name === 'idea.txt')).toBe(false);
    expect(await a.ME.allowAsk(a.ME.askKey(waiting))).toBe(true);
    expect((await F.listFiles()).find((f) => f.name === 'idea.txt')).toMatchObject({ dir });

    // Never: not offered, and the page says it may not save.
    await a.ME.setRules(l.id, { ask: [], never: ['file'], house: '' });
    forgetPages();
    expect(await tools()).not.toContain('save_file');
    expect((await read(a.ME.links()[0].web!)).web).not.toHaveProperty('files');
    expect((await c.ask(address(), 'save_file', { name: 'x.txt', content: 'x' })).isError).toBe(true);
  });

  it("keeps a saved file with the connector on a device that can't keep it, and lets it go once Save files is off", async () => {
    const { c, a, F, dir, l, address } = await withFiles();
    await a.ME.setWeb(l.id, { notes: false, dir, fwrite: true });
    await c.ask(address(), 'save_file', { name: 'late.txt', content: 'Too late' });
    const PORT = await import('./life/store-port');
    PORT.setLifeStore(null);
    expect(await a.ME.pullFeeds({ force: true })).toBe(0);
    expect((c.data.get(a.ME.links()[0].web!.id)!.get('e') as unknown[]).length).toBe(1); // still there
    PORT.setLifeStore({ addEvents: async (e) => e.length });
    await a.ME.setWeb(l.id, { notes: false, fwrite: false });
    expect(await a.ME.pullFeeds({ force: true })).toBe(0);
    expect((await F.listFiles()).some((f) => f.name === 'late.txt')).toBe(false);
    expect(c.data.get(a.ME.links()[0].web!.id)!.get('e')).toEqual([]);
  });

  it('gives the app nothing about the Player with Read off, even straight from its page', async () => {
    const { c, a, l, address, tools } = await withFiles();
    await a.ME.setWeb(l.id, { notes: true, read: false });
    const page = await read(a.ME.links()[0].web!);
    expect(page.web).toMatchObject({ read: false, notes: true });
    expect(page.goals).toEqual([]);
    expect(page.facts).toEqual([]);
    expect(page).not.toHaveProperty('name');
    expect(await tools()).toEqual(['add_note', 'add_todo']);
    expect((await c.ask(address(), 'my_goals')).isError).toBe(true);
    expect((await read(l)).goals[0].title).toBe('Run a half marathon'); // the link itself is as it was
    // On again.
    await a.ME.setWeb(l.id, { notes: true, read: true });
    forgetPages();
    expect((await c.ask(address(), 'my_goals')).content[0].text).toContain('Run a half marathon');
  });

  it('knows a connector from before files, and keeps a link without file switches exactly as before', async () => {
    const { a, l } = await withFiles();
    expect(await a.ME.checkConnector()).toBe(true);
    expect(a.ME.connectorDoesFiles()).toBe(true);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, name: 'arise-connector', version: '1.1.0', features: ['rules'] }), { status: 200 }));
    expect(await a.ME.checkConnector()).toBe(true);
    expect(a.ME.connectorDoesFiles()).toBe(false);
    connector();
    await a.ME.setWeb(l.id, { notes: false });
    const w = a.ME.links()[0].web!;
    expect(w).not.toHaveProperty('dir');
    expect(w).not.toHaveProperty('read');
    const page = await read(w);
    expect(page.web).toEqual({ notes: false, feed: w.fh });
    expect(page).not.toHaveProperty('files');
  });
});
