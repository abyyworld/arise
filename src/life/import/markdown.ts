// Notes written as files: an Obsidian vault (a zip of Markdown files, with its .obsidian
// folder), other Markdown or text notes in a zip, Apple Notes from Apple's data download, and a
// single .md, .txt or .html file. One note event per file (made in notes.ts).
//
//   ---
//   created: 2024-01-02 09:30
//   tags: [travel, ideas]
//   ---
//   # Trip ideas
//   Somewhere warm in June.
//
// The title is the first heading when the note starts with one, else the file's name. The date
// comes from the front matter (date: or created:), else a name that is a date (a daily note,
// "2024-01-02.md"), else when the file was last changed.
//
// Apple Notes: Apple has no export. The data download at privacy.apple.com has a folder
// "iCloud Notes" with each note as a .txt or .html file, and maybe a CSV with the dates.

import type { LifeEvent } from '../types';
import type { TextInput } from './types';
import type { Parts } from './chat';
import { CsvRows } from './text-stream';
import { baseName, dirName, frontMatter, htmlText, htmlTitle, leadingHeading, listOf, localLinks, nameDate, noExt, noteBatches, noteDate, readText, type NoteDoc } from './notes';

// Front matter keys that hold when a note was written, the best first.
const DATE_KEYS = ['date', 'created', 'date created', 'created at', 'creation date', 'created_at', 'day'];

export interface FileNoteOptions {
  app: string;
  root?: string; // the folder the notes are in (a vault's), left off the folder kept
  folder?: (dir: string) => string; // how a folder is shown (Notion takes its ids off)
  title?: (name: string) => string; // the same for a file's name
  dates?: Map<string, number>; // a time for a note by its title, lower case (Apple's CSV)
  lines?: boolean; // dates written as lines at the top ("Created: …", as Notion does)
}

const firstOf = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// One file as a note.
export function fileNote(path: string, raw: string, modified: number | undefined, o: FileNoteOptions): NoteDoc | null {
  const name = baseName(path);
  const html = /\.html?$/i.test(name);
  const md = /\.(md|markdown)$/i.test(name);
  const fileTitle = (o.title ?? ((x: string) => x))(noExt(name));
  let title = fileTitle;
  let text: string;
  let at = NaN;
  let tags: string[] = [];
  if (html) {
    text = htmlText(raw);
    title = htmlTitle(raw) || fileTitle;
  } else {
    const fm = md ? frontMatter(raw) : { data: {}, body: raw.replace(/^﻿/, '') };
    for (const k of DATE_KEYS) {
      at = noteDate(firstOf(fm.data[k]));
      if (Number.isFinite(at)) break;
    }
    tags = listOf(fm.data.tags ?? fm.data.tag);
    let body = fm.body;
    const head = md ? leadingHeading(body) : null;
    if (head) {
      title = (o.title ?? ((x: string) => x))(head.title);
      body = head.rest;
    }
    if (typeof fm.data.title === 'string' && fm.data.title) title = fm.data.title;
    if (o.lines && !Number.isFinite(at)) {
      // Notion writes a page's properties as lines under its title: "Created: January 2, 2024 3:04 PM".
      for (const line of body.split('\n', 20)) {
        const m = line.match(/^\s*(created|date|created time|date created|created on)\s*:\s*(.+)$/i);
        if (m && Number.isFinite((at = noteDate(m[2])))) break;
      }
    }
    text = md ? localLinks(body) : body;
  }
  if (!Number.isFinite(at)) at = o.dates?.get(title.toLowerCase()) ?? o.dates?.get(fileTitle.toLowerCase()) ?? NaN;
  if (!Number.isFinite(at)) at = nameDate(noExt(name));
  if (!Number.isFinite(at) && modified) at = modified;
  let dir = dirName(path);
  if (o.root && (dir + '/').startsWith(o.root)) dir = dir.slice(o.root.length);
  const folder = o.folder ? o.folder(dir) : dir;
  return { app: o.app, key: path.slice(o.root?.length ?? 0), title, text, at, folder, tags };
}

const NOTE_FILE = /\.(md|markdown|txt|html?)$/i;

// The notes in a zip (or one file on its own), every part a file.
export function parseFileNotes(parts: Parts, o: FileNoteOptions): AsyncGenerator<LifeEvent[]> {
  return noteBatches(
    (async function* () {
      for await (const p of parts) {
        if (!NOTE_FILE.test(p.name)) continue;
        yield fileNote(p.name, await readText(p), p.modified, o);
      }
    })(),
  );
}

// ---------- Apple Notes

// Where the notes are in Apple's data download, and the parts to leave out.
export const APPLE_NOTES = /(^|\/)iCloud Notes\//i;
const DELETED = /(^|\/)Recently Deleted\//i;
export const isAppleNote = (path: string): boolean => APPLE_NOTES.test(path) && !DELETED.test(path) && (NOTE_FILE.test(path) || /\.csv$/i.test(path));

// Its CSV of notes, when there is one: each note's time by its title (when it was made, else last changed).
async function appleDates(input: TextInput): Promise<Map<string, number>> {
  const rows = new CsvRows(',');
  const all: string[][] = [];
  for await (const c of input.text) all.push(...rows.push(c));
  all.push(...rows.end());
  const out = new Map<string, number>();
  const head = (all.shift() ?? []).map((h) => h.trim().toLowerCase());
  const title = head.findIndex((h) => h === 'title' || h === 'name');
  const made = head.findIndex((h) => /^(created|creation)/.test(h));
  const changed = head.findIndex((h) => /^(modified|last modified|updated)/.test(h));
  if (title < 0 || (made < 0 && changed < 0)) return out;
  for (const r of all) {
    let at = made >= 0 ? noteDate(r[made]) : NaN;
    if (!Number.isFinite(at) && made >= 0) at = Date.parse(r[made] ?? '');
    if (!Number.isFinite(at) && changed >= 0) at = noteDate(r[changed]);
    if (!Number.isFinite(at) && changed >= 0) at = Date.parse(r[changed] ?? '');
    const t = (r[title] ?? '').trim().toLowerCase();
    if (t && Number.isFinite(at)) out.set(t, at);
  }
  return out;
}

// The folder a note is in, without the folder Apple makes for each note (named like the note).
function appleFolder(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() === 'notes') parts.shift();
  return parts.join('/');
}

export function parseAppleNotes(parts: Parts, root: string): AsyncGenerator<LifeEvent[]> {
  const dates = new Map<string, number>();
  const o: FileNoteOptions = { app: 'Apple Notes', root, dates };
  return noteBatches(
    (async function* () {
      for await (const p of parts) {
        if (/\.csv$/i.test(p.name)) {
          for (const [k, v] of await appleDates(p)) dates.set(k, v);
          continue;
        }
        if (!NOTE_FILE.test(p.name)) continue;
        const d = fileNote(p.name, await readText(p), p.modified, o);
        if (d) {
          // Each note sits in a folder named like it: that one isn't worth keeping.
          const dir = dirName(p.name.slice(root.length));
          const own = baseName(dir).toLowerCase() === noExt(baseName(p.name)).toLowerCase();
          d.folder = appleFolder(own ? dirName(dir) : dir);
        }
        yield d;
      }
    })(),
  );
}
