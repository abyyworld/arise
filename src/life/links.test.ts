// @vitest-environment jsdom
// Your links: finding the links in notes, the journal and imported notes (and pages saved on
// purpose), a page made into plain readable text on the device, and "Keep a copy" through the
// helper, which is never asked when it isn't set up.

import { describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';
import type { LifeStore } from './store-port';
import * as LK from './links';
import { parts, readable } from './readable';
import { cleanLifeEvent } from '../lib/validate';

const T = (d: number, h = 12) => new Date(2026, 10, d, h).getTime();
const note = (id: string, at: number, detail: string, extra: Partial<LifeEvent> = {}): LifeEvent => ({ id, source: 'manual', kind: 'note', at, title: detail.split('\n')[0].slice(0, 80), detail, tier: 2, ...extra });

describe('finding links', () => {
  it('finds http and https addresses in text, without the punctuation around them', () => {
    const text = 'Read https://example.com/a. Also (see https://en.wikipedia.org/wiki/Foo_(bar)) and [docs](https://docs.example.org/x?y=1), "https://q.example.com/z", ftp://nope.example.com, javascript:alert(1), https://localhost-ish and https://example.com/a again.';
    expect(LK.findUrls(text)).toEqual(['https://example.com/a', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'https://docs.example.org/x?y=1', 'https://q.example.com/z']);
    expect(LK.cleanLink('https://me:secret@example.com/')).toBeNull();
    expect(LK.cleanLink('https://example.com/end!?')).toBe('https://example.com/end');
    expect(LK.findUrls('')).toEqual([]);
  });

  it('gathers them from notes, the journal and imported notes, newest first, with where and when', () => {
    const events: LifeEvent[] = [
      note('manual:n1', T(10), 'Recipe https://food.example.com/pie'),
      note('manual:n2', T(12), 'Again: https://food.example.com/pie/ and https://news.example.com/1'),
      { id: 'arise:journal:2026-11-11', source: 'arise', kind: 'note', at: T(11, 21), title: 'Journal: good day', detail: 'Found https://music.example.com/song', tier: 1 },
      { id: 'other:note:abc', source: 'other', kind: 'note', at: T(9), title: 'Reading list', detail: 'https://books.example.com/x', tier: 3, meta: { app: 'Obsidian' } },
      { id: 'browser:s1', source: 'browser', kind: 'note', at: T(13), title: 'A good story', url: 'https://story.example.com/a?id=7', detail: '"picked words"', tier: 3, meta: { saved: true, browser: 'Chrome on macOS', site: 'story.example.com' } },
      // Not the person's own writing: a page visited, a message, a quest.
      { id: 'browser:v1', source: 'browser', kind: 'visit', at: T(13), title: 'Visit', url: 'https://visited.example.com/', tier: 3 },
      { id: 'whatsapp:m1', source: 'whatsapp', kind: 'message', at: T(13), title: 'Chat', detail: 'https://chat.example.com/', tier: 3 },
      { id: 'arise:quest:1', source: 'arise', kind: 'note', at: T(13), title: 'https://quest.example.com/', tier: 1 },
    ];
    const items = LK.gatherLinks(events);
    expect(items.map((i) => i.url)).toEqual(['https://story.example.com/a?id=7', 'https://food.example.com/pie', 'https://news.example.com/1', 'https://music.example.com/song', 'https://books.example.com/x']);
    const pie = items[1];
    expect(pie.from.map((m) => [m.id, m.where])).toEqual([
      ['manual:n2', 'Your notes'],
      ['manual:n1', 'Your notes'],
    ]);
    expect(pie.title).toBe('food.example.com/pie');
    expect(items[0]).toMatchObject({ saved: true, title: 'A good story', note: '"picked words"', from: [{ where: 'Saved from Chrome on macOS' }] });
    expect(items.find((i) => i.site === 'music.example.com')!.from[0].where).toBe('Your journal');
    expect(items.find((i) => i.site === 'books.example.com')!.from[0].where).toBe('Obsidian');
  });

  it('saves a pasted link as a note the life log takes, and searches by any of its words', () => {
    const e = LK.savedLink({ url: '  example.com/guide  ', note: 'For the trip', at: T(14) })!;
    expect(cleanLifeEvent(e)).toEqual(e);
    expect(e).toMatchObject({ source: 'manual', kind: 'note', url: 'https://example.com/guide', detail: 'For the trip', meta: { saved: true } });
    expect(LK.savedLink({ url: 'not a link', at: T(14) })).toBeNull();
    expect(LK.savedLink({ url: 'javascript:alert(1)', at: T(14) })).toBeNull();
    const [item] = LK.gatherLinks([e]);
    expect(item).toMatchObject({ saved: true, note: 'For the trip', from: [{ where: 'Saved in Arise' }] });
    expect(LK.matches(item, 'trip guide')).toBe(true);
    expect(LK.matches(item, 'trip beach')).toBe(false);
    expect(LK.matches(item, '')).toBe(true);
  });
});

describe('a page as plain text', () => {
  const PAGE = `<!doctype html><html><head><title>Page title</title><meta property="og:title" content="How to bake a pie"><style>p{color:red}</style><script>alert('x')</script></head>
    <body><header class="site-header"><a href="/">Home</a> <a href="/about">About</a></header>
    <nav><ul><li>Menu one</li><li>Menu two</li></ul></nav>
    <div class="cookie-banner">We use cookies</div>
    <main><article><h1>How to bake a pie</h1><p>First, make the dough. It takes <b>ten</b> minutes.</p>
    <ul><li>Flour</li><li>Butter</li></ul><img src="x.png" alt="A pie on a table"><p>Then bake it.<br>Enjoy.</p>
    <form><input value="Search"></form><aside>Related posts</aside><div class="share-buttons">Share this</div></article></main>
    <footer>Copyright</footer><noscript>Turn on scripts</noscript></body></html>`;

  it('keeps the words of the page and leaves out scripts, styles, menus and the rest', () => {
    const r = readable(PAGE);
    expect(r.title).toBe('How to bake a pie');
    expect(r.text).toBe('First, make the dough. It takes ten minutes.\n\n- Flour\n\n- Butter\n\nA pie on a table\n\nThen bake it.\nEnjoy.');
    for (const gone of ['alert', 'color:red', 'Menu one', 'Home', 'cookies', 'Search', 'Related', 'Share this', 'Copyright', 'Turn on scripts']) expect(r.text).not.toContain(gone);
  });

  it('reads the body when there is no article, and never a page that is all around', () => {
    expect(readable('<html><body class="page has-sidebar"><div id="content" class="with-sidebar"><p>Main words here, quite a few of them.</p></div></body></html>').text).toBe('Main words here, quite a few of them.');
    expect(readable('<title>T</title>')).toEqual({ title: 'T', text: '' });
    expect(readable('')).toEqual({ title: '', text: '' });
  });

  it('cuts long text into parts at a paragraph, and says when there was more', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${'word '.repeat(30)}`.trim()).join('\n\n');
    const r = parts(text, 400, 3);
    expect(r.parts.length).toBe(3);
    expect(r.cut).toBe(true);
    for (const p of r.parts) {
      expect(p.length).toBeLessThanOrEqual(400);
      expect(p.startsWith('Paragraph')).toBe(true);
    }
    expect(parts('short', 400, 3)).toEqual({ parts: ['short'], cut: false });
  });
});

describe('keeping a copy', () => {
  function store() {
    const events = new Map<string, LifeEvent>();
    const s: LifeStore & { events: Map<string, LifeEvent> } = {
      events,
      addEvents: async (list) => list.filter((e) => !events.has(e.id) && events.set(e.id, e)).length,
      upsertEvents: async (list) => (list.forEach((e) => events.set(e.id, e)), list.length),
      removeIds: async (ids) => ids.filter((id) => events.delete(id)).length,
    };
    return s;
  }
  const page = (html: string, url = 'https://news.example.com/a') => vi.fn(async () => new Response(JSON.stringify({ url, html }), { status: 200, headers: { 'content-type': 'application/json' } }));

  it('fetches nothing without the helper, and says it needs it', async () => {
    const fetch = vi.fn();
    const r = await LK.keepCopy('https://news.example.com/a', { server: '', fetch: fetch as unknown as typeof globalThis.fetch, store: store() });
    expect(r).toEqual({ ok: false, code: 'no-helper', error: LK.NO_HELPER });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks the helper for that one address, and keeps the text in the life log next to the link', async () => {
    const s = store();
    const fetch = page('<title>News</title><article><p>Big news today.</p></article>', 'https://news.example.com/a/');
    const r = await LK.keepCopy('https://news.example.com/a', { server: 'https://helper.example.dev/', fetch: fetch as unknown as typeof globalThis.fetch, store: s, now: T(15) });
    expect(r).toEqual({ ok: true, title: 'News', parts: 1, cut: false });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://helper.example.dev/page');
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://news.example.com/a' });
    expect(init.credentials).toBe('omit');
    const kept = [...s.events.values()];
    expect(kept).toHaveLength(1);
    expect(cleanLifeEvent(kept[0])).toEqual(kept[0]);
    expect(kept[0]).toMatchObject({ source: 'manual', kind: 'note', at: T(15), title: 'Kept a copy: News', detail: 'Big news today.', url: 'https://news.example.com/a', tier: 3, meta: { copyOf: 'https://news.example.com/a', from: 'https://news.example.com/a/' } });
    // Matched to its link, and found by its words.
    const [item] = LK.gatherLinks([note('manual:n1', T(10), 'https://news.example.com/a'), ...kept]);
    expect(item.copy).toMatchObject({ title: 'News', text: 'Big news today.', ids: [kept[0].id] });
    expect(LK.matches(item, 'big news')).toBe(true);
    // A kept copy isn't a note of the person's own: its links aren't theirs.
    expect(LK.isNote(kept[0])).toBe(false);
  });

  it('keeps a long page in parts, and a new copy takes the old one\'s place', async () => {
    const s = store();
    const long = `<article>${Array.from({ length: 80 }, (_, i) => `<p>Part ${i} ${'text '.repeat(100)}</p>`).join('')}</article>`;
    const deps = { server: 'https://helper.example.dev', store: s, now: T(15) };
    const r = await LK.keepCopy('https://news.example.com/a', { ...deps, fetch: page(long) as unknown as typeof globalThis.fetch });
    expect(r).toMatchObject({ ok: true, parts: LK.COPY_PARTS, cut: true });
    expect(s.events.size).toBe(LK.COPY_PARTS);
    for (const e of s.events.values()) expect(e.detail!.length).toBeLessThanOrEqual(LK.COPY_SIZE);
    await LK.keepCopy('https://news.example.com/a', { ...deps, fetch: page('<p>Shorter now.</p>') as unknown as typeof globalThis.fetch });
    expect([...s.events.values()].map((e) => e.detail)).toEqual(['Shorter now.']);
  });

  it("says plainly when the page couldn't be kept", async () => {
    const run = (res: Response) => LK.keepCopy('https://news.example.com/a', { server: 'https://helper.example.dev', fetch: (async () => res) as unknown as typeof globalThis.fetch, store: store() });
    expect(await run(new Response('{}', { status: 404 }))).toMatchObject({ ok: false, error: "The site says that page isn't there." });
    expect(await run(new Response('{}', { status: 415 }))).toMatchObject({ ok: false, code: 'failed' });
    expect(await run(new Response(JSON.stringify({ html: '<script>only()</script>' })))).toMatchObject({ ok: false, code: 'empty' });
    const thrown = await LK.keepCopy('https://news.example.com/a', { server: 'https://helper.example.dev', fetch: (async () => Promise.reject(new Error('offline'))) as unknown as typeof globalThis.fetch, store: store() });
    expect(thrown).toMatchObject({ ok: false, code: 'failed' });
    expect(await LK.keepCopy('file:///etc/passwd', { server: 'https://helper.example.dev', fetch: vi.fn() as unknown as typeof globalThis.fetch })).toMatchObject({ ok: false, code: 'bad' });
  });
});
