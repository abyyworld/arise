// Your website: a few pages the Player writes (Home, About, Projects, Writing, their own pages and
// posts), in plain text with light Markdown, and the look they pick. Kept in the main state as
// `site` and synced end-to-end encrypted with the rest. Publishing (src/site-publish.ts) writes
// the static files `build` makes here to a GitHub Pages site in their own GitHub account.
//
// Like names for places (lib/place-names.ts): each page keeps the time it last changed (`at`), a
// deleted one stays as a tombstone (`gone`) for a while, and two copies merge per page, the later
// change winning. The look, the address and the visit counter's public id each merge the same way.
//
// Pure: no store, no network. Nothing of the Player's other data goes into the files: only what
// they wrote here.

export type Kind = 'home' | 'about' | 'projects' | 'writing' | 'page' | 'post';
export type Theme = 'paper' | 'night' | 'moss';

export interface SitePage {
  id: string;
  kind: Kind;
  title: string;
  slug: string; // the file's name: about → about.html, a post → writing/<slug>.html
  body: string; // plain text with light Markdown
  order: number;
  at: number; // when it last changed
  date?: string; // a post's date, YYYY-MM-DD
  draft?: true; // kept here, not published
  gone?: true;
}
export interface SiteLook {
  name: string; // the site's name, at the top of every page
  line: string; // one line about them, under the name on Home
  theme: Theme;
  at: number;
}
export interface Site {
  look: SiteLook;
  pages: Record<string, SitePage>;
  address: { url: string; at: number }; // where it was last published (public)
  count: { site: string; at: number }; // the visit counter's public site id ('' when off)
}

export const THEMES: Record<Theme, { name: string; about: string }> = {
  paper: { name: 'Paper', about: 'Warm and light, with serif headings.' },
  night: { name: 'Night', about: 'Dark and quiet, easy on the eyes.' },
  moss: { name: 'Moss', about: 'Soft green and grey, plain type.' },
};
export const isTheme = (v: unknown): v is Theme => typeof v === 'string' && Object.hasOwn(THEMES, v);

// The four pages every site starts with, in this order.
export const BUILT_IN: { id: Kind; title: string; slug: string }[] = [
  { id: 'home', title: 'Home', slug: 'index' },
  { id: 'about', title: 'About', slug: 'about' },
  { id: 'projects', title: 'Projects', slug: 'projects' },
  { id: 'writing', title: 'Writing', slug: 'writing' },
];
const KINDS: Kind[] = ['home', 'about', 'projects', 'writing', 'page', 'post'];
const isBuiltIn = (k: Kind) => k !== 'page' && k !== 'post';

export const MAX_PAGES = 80; // live pages and posts
export const BODY_MAX = 50_000;
export const TITLE_MAX = 120;
export const NAME_MAX = 80;
export const LINE_MAX = 200;
const KEEP_GONE = 180 * 86_400_000;
const ID = /^[a-z0-9-]{1,40}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SITE_ID = /^[A-Za-z0-9_-]{16,64}$/;
// Names a page of their own can't take: Arise's own files, and the Writing folder.
const RESERVED = new Set(['index', 'about', 'projects', 'writing', '404', 'style', 'count', 'arise-site']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
// Text keeps its lines and tabs; other control characters go.
const multiLine = (v: unknown, max: number) =>
  typeof v === 'string'
    ? v
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '')
        .slice(0, max)
    : '';

// A page's file name from its title: small letters, digits and hyphens.
export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'page';
}
const ownSlug = (v: unknown, title: string) => {
  const s = typeof v === 'string' && SLUG.test(v) && v.length <= 60 ? v : slugify(title);
  return RESERVED.has(s) ? `${s}-page` : s;
};

export function blankSite(): Site {
  return { look: { name: '', line: '', theme: 'paper', at: 0 }, pages: {}, address: { url: '', at: 0 }, count: { site: '', at: 0 } };
}

