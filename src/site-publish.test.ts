// @vitest-environment jsdom
// Publishing Your website: the GitHub calls (against a pretend GitHub), one commit per Publish
// that takes away only the files Arise wrote before, Pages turned on, and the key kept on this
// device and sent nowhere but api.github.com.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeNet, useWeb, type Call, type Net } from './test/fake-http';
import * as SITE from './lib/site';

type SP = typeof import('./site-publish');
let P: SP;
let net: Net;

const TOKEN = `github_pat_${'Zx9y'.repeat(20)}`;
const T = Date.UTC(2026, 10, 20, 12);
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// GitHub, as far as Publish uses it: repositories, their main branch's files, commits through the
// Git data API, and Pages.
interface Repo {
  files: Map<string, string>;
  commit: number;
  empty: boolean;
  pages: string;
  pagesRefuse?: boolean;
}
let repos: Map<string, Repo>;
let canMake: boolean;
let trees: Map<string, Map<string, string>>;
let commits: Map<string, string>; // commit sha → tree sha
let blobs: Map<string, string>;
let n: number;

const treeOf = (r: Repo) => `t${r.commit}`;
function github(c: Call) {
  const u = new URL(c.url);
  const body = c.body ? JSON.parse(c.body) : {};
  if (c.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { message: 'Bad credentials' } };
  if (u.pathname === '/user') return { body: { login: 'sam' } };
  if (u.pathname === '/user/repos' && c.method === 'POST') {
    if (!canMake) return { status: 403, body: { message: 'Resource not accessible by personal access token' } };
    repos.set(`sam/${body.name}`, { files: new Map([['README.md', '# hi']]), commit: 1, empty: false, pages: '' });
    return { status: 201, body: { full_name: `sam/${body.name}`, private: body.private } };
  }
  const m = /^\/repos\/(sam\/[^/]+)(\/.*)?$/.exec(u.pathname);
  const repo = m && repos.get(m[1]);
  if (!m || !repo) return { status: 404, body: { message: 'Not Found' } };
  const rest = m[2] || '';
  if (!rest) return { body: { full_name: m[1], private: false, default_branch: 'main' } };
  if (rest === '/git/ref/heads/main') return repo.empty ? { status: 409, body: { message: 'Git Repository is empty.' } } : { body: { object: { sha: `c${repo.commit}` } } };
  if (rest === '/contents/.nojekyll' && c.method === 'PUT') {
    repo.files.set('.nojekyll', atob(body.content));
    repo.empty = false;
    repo.commit++;
    return { status: 201, body: {} };
  }
  const commit = /^\/git\/commits\/(\w+)$/.exec(rest);
  if (commit && c.method === 'GET') return commit[1] === `c${repo.commit}` ? { body: { sha: commit[1], tree: { sha: treeOf(repo) } } } : { status: 404, body: {} };
  const tree = /^\/git\/trees\/(\w+)$/.exec(rest);
  if (tree && c.method === 'GET') {
    if (tree[1] !== treeOf(repo) || u.searchParams.get('recursive') !== '1') return { status: 404, body: {} };
    return {
      body: {
        sha: tree[1],
        truncated: false,
        tree: [...repo.files].map(([path, content]) => {
          const sha = `b${n++}`;
          blobs.set(sha, content);
          return { path, mode: '100644', type: 'blob', sha };
        }),
      },
    };
  }
  const blob = /^\/git\/blobs\/(\w+)$/.exec(rest);
  if (blob) return blobs.has(blob[1]) ? { body: { content: b64(blobs.get(blob[1])!), encoding: 'base64' } } : { status: 404, body: {} };
  if (rest === '/git/trees' && c.method === 'POST') {
    if (body.base_tree !== treeOf(repo)) return { status: 422, body: { message: 'base_tree is not current' } };
    const next = new Map(repo.files);
    for (const e of body.tree) {
      if (e.sha === null) {
        if (!next.has(e.path)) return { status: 422, body: { message: `${e.path} isn't there` } };
        next.delete(e.path);
      } else next.set(e.path, e.content);
    }
    const same = next.size === repo.files.size && [...next].every(([k, v]) => repo.files.get(k) === v);
    if (same) return { status: 201, body: { sha: treeOf(repo) } };
    const sha = `n${n++}`;
    trees.set(sha, next);
    return { status: 201, body: { sha } };
  }
  if (rest === '/git/commits' && c.method === 'POST') {
    if (body.parents?.[0] !== `c${repo.commit}` || !trees.has(body.tree)) return { status: 422, body: {} };
    const sha = `k${n++}`;
    commits.set(sha, body.tree);
    return { status: 201, body: { sha } };
  }
  if (rest === '/git/refs/heads/main' && c.method === 'PATCH') {
    const t = commits.get(body.sha);
    if (!t) return { status: 422, body: { message: 'Reference update failed' } };
    repo.files = trees.get(t)!;
    repo.commit++;
    return { body: { object: { sha: body.sha } } };
  }
  if (rest === '/pages' && c.method === 'GET') return repo.pages ? { body: { html_url: repo.pages } } : { status: 404, body: {} };
  if (rest === '/pages' && c.method === 'POST') {
    if (repo.pagesRefuse) return { status: 422, body: { message: 'Your current plan does not support GitHub Pages for this repository.' } };
    if (body.source?.branch !== 'main' || body.source?.path !== '/') return { status: 400, body: {} };
    repo.pages = m[1] === 'sam/sam.github.io' ? 'https://sam.github.io/' : `https://sam.github.io/${m[1].split('/')[1]}/`;
    return { status: 201, body: { html_url: repo.pages } };
  }
  return { status: 405, body: {} };
}

