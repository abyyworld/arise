// Google Keep, from a Google Takeout: a "Keep" folder with one .json per note (and an .html of
// each, which isn't needed):
//   { "title": "Shopping", "textContent": "…", "listContent": [{ "text": "Milk", "isChecked": false }],
//     "labels": [{ "name": "Home" }], "isTrashed": false, "isPinned": true, "isArchived": false,
//     "createdTimestampUsec": 1704189600000000, "userEditedTimestampUsec": 1704193200000000 }
// Notes in the bin are left out. A checklist becomes lines: "[ ] Milk", "[x] Bread".

import type { LifeEvent } from '../types';
import type { Parts } from './chat';
import { allText, isObj, parseJson } from './chat';
import { baseName, noExt, noteBatches, type NoteDoc } from './notes';

export const KEEP_PATH = /(^|\/)(Keep|Google Keep)\/[^/]+\.json$/i;
export const KEEP_HEAD = /"(userEditedTimestampUsec|createdTimestampUsec)"\s*:/;

const usec = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return n > 0 ? Math.round(n / 1000) : NaN;
};

// One note, or null when it's in the bin, empty, or not a Keep note.
export function keepNote(v: unknown, path: string): NoteDoc | null {
  if (!isObj(v) || v.isTrashed === true) return null;
  const title = typeof v.title === 'string' ? v.title.trim() : '';
  const lines: string[] = [];
  if (typeof v.textContent === 'string' && v.textContent.trim()) lines.push(v.textContent.trim());
  if (Array.isArray(v.listContent)) {
    for (const item of v.listContent) {
      if (!isObj(item) || typeof item.text !== 'string' || !item.text.trim()) continue;
      lines.push(`${item.isChecked === true ? '[x]' : '[ ]'} ${item.text.trim()}`);
    }
  }
  if (!title && !lines.length) return null;
  // When it was written; else when it was last changed.
  let at = usec(v.createdTimestampUsec);
  if (!Number.isFinite(at)) at = usec(v.userEditedTimestampUsec);
  const created = typeof v.createdTimestampUsec === 'number' || typeof v.createdTimestampUsec === 'string' ? String(v.createdTimestampUsec) : '';
  const tags = Array.isArray(v.labels) ? v.labels.flatMap((l) => (isObj(l) && typeof l.name === 'string' ? [l.name] : [])) : [];
  const extra: Record<string, boolean> = {};
  if (v.isPinned === true) extra.pinned = true;
  if (v.isArchived === true) extra.archived = true;
  return { app: 'Google Keep', key: created || noExt(baseName(path)), title, text: lines.join('\n'), at, tags, extra };
}

export function parseKeep(parts: Parts): AsyncGenerator<LifeEvent[]> {
  return noteBatches(
    (async function* () {
      for await (const p of parts) yield keepNote(parseJson(await allText(p, 4 << 20)), p.name);
    })(),
  );
}