export function cleanPage(id: string, raw: unknown): SitePage | null {
  if (!ID.test(id) || BAD_KEYS.has(id) || !raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isTime(r.at)) return null;
  const kind = KINDS.includes(r.kind as Kind) ? (r.kind as Kind) : null;
  if (!kind) return null;
  // The built-in pages keep their own ids and names.
  const fixed = BUILT_IN.find((b) => b.id === kind);
  if (fixed && id !== fixed.id) return null;
  if (!fixed && BUILT_IN.some((b) => b.id === id)) return null;
  const order = typeof r.order === 'number' && Number.isFinite(r.order) ? Math.max(0, Math.min(10_000, Math.round(r.order))) : 0;
  if (r.gone === true) return { id, kind, title: '', slug: fixed?.slug || 'page', body: '', order, at: r.at, gone: true };
  const title = kind === 'home' ? 'Home' : oneLine(r.title, TITLE_MAX) || fixed?.title || 'Untitled';
  const page: SitePage = { id, kind, title, slug: fixed ? fixed.slug : ownSlug(r.slug, title), body: multiLine(r.body, BODY_MAX), order, at: r.at };
  if (kind === 'post') page.date = isDay(r.date) ? r.date : new Date(r.at).toISOString().slice(0, 10);
  if (r.draft === true) page.draft = true;
  return page;
}

export function cleanSite(raw: unknown, now = Date.now()): Site {
  const out = blankSite();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const look = (r.look && typeof r.look === 'object' ? r.look : {}) as Record<string, unknown>;
  if (isTime(look.at)) out.look = { name: oneLine(look.name, NAME_MAX), line: oneLine(look.line, LINE_MAX), theme: isTheme(look.theme) ? look.theme : 'paper', at: look.at };
  const address = (r.address && typeof r.address === 'object' ? r.address : {}) as Record<string, unknown>;
  if (isTime(address.at)) out.address = { url: publicAddress(address.url), at: address.at };
  const count = (r.count && typeof r.count === 'object' ? r.count : {}) as Record<string, unknown>;
  if (isTime(count.at)) out.count = { site: typeof count.site === 'string' && SITE_ID.test(count.site) ? count.site : '', at: count.at };
  const pages: SitePage[] = [];
  if (r.pages && typeof r.pages === 'object' && !Array.isArray(r.pages)) {
    for (const [id, v] of Object.entries(r.pages as Record<string, unknown>)) {
      const p = cleanPage(id, v);
      if (!p || (p.gone && now - p.at > KEEP_GONE)) continue;
      pages.push(p);
    }
  }
  const newest = (list: SitePage[], most: number) => list.sort((a, b) => b.at - a.at).slice(0, most);
  for (const p of [...newest(pages.filter((p) => !p.gone), MAX_PAGES), ...newest(pages.filter((p) => p.gone), MAX_PAGES)]) out.pages[p.id] = p;
  return out;
}

// Only a GitHub Pages address (or another https one GitHub gave for a custom domain).
function publicAddress(v: unknown): string {
  if (typeof v !== 'string' || v.length > 300) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}

const later = <T extends { at: number }>(a: T, b: T) => (b.at > a.at ? b : a);
export function mergeSite(a: Site, b: Site, now = Date.now()): Site {
  const x = a || blankSite();
  const y = b || blankSite();
  const pages: Record<string, SitePage> = { ...x.pages };
  for (const [id, p] of Object.entries(y.pages || {})) if (!pages[id] || p.at > pages[id].at) pages[id] = p;
  return cleanSite({ look: later(x.look, y.look), address: later(x.address, y.address), count: later(x.count, y.count), pages }, now);
}

// ---------- changes (each a new copy)

const stamp = (prev: number | undefined, now: number) => Math.max(now, (prev || 0) + 1);

// The four built-in pages, empty, where they aren't there yet.
export function startSite(site: Site, name = '', now = Date.now()): Site {
  const pages = { ...site.pages };
  BUILT_IN.forEach((b, i) => {
    if (!pages[b.id] || pages[b.id].gone) pages[b.id] = { id: b.id, kind: b.id, title: b.title, slug: b.slug, body: '', order: i, at: stamp(pages[b.id]?.at, now) };
  });
  const look = site.look.at ? site.look : { name: oneLine(name, NAME_MAX), line: '', theme: 'paper' as Theme, at: now };
  return cleanSite({ ...site, look, pages }, now);
}
export const hasSite = (site: Site) => livePages(site).length > 0;

export function setLook(site: Site, patch: Partial<Pick<SiteLook, 'name' | 'line' | 'theme'>>, now = Date.now()): Site {
  return cleanSite({ ...site, look: { ...site.look, ...patch, at: stamp(site.look.at, now) } }, now);
}
export function setAddress(site: Site, url: string, now = Date.now()): Site {
  if (publicAddress(url) === site.address.url) return site;
  return cleanSite({ ...site, address: { url, at: stamp(site.address.at, now) } }, now);
}
export function setCount(site: Site, id: string, now = Date.now()): Site {
  return cleanSite({ ...site, count: { site: id, at: stamp(site.count.at, now) } }, now);
}