function site() {
  let s = SITE.startSite(SITE.blankSite(), 'Sam', T);
  s = SITE.editPage(s, 'about', { body: 'About me.' }, T);
  const p = SITE.addPage(s, 'page', 'Talks', 'My talks.', T)!;
  return { site: p.site, talks: p.id };
}

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  repos = new Map([['sam/sam.github.io', { files: new Map([['README.md', 'Mine'], ['CNAME', 'sam.example.com']]), commit: 1, empty: false, pages: '' }]]);
  canMake = false;
  trees = new Map();
  commits = new Map();
  blobs = new Map();
  n = 1;
  net = fakeNet().on(/^https:\/\/api\.github\.com\//, github);
  useWeb(net);
  P = await import('./site-publish');
});
afterEach(() => vi.unstubAllGlobals());

const files = (r = 'sam/sam.github.io') => [...repos.get(r)!.files.keys()].sort();

describe('connecting', () => {
  it('checks the key and the repository, and keeps the key on this device only', async () => {
    const c = await P.connect({ token: TOKEN, repo: '' });
    expect(c).toMatchObject({ repo: 'sam/sam.github.io', login: 'sam' });
    expect(localStorage.getItem('arise-site-github')).toContain(TOKEN);
    const S = await import('./store');
    expect(JSON.stringify(S.exportData())).not.toContain(TOKEN);
    expect(JSON.stringify(S.state)).not.toContain(TOKEN);
  });

  it('makes the repository, public, when it is not there and the key may', async () => {
    await expect(P.connect({ token: TOKEN, repo: 'my-site' })).rejects.toThrow(/no repository sam\/my-site/);
    expect(P.isConnected()).toBe(false);
    canMake = true;
    await P.connect({ token: TOKEN, repo: 'my-site' });
    const made = net.calls.find((c) => c.url.endsWith('/user/repos'))!;
    expect(JSON.parse(made.body)).toMatchObject({ name: 'my-site', private: false, auto_init: true });
    expect(P.conn().repo).toBe('sam/my-site');
  });

  it('refuses a key that is not a GitHub key before anything is sent', async () => {
    await expect(P.connect({ token: 'hunter2', repo: '' })).rejects.toThrow(/doesn't look like a GitHub key/);
    expect(net.calls).toEqual([]);
  });
});

describe('publishing', () => {
  it('writes every file in one commit, turns Pages on, and keeps the person\'s own files', async () => {
    await P.connect({ token: TOKEN, repo: 'sam.github.io' });
    const { site: s } = site();
    const out = await P.publish(SITE.build(s, { year: 2026 }), T);
    expect(out).toEqual({ url: 'https://sam.github.io/', changed: true });
    expect(files()).toEqual(['.nojekyll', '404.html', 'CNAME', 'README.md', 'about.html', 'arise-site.json', 'index.html', 'style.css', 'talks.html']);
    expect(repos.get('sam/sam.github.io')!.files.get('README.md')).toBe('Mine');
    expect(repos.get('sam/sam.github.io')!.files.get('about.html')).toContain('<p>About me.</p>');
    expect(repos.get('sam/sam.github.io')!.commit).toBe(2); // one commit
    expect(P.conn()).toMatchObject({ last: T, error: '' });
    // Every request went to GitHub itself, and the key went nowhere else.
    expect(net.calls.every((c) => c.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(net.calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(net.calls.some((c) => c.body.includes(TOKEN))).toBe(false);
    const pages = net.calls.filter((c) => c.url.endsWith('/pages'));
    expect(pages.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('takes away a page deleted since, but only files Arise wrote', async () => {
    await P.connect({ token: TOKEN, repo: 'sam.github.io' });
    const { site: s, talks } = site();
    await P.publish(SITE.build(s));
    const after = SITE.deletePage(s, talks, T + 1);
    net.calls.length = 0;
    const out = await P.publish(SITE.build(after));
    expect(out.changed).toBe(true);
    expect(files()).toEqual(['.nojekyll', '404.html', 'CNAME', 'README.md', 'about.html', 'arise-site.json', 'index.html', 'style.css']);
    // Pages was on already: asked, not turned on again.
    expect(net.calls.filter((c) => c.url.endsWith('/pages')).map((c) => c.method)).toEqual(['GET']);
  });

  it('makes no commit when nothing changed', async () => {
    await P.connect({ token: TOKEN, repo: 'sam.github.io' });
    const built = SITE.build(site().site, { year: 2026 });
    await P.publish(built);
    net.calls.length = 0;
    const out = await P.publish(built);
    expect(out.changed).toBe(false);
    expect(repos.get('sam/sam.github.io')!.commit).toBe(2);
    expect(net.calls.some((c) => c.method === 'PATCH' || c.url.endsWith('/git/commits'))).toBe(false);
  });

  it('starts an empty repository with a first file', async () => {
    repos.set('sam/blog', { files: new Map(), commit: 0, empty: true, pages: '' });
    await P.connect({ token: TOKEN, repo: 'blog' });
    const out = await P.publish(SITE.build(site().site));
    expect(out.url).toBe('https://sam.github.io/blog/');
    expect(files('sam/blog')).toContain('index.html');
  });

  it('says plainly what went wrong, and keeps it to show', async () => {
    repos.get('sam/sam.github.io')!.pagesRefuse = true;
    await P.connect({ token: TOKEN, repo: 'sam.github.io' });
    await expect(P.publish(SITE.build(site().site))).rejects.toThrow(/has to be public/);
    expect(P.conn().error).toMatch(/has to be public/);
    localStorage.setItem('arise-site-github', JSON.stringify({ ...JSON.parse(localStorage.getItem('arise-site-github')!), token: `github_pat_${'Bad0'.repeat(20)}` }));
    await expect(P.publish(SITE.build(site().site))).rejects.toThrow(/said no to this key/);
  });

  it('forgets the key on Disconnect', async () => {
    await P.connect({ token: TOKEN, repo: '' });
    P.forget();
    expect(localStorage.getItem('arise-site-github')).toBeNull();
    await expect(P.publish([])).rejects.toThrow(/Connect a GitHub repository first/);
  });
});
