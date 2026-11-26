// Your website on GitHub Pages: the files lib/site.ts builds, written to a repository in the
// Player's own GitHub account, with their own fine-grained key (personal access token) for that
// one repository, with Contents: Read and write and Pages: Read and write. Like GitHub backup
// (github-backup.ts), everything goes straight from this device to api.github.com
// (connect/http.ts), and the key stays on this device: never synced, never in a backup, gone
// with "Erase all data" or Disconnect.
//
// One Publish is one commit: the files are put in a tree on top of what's there, the files an
// earlier Publish wrote and this one doesn't (a page deleted, say) are taken away, and the
// person's own files (a README, a CNAME for their own domain) stay. Then Pages is turned on
// for the repository's main branch, if it isn't yet.

import { request, obj, arr, text, retryAfter, type Res } from './connect/http';
import { repoName, validToken } from './connect/github';
import { fromB64 } from './lib/crypto';
import { MANIFEST, type SiteFile } from './lib/site';

const API = 'https://api.github.com';
const STATE = 'arise-site-github';

export class PublishError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly wait = 0,
  ) {
    super(message);
  }
}

// ---------- what this device keeps

export interface Conn {
  token: string;
  repo: string; // owner/name
  login: string;
  last: number; // the last Publish that worked
  error: string;
}
const BLANK: Conn = { token: '', repo: '', login: '', last: 0, error: '' };
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : '');
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.round(v) : 0);

export function conn(): Conn {
  try {
    const r = obj(JSON.parse(localStorage.getItem(STATE) || 'null'));
    const token = str(r.token, 300);
    const repo = repoName(str(r.repo, 200), '');
    if (!validToken(token) || !repo) return { ...BLANK };
    return { token, repo, login: str(r.login, 39), last: time(r.last), error: str(r.error, 300) };
  } catch {
    return { ...BLANK };
  }
}
function setConn(patch: Partial<Conn>) {
  try {
    const next = { ...conn(), ...patch };
    if (!next.token) localStorage.removeItem(STATE);
    else localStorage.setItem(STATE, JSON.stringify(next));
  } catch {}
}
export const isConnected = () => !!conn().token;
export function forget() {
  setConn({ token: '' });
}

// ---------- GitHub

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
const headers = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' });

function trouble(res: Res, what = 'write to that repository'): PublishError {
  const s = res.status;
  if (s === 401) return new PublishError('GitHub said no to this key. It may have run out: make a new one and connect again.', s);
  if ((s === 403 && res.headers['x-ratelimit-remaining'] === '0') || s === 429) return new PublishError('GitHub asked Arise to wait. Try again in a while.', s, retryAfter(res, 3_600_000));
  if (s === 403 || s === 404) return new PublishError(`This key can't ${what}. Give the key that repository, with Contents and Pages: Read and write.`, s);
  if (s === 0 || s >= 500) return new PublishError("Couldn't reach GitHub. Try again in a while.", s);
  const msg = text(obj(res.data).message, 120);
  return new PublishError(`GitHub said no (${s}${msg ? `: ${msg}` : ''}).`, s);
}