const newId = () => `p${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('')}`;

// A page of their own, or a post (under Writing). Returns the new copy and the page's id.
export function addPage(site: Site, kind: 'page' | 'post', title: string, body = '', now = Date.now()): { site: Site; id: string } | null {
  if (livePages(site).length >= MAX_PAGES) return null;
  const id = newId();
  const t = oneLine(title, TITLE_MAX) || (kind === 'post' ? 'New post' : 'New page');
  const order = Math.max(BUILT_IN.length, ...livePages(site).map((p) => p.order + 1));
  const page: SitePage = { id, kind, title: t, slug: uniqueSlug(site, slugify(t), id, kind), body: multiLine(body, BODY_MAX), order, at: now };
  if (kind === 'post') {
    page.date = new Date(now).toISOString().slice(0, 10);
    page.draft = true; // a new post waits until they say it's ready
  }
  return { site: cleanSite({ ...site, pages: { ...site.pages, [id]: page } }, now), id };
}

// Pages share one folder and posts another, so a name is only taken within its own.
function uniqueSlug(site: Site, want: string, id: string, kind: Kind): string {
  const base = RESERVED.has(want) ? `${want}-page` : want;
  const post = kind === 'post';
  const taken = new Set(livePages(site).filter((p) => p.id !== id && (p.kind === 'post') === post).map((p) => p.slug));
  let s = base;
  for (let n = 2; taken.has(s); n++) s = `${base}-${n}`;
  return s;
}

export function editPage(site: Site, id: string, patch: Partial<Pick<SitePage, 'title' | 'body' | 'date'>> & { draft?: boolean }, now = Date.now()): Site {
  const p = site.pages[id];
  if (!p || p.gone) return site;
  const next: SitePage = { ...p, at: stamp(p.at, now) };
  if (patch.title !== undefined) {
    next.title = oneLine(patch.title, TITLE_MAX) || p.title;
    if (!isBuiltIn(p.kind)) next.slug = uniqueSlug(site, slugify(next.title), id, p.kind);
  }
  if (patch.body !== undefined) next.body = multiLine(patch.body, BODY_MAX);
  if (patch.draft !== undefined) {
    if (patch.draft) next.draft = true;
    else delete next.draft;
  }
  if (patch.date !== undefined && p.kind === 'post' && isDay(patch.date)) next.date = patch.date;
  if (next.title === p.title && next.body === p.body && !!next.draft === !!p.draft && next.date === p.date) return site;
  return cleanSite({ ...site, pages: { ...site.pages, [id]: next } }, now);
}

// Built-in pages can't go (an empty one just isn't published); their own pages and posts can.
export function deletePage(site: Site, id: string, now = Date.now()): Site {
  const p = site.pages[id];
  if (!p || p.gone || isBuiltIn(p.kind)) return site;
  return cleanSite({ ...site, pages: { ...site.pages, [id]: { ...p, title: '', body: '', gone: true, at: stamp(p.at, now) } } }, now);
}

export function movePage(site: Site, id: string, by: -1 | 1, now = Date.now()): Site {
  const list = menuPages(site, true).filter((p) => p.kind !== 'home');
  const i = list.findIndex((p) => p.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return site;
  [list[i], list[j]] = [list[j], list[i]];
  const pages = { ...site.pages };
  list.forEach((p, n) => {
    if (p.order !== n + 1) pages[p.id] = { ...p, order: n + 1, at: stamp(p.at, now) };
  });
  return cleanSite({ ...site, pages }, now);
}

// ---------- what's there

export const livePages = (site: Site) => Object.values(site.pages).filter((p) => !p.gone);
const byOrder = (a: SitePage, b: SitePage) => a.order - b.order || a.at - b.at;
// The pages in the menu, Home first. `all`: drafts and empty ones too (for the editor).
export function menuPages(site: Site, all = false): SitePage[] {
  return livePages(site)
    .filter((p) => p.kind !== 'post' && (all || published(site, p)))
    .sort((a, b) => (a.kind === 'home' ? -1 : b.kind === 'home' ? 1 : byOrder(a, b)));
}
// Posts, newest first.
export function posts(site: Site, all = false): SitePage[] {
  return livePages(site)
    .filter((p) => p.kind === 'post' && (all || published(site, p)))
    .sort((a, b) => (a.date === b.date ? b.at - a.at : (b.date || '') < (a.date || '') ? -1 : 1));
}
// Home always goes up. A draft never does, and nor does an empty page (Writing goes up when it
// has a post to list).
export function published(site: Site, p: SitePage): boolean {
  if (p.gone || p.draft) return false;
  if (p.kind === 'home') return true;
  if (p.kind === 'writing') return !!p.body.trim() || posts(site).length > 0;
  return !!p.body.trim();
}

// ---------- Markdown, a light kind

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHTML = (s: string) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const UNESC: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescapeHTML = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => UNESC[m]);

