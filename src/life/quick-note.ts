// A note for your day, from Today or Days ("Add to your day"): a few words, a title if you like,
// a mood if you like, and a file if you like. A text file's words go into the note itself. For any
// other file (a photo, a PDF), the note keeps only its name, size and type for now: big files
// aren't stored by this. When Arise can keep files, it plugs in through setFileStore, and the
// note then also keeps where the file went (meta.fileRef).

import type { LifeEvent } from './types';

export const MOODS = ['Low', 'Meh', 'Okay', 'Good', 'Great'];
const MAX_TEXT_BYTES = 1_000_000; // a text file bigger than this is kept like any other file
const MAX_DETAIL = 3900; // the life log keeps 4,000 characters of a detail

export interface Attachment {
  name: string;
  size: number; // bytes
  type: string; // what the file says it is (image/jpeg, text/plain), or ''
  text?: string; // a text file's words
  ref?: string; // where the file itself went, once Arise can keep files
}

// Files whose words can go into the note.
export function isTextFile(f: { name: string; type: string; size: number }): boolean {
  if (f.size > MAX_TEXT_BYTES) return false;
  if (/^text\//.test(f.type) || /^application\/(json|xml|x-yaml|yaml|x-ndjson)$/.test(f.type)) return true;
  return !f.type && /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|ics|vcf|srt)$/i.test(f.name);
}

const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function sizeText(n: number): string {
  if (n < 1000) return `${n} bytes`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}

// ---------- the hook for keeping files

export type FileStore = (file: Blob, info: { noteId: string; name: string; size: number; type: string }) => Promise<string | null>;
let fileStore: FileStore | null = null;

// For the file storage work: keeps a note's file somewhere and says where (a short reference the
// note keeps in meta.fileRef), or null when it didn't. Until one is set, files aren't kept.
export function setFileStore(store: FileStore | null) {
  fileStore = store;
}

// Keeps a note's file through the hook, if there is one. Never throws: the note matters more.
export async function storeNoteFile(file: Blob, info: { noteId: string; name: string; size: number; type: string }): Promise<string | null> {
  if (!fileStore) return null;
  try {
    const ref = await fileStore(file, info);
    return typeof ref === 'string' && ref.length > 0 && ref.length <= 400 ? ref : null;
  } catch {
    return null;
  }
}

// ---------- reading and making the note

export async function readAttachment(file: File): Promise<Attachment> {
  const a: Attachment = { name: oneLine(file.name || 'file', 120) || 'file', size: Math.max(0, file.size || 0), type: oneLine(file.type || '', 80) };
  if (isTextFile(a)) {
    try {
      const text = (await file.text()).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
      if (text) a.text = text;
    } catch {}
  }
  return a;
}

export const newNoteId = () => `manual:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export interface NoteInput {
  text?: string;
  title?: string;
  mood?: number; // 1 to 5, 0 for none
  at: number;
  file?: Attachment;
  id?: string;
}

// The life event for a note, or null when there's nothing in it.
export function makeNote({ text = '', title = '', mood = 0, at, file, id = newNoteId() }: NoteInput): LifeEvent | null {
  const body = text.replace(/\r\n?/g, '\n').trim();
  const head = oneLine(title, 120);
  const feel = mood >= 1 && mood <= 5 ? MOODS[mood - 1] : '';
  if (!body && !head && !feel && !file) return null;
  const first = body.split('\n')[0].trim();
  const named = head || first || (file ? file.name : '');
  const parts: string[] = [];
  if (body) parts.push(body);
  else if (head && !file) parts.push(head);
  if (file?.text) parts.push(`${file.name}:\n${file.text}`);
  else if (file) parts.push(`Attached: ${file.name} (${[sizeText(file.size), file.type].filter(Boolean).join(', ')}).`);
  if (feel && (body || head || file)) parts.push(`Mood: ${feel}.`);
  let detail = parts.join('\n\n');
  if (detail.length > MAX_DETAIL) detail = `${detail.slice(0, MAX_DETAIL)}\n\n(The rest of the file isn't kept.)`;
  const meta: Record<string, string | number | boolean> = {};
  if (feel) meta.mood = feel;
  if (file) {
    meta.file = file.name;
    meta.fileSize = file.size;
    if (file.type) meta.fileType = file.type;
    if (file.ref) meta.fileRef = file.ref;
  }
  return {
    id,
    source: 'manual',
    kind: named ? 'note' : 'mood',
    at,
    title: named ? (named.length > 90 ? `${named.slice(0, 89)}…` : named) : `Mood: ${feel}`,
    tier: 2,
    ...(named ? { detail } : {}),
    ...(feel ? { value: mood, unit: 'mood (1-5)' } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

// Reads the file (if any), keeps it through the hook when it isn't text, and makes the note.
export async function noteWithFile(input: Omit<NoteInput, 'file'>, file?: File | null): Promise<LifeEvent | null> {
  const id = input.id || newNoteId();
  let attachment: Attachment | undefined;
  if (file) {
    attachment = await readAttachment(file);
    if (!attachment.text) {
      const ref = await storeNoteFile(file, { noteId: id, name: attachment.name, size: attachment.size, type: attachment.type });
      if (ref) attachment.ref = ref;
    }
  }
  return makeNote({ ...input, id, file: attachment });
}
