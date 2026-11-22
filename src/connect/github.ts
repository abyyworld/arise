// GitHub: what the Player builds and writes down in the repositories they pick, with a read-only
// key they make themselves (a fine-grained personal access token, for those repositories only,
// with Contents: Read-only).
//
// From each repository:
//   - their own commits, into their days ("Committed to my-portfolio: Fix the navbar"). The first
//     time, the last 90 days; then whatever is new.
//   - its Markdown files at the top level (README.md, goals.md…), into the life log as notes, so
//     the coach and what Arise knows learn from them. A file that changed replaces its note.
// Read straight from this device: GitHub's API allows requests from web pages, so it works on the
// web and in the phone apps. The key stays on this device, never synced, never in a backup.
//
// Commits and notes are tier 2 (everyday, the Player's own work and writing): only the private AI
// and the AI on the device read them, unless the Player allows the less private ones.

import type { LifeEvent } from '../life/types';
import { ConnectError, arr, obj, request, retryAfter, text, type Res } from './http';
import { goOn, hand } from './sink';
import type { SvcState } from './state';

const API = 'https://api.github.com';
export const GAP = 30 * 60_000;
const FIRST_DAYS = 90;
const MAX_REPOS = 12;
const MAX_DOCS = 12; // Markdown files per repository
const MAX_DOC = 20_000; // characters kept of one file
const PAGES = 5; // of 100 commits, per repository per sync

export interface Ctx {
  save(): void;
}

// The two kinds of GitHub token a person can make.
export const validToken = (t: string) => /^(github_pat_[A-Za-z0-9_]{40,255}|gh[pousr]_[A-Za-z0-9]{36,255})$/.test(t.trim());
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

