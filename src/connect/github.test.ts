// @vitest-environment jsdom
// GitHub, read straight from the web app with the Player's own read-only token: their commits in
// the repositories they picked, into their days, and those repositories' Markdown files as notes,
// a changed file replacing its note.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeNet, useWeb, type Net } from '../test/fake-http';
import { fakeLife } from '../test/fake-life';
import * as GH from './github';
import * as IDS from './ids';
import { blank, clean, type SvcState } from './state';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const TOKEN = `github_pat_${'A1b2'.repeat(20)}`;
const ctx = { save: vi.fn() };
let net: Net;
let life: ReturnType<typeof fakeLife>;

const sha = (n: number) => n.toString(16).padStart(40, 'a');
const commit = (n: number, date: string, message: string) => ({ sha: sha(n), commit: { message, author: { name: 'Sam', date }, committer: { date } } });
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

function user(repos = 'sam/my-goals-and-networks,sam/my-portfolio'): SvcState {
  return { ...blank(), on: true, account: 'sam', user: 'sam', auth: { token: TOKEN }, cursors: { repos } };
}

beforeEach(() => {
  net = fakeNet();
  useWeb(net);
  life = fakeLife();
  IDS.resetForTests();
  net
    .on(/\/repos\/sam\/my-goals-and-networks\/commits/, { body: [commit(1, '2026-11-20T09:00:00Z', 'Add networking goals for 2027\n\nMore detail here.')] })
    .on(/\/repos\/sam\/my-portfolio\/commits/, { body: [commit(2, '2026-11-21T18:30:00Z', 'Fix the navbar')] })
    .on(/\/repos\/sam\/my-goals-and-networks\/contents\/$/, { body: [
      { type: 'file', name: 'README.md', path: 'README.md', sha: 'r1', size: 40 },
      { type: 'file', name: 'goals.md', path: 'goals.md', sha: 'g1', size: 60 },
      { type: 'file', name: 'photo.png', path: 'photo.png', sha: 'p1', size: 99 },
      { type: 'dir', name: 'notes', path: 'notes', sha: 'd1', size: 0 },
    ] })
    .on(/\/repos\/sam\/my-goals-and-networks\/contents\/README\.md/, { body: { content: b64('# My goals and networks\nPeople I want to meet.') } })
    .on(/\/repos\/sam\/my-goals-and-networks\/contents\/goals\.md/, { body: { content: b64('- Run a half marathon\n- Ship my portfolio') } })
    .on(/\/repos\/sam\/my-portfolio\/contents\/$/, { body: [] });
});

describe('GitHub', () => {
  it('knows a token and repository names when it sees them', () => {
    expect(GH.validToken(TOKEN)).toBe(true);
    expect(GH.validToken(`ghp_${'x'.repeat(36)}`)).toBe(true);
    expect(GH.validToken('password123')).toBe(false);
    expect(GH.repoList('my-portfolio\nhttps://github.com/sam/my-goals-and-networks.git, other/thing\nmy-portfolio\nnot a repo!', 'sam')).toEqual(['sam/my-portfolio', 'sam/my-goals-and-networks', 'other/thing']);
  });

  it("puts the Player's commits into their days, with the right time, and only what's new next time", async () => {
    const st = user();
    await GH.sync(st, ctx, NOW);
    const commits = life.list().filter((e) => e.meta?.sha);
    expect(commits.map((e) => [e.title, new Date(e.at).toISOString()])).toEqual([
      ['Committed to my-goals-and-networks: Add networking goals for 2027', '2026-11-20T09:00:00.000Z'],
      ['Committed to my-portfolio: Fix the navbar', '2026-11-21T18:30:00.000Z'],
    ]);
    expect(commits[0]).toMatchObject({ source: 'other', kind: 'other', tier: 2, detail: 'Add networking goals for 2027\n\nMore detail here.', url: `https://github.com/sam/my-goals-and-networks/commit/${sha(1)}` });
    // Only their own commits, from the last 90 days the first time.
    const first = new URL(net.urls().find((u) => u.includes('my-portfolio/commits'))!);
    expect(first.searchParams.get('author')).toBe('sam');
    expect(first.searchParams.get('since')).toBe(new Date(NOW - 90 * 86_400_000).toISOString());
    // The key goes only to GitHub, as a bearer token.
    expect(net.calls.every((c) => c.url.startsWith('https://api.github.com/') && c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    // Where it left off survives a reload (state.ts keeps only safe keys).
    const kept = clean(JSON.parse(JSON.stringify(st)));
    expect(kept.cursors[GH.cursorKey('since', 'sam/my-portfolio')]).toBe('2026-11-21T18:29:00.000Z');
    net.calls.length = 0;
    await GH.sync(kept, ctx, NOW + 3600_000);
    expect(new URL(net.urls().find((u) => u.includes('my-portfolio/commits'))!).searchParams.get('since')).toBe('2026-11-21T18:29:00.000Z');
    expect(life.list().filter((e) => e.meta?.sha)).toHaveLength(2); // the same commit again is kept once
  });

  it("reads the repositories' Markdown files as notes, and again only when one changed", async () => {
    const st = user();
    await GH.sync(st, ctx, NOW);
    const notes = life.list().filter((e) => e.kind === 'note');
    expect(notes.map((e) => e.title).sort()).toEqual(['my-goals-and-networks: README.md', 'my-goals-and-networks: goals.md']);
    expect(notes.find((e) => e.title.endsWith('goals.md'))!.detail).toBe('- Run a half marathon\n- Ship my portfolio');
    net.calls.length = 0;
    await GH.sync(st, ctx, NOW + 3600_000);
    expect(net.urls().some((u) => u.includes('/contents/goals.md'))).toBe(false); // unchanged: not read again
    net
      .on(/\/repos\/sam\/my-goals-and-networks\/contents\/$/, { body: [{ type: 'file', name: 'goals.md', path: 'goals.md', sha: 'g2', size: 70 }] })
      .on(/\/repos\/sam\/my-goals-and-networks\/contents\/goals\.md/, { body: { content: b64('- Run a full marathon') } });
    await GH.sync(st, ctx, NOW + 7200_000);
    expect(life.list().find((e) => e.title.endsWith('goals.md'))!.detail).toBe('- Run a full marathon');
  });

  it('says what to do when GitHub refuses', async () => {
    net.on(/\/repos\/sam\/my-portfolio\/commits/, { status: 404, body: { message: 'Not Found' } });
    await expect(GH.sync(user('sam/my-portfolio'), ctx, NOW)).rejects.toThrow("isn't open to this key");
    net.on(/\/repos\/sam\/my-portfolio\/commits/, { status: 401, body: { message: 'Bad credentials' } });
    await expect(GH.sync(user('sam/my-portfolio'), ctx, NOW)).rejects.toMatchObject({ kind: 'auth' });
    net.on(/\/repos\/sam\/my-portfolio\/commits/, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }, body: {} });
    await expect(GH.sync(user('sam/my-portfolio'), ctx, NOW)).rejects.toMatchObject({ kind: 'rate' });
    await expect(GH.sync({ ...user(), auth: {} }, ctx, NOW)).rejects.toMatchObject({ kind: 'auth' });
  });
});
