// Photos and files in the Player's own private GitHub repositories: the second kind of own
// storage, next to a Cloudflare R2 bucket (lib/own-storage.ts). As there, only sealed parts go
// there (files-seal.ts), the same JSON the database would hold, under ids that say nothing. GitHub
// sees how big they are and when they came. The index and each file's details stay in the
// database (files-sync.ts), and the index says which repository holds each file.
//
// In a repository:
//   README.md                   what this is, written when Arise starts an empty repository
//   arise/2026-11/<part id>     the parts sent that month
// A file's parts go in one commit (the git data API: blobs, a tree, a commit, then the branch moves
// on), and deleting takes them out in one commit. Git keeps them in the history, still sealed.
//
// GitHub isn't meant as file storage and may limit a repository past about 1 GB. Once one nears
// that (REPO_NEAR), new files wait until the Player adds another private repository.
//
// The token (fine-grained, Contents: Read and write on those repositories) stays on this device:
// never synced, never in a backup, gone with Stop or "Erase all data". Another device needs its
// own token for the same repositories to open these files.

import type { Sealed } from '../lib/crypto';
import { toB64 } from '../lib/crypto';
import { arr, obj, request, text, type Res } from '../connect/http';
import { repoName, validToken, whoami } from '../connect/github';

const API = 'https://api.github.com';
const KEY = 'arise-github-files';
export const REPO_SOFT_MAX = 1024 ** 3; // GitHub's soft limit for a repository
export const REPO_NEAR = 900 * 1024 ** 2; // past this, new files go to the next repository
export const MAX_REPOS = 20;
export const FIRST_NAME = 'arise-files';
const AT_ONCE = 4;

const README = `# Arise files

This private repository keeps photos and files from Arise. They were encrypted on your devices before they came here, so only your devices can open them.

Please don't change, move or delete anything here. A file with a part missing can't be opened.
`;

const fail = (code: string, message: string, status = 0) => Object.assign(new Error(message), { code, status });

// ---------- what this device keeps

export interface GitHubFiles {
  token: string;
  login: string; // whose token it is
  repos: string[]; // owner/name, in the order they were added: new files go to the first with room
}

const uniq = (list: string[]) => list.filter((r, i) => list.findIndex((x) => x.toLowerCase() === r.toLowerCase()) === i);

// Read back field by field, like everything from storage.
export function settings(): GitHubFiles | null {
  try {
    const r = obj(JSON.parse(localStorage.getItem(KEY) || 'null'));
    const token = typeof r.token === 'string' && r.token.length <= 300 ? r.token : '';
    if (!validToken(token)) return null;
    const repos = uniq(arr(r.repos).map((x) => (typeof x === 'string' && x.includes('/') ? repoName(x, '') : '')).filter(Boolean)).slice(0, MAX_REPOS);
    return repos.length ? { token, login: text(r.login, 39), repos } : null;
  } catch {
    return null;
  }
}
function keep(s: GitHubFiles) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    throw fail('github', "This device couldn't keep the token. Check it has some space left.");
  }
}
export const isOn = () => !!settings();

const listeners = new Set<() => void>();
export const onChange = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
const changed = () => listeners.forEach((fn) => fn());

// Stop: the token goes from this device. The files stay in the repositories.
export function forget() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  changed();
}

// ---------- GitHub

const headers = (token: string, raw = false) => ({
  authorization: `Bearer ${token}`,
  accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
});

