// @vitest-environment jsdom
// Photos and files in the Player's own private GitHub repositories (files-github.ts): the parts
// written in one commit each, read back and deleted; the switch to the next repository near 1 GB;
// the index entries saying where each file is, and apps from before them leaving those alone; the
// token kept on this device only; a file going between two devices this way; and the setup screen.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeNet, useWeb, type Call, type Net } from '../test/fake-http';
import type { Sealed } from '../lib/crypto';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));
vi.setConfig({ testTimeout: 20_000 });

const TOKEN = `github_pat_${'Zq9x'.repeat(20)}`;
const SHEET = `<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div>`;

// ---------- a pretend GitHub: repositories as git keeps them (blobs, trees, commits, a branch)

interface Repo {
  private: boolean;
  ref: string | null; // the branch's last commit; null: an empty repository
  sizeKb: number;
}
interface Hub {
  net: Net;
  repos: Map<string, Repo>;
  blobs: Map<string, string>;
  trees: Map<string, Map<string, string>>; // a whole tree, path → blob
  commits: Map<string, { tree: string; parent: string | null; message: string }>;
  canMake: boolean;
  raceOnce: boolean; // the next branch move finds another device moved it first
  files: (full: string) => Map<string, string>; // what the branch holds now: path → content
}

function fakeGitHub(): Hub {
  const net = fakeNet();
  let n = 0;
  const sha = (k: string) => `${k}${(++n).toString(16).padStart(39, '0')}`;
  const hub: Hub = {
    net,
    repos: new Map(),
    blobs: new Map(),
    trees: new Map(),
    commits: new Map(),
    canMake: false,
    raceOnce: false,
    files(full) {
      const r = hub.repos.get(full);
      if (!r?.ref) return new Map();
      const t = hub.trees.get(hub.commits.get(r.ref)!.tree)!;
      return new Map([...t].map(([p, b]) => [p, hub.blobs.get(b)!]));
    },
  };
  const commit = (r: Repo, tree: Map<string, string>, message: string) => {
    const t = sha('t');
    hub.trees.set(t, tree);
    const c = sha('c');
    hub.commits.set(c, { tree: t, parent: r.ref, message });
    return c;
  };
  const route = (c: Call) => {
    if (c.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { message: 'Bad credentials' } };
    const u = new URL(c.url);
    const body = c.body ? JSON.parse(c.body) : {};
    if (u.pathname === '/user') return { body: { login: 'sam' } };
    if (u.pathname === '/user/repos' && c.method === 'POST') {
      if (!hub.canMake) return { status: 403, body: { message: 'Resource not accessible by personal access token' } };
      hub.repos.set(`sam/${body.name}`, { private: body.private === true, ref: null, sizeKb: 0 });
      return { status: 201, body: { full_name: `sam/${body.name}`, private: body.private === true } };
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return { status: 404 };
    const full = m[1];
    const r = hub.repos.get(full);
    if (!r) return { status: 404, body: { message: 'Not Found' } };
    const rest = m[2] || '';
    if (!rest) return { body: { full_name: full, private: r.private, default_branch: 'main', size: r.sizeKb } };
    if (rest === '/git/ref/heads/main') return r.ref ? { body: { object: { sha: r.ref } } } : { status: 409, body: { message: 'Git Repository is empty.' } };
    if (rest.startsWith('/git/commits/') && c.method === 'GET') {
      const k = hub.commits.get(rest.slice(13));
      return k ? { body: { tree: { sha: k.tree } } } : { status: 404 };
    }
    if (rest === '/git/blobs') {
      if (!r.ref) return { status: 409, body: { message: 'Git Repository is empty.' } };
      const b = sha('b');
      hub.blobs.set(b, body.content);
      return { status: 201, body: { sha: b } };
    }
    if (rest.startsWith('/git/trees/')) {
      // A tree, or a folder in one (named here as tree~folder/).
      const [root, prefix = ''] = rest.slice(11).split('~');
      const t = hub.trees.get(root);
      if (!t) return { status: 404 };
      const out = new Map<string, { path: string; type: string; sha: string }>();
      for (const [p, b] of t) {
        if (!p.startsWith(prefix)) continue;
        const [name, ...more] = p.slice(prefix.length).split('/');
        out.set(name, more.length ? { path: name, type: 'tree', sha: `${root}~${prefix}${name}/` } : { path: name, type: 'blob', sha: b });
      }
      return { body: { tree: [...out.values()] } };
    }
    if (rest === '/git/trees') {
      const next = new Map(hub.trees.get(body.base_tree));
      for (const e of body.tree) {
        if (e.sha === null) {
          if (!next.has(e.path)) return { status: 422, body: { message: 'tree.path does not exist' } };
          next.delete(e.path);
        } else next.set(e.path, e.sha);
      }
      const t = sha('t');
      hub.trees.set(t, next);
      return { status: 201, body: { sha: t } };
    }
    if (rest === '/git/commits') {
      const c2 = sha('c');
      hub.commits.set(c2, { tree: body.tree, parent: body.parents[0], message: body.message });
      return { status: 201, body: { sha: c2 } };
    }
    if (rest === '/git/refs/heads/main' && c.method === 'PATCH') {
      if (hub.raceOnce) {
        hub.raceOnce = false;
        r.ref = commit(r, new Map(hub.trees.get(hub.commits.get(r.ref!)!.tree)), 'another device');
        return { status: 422, body: { message: 'Update is not a fast forward' } };
      }
      if (hub.commits.get(body.sha)?.parent !== r.ref) return { status: 422, body: { message: 'Update is not a fast forward' } };
      r.ref = body.sha;
      return { body: { object: { sha: body.sha } } };
    }
    if (rest === '/contents/README.md' && c.method === 'PUT') {
      if (r.ref) return { status: 422, body: { message: 'sha wasn\'t supplied' } };
      const b = sha('b');
      hub.blobs.set(b, atob(body.content));
      r.ref = commit(r, new Map([['README.md', b]]), body.message);
      return { status: 201, body: {} };
    }
    if (rest.startsWith('/contents/') && c.method === 'GET') {
      const path = decodeURIComponent(rest.slice(10));
      const now = hub.files(full);
      if (!path) {
        if (!r.ref) return { status: 404, body: { message: 'This repository is empty.' } };
        return { body: [...new Set([...now.keys()].map((p) => p.split('/')[0]))].map((name) => ({ name })) };
      }
      if (!now.has(path)) return { status: 404, body: { message: 'Not Found' } };
      if (c.headers.accept !== 'application/vnd.github.raw+json') return { status: 415 };
      return { body: now.get(path)!, headers: { 'content-type': 'application/vnd.github.raw' } };
    }
    return { status: 404 };
  };
  net.on(/^https:\/\/api\.github\.com\//, route);
  useWeb(net);
  return hub;
}

let hub: Hub;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  document.body.innerHTML = SHEET;
  hub = fakeGitHub();
});

