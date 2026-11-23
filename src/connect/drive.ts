// Google Drive, as a part of the Google link (google.ts): the text of the Drive files the Player
// picks goes into the life log as notes, so the coach and what Arise knows learn from them, like
// GitHub's Markdown files. Google Docs as plain text, Markdown and text files as they are, and
// PDFs when their text can be read (pdf-text.ts). A file that changed replaces its note; a file
// taken off the list takes its note with it.
//
// Off unless the Player ticks it when connecting Google. Read-only. Google's own file picker
// would let Arise ask for only the files picked (the drive.file permission), but it's a script
// of Google's that would have to run inside Arise, which Arise's rules don't allow (index.html,
// oauth.ts). So it asks for Drive read-only, the narrowest permission that can open a file the
// Player names, and only ever opens the files on their list. The app says so before they connect.
//
// Read straight from this device (Google allows web pages), on the web like the rest of Google.
// What a file says can be personal: tier 3, so only the private AI or the AI on the device reads it.

import type { LifeEvent } from '../life/types';
import { ConnectError, arr, obj, request, text } from './http';
import { googleError } from './google';
import { pdfText } from './pdf-text';
import { goOn, hand, hash, takeBack } from './sink';
import type { SvcState } from './state';

const API = 'https://www.googleapis.com/drive/v3';
export const MAX_PICKS = 20;
const MAX_DOC = 3900; // characters kept of one file (the life log keeps 4,000 of a detail)
const MAX_TEXT_BYTES = 2_000_000;
const MAX_PDF_BYTES = 10_000_000;
const PICKS = 'drive.picks';
const SEEN = 'drive.seen';

export type Kind = 'doc' | 'text' | 'pdf';
export interface DriveFile {
  id: string;
  name: string;
  mime: string;
  modified: string;
  size: number;
  link: string;
}
export interface Pick {
  id: string;
  name: string;
}

// Which files Arise can read the text of.
export function kindOf(mime: string, name = ''): Kind | null {
  if (mime === 'application/vnd.google-apps.document') return 'doc';
  if (mime === 'application/pdf') return 'pdf';
  if (/^text\/(plain|markdown|x-markdown)$/.test(mime) || /\.(md|markdown|txt)$/i.test(name)) return 'text';
  return null;
}

const ID = /^[A-Za-z0-9_-]{10,120}$/;
// A Drive or Docs link (…/d/<id>/edit, ?id=<id>), or the id itself.
export function fileIdFrom(input: string): string {
  const v = input.trim();
  const m = /\/d\/([A-Za-z0-9_-]{10,120})/.exec(v) || /[?&]id=([A-Za-z0-9_-]{10,120})/.exec(v);
  if (m) return m[1];
  return ID.test(v) ? v : '';
}

// ---------- the list, kept with the Google link on this device (state.ts)

export function picks(st: SvcState): Pick[] {
  try {
    const v = JSON.parse(st.cursors[PICKS] || '[]');
    return arr(v)
      .map(obj)
      .filter((p) => typeof p.id === 'string' && ID.test(p.id))
      .map((p) => ({ id: p.id as string, name: text(p.name, 120) || 'Drive file' }))
      .slice(0, MAX_PICKS);
  } catch {
    return [];
  }
}

// Sets the list. Returns the ids that left it (their notes come out: see forgetFiles).
export function setPicks(st: SvcState, list: Pick[]): string[] {
  const clean = [...new Map(list.filter((p) => ID.test(p.id)).map((p) => [p.id, { id: p.id, name: text(p.name, 120) || 'Drive file' }])).values()].slice(0, MAX_PICKS);
  const before = picks(st).map((p) => p.id);
  if (clean.length) st.cursors[PICKS] = JSON.stringify(clean);
  else delete st.cursors[PICKS];
  const now = new Set(clean.map((p) => p.id));
  const seen = seenOf(st);
  for (const id of Object.keys(seen)) if (!now.has(id)) delete seen[id];
  st.cursors[SEEN] = JSON.stringify(seen);
  return before.filter((id) => !now.has(id));
}