async function call(token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown, raw = false): Promise<Res> {
  try {
    return await request({ url: `${API}${path}`, method, headers: headers(token, raw), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw fail('unavailable', "Couldn't reach GitHub. Check the internet connection.");
  }
}

function trouble(res: Res, repo = ''): Error {
  const s = res.status;
  if (s === 401) return fail('github', 'GitHub said no to this token. It may have run out: make a new one and connect again.', s);
  if ((s === 403 && res.headers['x-ratelimit-remaining'] === '0') || s === 429) return fail('github-wait', 'GitHub asked Arise to wait. It tries again later.', s);
  if (s === 403 || s === 404) return fail('github', `This token can't write to ${repo || 'that repository'}. Give it that repository, with Contents: Read and write.`, s);
  if (s === 0 || s >= 500) return fail('unavailable', "GitHub didn't answer. Arise tries again later.", s);
  const msg = text(obj(res.data).message, 120);
  return fail('github', `GitHub said no (${s}${msg ? `: ${msg}` : ''}).`, s);
}

// The folder a part goes in: the month it was sent.
export const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
export const partPath = (month: string, id: string) => `arise/${month}/${id}`;

const sealedOf = (d: unknown): Sealed | null => {
  const x = obj(d);
  return typeof x.iv === 'string' && typeof x.ct === 'string' ? { iv: x.iv, ct: x.ct } : null;
};

async function inTurns<T>(list: readonly T[], fn: (x: T) => Promise<void>) {
  for (let i = 0; i < list.length; i += AT_ONCE) await Promise.all(list.slice(i, i + AT_ONCE).map(fn));
}

// Where files' parts go, read and are deleted. `repos`: where this device may send new files.
export interface GitHubParts {
  repos: readonly string[];
  put(repo: string, month: string, docs: readonly { id: string; s: Sealed }[]): Promise<void>;
  get(repo: string, month: string, id: string): Promise<Sealed | null>;
  del(repo: string, month: string, ids: readonly string[]): Promise<void>;
  used(repo: string): Promise<number>; // bytes, as GitHub counts the repository (it can lag)
}

const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

export function githubStore(token: string, repos: readonly string[]): GitHubParts {
  const about = new Map<string, { branch: string; size: number }>();
  async function aboutRepo(repo: string) {
    const known = about.get(repo);
    if (known) return known;
    const res = await call(token, 'GET', `/repos/${repo}`);
    if (res.status !== 200) throw trouble(res, repo);
    const d = obj(res.data);
    const branch = text(d.default_branch, 200);
    const info = { branch: BRANCH.test(branch) ? branch : 'main', size: typeof d.size === 'number' && d.size > 0 ? d.size * 1024 : 0 };
    about.set(repo, info);
    return info;
  }
  // The branch's last commit and its tree. Null: the repository is empty.
  async function head(repo: string): Promise<{ commit: string; tree: string } | null> {
    const { branch } = await aboutRepo(repo);
    const ref = await call(token, 'GET', `/repos/${repo}/git/ref/heads/${branch}`);
    if (ref.status === 404 || ref.status === 409) return null;
    if (ref.status !== 200) throw trouble(ref, repo);
    const commit = text(obj(obj(ref.data).object).sha, 64);
    const c = await call(token, 'GET', `/repos/${repo}/git/commits/${commit}`);
    if (c.status !== 200) throw trouble(c, repo);
    const tree = text(obj(obj(c.data).tree).sha, 64);
    if (!commit || !tree) throw fail('github', `GitHub's answer about ${repo} didn't read right.`);
    return { commit, tree };
  }
  // An empty repository has no branch to build on yet: a first commit, with the README.
  async function start(repo: string) {
    const res = await call(token, 'PUT', `/repos/${repo}/contents/README.md`, { message: 'Arise: start', content: toB64(new TextEncoder().encode(README)) });
    // (422: there's one already, as another device started it at the same time.)
    if (res.status !== 201 && res.status !== 200 && res.status !== 422) throw trouble(res, repo);
    about.delete(repo); // its branch is there now
  }
  async function ready(repo: string) {
    let h = await head(repo);
    if (h) return h;
    await start(repo);
    h = await head(repo);
    if (!h) throw fail('github', `Arise couldn't start ${repo}. Check the token has Contents: Read and write there.`);
    return h;
  }
  // One commit on the branch. `change` says what goes in it, from the commit it builds on (an empty
  // list: nothing to do). Another device moving the branch on in between: again, on top of that.
  async function commit(repo: string, message: string, change: (h: { commit: string; tree: string }) => Promise<{ path: string; sha: string | null }[]>) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const h = await ready(repo);
      const entries = await change(h);
      if (!entries.length) return;
      const t = await call(token, 'POST', `/repos/${repo}/git/trees`, { base_tree: h.tree, tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })) });
      if (t.status === 422) continue; // a part deleted meanwhile: look again
      if (t.status !== 201) throw trouble(t, repo);
      const c = await call(token, 'POST', `/repos/${repo}/git/commits`, { message, tree: text(obj(t.data).sha, 64), parents: [h.commit] });
      if (c.status !== 201) throw trouble(c, repo);
      const { branch } = await aboutRepo(repo);
      const u = await call(token, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: text(obj(c.data).sha, 64), force: false });
      if (u.status === 200) return;
      if (u.status !== 422 && u.status !== 409) throw trouble(u, repo);
    }
    throw fail('github', `GitHub was busy with other changes to ${repo}. Arise tries again later.`);
  }
  // The names in one folder of a tree, or none.
  async function names(repo: string, tree: string, name: string): Promise<{ path: string; sha: string; type: string }[] | null> {
    const res = await call(token, 'GET', `/repos/${repo}/git/trees/${tree}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw trouble(res, repo);
    const list = arr(obj(res.data).tree).map((x) => ({ path: text(obj(x).path, 200), sha: text(obj(x).sha, 64), type: text(obj(x).type, 10) }));
    const dir = list.find((x) => x.path === name && x.type === 'tree');
    if (!dir) return null;
    const inner = await call(token, 'GET', `/repos/${repo}/git/trees/${dir.sha}`);
    if (inner.status !== 200) throw trouble(inner, repo);
    return arr(obj(inner.data).tree).map((x) => ({ path: text(obj(x).path, 200), sha: text(obj(x).sha, 64), type: text(obj(x).type, 10) }));
  }
  return {
    repos,
    async put(repo, month, docs) {
      if (!docs.length) return;
      await ready(repo);
      const shas: string[] = [];
      await inTurns(
        docs.map((_, i) => i),
        async (i) => {
          const res = await call(token, 'POST', `/repos/${repo}/git/blobs`, { content: JSON.stringify({ v: 1, iv: docs[i].s.iv, ct: docs[i].s.ct }), encoding: 'utf-8' });
          if (res.status !== 201) throw trouble(res, repo);
          shas[i] = text(obj(res.data).sha, 64);
        },
      );
      await commit(repo, 'Arise: a file', async () => docs.map((d, i) => ({ path: partPath(month, d.id), sha: shas[i] })));
    },
    async get(repo, month, id) {
      const res = await call(token, 'GET', `/repos/${repo}/contents/${partPath(month, id)}`, undefined, true);
      if (res.status === 404) return null;
      if (res.status !== 200) throw trouble(res, repo);
      let d = res.data;
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d);
        } catch {
          return null;
        }
      }
      return sealedOf(d);
    },
    async del(repo, month, ids) {
      if (!ids.length) return;
      const want = new Set(ids);
      await commit(repo, 'Arise: a file deleted', async (h) => {
        const top = await names(repo, h.tree, 'arise');
        if (!top) return [];
        const dir = top.find((x) => x.path === month && x.type === 'tree');
        if (!dir) return [];
        const inner = await call(token, 'GET', `/repos/${repo}/git/trees/${dir.sha}`);
        if (inner.status !== 200) throw trouble(inner, repo);
        return arr(obj(inner.data).tree)
          .map((x) => text(obj(x).path, 200))
          .filter((p) => want.has(p))
          .map((p) => ({ path: partPath(month, p), sha: null }));
      });
    },
    async used(repo) {
      return (await aboutRepo(repo)).size;
    },
  };
}

// ---------- setting it up

// Writes a test part, reads it back and deletes it.
export async function checkRepo(token: string, repo: string, now = Date.now()): Promise<void> {
  const store = githubStore(token, [repo]);
  const id = `check-${now.toString(36)}`;
  const month = monthOf(now);
  const s = { iv: 'check', ct: 'Arise checks it can write here. This can be deleted.' };
  await store.put(repo, month, [{ id, s }]);
  const back = await store.get(repo, month, id);
  if (!back || back.ct !== s.ct) throw fail('github', `Arise wrote to ${repo} but couldn't read it back. Check the token has Contents: Read and write there.`);
  await store.del(repo, month, [id]);
}

// The repository, ready for files: private, and empty or only Arise's. When it isn't there and
// `make` says so (the Player said yes), Arise makes it, private, if the token may.
export async function prepareRepo(token: string, login: string, input: string, make = false): Promise<string> {
  const full = repoName(input || FIRST_NAME, login);
  if (!full) throw fail('github', "That repository name doesn't look right. Use a name like arise-files.");
  const res = await call(token, 'GET', `/repos/${full}`);
  if (res.status === 200) {
    const d = obj(res.data);
    if (d.private !== true) throw fail('github', `${full} is public. Pick a private repository, or a new name and Arise makes one.`);
    const named = text(d.full_name, 140) || full;
    const top = await call(token, 'GET', `/repos/${named}/contents/`);
    if (top.status === 200) {
      const there = arr(top.data).map((x) => text(obj(x).name, 200));
      if (there.some((n) => n !== 'README.md' && n !== 'arise')) throw fail('github', `${named} already has other things in it. Pick an empty one, or a new name and Arise makes one.`);
    } else if (top.status !== 404) throw trouble(top, named);
    return named;
  }
  if (res.status !== 404) throw trouble(res, full);
  if (!make) throw Object.assign(fail('missing', `There's no repository ${full} that this token can see.`), { full });
  const [owner, name] = full.split('/');
  const made =
    owner.toLowerCase() === login.toLowerCase() ? await call(token, 'POST', '/user/repos', { name, private: true, auto_init: false, description: 'Photos and files from Arise, encrypted.' }) : null;
  if (made?.status === 201 && obj(made.data).private === true) return text(obj(made.data).full_name, 140) || full;
  throw fail('github', `This token can't make ${full}. Make it on GitHub yourself (private and empty), give the token that repository with Contents: Read and write, and try again.`);
}

// Checks the token and the repository, and keeps them on this device.
export async function connect({ token, repo, make = false }: { token: string; repo: string; make?: boolean }): Promise<GitHubFiles> {
  const t = token.trim();
  if (!validToken(t)) throw fail('github', "That doesn't look like a GitHub token. A fine-grained one starts with github_pat_.");
  const login = await whoami(t);
  const full = await prepareRepo(t, login, repo, make);
  await checkRepo(t, full);
  const was = settings();
  const repos = was && was.login.toLowerCase() === login.toLowerCase() ? uniq([...was.repos, full]) : [full];
  keep({ token: t, login, repos });
  changed();
  return settings()!;
}

// Another repository, for when the ones there are near 1 GB.
export async function addRepo(input: string, make = false): Promise<string> {
  const st = settings();
  if (!st) throw fail('github', 'Connect your GitHub first.');
  if (st.repos.length >= MAX_REPOS) throw fail('github', `Arise keeps files in up to ${MAX_REPOS} repositories.`);
  const full = await prepareRepo(st.token, st.login, input, make);
  await checkRepo(st.token, full);
  keep({ ...st, repos: uniq([...st.repos, full]) });
  changed();
  return full;
}

// A name for the next repository: arise-files-2, -3...
export function nextName(repos: readonly string[]): string {
  const taken = new Set(repos.map((r) => (r.split('/')[1] || '').toLowerCase()));
  for (let i = repos.length + 1; ; i++) if (!taken.has(`${FIRST_NAME}-${i}`)) return `${FIRST_NAME}-${i}`;
}

// The Check button: each repository written, read and deleted from. The first that fails says why.
export async function checkAll(): Promise<number> {
  const st = settings();
  if (!st) throw fail('github', 'Connect your GitHub first.');
  for (const repo of st.repos) await checkRepo(st.token, repo);
  return st.repos.length;
}

// How full each repository is, as GitHub counts it.
export async function sizes(): Promise<Record<string, number>> {
  const st = settings();
  if (!st) return {};
  const store = githubStore(st.token, st.repos);
  const out: Record<string, number> = {};
  for (const repo of st.repos) out[repo] = await store.used(repo).catch(() => -1);
  return out;
}
