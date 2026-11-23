// @vitest-environment jsdom
// GitHub backup: the daily backup, locked with a backup password, also kept in a private
// repository of the Player's own on GitHub (the newest 7), and loaded again with Load backup.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeNet, useWeb, type Call, type Net } from './test/fake-http';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
// Fewer key-stretching rounds, so the tests run quickly. The file says how many it used.
vi.mock('./lib/crypto', async (orig) => ({ ...(await orig<typeof import('./lib/crypto')>()), KDF_ITERATIONS: 100_000 }));

type GHB = typeof import('./github-backup');
type Store = typeof import('./store');
let G: GHB;
let S: Store;
let net: Net;

const TOKEN = `github_pat_${'A1b2'.repeat(20)}`;
const PW = 'a long backup password';
const DAY = 86_400_000;
const session = (id: string, date = '2026-11-01') => ({ id, workout: 'a', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });

// GitHub, as far as the backup uses it: whose key it is, repositories, and the files in one
// repository's backups folder (with their blob sha, as GitHub checks it on every change).
interface Repo {
  private: boolean;
  files: Map<string, { sha: string; content: string }>;
}
let repos: Map<string, Repo>;
let canMake: boolean;
let shas: number;
const fromB64 = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

function github(c: Call) {
  const u = new URL(c.url);
  const body = c.body ? JSON.parse(c.body) : {};
  if (c.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { message: 'Bad credentials' } };
  if (u.pathname === '/user' && c.method === 'GET') return { body: { login: 'sam' } };
  if (u.pathname === '/user/repos' && c.method === 'POST') {
    if (!canMake) return { status: 403, body: { message: 'Resource not accessible by personal access token' } };
    repos.set(`sam/${body.name}`, { private: body.private === true, files: new Map() });
    return { status: 201, body: { full_name: `sam/${body.name}`, private: body.private === true } };
  }
  const m = /^\/repos\/([^/]+\/[^/]+)(\/contents\/backups(?:\/([^/]+))?)?$/.exec(u.pathname);
  const repo = m && repos.get(m[1]);
  if (!m || !repo) return { status: 404, body: { message: 'Not Found' } };
  if (!m[2]) return { body: { full_name: m[1], private: repo.private } };
  const name = m[3] && decodeURIComponent(m[3]);
  if (!name) {
    if (!repo.files.size) return { status: 404, body: { message: 'Not Found' } };
    return { body: [...repo.files].map(([n, f]) => ({ type: 'file', name: n, path: `backups/${n}`, sha: f.sha })) };
  }
  const now = repo.files.get(name);
  if (c.method === 'PUT') {
    if (now && !body.sha) return { status: 422, body: { message: '"sha" wasn\'t supplied.' } };
    if (now && body.sha !== now.sha) return { status: 409, body: { message: `is at ${now.sha} but expected ${body.sha}` } };
    repo.files.set(name, { sha: `sha${shas++}`, content: fromB64(body.content) });
    return { status: now ? 200 : 201, body: { content: { name } } };
  }
  if (c.method === 'DELETE') {
    if (!now || body.sha !== now.sha) return { status: 409, body: { message: 'sha does not match' } };
    repo.files.delete(name);
    return { body: {} };
  }
  return { status: 405 };
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  vi.resetModules();
  repos = new Map([['sam/arise-backup', { private: true, files: new Map() }]]);
  canMake = false;
  shas = 1;
  net = fakeNet().on(/^https:\/\/api\.github\.com\//, github);
  useWeb(net);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
  S = await import('./store');
  G = await import('./github-backup');
  S.importData({ sessions: [session('s1')], logs: { '2026-11-01': { t: 'my secret journal entry', at: 1 } } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const files = (repo = 'sam/arise-backup') => [...repos.get(repo)!.files.keys()].sort();
const connect = (over: Partial<Parameters<GHB['connect']>[0]> = {}) => G.connect({ token: TOKEN, repo: 'arise-backup', password: PW, password2: PW, ...over });

describe('connecting', () => {
  it('backs up at once, locked: GitHub only gets scrambled data', async () => {
    await connect();
    expect(files()).toEqual(['arise-backup-2026-11-20.json']);
    const file = repos.get('sam/arise-backup')!.files.get('arise-backup-2026-11-20.json')!.content;
    expect(JSON.parse(file)).toMatchObject({ arise: 'locked-backup', v: 1, iter: 100_000 });
    expect(file).not.toContain('secret journal');
    expect(file).not.toContain('band_row');
    expect(file).not.toContain(PW);
    expect(G.state()).toMatchObject({ repo: 'sam/arise-backup', login: 'sam', last: Date.now(), error: '' });
    // Every request went to GitHub itself, with the key, and nothing else carried the password.
    expect(net.calls.every((c) => c.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(net.calls.some((c) => c.body.includes(PW))).toBe(false);
  });

  it('keeps the key on this device only: not in the saved data or a backup', async () => {
    await connect();
    expect(JSON.stringify(S.exportData())).not.toContain(TOKEN);
    expect(localStorage.getItem('arise-github-backup')).toContain(TOKEN);
  });

  it('refuses what would not work, before anything is sent', async () => {
    await expect(connect({ token: 'password123' })).rejects.toThrow(/doesn't look like a GitHub key/);
    await expect(connect({ password: 'short', password2: 'short' })).rejects.toThrow(/at least 10/);
    await expect(connect({ password2: `${PW}!` })).rejects.toThrow(/don't match/);
    expect(net.calls).toEqual([]);
    expect(G.isOn()).toBe(false);
  });

  it('refuses a public repository', async () => {
    repos.get('sam/arise-backup')!.private = false;
    await expect(connect()).rejects.toThrow(/public/);
    expect(files()).toEqual([]);
    expect(G.isOn()).toBe(false);
  });

  it('makes the repository, private, when it is not there and the key may', async () => {
    canMake = true;
    await connect({ repo: 'https://github.com/sam/my-arise-backups' });
    expect(repos.get('sam/my-arise-backups')).toMatchObject({ private: true });
    expect(files('sam/my-arise-backups')).toEqual(['arise-backup-2026-11-20.json']);
    expect(net.calls.find((c) => c.method === 'POST')!.body).toContain('"private":true');
  });

  it("says what to do when it isn't there and the key can't make it", async () => {
    await expect(connect({ repo: 'elsewhere' })).rejects.toThrow(/Make it on GitHub first/);
    expect(G.isOn()).toBe(false);
  });

  it('says plainly when GitHub says no to the key', async () => {
    await expect(connect({ token: `github_pat_${'Z9y8'.repeat(20)}` })).rejects.toThrow(/said no to this key/);
  });
});

describe('backing up', () => {
  it('writes over the same day, and keeps the newest 7', async () => {
    await connect();
    const repo = repos.get('sam/arise-backup')!;
    for (const d of ['01', '02', '03', '04', '05', '06', '07', '08']) repo.files.set(`arise-backup-2026-11-${d}.json`, { sha: `old${d}`, content: '{}' });
    repo.files.set('notes.md', { sha: 'n1', content: 'mine' }); // not a backup: stays
    await G.backupNow();
    expect(files()).toEqual(['arise-backup-2026-11-03.json', 'arise-backup-2026-11-04.json', 'arise-backup-2026-11-05.json', 'arise-backup-2026-11-06.json', 'arise-backup-2026-11-07.json', 'arise-backup-2026-11-08.json', 'arise-backup-2026-11-20.json', 'notes.md']);
    // Today's was written over (with its sha), not added again.
    const puts = net.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts[1].body).sha).toBe('sha1');
    // Each delete named the file's sha.
    expect(net.calls.filter((c) => c.method === 'DELETE').map((c) => JSON.parse(c.body).sha)).toEqual(['old02', 'old01']);
  });

  it('tries again with the newest sha when another device wrote the same file meanwhile', async () => {
    await connect();
    const repo = repos.get('sam/arise-backup')!;
    let once = true;
    net.on(/\/contents\/backups\/arise-backup-2026-11-20\.json$/, (c) => {
      if (once && c.method === 'PUT') {
        once = false;
        repo.files.set('arise-backup-2026-11-20.json', { sha: 'theirs', content: '{}' });
      }
      return github(c);
    });
    await G.backupNow();
    expect(repo.files.get('arise-backup-2026-11-20.json')!.content).toContain('locked-backup');
  });

  it('notes what went wrong, for the screen', async () => {
    await connect();
    net.on(/\/contents\/backups\/arise-backup/, { status: 403, body: { message: 'Resource not accessible by personal access token' } });
    await expect(G.backupNow()).rejects.toThrow(/Contents: Read and write/);
    expect(G.state().error).toMatch(/Contents: Read and write/);
  });

  it('backs up once a day by itself, waits an hour after one that failed, and never from an empty device', async () => {
    await connect();
    const PUT = () => net.calls.filter((c) => c.method === 'PUT').length;
    expect(await G.backupIfDue()).toBe(false); // just done
    vi.setSystemTime(Date.now() + DAY);
    net.on(/\/contents\/backups\/arise-backup/, { status: 503 });
    expect(await G.backupIfDue()).toBe(false);
    expect(G.state().error).toMatch(/Couldn't reach GitHub/);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    const before = net.calls.length;
    expect(await G.backupIfDue()).toBe(false); // too soon after that
    expect(net.calls.length).toBe(before);
    net.on(/^https:\/\/api\.github\.com\//, github);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    expect(await G.backupIfDue()).toBe(true);
    expect(G.state().error).toBe('');
    // Erased: nothing of the Player's here, so the backups there aren't pushed out by empty ones.
    S.resetAll();
    vi.setSystemTime(Date.now() + DAY);
    const puts = PUT();
    expect(await G.backupIfDue()).toBe(false);
    expect(PUT()).toBe(puts);
  });

  it('stops: the key and the backup password go from this device, the backups stay', async () => {
    await connect();
    await G.forget();
    expect(G.isOn()).toBe(false);
    expect(localStorage.getItem('arise-github-backup')).toBeNull();
    expect(await G.backupKey()).toBeNull();
    expect(await G.backupNow()).toBe(false);
    expect(files()).toEqual(['arise-backup-2026-11-20.json']);
  });
});

describe('Load backup', () => {
  const pulled = () => JSON.parse(repos.get('sam/arise-backup')!.files.get('arise-backup-2026-11-20.json')!.content);

  it('opens a backup from GitHub on another device with the backup password, and restores it', async () => {
    await connect();
    const file = pulled();
    // A new device: nothing here, no backup key.
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    vi.resetModules();
    S = await import('./store');
    G = await import('./github-backup');
    const ask = vi.fn().mockResolvedValueOnce('not it').mockResolvedValueOnce(PW);
    const raw = await G.openBackup(file, ask);
    expect(ask.mock.calls).toEqual([[false], [true]]);
    S.importData(raw);
    expect(S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(S.state.logs['2026-11-01']?.t).toBe('my secret journal entry');
  });

  it('opens one made on this device without asking', async () => {
    await connect();
    const ask = vi.fn();
    expect(await G.openBackup(pulled(), ask)).toMatchObject({ sessions: [{ id: 's1' }] });
    expect(ask).not.toHaveBeenCalled();
  });

  it('loads nothing when the Player gives up, and takes a plain backup as it is', async () => {
    await connect();
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    G = await import('./github-backup');
    expect(await G.openBackup(pulled(), async () => null)).toBeNull();
    const plain = { sessions: [] };
    expect(await G.openBackup(plain, async () => null)).toBe(plain);
  });
});

describe('on screen', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main>';
  });

  it('is marked optional, says GitHub sees only scrambled data, and how to make the key', async () => {
    const UI = await import('./github-backup-ui.js');
    document.getElementById('app')!.innerHTML = UI.panel();
    const text = document.getElementById('hubGitHub')!.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('GitHub backup Optional');
    expect(text).toContain('GitHub only ever sees scrambled data');
    expect(text).toContain('Contents, Read and write');
    expect(text).not.toMatch(/\u2014/); // no long dashes
    for (const name of ['token', 'repo', 'password', 'password2']) expect(document.querySelector(`[data-ghb-form="connect"] [name="${name}"]`)).not.toBeNull();
  });

  it('connects from its form, then shows where it backs up and when it last did', async () => {
    const UI = await import('./github-backup-ui.js');
    document.getElementById('app')!.innerHTML = UI.panel();
    await UI.connect({ token: TOKEN, repo: 'arise-backup', password: PW, password2: PW });
    const text = document.getElementById('hubGitHub')!.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('GitHub backup Connected');
    expect(text).toContain('Backing up to sam/arise-backup (private)');
    expect(text).toContain('Last backup');
    expect(document.querySelector('[data-act="ghb-now"]')).not.toBeNull();
    expect(await UI.handleAction('ghb-now')).toBe(true);
    expect(document.getElementById('toast')!.textContent).toBe('Backed up to GitHub.');
  });

  it('asks for the backup password in a sheet, and gives up when it is closed', async () => {
    const UI = await import('./github-backup-ui.js');
    const ui = await import('./ui.js');
    const first = UI.askPassword(true);
    expect(document.querySelector('#sheet')!.textContent).toContain("That password doesn't open this backup.");
    (document.querySelector('[data-ghb-form="open"] [name="password"]') as HTMLInputElement).value = PW;
    document.querySelector<HTMLFormElement>('[data-ghb-form="open"]')!.requestSubmit();
    expect(await first).toBe(PW);
    expect((document.getElementById('sheet') as HTMLElement).hidden).toBe(true);
    const second = UI.askPassword();
    ui.closeSheet();
    expect(await second).toBeNull();
  });
});

describe('Load backup in the app', () => {
  it('asks for the backup password of a locked backup and restores it, and loads nothing when the sheet is closed', async () => {
    const { deriveBackupKey, lock } = await import('./lib/locked-backup');
    const file = await lock(await deriveBackupKey(PW), JSON.stringify(S.exportData()));
    // A new device, with the whole app.
    vi.resetModules();
    localStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
    const S2 = await import('./store');
    await import('./app.js');
    expect(S2.state.sessions).toEqual([]);
    const input = document.getElementById('importFile') as HTMLInputElement;
    const choose = () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File([file], 'arise-backup-2026-11-20.json', { type: 'application/json' })] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const sheetForm = () => document.querySelector<HTMLFormElement>('[data-ghb-form="open"]');
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(ok()).toBe(true);
    };

    choose();
    await until(() => !!sheetForm());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // closes the sheet
    await until(() => document.getElementById('toast')!.textContent === 'Not loaded.');
    expect(S2.state.sessions).toEqual([]);

    choose();
    await until(() => !!sheetForm());
    (sheetForm()!.querySelector('[name="password"]') as HTMLInputElement).value = PW;
    sheetForm()!.requestSubmit();
    await until(() => S2.state.sessions.length === 1);
    expect(S2.state.logs['2026-11-01']?.t).toBe('my secret journal entry');
  });
});