async function call(token: string, method: Method, path: string, body?: unknown): Promise<Res> {
  try {
    return await request({ url: `${API}${path}`, method, headers: headers(token), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw new PublishError("Couldn't reach GitHub. Check your internet connection.");
  }
}
const ok = (res: Res, ...codes: number[]) => codes.includes(res.status);
const seg = (s: string) => s.split('/').map(encodeURIComponent).join('/');

export async function whoami(token: string): Promise<string> {
  const res = await call(token, 'GET', '/user');
  if (res.status !== 200) throw trouble(res, 'be read');
  const login = text(obj(res.data).login, 39);
  if (!login) throw new PublishError("GitHub didn't say whose key this is.");
  return login;
}

// The repository as GitHub names it. Made (public, so a free account can have a Pages site) when
// it isn't there and the key may make repositories.
export async function ensureRepo(token: string, full: string, login: string): Promise<string> {
  const res = await call(token, 'GET', `/repos/${full}`);
  if (res.status === 200) return text(obj(res.data).full_name, 140) || full;
  if (res.status !== 404) throw trouble(res, 'read that repository');
  const [owner, name] = full.split('/');
  const made = owner.toLowerCase() === login.toLowerCase() ? await call(token, 'POST', '/user/repos', { name, private: false, auto_init: true, has_issues: false, has_wiki: false, description: 'My website, written in Arise.' }) : null;
  if (made?.status === 201) return text(obj(made.data).full_name, 140) || full;
  throw new PublishError(`There's no repository ${full} this key can reach, and it can't make one. Make it on GitHub first (public), then give the key that repository with Contents and Pages: Read and write.`);
}

// The branch's newest commit and its tree. An empty repository gets a first file (.nojekyll) so
// there's a branch to build on.
async function head(token: string, full: string, branch: string): Promise<{ commit: string; tree: string }> {
  let res = await call(token, 'GET', `/repos/${full}/git/ref/heads/${seg(branch)}`);
  if (res.status === 404 || res.status === 409) {
    const first = await call(token, 'PUT', `/repos/${full}/contents/.nojekyll`, { message: 'Start the website', content: '', branch });
    if (!ok(first, 200, 201)) throw trouble(first);
    res = await call(token, 'GET', `/repos/${full}/git/ref/heads/${seg(branch)}`);
  }
  if (res.status !== 200) throw trouble(res, 'read that repository');
  const commit = text(obj(obj(res.data).object).sha, 64);
  const c = await call(token, 'GET', `/repos/${full}/git/commits/${commit}`);
  if (c.status !== 200) throw trouble(c, 'read that repository');
  const tree = text(obj(obj(c.data).tree).sha, 64);
  if (!commit || !tree) throw new PublishError("GitHub didn't say what's in the repository. Try again.");
  return { commit, tree };
}

// The files there now, and which of them an earlier Publish wrote (from its list, MANIFEST).
async function present(token: string, full: string, tree: string): Promise<{ paths: Set<string>; ours: string[] }> {
  const res = await call(token, 'GET', `/repos/${full}/git/trees/${tree}?recursive=1`);
  if (res.status !== 200) throw trouble(res, 'read that repository');
  const items = arr(obj(res.data).tree).map(obj);
  const paths = new Set(items.filter((i) => i.type === 'blob').map((i) => text(i.path, 300)));
  const listed = items.find((i) => i.path === MANIFEST && i.type === 'blob');
  let ours: string[] = [];
  if (listed) {
    const blob = await call(token, 'GET', `/repos/${full}/git/blobs/${text(listed.sha, 64)}`);
    if (blob.status === 200) {
      try {
        const raw = new TextDecoder().decode(new Uint8Array(fromB64(text(obj(blob.data).content, 2_000_000).replace(/\s+/g, ''))));
        ours = arr(obj(JSON.parse(raw)).files).filter((p): p is string => typeof p === 'string' && p.length <= 300);
      } catch {}
    }
  }
  return { paths, ours };
}

// Pages on, from the branch's top folder. Its address.
export async function ensurePages(token: string, full: string, branch: string): Promise<string> {
  const res = await call(token, 'GET', `/repos/${full}/pages`);
  if (res.status === 200) return text(obj(res.data).html_url, 300);
  if (res.status !== 404) throw trouble(res, 'turn on GitHub Pages');
  const made = await call(token, 'POST', `/repos/${full}/pages`, { source: { branch, path: '/' } });
  if (ok(made, 201)) return text(obj(made.data).html_url, 300);
  if (made.status === 409) return ensurePages(token, full, branch); // on meanwhile
  if (made.status === 422) throw new PublishError('GitHub could not turn on Pages for this repository. On a free account the repository has to be public: change it on GitHub (Settings, Danger Zone, Change visibility), then publish again.', 422);
  throw trouble(made, 'turn on GitHub Pages');
}

// ---------- what the screen does

// Checks the key and the repository and keeps them on this device.
export async function connect({ token, repo }: { token: string; repo: string }): Promise<Conn> {
  const t = token.trim();
  if (!validToken(t)) throw new PublishError("That doesn't look like a GitHub key. It starts with github_pat_.");
  const login = await whoami(t);
  const full = repoName(repo || `${login}.github.io`, login);
  if (!full) throw new PublishError("That repository name doesn't look right. Use a name like my-website.");
  const named = await ensureRepo(t, full, login);
  setConn({ token: t, repo: named, login, last: 0, error: '' });
  return conn();
}

// Writes the files as one commit, then makes sure Pages is on. The site's address, and whether
// anything changed.
export async function publish(files: SiteFile[], now = Date.now()): Promise<{ url: string; changed: boolean }> {
  const c = conn();
  if (!c.token) throw new PublishError('Connect a GitHub repository first.');
  try {
    const info = await call(c.token, 'GET', `/repos/${c.repo}`);
    if (info.status !== 200) throw trouble(info, 'read that repository');
    const branch = text(obj(info.data).default_branch, 100) || 'main';
    const { commit, tree } = await head(c.token, c.repo, branch);
    const { paths, ours } = await present(c.token, c.repo, tree);
    const keep = new Set(files.map((f) => f.path));
    const gone = ours.filter((p) => !keep.has(p) && paths.has(p));
    const t = await call(c.token, 'POST', `/repos/${c.repo}/git/trees`, {
      base_tree: tree,
      tree: [...files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })), ...gone.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null }))],
    });
    if (!ok(t, 201)) throw trouble(t);
    const next = text(obj(t.data).sha, 64);
    let changed = false;
    if (next && next !== tree) {
      const made = await call(c.token, 'POST', `/repos/${c.repo}/git/commits`, { message: 'Publish the website from Arise', tree: next, parents: [commit] });
      if (!ok(made, 201)) throw trouble(made);
      const moved = await call(c.token, 'PATCH', `/repos/${c.repo}/git/refs/heads/${seg(branch)}`, { sha: text(obj(made.data).sha, 64), force: false });
      if (moved.status === 422 || moved.status === 409) throw new PublishError('The repository changed while Arise was publishing. Publish again.', moved.status);
      if (!ok(moved, 200)) throw trouble(moved);
      changed = true;
    }
    const url = await ensurePages(c.token, c.repo, branch);
    setConn({ last: now, error: '' });
    return { url, changed };
  } catch (err) {
    setConn({ error: (err as Error)?.message || "Couldn't publish." });
    throw err;
  }
}
