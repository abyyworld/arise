// A web page as plain text to read later: its title and its words, with the scripts, styles,
// menus, headers, footers, forms and the like left out. Worked out on the device from the page's
// HTML (Your links, "Keep a copy": links.ts). The HTML is only parsed, never shown or run: a
// parsed document doesn't run its scripts or load anything.

export interface Readable {
  title: string;
  text: string; // paragraphs, one blank line between them
}

export const MAX_TEXT = 60_000;

// Never part of what's read.
const DROP = 'script, style, noscript, template, iframe, frame, object, embed, svg, canvas, video, audio, picture source, map, form, button, input, select, textarea, label, nav, header, footer, aside, dialog, menu, [hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="dialog"], [role="alertdialog"], [role="search"], [role="menu"], [role="menubar"]';
// Class or id words that mean it's around the page, not the page.
const AROUND = /(^|[\s_-])(nav|navbar|menu|sidebar|footer|masthead|breadcrumbs?|cookies?|consent|banner|share|sharing|social|comments?|related|recommended|promo|advert|ads|subscribe|newsletter|signup|popup|modal|skip-link)($|[\s_-])/i;
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'TABLE', 'TR', 'FIGURE', 'FIGCAPTION', 'HR', 'ADDRESS', 'DETAILS', 'SUMMARY']);

const oneLine = (s: string | null | undefined) => (s || '').replace(/[\u0000-\u001f\u007f­​]+/g, ' ').replace(/\s+/g, ' ').trim();

function titleOf(doc: Document): string {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const t = oneLine(og) || oneLine(doc.querySelector('title')?.textContent) || oneLine(doc.querySelector('h1')?.textContent);
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

// The part of the page with the most words in a likely place: an article, the main part, or the
// whole body.
function rootOf(doc: Document): Element | null {
  const articles = [...doc.querySelectorAll('article')];
  if (articles.length) return articles.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0];
  return doc.querySelector('main, [role="main"]') || doc.body;
}

// The words, a block at a time.
function walk(el: Element, out: string[]) {
  for (const n of [...el.childNodes]) {
    if (n.nodeType === 3) {
      out.push((n.textContent || '').replace(/\s+/g, ' '));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const c = n as Element;
    const tag = c.tagName;
    if (tag === 'BR') {
      out.push('\n');
      continue;
    }
    if (tag === 'IMG') {
      const alt = oneLine(c.getAttribute('alt'));
      if (alt) out.push(` ${alt} `);
      continue;
    }
    if (tag === 'PRE') {
      out.push(`\n\n${(c.textContent || '').replace(/\r\n?/g, '\n').trim()}\n\n`);
      continue;
    }
    const block = BLOCK.has(tag);
    if (block) out.push('\n\n');
    if (tag === 'LI') out.push('- ');
    else if (tag === 'TD' || tag === 'TH') out.push(' ');
    walk(c, out);
    if (block) out.push('\n\n');
  }
}

export function readable(html: string): Readable {
  if (typeof html !== 'string' || !html.trim() || typeof DOMParser === 'undefined') return { title: '', text: '' };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = titleOf(doc);
  for (const el of [...doc.querySelectorAll(DROP)]) el.remove();
  // (Never a part that holds most of the page's words: "page has-sidebar" is the page.)
  const all = (doc.body?.textContent || '').length;
  for (const el of [...doc.querySelectorAll('[class], [id]')]) {
    if (!el.isConnected || el.tagName === 'BODY' || el.tagName === 'MAIN' || el.tagName === 'ARTICLE') continue;
    if (AROUND.test(`${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`) && (el.textContent || '').length < all * 0.4) el.remove();
  }
  const root = rootOf(doc);
  if (!root) return { title, text: '' };
  const out: string[] = [];
  walk(root, out);
  const paras = out
    .join('')
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split('\n')
        .map((l) => oneLine(l))
        .filter(Boolean)
        .join('\n'),
    )
    .filter((p) => p && p !== '-');
  // The title again as the first line: once is enough.
  if (paras.length && oneLine(paras[0]) === title) paras.shift();
  let text = paras.join('\n\n');
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT).replace(/\s+\S*$/, '')}…`;
  return { title, text };
}

// Text cut into parts of at most `size` characters, at a paragraph if it can (else a space), and
// at most `most` parts. `cut`: there was more than fits.
export function parts(text: string, size: number, most: number): { parts: string[]; cut: boolean } {
  const out: string[] = [];
  let rest = text.trim();
  while (rest && out.length < most) {
    if (rest.length <= size) {
      out.push(rest);
      rest = '';
      break;
    }
    let at = rest.lastIndexOf('\n\n', size);
    if (at < size / 2) at = rest.lastIndexOf(' ', size);
    if (at < size / 2) at = size;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  return { parts: out, cut: !!rest };
}
