// The web connector: MCP over HTTP for AI apps on the web, from one app's me link, only while the
// Player has the web on for it; the sealed log and notes Arise reads back.

import { beforeEach, describe, expect, it } from 'vitest';
import { Feed, forgetPages, handle, MAX_FILES, MAX_NOTES, type Env, type StorageLike } from './index';
import { filesKey, newUpload, PART_BYTES, partCount, partId, sealPart } from '../../../src/lib/me-files';
import { cloud, resetCloud, restFetch } from '../../../src/test/fake-firebase';
import * as ME from '../../../src/lib/me';
import { newShareRef, SHARE_OFF } from '../../../src/lib/share';
import { feedKey, newFeedToken, openEntry, tokenHash, type SealedEntry } from '../../../src/lib/feed';

const BASE: ME.MePayload = {
  format: 'arise.me/v1',
  name: 'Sam',
  facts: [{ text: 'I run on Sunday mornings.', since: '2026-09-02' }],
  goals: [{ title: 'Run a half marathon', why: 'I want to feel strong at 40', streak: 12 }],
  days: [{ day: '2026-10-16', text: 'I ran 8 km before work.' }],
  updated: Date.UTC(2026, 9, 17, 9, 30),
};

let now = Date.UTC(2026, 9, 17, 10);
const deps = { fetch: restFetch as typeof fetch, projectId: 'p', apiKey: 'k', now: () => now };

// Durable Objects, one per name, each with storage in memory.
function fakeEnv(limits = { link: true, ip: true }) {
  const objects = new Map<string, { feed: Feed; data: Map<string, unknown>; alarm: number }>();
  const env: Env & { objects: typeof objects } = {
    ALLOWED_ORIGINS: 'https://abyyworld.github.io,capacitor://localhost',
    SITE: 'https://abyyworld.github.io/arise/',
    PER_LINK: { limit: async () => ({ success: limits.link }) },
    PER_IP: { limit: async () => ({ success: limits.ip }) },
    objects,
    FEEDS: {
      idFromName: (name: string) => name,
      get(id: unknown) {
        const name = String(id);
        if (!objects.has(name)) {
          const data = new Map<string, unknown>();
          const o = { feed: null as unknown as Feed, data, alarm: 0 };
          const storage: StorageLike = {
            get: async <T,>(k: string) => structuredClone(data.get(k)) as T | undefined,
            put: async (k, v) => void data.set(k, structuredClone(v)),
            delete: async (k) => data.delete(k),
            deleteAll: async () => data.clear(),
            setAlarm: async (t) => void (o.alarm = t),
          };
          o.feed = new Feed({ storage }, undefined, () => now);
          objects.set(name, o);
        }
        const o = objects.get(name)!;
        return { fetch: (input: string, init?: RequestInit) => o.feed.fetch(new Request(input, init)) };
      },
    },
  };
  return env;
}

// A page in the cloud, as the Player's Arise leaves it. With `web`, the token that reads its log
// back goes with it (the page holds only its hash), unless `feed` says otherwise.
async function fakeLink(p: ME.MePayload) {
  const ref = await newShareRef();
  const token = newFeedToken();
  const payload = p.web && !('feed' in p.web) ? { ...p, web: { ...p.web, feed: await tokenHash(token) } } : p;
  const { sealed } = await ME.sealMe(ref, payload);
  cloud.docs.set(`shares/${ref.id}`, { owner: 'uid1', iv: sealed.iv, ct: sealed.ct, v: 1, updated: p.updated });
  return Object.assign(ref, { token });
}

