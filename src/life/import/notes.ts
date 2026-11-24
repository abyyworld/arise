// What the note importers share (Obsidian, Notion, Apple Notes, Google Keep, Word, PDF and loose
// text files): each note becomes one event of kind 'note', with its words in the detail.
//
// Notes come from 'other' (the life log has no source for each notes app), with the app's name in
// meta.app. Their words can be anything the Player wrote down (a diary, a letter from a doctor), so
// they're kept at the most private tier.

import type { LifeEvent } from '../types';
import type { TextInput } from './types';
import { clean, drain, hashId, isoMs, localMs } from './util';

// The life log keeps 4,000 characters of a detail: a little less, so the cut shows.
export const NOTE_MAX = 3900;
// How much of one file is read: far more than is kept, as HTML and front matter take room too.
const READ_MAX = 2 << 20;

export interface NoteDoc {
  app: string; // who it came from, in plain words: "Obsidian"
  key: string; // stable within the app (the path in the vault), so a second import finds the same note
  title: string;
  text: string;
  at: number; // ms
  folder?: string;
  tags?: string[];
  extra?: Record<string, string | number | boolean>;
}

// The words, tidy: no tabs or other control characters (the life log keeps none), no runs of
// spaces inside a line, none at line ends, and no runs of empty lines.
export function tidyText(s: string): string {
  return s
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .replace(/(\S) {2,}/g, '$1 ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

// One note as a life event, or null when it has no time or nothing in it.
export function noteEvent(d: NoteDoc): LifeEvent | null {
  if (!Number.isFinite(d.at) || d.at <= 0) return null;
  const text = tidyText(d.text);
  const title = clean(d.title, 200) || clean(text.split('\n', 1)[0], 120);
  if (!title) return null;
  const meta: Record<string, string | number | boolean> = { app: d.app };
  const folder = clean(d.folder, 200);
  if (folder) meta.folder = folder;
  const tags = (d.tags ?? []).map((t) => clean(t, 60)).filter(Boolean);
  if (tags.length) meta.tags = clean(tags.join(', '), 300);
  Object.assign(meta, d.extra);
  const e: LifeEvent = { id: `other:note:${hashId(d.app, d.key)}`, source: 'other', kind: 'note', at: d.at, title, tier: 3, meta };
  if (text) e.detail = cut(text, NOTE_MAX);
  return e;
}

// Events from notes, in batches.
export async function* noteBatches(docs: AsyncIterable<NoteDoc | null>): AsyncGenerator<LifeEvent[]> {
  const out: LifeEvent[] = [];
  for await (const d of docs) {
    const e = d && noteEvent(d);
    if (e) out.push(e);
    yield* drain(out);
  }
  yield* drain(out, true);
}

// A file's text, up to `max` characters (the rest isn't read).
export async function readText(input: TextInput, max = READ_MAX): Promise<string> {
  let s = '';
  for await (const c of input.text) {
    s += c;
    if (s.length >= max) break;
  }
  return s.slice(0, max);
}

// ---------- names and folders

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const dirName = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const noExt = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,8}$/, '');

// A name is a date ("2024-01-02", as daily notes are named): noon that day on this device's clock.
export function nameDate(name: string): number {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  return m ? localMs(+m[1], +m[2], +m[3]) : NaN;
}

// ---------- dates written by people and apps

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const hour12 = (h: number, ap: string | undefined) => (!ap ? h : /p/i.test(ap) ? (h % 12) + 12 : h % 12);

// "2024-01-02", "2024-01-02 10:30", "2024-01-02T10:30:00Z", "January 2, 2024 3:04 PM" (Notion),
// "2 January 2024". With no zone, it's this device's clock; with no time, noon. NaN when it isn't one.
export function noteDate(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  const s = v.trim().replace(/^["']|["']$/g, '');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return isoMs(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (m) return m[4] ? localMs(+m[1], +m[2], +m[3], hour12(+m[4], m[7]), +m[5], +(m[6] || 0)) : localMs(+m[1], +m[2], +m[3]);
  m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?)?/i);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    if (!mo) return NaN;
    return m[4] ? localMs(+m[3], mo, +m[2], hour12(+m[4], m[6]), +m[5]) : localMs(+m[3], mo, +m[2]);
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*(am|pm)?)?/i);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    if (!mo) return NaN;
    return m[4] ? localMs(+m[3], mo, +m[1], hour12(+m[4], m[6]), +m[5]) : localMs(+m[3], mo, +m[1]);
  }
  return NaN;
}

// ---------- front matter (the YAML block at the top of a Markdown note)

export interface FrontMatter {
  data: Record<string, string | string[]>; // keys in lower case
  body: string;
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2').trim();

export function frontMatter(text: string): FrontMatter {
  const t = text.replace(/^﻿/, '');
  const m = t.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: t };
  const data: Record<string, string | string[]> = {};
  let list = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_][A-Za-z0-9_ .-]*?)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim().toLowerCase();
      const v = kv[2].trim();
      list = '';
      if (!v) {
        data[key] = [];
        list = key;
      } else if (/^\[.*\]$/.test(v)) data[key] = v.slice(1, -1).split(',').map(unquote).filter(Boolean);
      else data[key] = unquote(v);
      continue;
    }
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && list) (data[list] as string[]).push(unquote(item[1]));
  }
  return { data, body: t.slice(m[0].length) };
}

// A front matter value as a list ("tags: [a, b]", "tags: a, b", or a list of lines), without "#".
export function listOf(v: string | string[] | undefined): string[] {
  const all = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return all.map((x) => x.replace(/^#/, '').trim()).filter(Boolean);
}

// ---------- Markdown and HTML

// A note that starts with "# Title": that title and the rest.
export function leadingHeading(body: string): { title: string; rest: string } | null {
  const m = body.match(/^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/);
  return m ? { title: m[1].trim(), rest: body.slice(m[0].length) } : null;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', euro: '€', pound: '£' };

export function entities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

// The words of an HTML page, with its paragraphs and list items on their own lines.
export function htmlText(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<input\b[^>]*\bchecked\b[^>]*>/gi, '[x] ')
    .replace(/<input\b[^>]*type=["']?checkbox[^>]*>/gi, '[ ] ')
    .replace(/<\/?(p|div|h[1-6]|ul|ol|tr|table|blockquote|pre|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]*>/g, '');
  return tidyText(
    entities(s)
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n /g, '\n'),
  );
}

// The page's own title (<title>, else its first <h1>), or ''.
export function htmlTitle(html: string): string {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) ?? html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? clean(entities(m[1].replace(/<[^>]*>/g, ' ')), 200) : '';
}

// Links to other files in an export ("[Trip](Trip%20plans%201a2b.md)") keep only their words.
export const localLinks = (s: string): string => s.replace(/\[([^\]\n]*)\]\((?!https?:|mailto:)[^)\n]*\.(md|csv|html?)\)/gi, '$1');
