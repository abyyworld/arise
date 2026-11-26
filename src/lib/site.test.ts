// Your website: light Markdown to HTML (with everything they type escaped), the pages kept and
// merged per page, and the files Publish writes.

import { describe, expect, it } from 'vitest';
import * as SITE from './site';

const T = Date.UTC(2026, 10, 20, 12);

describe('Markdown to HTML', () => {
  it('turns light Markdown into HTML', () => {
    const html = SITE.toHTML(['# Big', '## Smaller', 'A **bold** and *quiet* line,', 'and the next one.', '', '- one', '- two', '', '1. first', '2. second', '', '> a quote', '', '---', '', '```', 'let x = 1 < 2;', '```', 'See [my code](https://github.com/sam) and `npm ci`.'].join('\n'));
    expect(html).toBe(
      [
        '<h2>Big</h2>',
        '<h3>Smaller</h3>',
        '<p>A <strong>bold</strong> and <em>quiet</em> line,<br>\nand the next one.</p>',
        '<ul><li>one</li><li>two</li></ul>',
        '<ol><li>first</li><li>second</li></ol>',
        '<blockquote><p>a quote</p></blockquote>',
        '<hr>',
        '<pre><code>let x = 1 &lt; 2;</code></pre>',
        '<p>See <a href="https://github.com/sam">my code</a> and <code>npm ci</code>.</p>',
      ].join('\n'),
    );
  });

  it('escapes everything they type, so none of it becomes HTML of its own', () => {
    const html = SITE.toHTML('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n"quotes" & \'apostrophes\'');
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;quotes&quot; &amp; &#39;apostrophes&#39;');
    expect(SITE.inline('`<b>`')).toBe('<code>&lt;b&gt;</code>');
  });

  it('only links to the web, an email address or another page', () => {
    expect(SITE.inline('[a](javascript:alert(1))')).not.toContain('href');
    expect(SITE.inline('[a](JavaScript:alert)')).toBe('a');
    expect(SITE.inline('[a](data:text/html,hi)')).toBe('a');
    expect(SITE.inline('[a](//evil.example/x)')).toBe('a');
    expect(SITE.inline('[a](vbscript:x)')).toBe('a');
    expect(SITE.inline('[mail](mailto:sam@example.com)')).toBe('<a href="mailto:sam@example.com">mail</a>');
    expect(SITE.inline('[about](about.html)')).toBe('<a href="about.html">about</a>');
    // Quotes can't break out of the address, and emphasis never reaches it.
    expect(SITE.inline('[x](https://a.example/"onmouseover=alert(1))')).not.toMatch(/href="[^"]*"on/);
    expect(SITE.inline('[x](https://a.example/_a_b_/*c*)')).toBe('<a href="https://a.example/_a_b_/*c*">x</a>');
    expect(SITE.inline('[x](https://a.example/?a=1&b=2)')).toBe('<a href="https://a.example/?a=1&amp;b=2">x</a>');
  });

  it('shows a picture only from an https address, with its words', () => {
    expect(SITE.toHTML('![A bridge](https://img.example/b.jpg)')).toBe('<figure><img src="https://img.example/b.jpg" alt="A bridge" loading="lazy"><figcaption>A bridge</figcaption></figure>');
    expect(SITE.toHTML('![x" onerror="alert(1)](http://img.example/b.jpg)')).not.toContain('<img');
    expect(SITE.toHTML('![x](javascript:alert(1))')).not.toContain('<img');
  });
});