const at = (ref: { id: string; key: string }) => `https://arise-connector.example.workers.dev/mcp/${ref.id}.${ref.key}`;
type Reply = { id?: unknown; result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean; protocolVersion?: string }; error?: { code: number; message: string } };
async function post(env: Env, url: string, body: unknown, ua = 'Claude-User') {
  const res = await handle(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': ua }, body: JSON.stringify(body) }), env, deps);
  return { res, body: res.status === 202 ? null : ((await res.json()) as Reply) };
}
const rpc = (env: Env, url: string, method: string, params?: object) => post(env, url, { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
const call = async (env: Env, url: string, name: string, args: object = {}) => (await rpc(env, url, 'tools/call', { name, arguments: args })).body!.result!;
const toolNames = async (env: Env, url: string) => (await rpc(env, url, 'tools/list')).body!.result!.tools!.map((t) => t.name);

async function readFeed(env: Env, ref: { id: string; key: string; token: string }) {
  const key = await feedKey(ref.id, ref.key);
  const token = ref.token;
  const res = await handle(new Request(`https://x/feed/${ref.id}`, { headers: { authorization: `Bearer ${token}`, origin: 'https://abyyworld.github.io' } }), env, deps);
  const { entries = [] } = (await res.json()) as { entries?: SealedEntry[] };
  return { res, entries, open: await Promise.all(entries.map((e) => openEntry(key, ref.id, e))), token };
}

beforeEach(() => {
  resetCloud();
  forgetPages();
  now = Date.UTC(2026, 9, 17, 10);
});

describe('the web connector', () => {
  it('says it is there, for Arise to check', async () => {
    const res = await handle(new Request('https://x/health', { headers: { origin: 'https://abyyworld.github.io' } }), fakeEnv(), deps);
    // From 1.1.0 it says it keeps to the Player's rules, and from 1.2.0 that it serves files, so Arise knows it needs no update.
    expect(await res.json()).toMatchObject({ ok: true, name: 'arise-connector', version: '1.2.0', features: ['rules', 'files'] });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://abyyworld.github.io');
    const other = await handle(new Request('https://x/health', { headers: { origin: 'https://evil.example' } }), fakeEnv(), deps);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('speaks MCP over HTTP: JSON answers, 202 for notifications, no stream', async () => {
    const env = fakeEnv();
    const url = at(await fakeLink({ ...BASE, web: { notes: false } }));
    const init = await rpc(env, url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } });
    expect(init.res.status).toBe(200);
    expect(init.res.headers.get('content-type')).toContain('application/json');
    expect(init.res.headers.get('access-control-allow-origin')).toBe('*');
    expect(init.body!.result!.protocolVersion).toBe('2025-06-18');
    const n = await post(env, url, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(n.res.status).toBe(202);
    expect((await handle(new Request(url), env, deps)).status).toBe(405);
    expect((await handle(new Request(url, { method: 'DELETE' }), env, deps)).status).toBe(405);
    const batch = await post(env, url, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);
    expect(batch.body).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
    expect((await handle(new Request(url, { method: 'POST', body: '{nope' }), env, deps)).status).toBe(400);
    expect((await handle(new Request('https://x/mcp/not-a-link', { method: 'POST', body: '{}' }), env, deps)).status).toBe(404);
    expect((await handle(new Request('https://x/.well-known/oauth-protected-resource'), env, deps)).status).toBe(404);
  });

  it('answers only for a link the Player turned on for the web, and only until the date they picked', async () => {
    const env = fakeEnv();
    const plain = at(await fakeLink(BASE));
    const off = await call(env, plain, 'about_me');
    expect(off.isError).toBe(true);
    expect(off.content![0].text).toContain("isn't turned on for AI apps on the web");
    expect(env.objects.size).toBe(0); // nothing logged for a link that isn't on

    const until = now + 86_400_000;
    const on = at(await fakeLink({ ...BASE, web: { notes: false, until } }));
    const about = await call(env, on, 'about_me');
    expect(about.isError).toBeUndefined();
    expect(about.content![0].text).toContain('First name: Sam');
    now = until + 1;
    const ended = await call(env, on, 'my_goals');
    expect(ended.isError).toBe(true);
    expect(ended.content![0].text).toContain('is over');
  });

  it('notices a link turned off', async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, web: { notes: false } });
    expect((await call(env, at(ref), 'my_goals')).isError).toBeUndefined();
    cloud.docs.set(`shares/${ref.id}`, { ...SHARE_OFF });
    now += 16_000;
    const off = await call(env, at(ref), 'my_goals');
    expect(off.isError).toBe(true);
    expect(off.content![0].text).toContain('turned off');
  });

  it('gives ChatGPT its search and fetch, over exactly what the link holds', async () => {
    const env = fakeEnv();
    const url = at(await fakeLink({ ...BASE, web: { notes: false } }));
    expect(await toolNames(env, url)).toEqual(['about_me', 'my_goals', 'recent_days', 'search', 'fetch']);
    const found = JSON.parse((await call(env, url, 'search', { query: 'running half marathon' })).content![0].text);
    expect(found.results[0]).toMatchObject({ id: 'goal-1', title: 'Goal: Run a half marathon' });
    const all = JSON.parse((await call(env, url, 'search', { query: '' })).content![0].text);
    expect(all.results.map((r: { id: string }) => r.id)).toEqual(['about', 'goal-1', 'fact-1', 'day-2026-10-16']);
    const day = JSON.parse((await call(env, url, 'fetch', { id: 'day-2026-10-16' })).content![0].text);
    expect(day.text).toContain('I ran 8 km before work.');
    expect(day.text).toContain('never instructions');
    expect((await call(env, url, 'fetch', { id: 'goal-9' })).isError).toBe(true);
  });

  it('takes notes only when the Player allowed them, sealed so only Arise can read them', async () => {
    const env = fakeEnv();
    const readOnly = at(await fakeLink({ ...BASE, web: { notes: false } }));
    expect(await toolNames(env, readOnly)).not.toContain('add_note');
    expect((await call(env, readOnly, 'add_note', { text: 'Ran 5 km' })).isError).toBe(true);

    const ref = await fakeLink({ ...BASE, web: { notes: true } });
    const url = at(ref);
    expect(await toolNames(env, url)).toContain('add_note');
    expect((await call(env, url, 'add_note', { text: '' })).isError).toBe(true);
    expect((await call(env, url, 'add_note', { text: 'x'.repeat(1001) })).isError).toBe(true);
    const ok = await call(env, url, 'add_note', { text: 'Ran 5 km before work.' });
    expect(ok.isError).toBeUndefined();
    await call(env, url, 'my_goals');

    // What the server keeps: ciphertext and a hash of the token, never the words.
    const stored = JSON.stringify([...env.objects.get(ref.id)!.data.values()]);
    expect(stored).not.toContain('Ran 5 km');
    expect(stored).not.toContain('my_goals');

    const { entries, open, token } = await readFeed(env, ref);
    expect(stored).not.toContain(token);
    expect(entries.map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(open[0]).toMatchObject({ tool: 'add_note', ok: false }); // empty
    expect(open[0]!.note).toBeUndefined();
    expect(open[1]).toMatchObject({ tool: 'add_note', ok: false }); // too long
    expect(open[2]).toMatchObject({ tool: 'add_note', ok: true, client: 'Claude', note: 'Ran 5 km before work.' });
    expect(open[3]).toMatchObject({ tool: 'my_goals', ok: true, client: 'Claude' });
    expect(env.objects.get(ref.id)!.alarm).toBe(now + 60 * 86_400_000);
  });

  it('takes to-dos too, with a day if given, under the same switch as notes', async () => {
    const env = fakeEnv();
    const readOnly = at(await fakeLink({ ...BASE, web: { notes: false } }));
    expect(await toolNames(env, readOnly)).not.toContain('add_todo');
    const ref = await fakeLink({ ...BASE, web: { notes: true } });
    expect(await toolNames(env, at(ref))).toEqual(['about_me', 'my_goals', 'recent_days', 'search', 'fetch', 'add_note', 'add_todo']);
    expect((await call(env, at(ref), 'add_todo', { text: 'Call mum', day: 'Friday' })).isError).toBe(true);
    const ok = await call(env, at(ref), 'add_todo', { text: 'Call mum', day: '2026-11-20' });
    expect(ok.content![0].text).toContain('Added to their to-dos for Fri, 20 Nov 2026.');
    expect((await call(env, at(ref), 'add_todo', { text: 'Buy a bike light' })).isError).toBeUndefined();
    const { open } = await readFeed(env, ref);
    expect(open.filter((e) => e!.ok)).toMatchObject([
      { tool: 'add_todo', note: 'Call mum', day: '2026-11-20' },
      { tool: 'add_todo', note: 'Buy a bike light' },
    ]);
    expect(open.at(-1)).not.toHaveProperty('day');
  });

  it('logs what each app did, which only the token from the link opens, and lets it go once read', async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, web: { notes: false } });
    await post(env, at(ref), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'about_me', arguments: {} } }, 'openai-mcp/1.0');
    await post(env, at(ref), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const { entries, open, token } = await readFeed(env, ref);
    expect(entries).toHaveLength(1); // listing tools isn't logged
    expect(open[0]).toMatchObject({ tool: 'about_me', ok: true, client: 'ChatGPT', at: now });

    const wrong = await handle(new Request(`https://x/feed/${ref.id}`, { headers: { authorization: `Bearer ${'A'.repeat(43)}` } }), env, deps);
    expect(wrong.status).toBe(403);
    // Whoever has the address (the AI app) has the page's key, not the token: it can't read or wipe the log.
    for (const guess of [ref.key]) {
      expect((await handle(new Request(`https://x/feed/${ref.id}/done`, { method: 'POST', headers: { authorization: `Bearer ${guess}` }, body: JSON.stringify({ upTo: 99 }) }), env, deps)).status).toBe(403);
    }
    expect((await readFeed(env, ref)).entries).toHaveLength(1);
    expect((await handle(new Request(`https://x/feed/${ref.id}`), env, deps)).status).toBe(401);
    // Another link's log, with this token: refused.
    const other = await fakeLink({ ...BASE, web: { notes: false } });
    await call(env, at(other), 'about_me');
    expect((await handle(new Request(`https://x/feed/${other.id}`, { headers: { authorization: `Bearer ${token}` } }), env, deps)).status).toBe(403);

    const done = await handle(new Request(`https://x/feed/${ref.id}/done`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ upTo: entries[0].n }) }), env, deps);
    expect(await done.json()).toEqual({ left: 0 });
    expect((await readFeed(env, ref)).entries).toEqual([]);
  });

  it('keeps nothing and takes no notes for a page without a token to read them back', async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, web: { notes: true, feed: undefined } });
    expect((await call(env, at(ref), 'about_me')).isError).toBeUndefined();
    const note = await call(env, at(ref), 'add_note', { text: 'Ran 5 km' });
    expect(note.isError).toBe(true);
    expect(note.content![0].text).toContain("can't keep notes");
    expect(env.objects.size).toBe(0);
  });

  it('takes a new token when the Player turned the web off and on again', async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, web: { notes: false } });
    await call(env, at(ref), 'about_me');
    const token = newFeedToken();
    const { sealed } = await ME.sealMe(ref, { ...BASE, web: { notes: false, feed: await tokenHash(token) } });
    cloud.docs.set(`shares/${ref.id}`, { owner: 'uid1', iv: sealed.iv, ct: sealed.ct, v: 1, updated: BASE.updated });
    forgetPages();
    await call(env, at(ref), 'my_goals');
    expect((await readFeed(env, ref)).res.status).toBe(403);
    expect((await readFeed(env, { ...ref, token })).entries).toHaveLength(2);
  });

  it('keeps at most 50 notes waiting, and nothing past 60 days unused', async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, web: { notes: true } });
    for (let i = 0; i < MAX_NOTES; i++) expect((await call(env, at(ref), 'add_note', { text: `Note ${i}` })).isError).toBeUndefined();
    const full = await call(env, at(ref), 'add_note', { text: 'One more' });
    expect(full.isError).toBe(true);
    expect(full.content![0].text).toContain('notes waiting');
    await env.objects.get(ref.id)!.feed.alarm();
    // Only the count stays, so numbers never start again at 1.
    expect([...env.objects.get(ref.id)!.data]).toEqual([['n', MAX_NOTES + 1]]);
  });

  it('opens a shared file only with Read files on: from the page, or from its sealed parts in the cloud', async () => {
    const env = fakeEnv();
    const ref = await newShareRef();
    const token = newFeedToken();
    const big = new Uint8Array(PART_BYTES * 2 + 100).map((_, i) => i % 256);
    const v = newUpload();
    const key = await filesKey(ref.id, ref.key);
    const n = partCount(big.length);
    for (let i = 0; i < n; i++) {
      const s = await sealPart(key, ref.id, 'b'.repeat(22), v, i, n, big.subarray(i * PART_BYTES, (i + 1) * PART_BYTES));
      cloud.docs.set(`shares/${await partId(ref.id, ref.key, 'b'.repeat(22), v, i)}`, { owner: 'uid1', iv: s.iv, ct: s.ct, v: 1, updated: 1 });
    }
    const files = [
      { id: 'a'.repeat(22), name: 'list.txt', type: 'text/plain', size: 5, at: 1, data: btoa('Milk.') },
      { id: 'b'.repeat(22), name: 'data.bin', type: 'application/octet-stream', size: big.length, at: 2, p: { v, n } },
    ];
    const put = async (web: object) => {
      const { sealed } = await ME.sealMe(ref, { ...BASE, web: { notes: false, feed: await tokenHash(token), ...web }, files } as ME.MePayload);
      cloud.docs.set(`shares/${ref.id}`, { owner: 'uid1', iv: sealed.iv, ct: sealed.ct, v: 1, updated: BASE.updated });
      forgetPages();
    };
    await put({ files: { read: true, write: false, folder: 'Shared' } });
    expect((await call(env, at(ref), 'read_file', { id: 'a'.repeat(22) })).content![1].text).toBe('Milk.');
    const got = (await call(env, at(ref), 'read_file', { id: 'b'.repeat(22) })) as unknown as { content: { resource: { blob: string } }[] };
    expect(Uint8Array.from(atob(got.content[1].resource.blob), (x) => x.charCodeAt(0))).toEqual(big);
    // A part swapped for another: it doesn't open, and the app is told to wait for Arise.
    const p0 = `shares/${await partId(ref.id, ref.key, 'b'.repeat(22), v, 0)}`;
    const p1 = `shares/${await partId(ref.id, ref.key, 'b'.repeat(22), v, 1)}`;
    const first = cloud.docs.get(p0)!;
    cloud.docs.set(p0, cloud.docs.get(p1)!);
    const swapped = await call(env, at(ref), 'read_file', { id: 'b'.repeat(22) });
    expect(swapped.isError).toBe(true);
    expect(swapped.content![0].text).toContain("doesn't open");
    // A part turned off: gone.
    cloud.docs.set(p0, SHARE_OFF);
    expect((await call(env, at(ref), 'read_file', { id: 'b'.repeat(22) })).content![0].text).toContain("isn't there any more");
    cloud.docs.set(p0, first);
    // Read files off: no tool, nothing read, whatever the page still lists.
    await put({});
    expect(await toolNames(env, at(ref))).not.toContain('read_file');
    expect((await call(env, at(ref), 'read_file', { id: 'a'.repeat(22) })).isError).toBe(true);
    // The log names each tool, refused or not.
    const { open } = await readFeed(env, { ...ref, token });
    expect(open.map((e) => `${e!.tool} ${e!.ok}`)).toEqual(['read_file true', 'read_file true', 'read_file false', 'read_file false', 'read_file false']);
  });

  it('takes a saved file only with Save files on, sealed in the log and kept on its own until Arise takes it', async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, web: { notes: false, files: { read: false, write: true, folder: 'Shared' } } } as ME.MePayload);
    // (A file is far bigger than a note: the connector takes it whole.)
    const text = 'Plan. '.repeat(20_000);
    expect(text.length).toBeGreaterThan(64 * 1024);
    const ok = await call(env, at(ref), 'save_file', { name: 'plan.md', content: text });
    expect(ok.isError).toBeUndefined();
    expect((await call(env, at(ref), 'save_file', { name: 'big.txt', content: 'x'.repeat(256 * 1024 + 1) })).isError).toBe(true);
    const o = env.objects.get(ref.id)!;
    // Kept apart from the list, and only as ciphertext.
    const list = o.data.get('e') as { n: number; ct: string; file?: boolean }[];
    expect(list.map((e) => [e.n, e.file, e.ct])).toEqual([
      [1, true, ''],
      [2, undefined, expect.any(String)],
    ]);
    expect(String(o.data.get('f1')).length).toBeGreaterThan(100_000);
    expect(JSON.stringify([...o.data.values()])).not.toContain('Plan.');
    const { entries, open, token } = await readFeed(env, ref);
    expect(open[0]).toMatchObject({ tool: 'save_file', ok: true, client: 'Claude', file: { name: 'plan.md', type: 'text/markdown', data: btoa(text) } });
    expect(open[1]).toMatchObject({ tool: 'save_file', ok: false });
    expect(open[1]).not.toHaveProperty('file');
    await handle(new Request(`https://x/feed/${ref.id}/done`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ upTo: entries.at(-1)!.n }) }), env, deps);
    expect(o.data.has('f1')).toBe(false);
    // At most 10 waiting.
    for (let i = 0; i < MAX_FILES; i++) expect((await call(env, at(ref), 'save_file', { name: `f${i}.txt`, content: 'x' })).isError).toBeUndefined();
    const full = await call(env, at(ref), 'save_file', { name: 'one-more.txt', content: 'x' });
    expect(full.content![0].text).toContain('files waiting');
    // Read only: no saving.
    const reader = await fakeLink({ ...BASE, web: { notes: true, files: { read: true, write: false, folder: 'Shared' } } } as ME.MePayload);
    expect(await toolNames(env, at(reader))).not.toContain('save_file');
    expect((await call(env, at(reader), 'save_file', { name: 'a.txt', content: 'x' })).isError).toBe(true);
  });

  it('asks first for a file when their rules say so, with the file sealed in the request', async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, web: { notes: false, files: { read: false, write: true, folder: 'Shared' } }, rules: { ask: ['file'], never: [], house: '' } } as ME.MePayload);
    expect((await call(env, at(ref), 'save_file', { name: 'idea.txt', content: 'Paint the shed' })).content![0].text).toContain("isn't saved yet");
    const { open } = await readFeed(env, ref);
    expect(open).toMatchObject([{ tool: 'ask', want: 'save_file', note: 'idea.txt', file: { name: 'idea.txt', type: 'text/plain', data: btoa('Paint the shed') } }]);
  });

  it("keeps to the Player's rules: never isn't offered, ask first becomes a sealed request, house rules go with every answer", async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, facts: [...BASE.facts, { text: 'I pay 900 a month in rent.', since: '2026-09-03' }], web: { notes: true }, rules: { ask: ['todo'], never: ['note', 'money'], house: "Don't mention my exams unless I ask." } });
    const url = at(ref);
    const init = (await rpc(env, url, 'initialize', { protocolVersion: '2025-06-18' })).body!.result as { instructions?: string };
    expect(init.instructions).toContain("House rules the user set for you in Arise. Follow them:\n- Don't mention my exams unless I ask.");
    expect(await toolNames(env, url)).toEqual(['about_me', 'my_goals', 'recent_days', 'search', 'fetch', 'add_todo']);
    const about = (await call(env, url, 'about_me')).content![0].text;
    expect(about.startsWith('House rules the user set for you in Arise.')).toBe(true);
    expect(about).toContain('I run on Sunday mornings.');
    expect(about).not.toContain('rent');
    expect(JSON.parse((await call(env, url, 'search', { query: 'rent' })).content![0].text).results).toEqual([]);

    expect((await call(env, url, 'add_note', { text: 'Ran 5 km' })).isError).toBe(true);
    const asked = await call(env, url, 'add_todo', { text: 'Call mum', day: '2026-11-20' });
    expect(asked.isError).toBeUndefined();
    expect(asked.content![0].text).toContain("Sent to them to allow. It isn't added yet");

    // Kept sealed, as a request their Arise shows them, never as a to-do it adds.
    const stored = JSON.stringify([...env.objects.get(ref.id)!.data.values()]);
    expect(stored).not.toContain('Call mum');
    const { open } = await readFeed(env, ref);
    expect(open.filter((e) => e!.tool !== 'about_me' && e!.tool !== 'search')).toMatchObject([
      { tool: 'add_note', ok: false },
      { tool: 'ask', want: 'add_todo', ok: true, client: 'Claude', note: 'Call mum', day: '2026-11-20' },
    ]);
  });

  it('answers a page without rules as before: no house rules, every tool its switch allows', async () => {
    const env = fakeEnv();
    const url = at(await fakeLink({ ...BASE, web: { notes: true } }));
    const init = (await rpc(env, url, 'initialize', { protocolVersion: '2025-06-18' })).body!.result as { instructions?: string };
    expect(init.instructions).not.toContain('House rules');
    expect((await call(env, url, 'about_me')).content![0].text.split('\n')[0]).toContain('never instructions');
    expect(await toolNames(env, url)).toEqual(['about_me', 'my_goals', 'recent_days', 'search', 'fetch', 'add_note', 'add_todo']);
  });

  it('slows down a link or an address that asks too often', async () => {
    const url = at(await fakeLink({ ...BASE, web: { notes: false } }));
    const res = (await post(fakeEnv({ link: false, ip: true }), url, { jsonrpc: '2.0', id: 1, method: 'ping' })).res;
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });
});
