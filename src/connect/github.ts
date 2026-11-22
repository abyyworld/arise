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
import { goOn, hand, hash } from './sink';
import type { SvcState } from './state';

const API = 'https://api.github.com';
export const GAP = 30 * 60_000;
const FIRST_DAYS = 90;
// Each sync looks back this far again: commits merged later keep their older dates, and the same
// commit twice is kept once (its id).
const LOOKBACK = 14 * 86_400_000;
const MAX_REPOS = 12;
const MAX_DOCS = 12; // Markdown files per repository
const MAX_DOC = 3900; // characters kept of one file (the life log keeps 4,000 of a detail)
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
// Where a sync left off, one of each per repository (state.ts keeps 60, with keys of letters,
// digits and _ : . -, so a repository is named by a hash).
export const cursorKey = (kind: 'since' | 'docs', full: string) => `${kind}:${hash(full.toLowerCase())}`;

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
    // (A hash: a file's name may have spaces or letters the life log's ids don't take.)
    id: `other:github:doc:${hash(`${full.toLowerCase()}/${path}`)}`,
    source: 'other',
    kind: 'note',
    at,
    title: `${shortRepo(full)}: ${path}`,
    detail: kept,
    url: `https://github.com/${full}/blob/HEAD/${encodeURI(path)}`,
    // What people keep in their own repositories can be personal (a journal, plans): sensitive,
    // so only the private AI and the AI on the device read it.
    tier: 3,
    meta: { app: 'github', repo: full, file: path },
  };
}

const decode = (b64: string) => {
  const bin = atob(b64.replace(/\s+/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

// The blob sha of each file as last read, for one repository.
function seenDocs(st: SvcState, full: string): Record<string, string> {
  try {
    const v = JSON.parse(st.cursors[cursorKey('docs', full)] || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

async function docs(token: string, full: string, st: SvcState, now: number): Promise<LifeEvent[]> {
  goOn('github');
  const { data } = await get(token, `/repos/${full}/contents/`, full);
  const files = arr(data)
    .map(obj)
    .filter((f) => f.type === 'file' && /\.(md|markdown|txt)$/i.test(text(f.name, 200)) && Number(f.size) > 0 && Number(f.size) < 500_000)
    .slice(0, MAX_DOCS);
  const out: LifeEvent[] = [];
  const seen = seenDocs(st, full);
  const next: Record<string, string> = {};
  for (const f of files) {
    const path = text(f.path, 200);
    const sha = text(f.sha, 64);
    if (!path) continue;
    if (seen[path] === sha) {
      next[path] = sha; // unchanged since last time
      continue;
    }
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
    next[path] = sha;
  }
  st.cursors[cursorKey('docs', full)] = JSON.stringify(next);
  return out;
}

// ---------- the sync

export const reposOf = (st: SvcState) => (st.cursors.repos || '').split(',').filter((r) => REPO.test(r));

export async function sync(st: SvcState, ctx: Ctx, now = Date.now()) {
  const token = st.auth.token || '';
  const login = st.user;
  if (!validToken(token) || !login) throw new ConnectError('auth', 'Connect GitHub again.');
  const repos = reposOf(st);
  // Only the repositories still picked keep a place.
  const keep = new Set(['repos', ...repos.flatMap((r) => [cursorKey('since', r), cursorKey('docs', r)])]);
  for (const k of Object.keys(st.cursors)) if (!keep.has(k)) delete st.cursors[k];
  for (const full of repos) {
    const key = cursorKey('since', full);
    const since = st.cursors[key] || new Date(now - FIRST_DAYS * 86_400_000).toISOString();
    await hand('github', await commits(token, login, full, since));
    // Next time from a while before this sync (GitHub's `since` goes by when a commit landed, and
    // a merged branch brings older ones), never from a date still to come.
    st.cursors[key] = new Date(Math.max(Date.parse(since) || 0, now - LOOKBACK)).toISOString();
    ctx.save();
    await hand('github', await docs(token, full, st, now), { replace: true });
    ctx.save();
  }
}
