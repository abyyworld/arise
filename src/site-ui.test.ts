// @vitest-environment jsdom
// Your website on screen: the way in from Me, starting a site, the editor's live preview (with
// what they type escaped) and what it saves, the look, Ideas to write about (only through the
// coach's AI, and nothing written by itself), Publish, and the visit counter (hidden until its
// address is set, its read key kept on this device).

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const h = vi.hoisted(() => ({
  ai: { ready: false, ideas: vi.fn() },
  server: '',
  publish: vi.fn(),
  token: '',
}));
vi.mock('./ai.js', async (orig) => ({ ...(await orig<typeof import('./ai.js')>()), ready: () => h.ai.ready, postIdeas: (...a: unknown[]) => h.ai.ideas(...a) }));
vi.mock('./visits-config', () => ({
  VISITS: {
    get server() {
      return h.server;
    },
  },
}));
vi.mock('./site-publish', async (orig) => ({
  ...(await orig<typeof import('./site-publish')>()),
  conn: () => ({ token: h.token, repo: 'sam/sam.github.io', login: 'sam', last: 0, error: '' }),
  publish: (...a: unknown[]) => h.publish(...a),
}));

const NOW = new Date(2026, 10, 25, 10);
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(view: string) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, settings: { name: 'Sam' } }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const S = await import('./store');
  await import('./app.js');
  return { S };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const click = (sel: string) => $(sel)!.click();
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};
function type(sel: string, value: string, done = true) {
  const el = $(sel) as HTMLInputElement | HTMLTextAreaElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (done) el.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  h.ai.ready = false;
  h.ai.ideas.mockReset();
  h.publish.mockReset();
  h.server = '';
  h.token = '';
  globalThis.confirm = () => true;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Your website', { timeout: 20000 }, () => {
  it('opens from Me and starts with four empty pages, using their name', async () => {
    const { S } = await boot('progress');
    expect(text('.site-entry')).toContain('Your website');
    click('.site-entry [data-v="website"]');
    await until(() => !!$('.site-start'));
    expect(text('.site-start')).toContain('Only what you write here goes on it');
    click('[data-act="site-start"]');
    await until(() => !!$('#siteEditor'));
    expect([...document.querySelectorAll('.site-pages .site-row b')].map((b) => b.textContent)).toEqual(['Home', 'About', 'Projects', 'Writing']);
    expect(S.site().look.name).toBe('Sam');
    expect(text('.site-pages')).toContain('Empty, not published');
    // The tab bar keeps Me lit.
    expect($('#tabs [aria-current="page"]')?.dataset.v).toBe('progress');
    // Plain words: no long dashes anywhere on the screen.
    expect($('#app')!.textContent).not.toMatch(/[\u2013\u2014]/);
  });

  it('shows a live preview while they type, escaped, and saves when they finish', async () => {
    const { S } = await boot('website');
    click('[data-act="site-start"]');
    await until(() => !!$('#siteEditor'));
    type('#siteEditor textarea', 'Hi, I **build** things.\n<script>alert(1)</script>', false);
    expect($('.site-preview')!.innerHTML).toContain('<strong>build</strong>');
    expect($('.site-preview script')).toBeNull();
    expect(text('.site-preview')).toContain('<script>alert(1)</script>');
    expect(S.site().pages.home.body).toBe(''); // not saved yet
    $('#siteEditor textarea')!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(S.site().pages.home.body).toBe('Hi, I **build** things.\n<script>alert(1)</script>');
    expect(text('.site-pages')).toContain('Published');
  });

  it('adds a page, renames it, makes it a draft and deletes it', async () => {
    const { S } = await boot('website');
    click('[data-act="site-start"]');
    await until(() => !!$('#siteEditor'));
    click('[data-act="site-add-page"]');
    await until(() => text('#siteEditor').includes('New page'));
    type('#siteEditor [data-site-field="title"]', 'Talks & Slides');
    const id = $('#siteEditor')!.dataset.id!;
    expect(S.site().pages[id]).toMatchObject({ title: 'Talks & Slides', slug: 'talks-slides' });
    const draft = $('#siteEditor [data-site-field="draft"]') as HTMLInputElement;
    draft.checked = true;
    draft.dispatchEvent(new Event('change', { bubbles: true }));
    expect(S.site().pages[id].draft).toBe(true);
    click('#siteEditor [data-act="site-delete"]');
    await until(() => !$('#siteEditor'));
    expect(S.site().pages[id].gone).toBe(true);
  });

  it('changes the look', async () => {
    const { S } = await boot('website');
    click('[data-act="site-start"]');
    await until(() => !!$('.site-look'));
    type('[data-site-look="line"]', 'I make small tools.');
    const night = $('[data-site-look="theme"][value="night"]') as HTMLInputElement;
    night.checked = true;
    night.dispatchEvent(new Event('change', { bubbles: true }));
    expect(S.site().look).toMatchObject({ line: 'I make small tools.', theme: 'night' });
    expect($('.site-preview')!.classList.contains('theme-night')).toBe(true);
  });

  it('asks the coach\'s AI for ideas only when it is on, and only starts a draft when they pick one', async () => {
    const { S } = await boot('website');
    click('[data-act="site-start"]');
    await until(() => !!$('[data-act="site-ideas"]'));
    click('[data-act="site-ideas"]');
    await until(() => text('.site-ideas-panel').includes('Turn on the AI coach'));
    expect(h.ai.ideas).not.toHaveBeenCalled();
    h.ai.ready = true;
    h.ai.ideas.mockResolvedValue({ ideas: [{ title: 'What 30 days of running taught me', why: 'You ran most mornings this month.' }, { title: 'Building my budget app', why: 'Your project on GitHub.' }], tier: 2 });
    const before = JSON.stringify(S.site());
    click('[data-act="site-ideas"]');
    await until(() => !!$('[data-act="site-idea"]'));
    expect(JSON.stringify(S.site())).toBe(before); // nothing written by itself
    expect(text('.site-ideas')).toContain('What 30 days of running taught me');
    click('[data-act="site-idea"][data-i="0"]');
    await until(() => !!$('#siteEditor'));
    const post = SITEposts(S);
    expect(post).toMatchObject({ kind: 'post', title: 'What 30 days of running taught me', body: '', draft: true });
    expect(($('#siteEditor textarea') as HTMLTextAreaElement).placeholder).toBe('You ran most mornings this month.');
  });

  it('publishes the built files and keeps the address', async () => {
    h.token = `github_pat_${'Zx9y'.repeat(20)}`;
    h.publish.mockResolvedValue({ url: 'https://sam.github.io/', changed: true });
    const { S } = await boot('website');
    click('[data-act="site-start"]');
    await until(() => !!$('[data-act="site-publish"]'));
    let asked = '';
    globalThis.confirm = (q?: string) => ((asked = q || ''), true);
    click('[data-act="site-publish"]');
    await until(() => h.publish.mock.calls.length > 0 && !!$('#sitePublish a'));
    expect(asked).toContain('will be public');
    const files = h.publish.mock.calls[0][0] as { path: string; content: string }[];
    expect(files.map((f) => f.path)).toContain('index.html');
    expect(files.some((f) => f.path === 'count.js')).toBe(false);
    expect(S.site().address.url).toBe('https://sam.github.io/');
    expect(text('#sitePublish')).toContain('https://sam.github.io/');
  });

  it('shows the connect form with how to make the key when not connected', async () => {
    await boot('website');
    click('[data-act="site-start"]');
    await until(() => !!$('[data-site-form="connect"]'));
    expect(text('#sitePublish')).toContain('Contents and Pages, Read and write');
    expect(text('#sitePublish')).toContain('stays on this device');
  });
});