const sealed = (k: string): Sealed => ({ iv: `iv-${k}`, ct: `sealed bytes ${k}` });
const MB = 1024 * 1024;

describe('the GitHub store', () => {
  it('starts an empty repository, puts a file in one commit under arise/<month>/, reads it back and deletes it', async () => {
    const GH = await import('./files-github');
    hub.repos.set('sam/arise-files', { private: true, ref: null, sizeKb: 0 });
    const store = GH.githubStore(TOKEN, ['sam/arise-files']);
    await store.put('sam/arise-files', '2026-11', [
      { id: 'part0', s: sealed('0') },
      { id: 'part1', s: sealed('1') },
    ]);
    const files = hub.files('sam/arise-files');
    expect([...files.keys()].sort()).toEqual(['README.md', 'arise/2026-11/part0', 'arise/2026-11/part1']);
    expect(JSON.parse(files.get('arise/2026-11/part1')!)).toEqual({ v: 1, ...sealed('1') });
    // The README, then one commit for the whole file. Its message says nothing about the file.
    expect([...hub.commits.values()].map((c) => c.message)).toEqual(['Arise: start', 'Arise: a file']);

    expect(await store.get('sam/arise-files', '2026-11', 'part0')).toEqual(sealed('0'));
    expect(await store.get('sam/arise-files', '2026-11', 'nothing')).toBeNull();

    // Deleting: only what's there, in one commit; nothing there is no commit at all.
    await store.del('sam/arise-files', '2026-11', ['part0', 'part1', 'never-sent']);
    expect([...hub.files('sam/arise-files').keys()]).toEqual(['README.md']);
    const commits = hub.commits.size;
    await store.del('sam/arise-files', '2026-10', ['part0']);
    expect(hub.commits.size).toBe(commits);
  });

  it('builds on what another device wrote in between', async () => {
    const GH = await import('./files-github');
    hub.repos.set('sam/arise-files', { private: true, ref: null, sizeKb: 0 });
    const store = GH.githubStore(TOKEN, ['sam/arise-files']);
    await store.put('sam/arise-files', '2026-11', [{ id: 'a', s: sealed('a') }]);
    hub.raceOnce = true;
    await store.put('sam/arise-files', '2026-11', [{ id: 'b', s: sealed('b') }]);
    expect([...hub.files('sam/arise-files').keys()].sort()).toEqual(['README.md', 'arise/2026-11/a', 'arise/2026-11/b']);
  });

  it('says plainly when the token is wrong or GitHub is out of reach', async () => {
    const GH = await import('./files-github');
    hub.repos.set('sam/arise-files', { private: true, ref: null, sizeKb: 0 });
    const bad = GH.githubStore(`github_pat_${'Wrong'.repeat(16)}`, ['sam/arise-files']);
    await expect(bad.get('sam/arise-files', '2026-11', 'x')).rejects.toThrow('GitHub said no to this token.');
    hub.net.on(/api\.github\.com/, () => {
      throw new Error('offline');
    });
    await expect(GH.githubStore(TOKEN, []).get('sam/arise-files', '2026-11', 'x')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

// ---------- with the sync (files-sync.ts)

function memRemote() {
  const docs = new Map<string, Sealed>();
  return {
    docs,
    async get(id: string) {
      return docs.get(id) ?? null;
    },
    async put(list: readonly { id: string; s: Sealed }[]) {
      for (const d of list) docs.set(d.id, d.s);
    },
    async del(ids: readonly string[]) {
      for (const id of ids) docs.delete(id);
    },
    async swapIndex(id: string, expect: string, next: Sealed) {
      if ((docs.get(id)?.iv ?? '') !== expect) return false;
      docs.set(id, next);
      return true;
    },
  };
}

async function setup() {
  const { newDataKey } = await import('../lib/crypto');
  const { newLifeKey } = await import('./seal');
  const F = await import('./files');
  const LOCAL = await import('./files-store');
  const FS = await import('./files-sync');
  const GH = await import('./files-github');
  const SEAL = await import('./files-seal');
  const { cleanFilesIndex } = await import('../lib/validate');
  const keys = (await newLifeKey(await newDataKey(), 'uid1')).keys;
  const remote = memRemote();
  const dbs = new Map<string, IDBFactory>();
  const on = (name: string) => {
    LOCAL.closeFilesDB();
    if (!dbs.has(name)) dbs.set(name, new IDBFactory());
    globalThis.indexedDB = dbs.get(name)!;
  };
  const rawIndex = async () => JSON.parse(await SEAL.openFilesIndex(keys, 'uid1', remote.docs.get(await SEAL.indexDocId(keys))!));
  const gh = (repos: string[]) => GH.githubStore(TOKEN, repos);
  const deps = (over: Record<string, unknown> = {}) => ({ remote, keys, uid: 'uid1', ...over });
  const bytes = (len: number, seed = 1) => {
    const b = new Uint8Array(len);
    for (let i = 0; i < len; i++) b[i] = (i * 13 + seed) & 255;
    return b;
  };
  return { F, LOCAL, FS, GH, SEAL, cleanFilesIndex, keys, remote, on, rawIndex, gh, deps, bytes };
}

describe('files through your GitHub', () => {
  it('goes between two devices: parts in the repository, details in the database, fetched when opened', async () => {
    const T = await setup();
    hub.repos.set('sam/arise-files', { private: true, ref: null, sizeKb: 0 });
    T.on('phone');
    const data = T.bytes(T.SEAL.PART_BYTES + 300);
    const f = await T.F.putFile(data, { name: 'passport.pdf', type: 'application/pdf', day: '2026-11-20' });
    await T.FS.syncFiles(T.deps({ gh: T.gh(['sam/arise-files']), now: Date.UTC(2026, 10, 26) }));
    // Two sealed parts in this month's folder; GitHub never sees a name.
    const there = hub.files('sam/arise-files');
    const parts = [...there.keys()].filter((p) => p.startsWith('arise/'));
    expect(parts).toHaveLength(2);
    for (const p of parts) {
      expect(p).toMatch(/^arise\/2026-11\/[A-Za-z0-9_-]{43}$/);
      expect(atob(JSON.parse(there.get(p)!).ct.slice(0, 4000)).includes('passport')).toBe(false);
    }
    expect(T.remote.docs.size).toBe(2); // the index and the details

    T.on('laptop');
    // Without GitHub connected there, it's listed but can't be fetched.
    await T.FS.syncFiles(T.deps());
    expect(await T.LOCAL.getStored(f.id)).toMatchObject({ where: 'gh', here: false });
    expect(await T.FS.fetchBytes(T.deps(), f.id)).toBeNull();
    // With its own token for the same repository, it can.
    const got = await T.FS.fetchBytes(T.deps({ gh: T.gh([]) }), f.id);
    expect(got?.length).toBe(2);
    const back = await T.F.getFile(f.id);
    expect(Buffer.from(new Uint8Array(await back!.blob.arrayBuffer())).equals(Buffer.from(data))).toBe(true);

    // Deleted on the laptop: in the trash, the parts stay; emptied, they leave the repository.
    await T.F.trashFile(f.id);
    await T.FS.syncFiles(T.deps({ gh: T.gh([]) }));
    expect([...hub.files('sam/arise-files').keys()].filter((p) => p.startsWith('arise/'))).toHaveLength(2);
    await T.F.emptyTrash();
    await T.FS.syncFiles(T.deps({ gh: T.gh([]) }));
    expect([...hub.files('sam/arise-files').keys()]).toEqual(['README.md']);
    expect(T.remote.docs.size).toBe(1);
    expect((await T.rawIndex()).gone[f.id]).toMatchObject({ o: 2, r: 0, m: '2026-11' });
    T.on('phone');
    await T.FS.syncFiles(T.deps({ gh: T.gh(['sam/arise-files']) }));
    expect(await T.F.listFiles({ trash: 'all' })).toEqual([]);
  });

  it('moves on to the next repository near 1 GB, and waits for one when all are near it', async () => {
    const T = await setup();
    hub.repos.set('sam/arise-files', { private: true, ref: null, sizeKb: 950 * 1024 }); // GitHub counts 950 MB
    T.on('phone');
    const a = await T.F.putFile(T.bytes(1000), { name: 'a' });
    await T.FS.syncFiles(T.deps({ gh: T.gh(['sam/arise-files']) }));
    expect((await T.LOCAL.getStored(a.id))?.up).toBe(false); // waiting here
    expect(T.FS.status.ghFull).toBe(true);
    expect(hub.files('sam/arise-files').size).toBe(0);

    hub.repos.set('sam/arise-files-2', { private: true, ref: null, sizeKb: 0 });
    await T.FS.syncFiles(T.deps({ gh: T.gh(['sam/arise-files', 'sam/arise-files-2']) }));
    expect(T.FS.status.ghFull).toBe(false);
    expect((await T.LOCAL.getStored(a.id))?.up).toBe(true);
    expect([...hub.files('sam/arise-files-2').keys()].some((p) => p.startsWith('arise/'))).toBe(true);
    const idx = await T.rawIndex();
    expect(idx.repos).toEqual(['sam/arise-files-2']);
    expect(idx.files[a.id]).toMatchObject({ o: 2, r: 0 });

    // Near it by what the index knows too, before GitHub's own count catches up (it lags).
    expect(T.GH.REPO_NEAR).toBeLessThan(T.GH.REPO_SOFT_MAX);
    expect(hub.repos.get('sam/arise-files-2')!.sizeKb).toBe(0);
    const id = await T.SEAL.indexDocId(T.keys);
    // Five files of 178 MB from another device: 890 MB in all.
    const big = Object.fromEntries('BCDEF'.split('').map((c) => [c.repeat(22), { n: 356, size: 178 * MB, o: 2, r: 0, m: '2026-11' }]));
    T.remote.docs.set(id, await T.SEAL.sealFilesIndex(T.keys, 'uid1', JSON.stringify({ ...idx, seq: idx.seq + 1, files: { ...idx.files, ...big } })));
    hub.repos.set('sam/arise-files-3', { private: true, ref: null, sizeKb: 0 });
    const b = await T.F.putFile(T.bytes(11 * MB), { name: 'b' });
    await T.FS.syncFiles(T.deps({ gh: T.gh(['sam/arise-files-2', 'sam/arise-files-3']) }));
    const idx3 = await T.rawIndex();
    expect(idx3.repos).toEqual(['sam/arise-files-2', 'sam/arise-files-3']);
    expect(idx3.files[b.id]).toMatchObject({ o: 2, r: 1 });
  });

  it('marks where each file is in the index, and an app from before it leaves the index alone', async () => {
    const T = await setup();
    hub.repos.set('sam/arise-files', { private: true, ref: null, sizeKb: 0 });
    T.on('phone');
    const inDb = await T.F.putFile(T.bytes(10), { name: 'db' });
    await T.FS.syncFiles(T.deps());
    const inGh = await T.F.putFile(T.bytes(20, 2), { name: 'gh' });
    await T.FS.syncFiles(T.deps({ gh: T.gh(['sam/arise-files']), now: Date.UTC(2026, 10, 26) }));
    const raw = await T.rawIndex();
    expect(raw.schema).toBe(T.FS.FILES_SCHEMA_GH);
    expect(raw.repos).toEqual(['sam/arise-files']);
    expect(raw.files[inDb.id]).toEqual({ n: 1, size: 10 });
    expect(raw.files[inGh.id]).toEqual({ n: 1, size: 20, o: 2, r: 0, m: '2026-11' });
    // Read back as written, and a broken entry keeps the file listed.
    expect(T.cleanFilesIndex(raw).files[inGh.id]).toEqual({ n: 1, size: 20, o: 2, r: 0, m: '2026-11' });
    expect(T.cleanFilesIndex({ ...raw, files: { [inGh.id]: { n: 1, size: 20, o: 2, r: 7, m: 'May' } } }).files[inGh.id]).toEqual({ n: 1, size: 20, o: 2 });

    // Apps from before (1.37 with R2 knew schema 2; older ones 1) stop at the index: they throw
    // "newer" before reading a file or writing anything, so they never drop or delete these.
    const olderStops = (known: number) => T.cleanFilesIndex(raw).schema > known;
    expect(olderStops(2)).toBe(true);
    expect(olderStops(1)).toBe(true);
    // And this app the same, with one from after it.
    const SEAL = T.SEAL;
    const id = await SEAL.indexDocId(T.keys);
    const before = T.remote.docs.get(id);
    T.remote.docs.set(id, await SEAL.sealFilesIndex(T.keys, 'uid1', JSON.stringify({ ...raw, schema: 4 })));
    await expect(T.FS.syncFiles(T.deps())).rejects.toMatchObject({ code: 'newer' });
    T.remote.docs.set(id, before!);

    // Once nothing in GitHub is listed, deletions included, the index goes back to schema 1.
    await T.F.deleteFile(inGh.id);
    await T.FS.syncFiles(T.deps({ gh: T.gh(['sam/arise-files']) }));
    expect((await T.rawIndex()).schema).toBe(3); // the deletion is still noted
    expect((await T.rawIndex()).gone[inGh.id]).toMatchObject({ o: 2 });
  });
});

// ---------- the token, and the screen

describe('the token', () => {
  it('stays on this device: never in the synced data, a backup, or a request anywhere but GitHub', async () => {
    const T = await setup();
    const S = await import('../store');
    hub.canMake = true;
    await expect(T.GH.connect({ token: TOKEN, repo: 'arise-files' })).rejects.toMatchObject({ code: 'missing' });
    const st = await T.GH.connect({ token: TOKEN, repo: 'arise-files', make: true });
    expect(st).toMatchObject({ login: 'sam', repos: ['sam/arise-files'] });
    expect(hub.repos.get('sam/arise-files')?.private).toBe(true);
    // The check part was written, read back and deleted.
    expect([...hub.files('sam/arise-files').keys()]).toEqual(['README.md']);

    T.on('phone');
    const f = await T.F.putFile(T.bytes(50), { name: 'x' });
    await T.FS.syncFiles(T.deps({ gh: T.gh(st.repos) }));
    expect((await T.LOCAL.getStored(f.id))?.up).toBe(true);

    // Only under its own key in this browser.
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k !== 'arise-github-files') expect(localStorage.getItem(k)).not.toContain(TOKEN);
    }
    expect(JSON.stringify(S.state)).not.toContain(TOKEN);
    expect(JSON.stringify(S.exportData())).not.toContain(TOKEN);
    for (const s of T.remote.docs.values()) expect(JSON.stringify(s)).not.toContain('github_pat_');
    for (const c of hub.net.calls) {
      if (JSON.stringify(c).includes(TOKEN)) expect(c.url.startsWith('https://api.github.com/')).toBe(true);
      expect(c.body).not.toContain(TOKEN);
    }
    T.GH.forget();
    expect(localStorage.getItem('arise-github-files')).toBeNull();
    expect(T.GH.isOn()).toBe(false);
  });

  it('only takes a private repository that is empty or only Arise\'s', async () => {
    const GH = await import('./files-github');
    hub.repos.set('sam/open', { private: false, ref: null, sizeKb: 0 });
    await expect(GH.connect({ token: TOKEN, repo: 'open' })).rejects.toThrow('sam/open is public.');
    hub.repos.set('sam/code', { private: true, ref: null, sizeKb: 0 });
    const store = GH.githubStore(TOKEN, []);
    await store.put('sam/code', '2026-11', [{ id: 'x', s: sealed('x') }]);
    hub.trees.get(hub.commits.get(hub.repos.get('sam/code')!.ref!)!.tree)!.set('src/main.ts', 'b');
    await expect(GH.connect({ token: TOKEN, repo: 'sam/code' })).rejects.toThrow('already has other things in it');
    await expect(GH.connect({ token: 'not a token', repo: 'x' })).rejects.toThrow('github_pat_');
    hub.canMake = false;
    await expect(GH.connect({ token: TOKEN, repo: 'new-one', make: true })).rejects.toThrow("This token can't make sam/new-one.");
    expect(GH.isOn()).toBe(false);
    expect(GH.nextName(['sam/arise-files'])).toBe('arise-files-2');
  });
});

describe('the setup screen', () => {
  it('shows plain steps, makes the repository after asking, then Check, Add a repository and Stop', async () => {
    const UI = await import('./files-github-ui.js');
    const GH = await import('./files-github');
    document.body.insertAdjacentHTML('beforeend', `<div id="host">${UI.ghPart()}</div>`);
    expect(document.querySelector('#ghFiles')?.textContent).toContain('Your GitHub');
    await UI.handleAction('myfiles-gh-edit', document.createElement('button'));
    const text = document.querySelector('#ghFiles')?.textContent || '';
    expect(text).toContain('Fine-grained tokens');
    expect(text).toContain('Contents to Read and write');
    expect(text).toContain("GitHub isn't meant for keeping files");
    expect(text).not.toMatch(/\u2014/);

    hub.canMake = true;
    (document.querySelector('#ghToken') as HTMLInputElement).value = TOKEN;
    const asked: string[] = [];
    globalThis.confirm = (q?: string) => (asked.push(String(q)), true);
    await UI.handleAction('myfiles-gh-save', null);
    expect(asked[0]).toContain("There's no repository sam/arise-files yet.");
    expect(document.querySelector('#toast')?.textContent).toContain('Your GitHub works.');
    expect(GH.settings()?.repos).toEqual(['sam/arise-files']);
    const on = document.querySelector('#ghFiles')?.textContent || '';
    expect(on).toContain('sam/arise-files');
    expect(on).toContain('The token stays on this device.');

    await UI.handleAction('myfiles-gh-check', null);
    expect(document.querySelector('#toast')?.textContent).toContain('Checked.');

    await UI.handleAction('myfiles-gh-add', null);
    expect((document.querySelector('#ghAddRepo') as HTMLInputElement).value).toBe('arise-files-2');
    await UI.handleAction('myfiles-gh-add-save', null);
    expect(GH.settings()?.repos).toEqual(['sam/arise-files', 'sam/arise-files-2']);

    await UI.handleAction('myfiles-gh-stop', null);
    expect(GH.isOn()).toBe(false);
    expect(document.querySelector('#ghFiles')?.textContent).toContain('Set it up');
  });
});