// A link may go to the web (https or http), an email address, or another page of the site.
// Anything else (javascript:, data: and the like) is left as plain text.
export function safeHref(raw: string): string {
  const v = raw.trim();
  if (!v || /[\s<>"'`\\]/.test(v)) return '';
  if (/^(https?:\/\/|mailto:)/i.test(v)) {
    try {
      const u = new URL(v);
      return /^(https?|mailto):$/.test(u.protocol) ? v : '';
    } catch {
      return '';
    }
  }
  // Relative: no scheme at all (nothing like "x:" before the first / ? or #), and not "//host".
  if (/^\/\//.test(v) || /^[^/?#]*:/.test(v)) return '';
  return v;
}
const safeImage = (raw: string) => (/^https:\/\//i.test(raw.trim()) ? safeHref(raw) : '');

// One line's worth: code spans, links, bold and italic. Everything is escaped first, so nothing
// they typed can become HTML of its own.
export function inline(text: string): string {
  const parts = text.replace(/\u0000/g, '').split(/(`[^`\n]+`)/);
  return parts
    .map((part, i) => {
      if (i % 2) return `<code>${escapeHTML(part.slice(1, -1))}</code>`;
      // Links are put aside while bold and italic are found, so neither reaches an address.
      const links: string[] = [];
      let s = escapeHTML(part).replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_m, label: string, href: string) => {
        const url = safeHref(unescapeHTML(href));
        links.push(url ? `<a href="${escapeHTML(url)}">${emphasis(label)}</a>` : emphasis(label));
        return `\u0000${links.length - 1}\u0000`;
      });
      s = emphasis(s);
      return s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => links[Number(n)]);
    })
    .join('');
}
const emphasis = (s: string) =>
  s
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');

// Paragraphs, headings (# to ###), lists (- or 1.), quotes (>), code blocks (```), a line (---)
// and an image on a line of its own (![what it shows](https://…)).
export function toHTML(md: string): string {
  const lines = multiLine(md, BODY_MAX).split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>\n')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^```/.test(t)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i].trim()); i++) code.push(lines[i]);
      out.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!t) {
      flush();
      continue;
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(t);
    if (h) {
      flush();
      const n = h[1].length + 1; // the page's title is the h1
      out.push(`<h${n}>${inline(h[2].replace(/\s+#+$/, ''))}</h${n}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush();
      out.push('<hr>');
      continue;
    }
    const img = /^!\[([^\]\n]*)\]\(([^()\s]+)\)$/.exec(t);
    if (img) {
      flush();
      const src = safeImage(img[2]);
      out.push(src ? `<figure><img src="${escapeHTML(src)}" alt="${escapeHTML(img[1])}" loading="lazy">${img[1] ? `<figcaption>${inline(img[1])}</figcaption>` : ''}</figure>` : `<p>${inline(img[1])}</p>`);
      continue;
    }
    if (/^>\s?/.test(t)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i].trim()); i++) quote.push(lines[i].trim().replace(/^>\s?/, ''));
      i--;
      out.push(`<blockquote>${toHTML(quote.join('\n'))}</blockquote>`);
      continue;
    }
    const ul = /^[-*+]\s+/;
    const ol = /^\d{1,9}[.)]\s+/;
    if (ul.test(t) || ol.test(t)) {
      flush();
      const re = ul.test(t) ? ul : ol;
      const items: string[] = [];
      for (; i < lines.length && re.test(lines[i].trim()); i++) items.push(`<li>${inline(lines[i].trim().replace(re, ''))}</li>`);
      i--;
      const tag = re === ul ? 'ul' : 'ol';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    para.push(t);
  }
  flush();
  return out.join('\n');
}

// ---------- the files Publish writes

export interface SiteFile {
  path: string;
  content: string;
}
export const MANIFEST = 'arise-site.json';

export const fileOf = (p: SitePage) => (p.kind === 'post' ? `writing/${p.slug}.html` : `${p.slug}.html`);

const longDate = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// Every file of the site: one HTML file per page and post that's published, the look's style
// sheet, a page for addresses that aren't there, `.nojekyll` (GitHub serves the files as they
// are) and a list of the files Arise wrote, so the next Publish knows which of them to take away.
// With `count` (the visit counter's address and the site's public id), also a small script that
// tells it a page was opened. Each page allows nothing else to load or run (its own
// Content-Security-Policy): no fonts, scripts or trackers from anywhere.
export function build(site: Site, { count, year = new Date().getUTCFullYear() }: { count?: { server: string; site: string } | null; year?: number } = {}): SiteFile[] {
  const name = site.look.name || 'My website';
  const menu = menuPages(site);
  const list = posts(site);
  const counting = !!(count?.server && /^https:\/\//.test(count.server) && SITE_ID.test(count.site));
  const files: SiteFile[] = [];

  const page = (path: string, p: { title: string; key: string; main: string; here?: string }) => {
    const up = path.includes('/') ? '../' : '';
    const nav = menu
      .filter((m) => m.kind !== 'home')
      .map((m) => `<a href="${up}${fileOf(m)}"${m.id === p.here ? ' aria-current="page"' : ''}>${escapeHTML(m.title)}</a>`)
      .join('');
    const csp = `default-src 'none'; style-src 'self'; img-src https: 'self'; ${counting ? `script-src 'self'; connect-src ${new URL(count!.server).origin}; ` : ''}base-uri 'none'; form-action 'none'`;
    const title = p.key === 'index' ? name : `${p.title} | ${name}`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHTML(csp)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escapeHTML(title)}</title>
${site.look.line ? `<meta name="description" content="${escapeHTML(site.look.line)}">\n` : ''}<link rel="stylesheet" href="${up}style.css">
</head>
<body>
<header class="top"><a class="name" href="${up}index.html">${escapeHTML(name)}</a>${nav ? `<nav>${nav}</nav>` : ''}</header>
<main>
${p.main}
</main>
<footer><p>&copy; ${year} ${escapeHTML(name)}</p></footer>
${counting ? `<script src="${up}count.js" data-page="${escapeHTML(p.key)}"></script>\n` : ''}</body>
</html>
`;
  };

  for (const p of menu) {
    let main = p.kind === 'home' ? `<h1>${escapeHTML(name)}</h1>${site.look.line ? `\n<p class="line">${escapeHTML(site.look.line)}</p>` : ''}` : `<h1>${escapeHTML(p.title)}</h1>`;
    if (p.body.trim()) main += `\n${toHTML(p.body)}`;
    if (p.kind === 'writing' && list.length) {
      main += `\n<ul class="posts">${list.map((x) => `<li><a href="${fileOf(x)}">${escapeHTML(x.title)}</a> <time datetime="${x.date}">${longDate(x.date!)}</time></li>`).join('')}</ul>`;
    }
    files.push({ path: fileOf(p), content: page(fileOf(p), { title: p.title, key: p.slug, main, here: p.id }) });
  }
  const writing = menu.find((m) => m.kind === 'writing');
  for (const x of list) {
    const main = `<article>\n<h1>${escapeHTML(x.title)}</h1>\n<p class="date"><time datetime="${x.date}">${longDate(x.date!)}</time></p>\n${toHTML(x.body)}\n</article>${writing ? `\n<p class="back"><a href="../writing.html">All writing</a></p>` : ''}`;
    files.push({ path: fileOf(x), content: page(fileOf(x), { title: x.title, key: `writing/${x.slug}`, main, here: writing?.id }) });
  }
  files.push({ path: '404.html', content: page('404.html', { title: 'Not here', key: '404', main: `<h1>Not here</h1>\n<p>There's no page at this address. <a href="index.html">Go to the home page</a>.</p>` }) });
  files.push({ path: 'style.css', content: css(site.look.theme) });
  if (counting) files.push({ path: 'count.js', content: counterScript(count!.server, count!.site) });
  files.push({ path: '.nojekyll', content: '' });
  files.push({ path: MANIFEST, content: `${JSON.stringify({ by: 'Arise', files: [...files.map((f) => f.path), MANIFEST].sort() }, null, 2)}\n` });
  return files;
}

// Tells the counter one page was opened: the site's public id and the page's name, nothing else.
// No cookies, no address of where the visitor came from, and nothing when their browser asks
// sites not to track them.
export function counterScript(server: string, id: string): string {
  const url = `${new URL(server).origin}/v1/hit`;
  return `// Counts that this page was opened. It sends the site's id and the page's name, nothing else:
// no cookies, no address of where you came from. Nothing is sent when your browser asks sites
// not to track you.
(function () {
  var n = navigator;
  if (n.globalPrivacyControl || n.doNotTrack === '1') return;
  var me = document.currentScript;
  var page = (me && me.getAttribute('data-page')) || 'index';
  try {
    fetch(${JSON.stringify(url)}, { method: 'POST', mode: 'no-cors', credentials: 'omit', keepalive: true, referrerPolicy: 'no-referrer', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ s: ${JSON.stringify(id)}, p: page }) });
  } catch (e) {}
})();
`;
}

// ---------- the looks

const LOOKS: Record<Theme, { bg: string; text: string; muted: string; accent: string; line: string; head: string; body: string }> = {
  paper: { bg: '#fbf8f3', text: '#2b2620', muted: '#6f665c', accent: '#8a4f1f', line: '#e6ded2', head: 'Georgia, "Iowan Old Style", "Times New Roman", serif', body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  night: { bg: '#15171c', text: '#e8e5df', muted: '#a29f98', accent: '#d8b878', line: '#2c2f36', head: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  moss: { bg: '#f1f4ee', text: '#20281d', muted: '#59654f', accent: '#2f6b45', line: '#d7ddd0', head: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
};

export function css(theme: Theme): string {
  const t = LOOKS[isTheme(theme) ? theme : 'paper'];
  return `/* ${THEMES[isTheme(theme) ? theme : 'paper'].name}, a look made by Arise. */
:root { --bg: ${t.bg}; --text: ${t.text}; --muted: ${t.muted}; --accent: ${t.accent}; --line: ${t.line}; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 18px/1.65 ${t.body}; }
.top, main, footer { max-width: 42rem; margin: 0 auto; padding: 0 20px; }
.top { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 20px; padding-top: 28px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.name { font-family: ${t.head}; font-weight: 700; font-size: 1.15rem; color: var(--text); text-decoration: none; }
nav { display: flex; flex-wrap: wrap; gap: 4px 18px; }
nav a { color: var(--muted); text-decoration: none; }
nav a:hover, nav a[aria-current] { color: var(--text); }
nav a[aria-current] { text-decoration: underline; text-underline-offset: 6px; }
main { padding-top: 36px; padding-bottom: 48px; }
h1, h2, h3, h4 { font-family: ${t.head}; line-height: 1.25; margin: 1.6em 0 0.5em; }
h1 { font-size: 2.1rem; margin-top: 0; }
h2 { font-size: 1.45rem; }
h3 { font-size: 1.2rem; }
h4 { font-size: 1.05rem; }
p, ul, ol, blockquote, pre, figure { margin: 0 0 1.1em; }
a { color: var(--accent); text-underline-offset: 3px; }
.line { font-size: 1.2rem; color: var(--muted); }
.date, time { color: var(--muted); font-size: 0.9rem; }
blockquote { border-left: 3px solid var(--line); padding-left: 16px; color: var(--muted); }
code { font: 0.88em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: color-mix(in srgb, var(--line) 55%, transparent); padding: 0.1em 0.35em; border-radius: 4px; }
pre { overflow-x: auto; padding: 14px 16px; border: 1px solid var(--line); border-radius: 8px; }
pre code { background: none; padding: 0; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
img { max-width: 100%; height: auto; border-radius: 6px; }
figcaption { color: var(--muted); font-size: 0.9rem; margin-top: 6px; }
.posts { list-style: none; padding: 0; }
.posts li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 16px; padding: 10px 0; border-top: 1px solid var(--line); }
.back { margin-top: 2em; }
footer { padding-bottom: 36px; color: var(--muted); font-size: 0.9rem; }
@media (max-width: 520px) { body { font-size: 17px; } h1 { font-size: 1.75rem; } }
`;
}
