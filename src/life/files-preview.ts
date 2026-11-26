// What a file's sheet shows of it, worked out on the device from its decrypted bytes: the picture,
// a PDF's first page, a player for sound and video, or the words of a text or Markdown file.
// Nothing is made ahead or kept: it's drawn when the sheet opens.

import type { FileMeta } from '../lib/validate';

export type PreviewKind = 'image' | 'pdf' | 'audio' | 'video' | 'markdown' | 'text';

export const TEXT_SHOWN = 100_000; // characters of a text file shown inline
export const PDF_PICTURE_MAX = 40 * 1024 * 1024; // bigger PDFs show no first page (it's slow to look through)

const ext = (name: string) => (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase();

// Which preview a file gets, by its type (and its name, for files saved as "octet-stream").
// Null: none (a Word file, a zip): the sheet offers Save a copy.
export function previewKind(f: Pick<FileMeta, 'name' | 'type'>): PreviewKind | null {
  const t = f.type.toLowerCase();
  const e = ext(f.name);
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf' || e === 'pdf') return 'pdf';
  if (t.startsWith('audio/') || /^(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/.test(e)) return 'audio';
  if (t.startsWith('video/') || /^(mp4|m4v|mov|webm|ogv)$/.test(e)) return 'video';
  if (/^text\/(markdown|x-markdown)$/.test(t) || /^(md|markdown)$/.test(e)) return 'markdown';
  if (/^text\/(plain|csv|tab-separated-values|x-log)$/.test(t) || t === 'application/json' || /^(txt|text|csv|tsv|json|log)$/.test(e)) return 'text';
  return null;
}

// The words of a text file, at most `max` characters (and whether there's more).
export function textOf(bytes: Uint8Array, max = TEXT_SHOWN): { text: string; more: boolean } {
  const head = bytes.subarray(0, max * 4);
  let text = new TextDecoder('utf-8', { fatal: false }).decode(head).replace(/^﻿/, '');
  const more = bytes.length > head.length || text.length > max;
  if (text.length > max) text = text.slice(0, max);
  return { text, more };
}
