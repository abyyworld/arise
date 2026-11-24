import { describe, expect, it } from 'vitest';
import { cut, frontMatter, htmlText, htmlTitle, listOf, localLinks, nameDate, noteDate, noteEvent, NOTE_MAX } from './notes';
import { cleanLifeEvent } from '../../lib/validate';

// The tests run with TZ=UTC, so a time on this device's clock is UTC too.
const local = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('note helpers', () => {
  it('reads front matter: values, lists in brackets and as lines, and the body after it', () => {
    const fm = frontMatter('---\ntitle: "Trip ideas"\ncreated: 2024-01-02 09:30\ntags: [travel, "ideas"]\naliases:\n  - Trips\n  - Away\n---\n# Heading\nBody\n');
    expect(fm.data).toEqual({ title: 'Trip ideas', created: '2024-01-02 09:30', tags: ['travel', 'ideas'], aliases: ['Trips', 'Away'] });
    expect(fm.body).toBe('# Heading\nBody\n');
    expect(frontMatter('No front matter\n---\n').body).toBe('No front matter\n---\n');
    expect(listOf('#a, b #c')).toEqual(['a', 'b', 'c']);
  });

  it('reads the dates people and apps write, on this device’s clock unless a zone is given', () => {
    expect(noteDate('2024-01-02')).toBe(local(2024, 1, 2));
    expect(noteDate('2024-01-02 09:30')).toBe(local(2024, 1, 2, 9, 30));
    expect(noteDate('"2024-01-02T09:30"')).toBe(local(2024, 1, 2, 9, 30));
    expect(noteDate('2024-01-02T09:30:00+02:00')).toBe(Date.UTC(2024, 0, 2, 7, 30));
    expect(noteDate('January 2, 2024 3:04 PM')).toBe(local(2024, 1, 2, 15, 4));
    expect(noteDate('Jan 2, 2024')).toBe(local(2024, 1, 2));
    expect(noteDate('2 March 2024 12:15 am')).toBe(local(2024, 3, 2, 0, 15));
    expect(noteDate('Someday 2, 2024')).toBeNaN();
    expect(noteDate('soon')).toBeNaN();
    expect(noteDate(42)).toBeNaN();
    expect(nameDate('2024-02-29 Notes')).toBe(local(2024, 2, 29));
    expect(nameDate('2023-02-29')).toBeNaN();
  });

  it('keeps the words of HTML, with lines for paragraphs, lists and ticks', () => {
    const html = '<html><head><title>Plan &amp; ideas</title><style>p{}</style></head><body><h1>Plan</h1><p>First&nbsp;line<br>second</p><ul><li>One</li><li><input type="checkbox" checked> Done</li></ul><script>x()</script></body></html>';
    expect(htmlTitle(html)).toBe('Plan & ideas');
    expect(htmlText(html)).toBe('Plan\n\nFirst line\nsecond\n\n- One\n- [x] Done');
    expect(htmlText('<p>&#8364;5 &#x1F600; &bogus;</p>')).toBe('€5 😀 &bogus;');
  });

  it('makes one private note event, cut to what the life log keeps', () => {
    const long = 'word '.repeat(2000);
    const e = noteEvent({ app: 'Obsidian', key: 'a.md', title: '', text: `First line\n\n\n\nmore ${long}`, at: 1_700_000_000_000, folder: 'Ideas', tags: ['x', 'y'] })!;
    expect(e).toMatchObject({ source: 'other', kind: 'note', tier: 3, title: 'First line', meta: { app: 'Obsidian', folder: 'Ideas', tags: 'x, y' } });
    expect(e.id).toMatch(/^other:note:[0-9a-f]{16}$/);
    expect(e.detail!.length).toBe(NOTE_MAX);
    expect(e.detail!.endsWith('…')).toBe(true);
    expect(e.detail).toContain('First line\n\nmore');
    expect(cleanLifeEvent(e)).toEqual(e);
    expect(noteEvent({ app: 'A', key: 'k', title: '', text: '  ', at: 1 })).toBeNull();
    expect(noteEvent({ app: 'A', key: 'k', title: 'T', text: '', at: NaN })).toBeNull();
    expect(cut('abc', 5)).toBe('abc');
    expect(localLinks('See [Trip](Trip%20plans%201a2b.md) and [site](https://x.org/a.md)')).toBe('See Trip and [site](https://x.org/a.md)');
  });
});
