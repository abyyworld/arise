// GitHub backup (optional): the same daily backup as Your files (files-folder.js), also kept in a
// private repository of the Player's own on GitHub, locked first with a backup password
// (lib/locked-backup.ts). GitHub only ever gets the locked file: scrambled data it can't open.
//
// The Player makes a fine-grained key (personal access token) for one repository, with Contents:
// Read and write, and pastes it here. If the repository isn't there yet and the key may make
// repositories, Arise makes it, private. In it:
//   backups/arise-backup-YYYY-MM-DD.json   once a day while Arise is open, the newest 7 kept
// Restoring: download one from GitHub, then Load backup, which asks for the backup password.
//
// Everything goes straight from this device to GitHub (connect/http.ts). The key and the backup
// key (a key made from the backup password that can be used but never read out, like the
// account's, lib/keystore.ts) stay on this device: never synced, never in a backup, and gone
// with "Erase all data" or Stop.

import * as S from './store';
import { request, obj, arr, text, retryAfter, type Res } from './connect/http';
import { repoName, validToken } from './connect/github';
import { toB64 } from './lib/crypto';
import { deriveBackupKey, fits, isLocked, lock, unlock, MIN_PASSWORD, type BackupKey } from './lib/locked-backup';
import { backupName, oldBackups } from './files-folder.js';

const API = 'https://api.github.com';
const STATE = 'arise-github-backup';
const DIR = 'backups';
const DAY_MS = 86_400_000;
const RETRY_MS = 3_600_000; // after a backup that didn't work, no automatic one for an hour

export class BackupError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly wait = 0, // ms GitHub asked to wait
  ) {
    super(message);
  }
}

// ---------- what this device keeps

export interface State {
  token: string;
  repo: string; // owner/name
  login: string; // whose key it is
  last: number; // the last backup that worked
  tried: number; // the last automatic try
  error: string;
}
const BLANK: State = { token: '', repo: '', login: '', last: 0, tried: 0, error: '' };

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : '');
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.round(v) : 0);

// Read back field by field, like everything from storage.
export function state(): State {
  try {
    const r = obj(JSON.parse(localStorage.getItem(STATE) || 'null'));
    const token = str(r.token, 300);
    const repo = repoName(str(r.repo, 200), '');
    if (!validToken(token) || !repo) return { ...BLANK };
    return { token, repo, login: str(r.login, 39), last: time(r.last), tried: time(r.tried), error: str(r.error, 300) };
  } catch {
    return { ...BLANK };
  }
}
function setState(patch: Partial<State>) {
  try {
    const next = { ...state(), ...patch };
    if (!next.token) localStorage.removeItem(STATE);
    else localStorage.setItem(STATE, JSON.stringify(next));
  } catch {}
}
export const isOn = () => !!state().token;

const listeners = new Set<() => void>();
export const onChange = (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb));
const changed = () => listeners.forEach((cb) => cb());

// The backup key, in IndexedDB (or in memory when that isn't there, for this visit only).
const DB = 'arise-github-backup';
let memory: BackupKey | null = null;
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = d.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}
async function saveKey(k: BackupKey) {
  memory = k;
  try {
    await kv('readwrite', (s) => s.put(k, 'key'));
  } catch {}
}
export async function backupKey(): Promise<BackupKey | null> {
  if (memory) return memory;
  try {
    const k = (await kv('readonly', (s) => s.get('key'))) as BackupKey | undefined;
    if (k?.key && typeof k.salt === 'string' && Number.isInteger(k.iter)) return (memory = k);
  } catch {}
  return null;
}
async function dropKey() {
  memory = null;
  try {
    await kv('readwrite', (s) => s.delete('key'));
  } catch {}
}

// ---------- GitHub

const headers = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' });

function trouble(res: Res): BackupError {
  const s = res.status;
  if (s === 401) return new BackupError('GitHub said no to this key. It may have run out: make a new one and connect again.', s);
  if ((s === 403 && res.headers['x-ratelimit-remaining'] === '0') || s === 429) return new BackupError('GitHub asked Arise to wait. It tries again later.', s, retryAfter(res, RETRY_MS));
  if (s === 403 || s === 404) return new BackupError("This key can't write to that repository. Give the key that repository, with Contents: Read and write.", s);
  if (s === 0 || s >= 500) return new BackupError("Couldn't reach GitHub. Arise tries again later.", s);
  const msg = text(obj(res.data).message, 120);
  return new BackupError(`GitHub said no (${s}${msg ? `: ${msg}` : ''}).`, s);
}