// "my-portfolio", "abyyworld/my-portfolio" or its link, for the token's owner → "owner/name".
export function repoName(input: string, login: string): string {
  const v = input.trim().replace(/\.git$/, '');
  const m = /github\.com\/([^/\s]+\/[^/\s#?]+)/.exec(v);
  const full = m ? m[1] : v.includes('/') ? v : login ? `${login}/${v}` : '';
  return REPO.test(full) ? full : '';
}

// The repositories as the Player wrote them, one per line or with commas, owner/name, no repeats.
export function repoList(textIn: string, login: string): string[] {
  return [...new Set(textIn.split(/[\n,]+/).map((x) => repoName(x, login)).filter(Boolean))].slice(0, MAX_REPOS);
}

function ghError(res: Res, what = 'GitHub'): ConnectError {
  if (res.status === 401) return new ConnectError('auth', 'GitHub said no to this key. Make a new one and connect again.', 0, 401);
  if (res.status === 403 && res.headers['x-ratelimit-remaining'] === '0') {
    const reset = Number(res.headers['x-ratelimit-reset']) * 1000;
    return new ConnectError('rate', 'GitHub asked Arise to wait. It will try again later.', reset > Date.now() ? reset - Date.now() : 3600_000, 403);
  }
  if (res.status === 429) return new ConnectError('rate', 'GitHub is busy. Arise will try again later.', retryAfter(res), 429);
  if (res.status === 403 || res.status === 404) return new ConnectError('other', `${what} isn't open to this key. Give the key that repository (Contents: Read-only).`, 0, res.status);
  if (res.status >= 500 || res.status === 0) return new ConnectError('net', "GitHub didn't answer. Arise will try again later.", 0, res.status);
  return new ConnectError('other', `GitHub said no (${res.status}).`, 0, res.status);
}

async function get(token: string, path: string, what?: string): Promise<{ data: unknown; res: Res }> {
  const res = await request({ url: `${API}${path}`, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
  if (res.status === 200) return { data: res.data, res };
  throw ghError(res, what);
}

export async function whoami(token: string): Promise<string> {
  const { data } = await get(token, '/user');
  const login = text(obj(data).login, 39);
  if (!login) throw new ConnectError('other', "GitHub didn't say whose key this is.");
  return login;
}

// Checks the key can read the repository; its name as GitHub spells it.
export async function checkRepo(token: string, full: string): Promise<string> {
  const { data } = await get(token, `/repos/${full}`, full);
  return text(obj(data).full_name, 140) || full;
}

// ---------- commits

const firstLine = (m: string) => m.split('\n')[0].trim();
const shortRepo = (full: string) => full.split('/')[1] || full;
// A key for where a sync left off (state.ts allows letters, digits, _ : . - and 64 of them).
export const cursorKey = (...parts: string[]) => parts.join(':').replace(/[^\w:.-]/g, '_').slice(0, 64);

export function commitEvent(full: string, c: Record<string, unknown>): LifeEvent | null {
  const sha = text(c.sha, 64);
  const commit = obj(c.commit);
  const when = Date.parse(text(obj(commit.author).date, 40) || text(obj(commit.committer).date, 40));
  // (Not text(): that would join the lines, and the first line is the title.)
  const message = typeof commit.message === 'string' ? commit.message.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, 2000) : '';
  if (!/^[0-9a-f]{40}$/.test(sha) || !Number.isFinite(when) || !message) return null;
  const line = firstLine(message);
  return {
    id: `other:github:commit:${sha}`,
    source: 'other',
    kind: 'other',
    at: when,
    title: `Committed to ${shortRepo(full)}: ${line.length > 100 ? `${line.slice(0, 99)}…` : line}`,
    ...(message.length > line.length ? { detail: message.slice(0, 1500) } : {}),
    url: `https://github.com/${full}/commit/${sha}`,
    tier: 2,
    meta: { app: 'github', repo: full, sha },
  };
}

async function commits(token: string, login: string, full: string, since: string): Promise<LifeEvent[]> {
  const out: LifeEvent[] = [];
  for (let page = 1; page <= PAGES; page++) {
    goOn('github');
    const { data } = await get(token, `/repos/${full}/commits?${new URLSearchParams({ author: login, since, per_page: '100', page: String(page) })}`, full);
    const list = arr(data).map(obj);
    for (const c of list) {
      const e = commitEvent(full, c);
      if (e) out.push(e);
    }
    if (list.length < 100) break;
  }
  return out;
}

// ---------- the Markdown files at the top of each repository

export function docEvent(full: string, path: string, body: string, at: number): LifeEvent {
  const kept = body.length > MAX_DOC ? `${body.slice(0, MAX_DOC)}\n\n(The rest is in the repository.)` : body;
  return {
    id: `other:github:doc:${full}:${path}`,
    source: 'other',
    kind: 'note',
    at,
    title: `${shortRepo(full)}: ${path}`,
    detail: kept,
    url: `https://github.com/${full}/blob/HEAD/${path}`,
    tier: 2,
    meta: { app: 'github', repo: full, file: path },
  };
}

const decode = (b64: string) => {
  const bin = atob(b64.replace(/\s+/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

async function docs(token: string, full: string, st: SvcState, now: number): Promise<LifeEvent[]> {
  goOn('github');
  const { data } = await get(token, `/repos/${full}/contents/`, full);
  const files = arr(data)
    .map(obj)
    .filter((f) => f.type === 'file' && /\.(md|markdown|txt)$/i.test(text(f.name, 200)) && Number(f.size) > 0 && Number(f.size) < 500_000)
    .slice(0, MAX_DOCS);
  const out: LifeEvent[] = [];
  for (const f of files) {
    const path = text(f.path, 200);
    const sha = text(f.sha, 64);
    const key = cursorKey('doc', full, path);
    if (!path || st.cursors[key] === sha) continue; // unchanged since last time
    goOn('github');
    const { data: file } = await get(token, `/repos/${full}/contents/${encodeURIComponent(path)}`, full);
    const content = text(obj(file).content, 1_000_000);
    if (!content) continue;
    let body = '';
    try {
      body = decode(content).trim();
    } catch {
      continue;
    }
    if (!body) continue;
    out.push(docEvent(full, path, body, now));
    st.cursors[key] = sha;
  }
  return out;
}

// ---------- the sync

export const reposOf = (st: SvcState) => (st.cursors.repos || '').split(',').filter((r) => REPO.test(r));

export async function sync(st: SvcState, ctx: Ctx, now = Date.now()) {
  const token = st.auth.token || '';
  const login = st.user;
  if (!validToken(token) || !login) throw new ConnectError('auth', 'Connect GitHub again.');
  for (const full of reposOf(st)) {
    const key = cursorKey('since', full);
    const since = st.cursors[key] || new Date(now - FIRST_DAYS * 86_400_000).toISOString();
    const found = await commits(token, login, full, since);
    await hand('github', found);
    // Next time, from the newest commit (a little before, in case clocks differ: ids keep it once).
    const newest = found.reduce((m, e) => Math.max(m, e.at), 0);
    st.cursors[key] = new Date(Math.max(Date.parse(since) || 0, newest - 60_000)).toISOString();
    ctx.save();
    await hand('github', await docs(token, full, st, now), { replace: true });
    ctx.save();
  }
}
