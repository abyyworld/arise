// Notion: the zip from Settings, Export, "Markdown & CSV". Every page is a Markdown file and every
// database a CSV, each named with a long id after it ("Trip plans 1a2b3c….md"). Pages become notes
// (the id taken off their names); each row of a database becomes a note too: its first column (the
// title) and the others as lines ("Status: Done").
//
// A row that has its own page in the export is that page already, and isn't added twice. Newer
// exports write a database twice ("Tasks 1a2b….csv" and "Tasks 1a2b…_all.csv"): one is enough.

import type { LifeEvent } from '../types';
import type { Parts } from './chat';
import { CsvRows } from './text-stream';
import { fileNote } from './markdown';
import { baseName, dirName, noteBatches, noteDate, readText, type NoteDoc } from './notes';
import { Repeats } from './util';

// " 1a2b3c4d…" (32 hex digits) at the end of a name, as Notion adds them.
const ID = /\s+[0-9a-f]{32}$/i;
export const NOTION_NAME = /\s[0-9a-f]{32}(_all)?\.(md|csv)$/i;

export const notionName = (s: string): string => s.replace(ID, '').trim();
const notionFolder = (dir: string) =>
  dir
    .split('/')
    .map((p) => notionName(p))
    .filter(Boolean)
    .join('/');

const CSV_DATE = /^(created|created time|date created|created on|date)$/i;

export function parseNotion(parts: Parts, root = ''): AsyncGenerator<LifeEvent[]> {
  // Pages seen so far, by folder: a database's rows with a page are left out.
  const pages = new Map<string, Set<string>>();
  const csvs = new Set<string>(); // databases read, by name without "_all"
  const o = { app: 'Notion', root, folder: notionFolder, title: notionName, lines: true };
  return noteBatches(
    (async function* () {
      for await (const p of parts) {
        if (/\.(md|markdown)$/i.test(p.name)) {
          const d = fileNote(p.name, await readText(p), p.modified, o);
          if (d) {
            const dir = dirName(p.name);
            let set = pages.get(dir);
            if (!set) pages.set(dir, (set = new Set()));
            set.add(d.title.toLowerCase());
          }
          yield d;
        } else if (/\.csv$/i.test(p.name)) {
          const plain = p.name.replace(/_all\.csv$/i, '.csv');
          if (csvs.has(plain)) continue;
          csvs.add(plain);
          yield* rows(plain, await readText(p, 8 << 20), p.modified, pages.get(plain.replace(/\.csv$/i, '')), root);
        }
      }
    })(),
  );
}

function* rows(path: string, text: string, modified: number | undefined, withPage: Set<string> | undefined, root: string): Generator<NoteDoc> {
  const csv = new CsvRows(',');
  const all = [...csv.push(text.replace(/^﻿/, '')), ...csv.end()];
  const head = (all.shift() ?? []).map((h) => h.trim());
  if (!head.length) return;
  const dateCol = head.findIndex((h) => CSV_DATE.test(h));
  const db = notionName(baseName(path).replace(/\.csv$/i, ''));
  const folder = notionFolder(dirName(path.slice(root.length)));
  const repeats = new Repeats();
  for (const r of all) {
    const title = (r[0] ?? '').trim();
    if (!title && r.every((c) => !c.trim())) continue;
    if (title && withPage?.has(title.toLowerCase())) continue;
    const lines = head.slice(1).flatMap((h, i) => {
      const v = (r[i + 1] ?? '').trim();
      return v ? [`${h || `Column ${i + 2}`}: ${v}`] : [];
    });
    let at = dateCol >= 0 ? noteDate(r[dateCol]) : NaN;
    if (!Number.isFinite(at) && modified) at = modified;
    const key = `${path}\u0001${title}`;
    yield { app: 'Notion', key: `${key}\u0001${repeats.next(key)}`, title: title || db, text: lines.join('\n'), at, folder: folder ? `${folder}/${db}` : db };
  }
}
