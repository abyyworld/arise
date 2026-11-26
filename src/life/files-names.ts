// Better names for files with names that say nothing (IMG_1234.jpg, scan.pdf, document (3).docx):
// a name from the file's first heading, from what "Arise reads it for you" wrote about it, or
// from its date. Worked out on the device, with no AI. Nothing here reads or writes storage.

import type { FileMeta } from '../lib/validate';

// What camera apps, scanners, downloads and "Save as" call files when nobody names them.
const GENERIC = new Set(
  [
    'img', 'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pict', 'dsc', 'dscn', 'dscf', 'dcim', 'pxl', 'mvimg', 'vid', 'video',
    'mov', 'movie', 'clip', 'gopr', 'gp', 'dji', 'wp', 'sam', 'snapshot', 'screenshot', 'screen shot', 'screen recording', 'scan', 'scans', 'scanned',
    'scanned document', 'scanned image', 'document', 'documents', 'doc', 'docs', 'file', 'files', 'untitled', 'untitled document', 'new document',
    'unnamed', 'download', 'downloads', 'attachment', 'attachments', 'export', 'output', 'print', 'page', 'capture', 'recording', 'new recording',
    'audio', 'voice', 'voice memo', 'whatsapp image', 'whatsapp video', 'whatsapp audio', 'ptt', 'blob', 'temp', 'tmp', 'copy', 'upload', 'unknown',
    'noname', 'no name', 'sheet', 'spreadsheet', 'presentation', 'book', 'workbook', 'text', 'new', 'draft', 'final', 'edited',
  ],
);

export const extOf = (name: string) => (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase();
const baseOf = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '');

// Whether a name says nothing about what's in the file.
export function unhelpful(name: string): boolean {
  const base = baseOf(name.trim());
  if (!base) return true;
  if (/^[0-9a-f]{12,}$/i.test(base.replace(/-/g, ''))) return true; // a random id
  if (/^(img|dsc|dscn|dscf|pxl|mvimg|vid|mov|gopr|dji|sam|wp)[_-]?[a-z]?\d{3,}/i.test(base)) return true; // a camera's
  const words = base
    .toLowerCase()
    .replace(/\(\d+\)/g, ' ')
    .replace(/[_.\-–+~]+/g, ' ')
    .split(/\s+/)
    // Numbers, dates and times, counters like e1234, and the "at" of "at 10.30.00".
    .filter((w) => w && !/^[a-z]{0,2}\d+[a-z]{0,2}$/.test(w) && w !== 'at' && w !== 'am' && w !== 'pm')
    .join(' ');
  return !words || GENERIC.has(words) || (/^copy of /.test(words) && GENERIC.has(words.slice(8)));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-11-26" as "26 Nov 2026".
export function dayWords(day: string): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || ''} ${m[1]}` : day;
}

const TYPE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'application/pdf': 'pdf', 'text/plain': 'txt',
  'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

// What a file is, in one word, for a name made from its date.
function kindWord(f: Pick<FileMeta, 'name' | 'type'>): string {
  const t = f.type;
  if (t.startsWith('image/')) return /scan/i.test(f.name) ? 'Scan' : /screen/i.test(f.name) ? 'Screenshot' : 'Photo';
  if (t.startsWith('video/')) return 'Video';
  if (t.startsWith('audio/')) return 'Recording';
  if (/scan/i.test(f.name)) return 'Scan';
  if (/sheet|excel|csv/.test(t)) return 'Spreadsheet';
  if (/presentation|powerpoint/.test(t)) return 'Slides';
  return 'Document';
}

const tidy = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const words = (s: string, n: number) => s.split(' ').slice(0, n).join(' ');
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const letters = (s: string) => (s.match(/\p{L}/gu) || []).length;

// The first heading of a file's words: a Markdown heading when there is one near the top, else its
// first line, when that reads like a title (short, with letters, not a sentence).
export function firstHeading(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 40);
  const h = lines.find((l) => /^#{1,3}\s+\S/.test(l));
  const line = tidy((h || lines[0] || '').replace(/^#+\s*/, '').replace(/\s+#+$/, '').replace(/[*_`]+/g, ''));
  if (!line || line.length > 70 || letters(line) < 3) return '';
  if (!h && (/[.!?;,]$/.test(line) || line.split(' ').length > 9)) return '';
  return line.replace(/[.:;,\-–]+$/, '').trim();
}

// A name from a description ("A scanned receipt from Tesco for groceries, …" as "Receipt from
// Tesco for groceries"): its first part, without "a photo of" and the like.
export function fromDescription(desc: string): string {
  let s = tidy(desc).split(/[.;:!?(]|,\s|\s-\s|\s–\s/)[0] || '';
  for (let i = 0; i < 3; i++)
    s = s
      .replace(/^(this|it)\s+(is|shows)\s+/i, '')
      .replace(/^(a|an|the)\s+/i, '')
      .replace(/^(scanned|scan|photo(graph)?|picture|image|screenshot|copy|pdf|document|file)\s+(of|showing)\s+/i, '')
      .replace(/^(scanned|photographed)\s+/i, '');
  s = words(s, 7).replace(/\s+(of|for|from|with|and|to|in|on|at|the|a|an)$/i, '');
  return letters(s) >= 3 ? capital(s) : '';
}

export interface NameHints {
  heading?: string; // the file's words (its first heading is used: firstHeading)
  desc?: string; // what "Arise reads it for you" wrote about it
}
export interface Suggestion {
  name: string;
  from: 'heading' | 'description' | 'date';
}

// A better name, or null: when the file's name already says something, when the Player gave it
// that name or kept it, or when there's nothing better.
export function suggestName(f: Pick<FileMeta, 'name' | 'type' | 'day' | 'renamed'>, hints: NameHints = {}): Suggestion | null {
  if (f.renamed || !unhelpful(f.name)) return null;
  const ext = extOf(f.name) || TYPE_EXT[f.type] || '';
  const withExt = (base: string) => `${base.slice(0, 80).trim()}${ext ? `.${ext}` : ''}`;
  const heading = hints.heading ? firstHeading(hints.heading) : '';
  const desc = hints.desc ? fromDescription(hints.desc) : '';
  const pick: Suggestion =
    heading && !unhelpful(heading)
      ? { name: withExt(heading), from: 'heading' }
      : desc && !unhelpful(desc)
        ? { name: withExt(desc), from: 'description' }
        : { name: withExt(`${kindWord(f)} ${dayWords(f.day)}`), from: 'date' };
  return pick.name.toLowerCase() === f.name.toLowerCase() ? null : pick;
}

// Where a suggestion came from, in a few words for the screen.
export const SUGGESTION_FROM: Record<Suggestion['from'], string> = {
  heading: 'From its first heading.',
  description: 'From what Arise wrote about it.',
  date: 'From the day it was added.',
};
