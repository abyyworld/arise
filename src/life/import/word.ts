// A Word document (.docx), which is a zip: its words are in word/document.xml, a paragraph per
// <w:p>, the text in <w:t>; when it was written is in docProps/core.xml (dcterms:created). The
// whole document becomes one note, named after the file.

import type { LifeEvent } from '../types';
import type { Parts } from './chat';
import { entities, noExt, noteBatches, readText, type NoteDoc } from './notes';
import { isoMs } from './util';

export const WORD_BODY = 'word/document.xml';
export const WORD_PROPS = 'docProps/core.xml';

// The words of word/document.xml: paragraphs on their own lines, tabs and line breaks kept.
// Deleted words (tracked changes, <w:delText>) are left out.
export function wordText(xml: string): string {
  const out: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\s*\/>|<\/w:p>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1] !== undefined) out.push(entities(m[1]));
    else out.push(m[2] === 'tab' ? '\t' : '\n');
  }
  return out.join('');
}

// When it was made (else last saved), from docProps/core.xml.
export function wordDate(xml: string): number {
  for (const tag of ['dcterms:created', 'dcterms:modified']) {
    const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([^<]+)</${tag}>`));
    const at = m ? isoMs(m[1].trim()) : NaN;
    if (Number.isFinite(at) && at > Date.UTC(1980, 0, 2)) return at;
  }
  return NaN;
}

export function parseWord(parts: Parts, file = 'Document.docx'): AsyncGenerator<LifeEvent[]> {
  return noteBatches(
    (async function* (): AsyncGenerator<NoteDoc> {
      let at = NaN;
      let modified: number | undefined;
      for await (const p of parts) {
        if (p.name === WORD_PROPS) at = wordDate(await readText(p, 1 << 20));
        else if (p.name === WORD_BODY) {
          modified ??= p.modified;
          const text = wordText(await readText(p, 32 << 20));
          // No words (only pictures): nothing to keep, and the Player is told.
          if (!text.trim()) continue;
          yield { app: 'Word', key: file, title: noExt(file), text, at: Number.isFinite(at) ? at : (modified ?? NaN), extra: { file: file.slice(0, 200) } };
        }
      }
    })(),
  );
}