describe('the pages, kept and merged', () => {
  const started = () => SITE.startSite(SITE.blankSite(), 'Sam Lee', T);

  it('starts with Home, About, Projects and Writing, all empty', () => {
    const s = started();
    expect(SITE.menuPages(s, true).map((p) => p.id)).toEqual(['home', 'about', 'projects', 'writing']);
    expect(s.look).toEqual({ name: 'Sam Lee', line: '', theme: 'paper', at: T });
    // Only Home goes up while the rest are empty.
    expect(SITE.menuPages(s).map((p) => p.id)).toEqual(['home']);
  });

  it('cleans what comes from storage or sync: bad pages, odd names and anything unknown go', () => {
    const s = SITE.cleanSite(
      {
        look: { name: 'Sam\u0000 Lee', line: 'x'.repeat(500), theme: 'neon', at: T, extra: 1 },
        address: { url: 'javascript:alert(1)', at: T },
        count: { site: '<bad>', at: T },
        pages: {
          home: { kind: 'home', title: 'Whatever', body: 'Hi\r\nthere\u0007', order: 0, at: T },
          about: { kind: 'page', title: 'Not really about', body: '', at: T },
          p1: { kind: 'page', title: 'My Café Notes!', slug: '../../etc', body: 'b', at: T },
          p2: { kind: 'post', title: 'Post', body: 'p', at: T, date: 'not a date' },
          '__proto__': { kind: 'page', title: 'x', at: T },
          p3: { kind: 'page', title: 'No time' },
          p4: { kind: 'page', title: 'Index', slug: 'index', body: 'b', at: T },
        },
      },
      T,
    );
    expect(s.look).toEqual({ name: 'Sam Lee', line: 'x'.repeat(200), theme: 'paper', at: T });
    expect(s.address.url).toBe('');
    expect(s.count.site).toBe('');
    expect(Object.keys(s.pages).sort()).toEqual(['home', 'p1', 'p2', 'p4']);
    expect(s.pages.home).toMatchObject({ title: 'Home', slug: 'index', body: 'Hi\nthere' });
    expect(s.pages.p1.slug).toBe('my-cafe-notes');
    expect(s.pages.p2.date).toBe('2026-11-20');
    expect(s.pages.p4.slug).toBe('index-page');
  });

  it('merges per page, the later change winning, and keeps a deleted page deleted', () => {
    const base = started();
    const added = SITE.addPage(base, 'page', 'Talks', 'First', T + 10)!;
    const phone = SITE.editPage(added.site, 'about', { body: 'From the phone' }, T + 100);
    let laptop = SITE.editPage(added.site, 'projects', { body: 'From the laptop' }, T + 200);
    laptop = SITE.deletePage(laptop, added.id, T + 300);
    laptop = SITE.setLook(laptop, { theme: 'moss' }, T + 50);
    const a = SITE.mergeSite(phone, laptop, T + 400);
    const b = SITE.mergeSite(laptop, phone, T + 400);
    expect(a).toEqual(b);
    expect(a.pages.about.body).toBe('From the phone');
    expect(a.pages.projects.body).toBe('From the laptop');
    expect(a.pages[added.id].gone).toBe(true);
    expect(a.look.theme).toBe('moss');
    // The same page changed on both: the later one.
    const x = SITE.editPage(base, 'home', { body: 'older' }, T + 10);
    const y = SITE.editPage(base, 'home', { body: 'newer' }, T + 20);
    expect(SITE.mergeSite(y, x, T + 30).pages.home.body).toBe('newer');
    // A tombstone goes after 180 days.
    expect(SITE.cleanSite(a, T + 181 * 86_400_000).pages[added.id]).toBeUndefined();
  });

  it("can't delete the built-in pages, keeps names unique and moves pages in the menu", () => {
    let s = started();
    expect(SITE.deletePage(s, 'about', T)).toBe(s);
    const one = SITE.addPage(s, 'page', 'Talks', 'a', T + 1)!;
    const two = SITE.addPage(one.site, 'page', 'Talks', 'b', T + 2)!;
    s = two.site;
    expect([s.pages[one.id].slug, s.pages[two.id].slug]).toEqual(['talks', 'talks-2']);
    // A post may share a page's name: posts have their own folder.
    const post = SITE.addPage(s, 'post', 'Talks', 'c', T + 3)!;
    expect(post.site.pages[post.id]).toMatchObject({ slug: 'talks', draft: true, date: '2026-11-20' });
    s = SITE.movePage(post.site, two.id, -1, T + 4);
    expect(SITE.menuPages(s, true).map((p) => p.id)).toEqual(['home', 'about', 'projects', 'writing', two.id, one.id]);
  });
});