describe('Visitors', { timeout: 20000 }, () => {
  it('stays hidden until the counter has an address', async () => {
    await boot('website');
    click('[data-act="site-start"]');
    await until(() => !!$('.site-look'));
    expect($('#siteVisits')).toBeNull();
  });

  it('turns on with a site id, keeps the read key on this device, and shows the counts', async () => {
    h.server = 'https://arise-visits.example.workers.dev';
    const KEY = 'k'.repeat(43);
    const SITE_ID = 's'.repeat(22);
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      if (url.endsWith('/v1/sites')) return new Response(JSON.stringify({ site: SITE_ID, key: KEY }), { status: 200 });
      if (url.endsWith('/v1/read')) return new Response(JSON.stringify({ counts: [{ day: '2026-11-24', page: 'index', n: 3 }, { day: '2026-11-25', page: 'about', n: 2 }] }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    const { S } = await boot('website');
    click('[data-act="site-start"]');
    await until(() => !!$('#siteVisits'));
    expect(text('#siteVisits')).toContain('Less private');
    expect(text('#siteVisits')).toContain('Its server does see that a page was opened');
    const box = $('[data-site-count]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => text('#siteVisits').includes('5 visits in the last 30 days'));
    expect(S.site().count.site).toBe(SITE_ID);
    expect(JSON.stringify(S.state)).not.toContain(KEY);
    expect(JSON.stringify(S.exportData())).not.toContain(KEY);
    expect(localStorage.getItem('arise-site-visits')).toContain(KEY);
    expect(calls.every((c) => c.url.startsWith(h.server))).toBe(true);
    expect($('.site-chart')!.querySelectorAll('rect').length).toBe(30);
    // Off: the counter forgets the site, and the key goes.
    box.checked = false;
    const off = $('[data-site-count]') as HTMLInputElement;
    off.checked = false;
    off.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => S.site().count.site === '');
    expect(localStorage.getItem('arise-site-visits')).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/v1/forget') && c.body.includes(KEY))).toBe(true);
  });
});

function SITEposts(S: typeof import('./store')) {
  return Object.values(S.site().pages).find((p) => p.kind === 'post');
}