function seenOf(st: SvcState): Record<string, string> {
  try {
    const v = JSON.parse(st.cursors[SEEN] || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export const noteId = (fileId: string) => `other:gdrive:${hash(fileId)}`;

// Takes the notes of files no longer picked back out of the life log.
export const forgetFiles = (ids: string[]) => takeBack('google', ids.map(noteId));

// ---------- requests

async function get(st: SvcState, url: string): Promise<unknown> {
  goOn('google');
  const res = await request({ url, headers: { Authorization: `Bearer ${st.auth.token}` } });
  if (res.status >= 200 && res.status < 300) return res.data;
  throw googleError(res);
}

const FIELDS = 'id,name,mimeType,modifiedTime,size,trashed,webViewLink';
const asFile = (v: unknown): DriveFile | null => {
  const f = obj(v);
  if (typeof f.id !== 'string' || !ID.test(f.id) || f.trashed === true) return null;
  const link = typeof f.webViewLink === 'string' && /^https:\/\/(docs|drive)\.google\.com\/[^\s"'<>`]{1,1500}$/.test(f.webViewLink) ? f.webViewLink : '';
  return { id: f.id, name: text(f.name, 120) || 'Drive file', mime: text(f.mimeType, 120), modified: text(f.modifiedTime, 40), size: Number(f.size) || 0, link };
};

// Files whose text Arise can read, newest first, whose name has `words` (or all of them).
export async function search(st: SvcState, words = ''): Promise<DriveFile[]> {
  const types = "(mimeType = 'application/vnd.google-apps.document' or mimeType = 'text/plain' or mimeType = 'text/markdown' or mimeType = 'application/pdf' or name contains '.md')";
  const w = words.replace(/[\\']/g, ' ').trim().slice(0, 100);
  const q = `trashed = false and ${types}${w ? ` and name contains '${w}'` : ''}`;
  const data = obj(await get(st, `${API}/files?${new URLSearchParams({ q, fields: `files(${FIELDS})`, orderBy: 'modifiedTime desc', pageSize: '30', spaces: 'drive' })}`));
  return arr(data.files)
    .map(asFile)
    .filter((f): f is DriveFile => !!f && !!kindOf(f.mime, f.name));
}

export async function fileInfo(st: SvcState, id: string): Promise<DriveFile | null> {
  return asFile(await get(st, `${API}/files/${encodeURIComponent(id)}?${new URLSearchParams({ fields: FIELDS, supportsAllDrives: 'true' })}`));
}

// A PDF's bytes: straight with fetch (Google allows web pages, and Drive is only on the web).
async function bytes(st: SvcState, id: string): Promise<Uint8Array> {
  goOn('google');
  let res: Response;
  try {
    res = await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${st.auth.token}` }, credentials: 'omit', cache: 'no-store' });
  } catch {
    throw new ConnectError('net', "Google didn't answer. Arise will try again later.");
  }
  if (!res.ok) throw googleError({ status: res.status, data: await res.json().catch(() => ({})), headers: {} });
  return new Uint8Array(await res.arrayBuffer());
}

// The text of one file, or '' when there's none Arise can read.
export async function readText(st: SvcState, f: DriveFile): Promise<string> {
  const kind = kindOf(f.mime, f.name);
  if (kind === 'doc') {
    const data = await get(st, `${API}/files/${encodeURIComponent(f.id)}/export?mimeType=text%2Fplain`);
    return (typeof data === 'string' ? data : JSON.stringify(data)).replace(/^﻿/, '');
  }
  if (kind === 'text') {
    if (f.size > MAX_TEXT_BYTES) return '';
    const data = await get(st, `${API}/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`);
    return typeof data === 'string' ? data : JSON.stringify(data, null, 1);
  }
  if (kind === 'pdf') {
    if (f.size > MAX_PDF_BYTES) return '';
    return pdfText(await bytes(st, f.id));
  }
  return '';
}

export function noteEvent(f: DriveFile, body: string, at: number): LifeEvent {
  const clean = body.replace(/\r\n?/g, '\n').trim();
  const kept = clean.length > MAX_DOC ? `${clean.slice(0, MAX_DOC)}\n\n(The rest is in Google Drive.)` : clean;
  return {
    id: noteId(f.id),
    source: 'other',
    kind: 'note',
    at,
    title: `Drive: ${f.name}`,
    detail: kept,
    ...(f.link ? { url: f.link } : {}),
    tier: 3,
    meta: { app: 'google-drive', file: f.name },
  };
}

// Reads each picked file that changed since last time.
export async function syncDrive(st: SvcState, ctx: { save(): void }, now = Date.now()) {
  const list = picks(st);
  const seen = seenOf(st);
  const out: LifeEvent[] = [];
  const names: Pick[] = [];
  for (const p of list) {
    let f: DriveFile | null;
    try {
      f = await fileInfo(st, p.id);
    } catch (e) {
      // Gone, or no longer shared with them: its note stays until they take it off the list.
      if (e instanceof ConnectError && (e.kind === 'gone' || e.status === 403)) {
        names.push(p);
        continue;
      }
      throw e;
    }
    if (!f || !kindOf(f.mime, f.name)) {
      names.push(p);
      continue;
    }
    names.push({ id: f.id, name: f.name });
    const version = `${f.modified}|${f.size}|${f.name}`;
    if (seen[f.id] === version) continue;
    const body = await readText(st, f);
    seen[f.id] = version;
    if (body.trim()) out.push(noteEvent(f, body, now));
  }
  await hand('google', out, { replace: true });
  st.cursors[PICKS] = JSON.stringify(names.slice(0, MAX_PICKS));
  st.cursors[SEEN] = JSON.stringify(seen);
  ctx.save();
}