describe('the files Publish writes', () => {
  function site() {
    let s = SITE.startSite(SITE.blankSite(), 'Sam <Lee>', T);
    s = SITE.setLook(s, { line: 'I make small tools & write about them.', theme: 'night' }, T);
    s = SITE.editPage(s, 'home', { body: 'Hello, I am **Sam**.' }, T);
    s = SITE.editPage(s, 'about', { body: 'About me.' }, T);
    const draft = SITE.addPage(s, 'page', 'Secret plans', 'Not yet', T)!;
    s = SITE.editPage(draft.site, draft.id, { draft: true }, T);
    const post = SITE.addPage(s, 'post', 'My first post', 'It *works*.', T)!;
    s = SITE.editPage(post.site, post.id, { draft: false, date: '2026-11-19' }, T);
    return s;
  }

  it('writes one HTML file per published page and post, the style sheet and the list of files', () => {
    const files = SITE.build(site(), { year: 2026 });
    expect(files.map((f) => f.path).sort()).toEqual(['.nojekyll', '404.html', 'about.html', 'arise-site.json', 'index.html', 'style.css', 'writing.html', 'writing/my-first-post.html']);
    const get = (p: string) => files.find((f) => f.path === p)!.content;
    // Projects is empty and the draft is a draft: neither goes up, nor are they in the menu.
    expect(get('index.html')).not.toContain('projects.html');
    expect(files.some((f) => f.content.includes('Secret plans') || f.content.includes('Not yet'))).toBe(false);
    expect(get('index.html')).toContain('<nav><a href="about.html">About</a><a href="writing.html">Writing</a></nav>');
    expect(get('index.html')).toContain('<h1>Sam &lt;Lee&gt;</h1>');
    expect(get('index.html')).toContain('<p class="line">I make small tools &amp; write about them.</p>');
    expect(get('index.html')).toContain('<p>Hello, I am <strong>Sam</strong>.</p>');
    expect(get('index.html')).toContain('&copy; 2026 Sam &lt;Lee&gt;');
    expect(get('writing.html')).toContain('<li><a href="writing/my-first-post.html">My first post</a> <time datetime="2026-11-19">19 November 2026</time></li>');
    // A post is one folder down: its links go up one.
    const post = get('writing/my-first-post.html');
    expect(post).toContain('<link rel="stylesheet" href="../style.css">');
    expect(post).toContain('<a href="../about.html">About</a>');
    expect(post).toContain('<p>It <em>works</em>.</p>');
    expect(post).toContain('<title>My first post | Sam &lt;Lee&gt;</title>');
    expect(get('style.css')).toContain('--bg: #15171c');
    expect(JSON.parse(get('arise-site.json'))).toEqual({ by: 'Arise', files: ['.nojekyll', '404.html', 'about.html', 'arise-site.json', 'index.html', 'style.css', 'writing.html', 'writing/my-first-post.html'] });
  });

  it('lets nothing else load or run, and has no counter unless it is on', () => {
    const files = SITE.build(site(), { year: 2026 });
    for (const f of files.filter((x) => x.path.endsWith('.html'))) {
      expect(f.content).toContain(`content="default-src &#39;none&#39;; style-src &#39;self&#39;; img-src https: &#39;self&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"`);
      expect(f.content).not.toContain('<script');
    }
    expect(files.some((f) => f.path === 'count.js')).toBe(false);
  });

  it('with the counter on: a small script that sends the site id and page name, and nothing else', () => {
    const id = 'abcdefghijklmnopqrstuv';
    const files = SITE.build(site(), { count: { server: 'https://arise-visits.example.workers.dev', site: id }, year: 2026 });
    const get = (p: string) => files.find((f) => f.path === p)!.content;
    expect(get('index.html')).toContain('<script src="count.js" data-page="index"></script>');
    expect(get('writing/my-first-post.html')).toContain('<script src="../count.js" data-page="writing/my-first-post"></script>');
    expect(get('index.html')).toContain('connect-src https://arise-visits.example.workers.dev;');
    const js = get('count.js');
    expect(js).toContain('"https://arise-visits.example.workers.dev/v1/hit"');
    expect(js).toContain(`s: "${id}", p: page`);
    expect(js).toContain("credentials: 'omit'");
    expect(js).toContain("referrerPolicy: 'no-referrer'");
    expect(js).toContain('globalPrivacyControl');
    expect(js).not.toMatch(/localStorage|document\.cookie|userAgent|screen\.|location\./);
    // Not with a bad id or an address that isn't https.
    expect(SITE.build(site(), { count: { server: 'http://x.example', site: id } }).some((f) => f.path === 'count.js')).toBe(false);
    expect(SITE.build(site(), { count: { server: 'https://x.example', site: 'bad' } }).some((f) => f.path === 'count.js')).toBe(false);
  });
});