async function call(token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Res> {
  try {
    return await request({ url: `${API}${path}`, method, headers: headers(token), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw new BackupError("Couldn't reach GitHub. Check your internet connection.");
  }
}
const pathOf = (full: string, file = '') => `/repos/${full}/contents/${DIR}${file ? `/${encodeURIComponent(file)}` : ''}`;

// Whose key it is.
export async function whoami(token: string): Promise<string> {
  const res = await call(token, 'GET', '/user');
  if (res.status !== 200) throw trouble(res);
  const login = text(obj(res.data).login, 39);
  if (!login) throw new BackupError("GitHub didn't say whose key this is.");
  return login;
}

// The repository as GitHub names it, private. Made (private) when it isn't there and the key may.
export async function ensureRepo(token: string, full: string, login: string): Promise<string> {
  const res = await call(token, 'GET', `/repos/${full}`);
  if (res.status === 200) {
    const d = obj(res.data);
    if (d.private !== true) throw new BackupError('That repository is public. Make it private on GitHub first (Settings, Danger Zone, Change visibility), or pick a private one.');
    return text(d.full_name, 140) || full;
  }
  if (res.status !== 404) throw trouble(res);
  const [owner, name] = full.split('/');
  const made = owner.toLowerCase() === login.toLowerCase() ? await call(token, 'POST', '/user/repos', { name, private: true, auto_init: true, description: 'Arise backups, locked with a backup password.' }) : null;
  if (made?.status === 201 && obj(made.data).private === true) return text(obj(made.data).full_name, 140) || full;
  throw new BackupError(`There's no repository ${full} this key can reach, and it can't make one. Make it on GitHub first (private), then give the key that repository with Contents: Read and write.`);
}

// The backups there now: name and blob sha.
export async function listBackups(token: string, full: string): Promise<{ name: string; sha: string }[]> {
  const res = await call(token, 'GET', pathOf(full));
  if (res.status === 404) return []; // no folder yet (or an empty repository)
  if (res.status !== 200) throw trouble(res);
  return arr(res.data)
    .map(obj)
    .filter((f) => f.type === 'file')
    .map((f) => ({ name: text(f.name, 200), sha: text(f.sha, 64) }))
    .filter((f) => f.name && f.sha);
}

// Writes one file (in place of what's there under that name), then lets the oldest go, so only
// the newest 7 stay. Returns the names deleted.
export async function upload(token: string, full: string, name: string, content: string): Promise<string[]> {
  const body = (sha?: string) => ({ message: `Arise backup ${name.replace(/^arise-backup-|\.json$/g, '')}`, content: toB64(new TextEncoder().encode(content)), ...(sha ? { sha } : {}) });
  let files = await listBackups(token, full);
  let res = await call(token, 'PUT', pathOf(full, name), body(files.find((f) => f.name === name)?.sha));
  // Written meanwhile (another device, the same day): once more with what's there now.
  if (res.status === 409 || res.status === 422) {
    files = await listBackups(token, full);
    res = await call(token, 'PUT', pathOf(full, name), body(files.find((f) => f.name === name)?.sha));
  }
  if (res.status !== 200 && res.status !== 201) throw trouble(res);
  const names = [...new Set([...files.map((f) => f.name), name])];
  const old = oldBackups(names) as string[];
  for (const n of old) {
    const sha = files.find((f) => f.name === n)?.sha;
    if (!sha) continue;
    await call(token, 'DELETE', pathOf(full, n), { message: `Arise backup: ${n} goes (the newest 7 stay)`, sha }).catch(() => null);
  }
  return old;
}

// ---------- what the screen does

// Checks the key and the repository, keeps the backup key, and backs up once.
export async function connect({ token, repo, password, password2 }: { token: string; repo: string; password: string; password2: string }) {
  const t = token.trim();
  if (!validToken(t)) throw new BackupError("That doesn't look like a GitHub key. It starts with github_pat_.");
  if (password.length < MIN_PASSWORD) throw new BackupError(`Use a backup password with at least ${MIN_PASSWORD} characters.`);
  if (password !== password2) throw new BackupError("The two backup passwords don't match.");
  const login = await whoami(t);
  const full = repoName(repo || 'arise-backup', login);
  if (!full) throw new BackupError("That repository name doesn't look right. Use a name like arise-backup.");
  const named = await ensureRepo(t, full, login);
  await saveKey(await deriveBackupKey(password));
  setState({ token: t, repo: named, login, last: 0, tried: 0, error: '' });
  changed();
  await backupNow();
}

// Backs up now (today's file, in place of one already there today). Throws when it can't, and
// says so in state().
export async function backupNow(now = Date.now()): Promise<boolean> {
  const st = state();
  if (!st.token) return false;
  const k = await backupKey();
  if (!k) {
    setState({ error: 'The backup password is missing on this device. Stop, then connect again.' });
    changed();
    throw new BackupError(state().error);
  }
  try {
    const file = await lock(k, JSON.stringify(S.exportData(), null, 2));
    await upload(st.token, st.repo, backupName(S.todayKey()), file);
    setState({ last: now, tried: now, error: '' });
  } catch (err) {
    setState({ tried: now, error: (err as Error)?.message || "Couldn't back up to GitHub." });
    changed();
    throw err;
  }
  changed();
  return true;
}

// Once a day while Arise is open; an hour after one that didn't work. Never while this device has
// nothing of the Player's (just erased, say): that would push good backups out.
export async function backupIfDue(now = Date.now()): Promise<boolean> {
  const st = state();
  if (!st.token || now - st.last < DAY_MS || now - st.tried < RETRY_MS || !S.hasOwnData()) return false;
  try {
    return await backupNow(now);
  } catch {
    return false;
  }
}

// Stop: the key and the backup key go from this device. The backups stay on GitHub.
export async function forget() {
  setState({ token: '' });
  await dropKey();
  changed();
}

// For Load backup: a locked backup, opened with this device's backup key when it was made with it,
// or else with the password `ask` gets (`wrong`: the last one didn't open it; null: the Player
// gave up, and nothing is loaded). Any other backup as it is.
export async function openBackup(raw: unknown, ask: (wrong: boolean) => Promise<string | null>): Promise<unknown> {
  if (!isLocked(raw)) return raw;
  const k = await backupKey();
  if (fits(k, raw)) {
    try {
      return JSON.parse(await unlock(raw, k!));
    } catch {}
  }
  let wrong = false;
  for (;;) {
    const password = await ask(wrong);
    if (password === null) return null;
    try {
      return JSON.parse(await unlock(raw, password));
    } catch (err) {
      if ((err as { code?: string })?.code !== 'wrong-key') throw err;
      wrong = true;
    }
  }
}

export function initGitHubBackup() {
  void backupIfDue();
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void backupIfDue();
  });
}
