// Bringing in years of history from the exports services give people. The file is read here,
// on the device (in a Web Worker: see client.ts and worker.ts), and nothing is uploaded.
//
//   detect(file, signal)  what the file (or zip) holds, and anything to ask before reading it
//   importFile(file, …)   reads it, handing over events about 500 at a time
//
// Both work on any Blob with a name (a File), anywhere: the worker, the page, or a test.

import type { LifeEvent } from '../types';
import type { Detection, Found, ImportChoices, ImportKind, ImportOptions, ImportResult, Progress, TextInput } from './types';
import { entryBytes, entryHead, isZip, listZip, ZipError, type ZipEntry } from './zip';
import { parseChromeHistory, parseMyActivity } from './google';
import { parseSemanticHistory, parseTimeline } from './maps';
import { parseSpotify } from './spotify';
import { netflixProfiles, parseNetflixActivity, parseNetflixHistory } from './netflix';
import { parseAppleHealth } from './health';
import { chatLine, chatName, parseWhatsApp } from './whatsapp';
import { guessCsv, parseBankCsv } from './bank';
import { onePart } from './chat';
import { parseTelegram } from './telegram';
import { META_PROFILE, META_THREAD, parseMeta } from './meta';
import { parseX, X_ACCOUNT, X_DMS } from './x';
import { parseTikTok, TIKTOK } from './tiktok';
import { parseSnapchat, SNAPCHAT } from './snapchat';
import { DISCORD_FILE, DISCORD_INDEX, parseDiscord } from './discord';
import { isLinkedInMessages, parseLinkedIn } from './linkedin';
import { listClaude, parseClaude } from './claude';
import { listChatGPT, parseChatGPT } from './chatgpt';
import { listGemini, parseGemini } from './gemini';
import { APPLE_NOTES, isAppleNote, parseAppleNotes, parseFileNotes } from './markdown';
import { NOTION_NAME, parseNotion } from './notion';
import { KEEP_HEAD, KEEP_PATH, parseKeep } from './keep';
import { parseWord, WORD_BODY, WORD_PROPS } from './word';
import { parsePdf } from './pdf';
import { FITBIT_FILE, FITBIT_HEAD, parseFitbit } from './fitbit';

export type * from './types';

type Named = Blob & { name?: string };

const CHUNK = 1 << 20;
const SNIFF = 8192;
const CSV_HEAD = 256 << 10;

// ---------- reading

async function* fileBytes(blob: Blob, onRead?: (n: number) => void, limit = Infinity): AsyncGenerator<Uint8Array> {
  const end = Math.min(blob.size, limit);
  for (let at = 0; at < end; at += CHUNK) {
    const b = new Uint8Array(await blob.slice(at, Math.min(end, at + CHUNK)).arrayBuffer());
    onRead?.(b.length);
    yield b;
  }
}

async function* decode(bytes: AsyncIterable<Uint8Array>, encoding = 'utf-8'): AsyncGenerator<string> {
  const d = new TextDecoder(encoding);
  for await (const b of bytes) {
    const s = d.decode(b, { stream: true });
    if (s) yield s;
  }
  const t = d.decode();
  if (t) yield t;
}

// Some banks still write Windows-1252: if the start isn't UTF-8, read it as that.
function encodingOf(head: Uint8Array): string | undefined {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return undefined;
  } catch {
    return 'windows-1252';
  }
}

class Cancelled extends Error {}

// The same for bytes.
async function* guardBytes(it: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  for await (const b of it) {
    if (signal?.aborted) throw new Cancelled();
    yield b;
  }
}

// Every piece read is a chance to stop.
async function* guard(it: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<string> {
  for await (const s of it) {
    if (signal?.aborted) throw new Cancelled();
    yield s;
  }
}

async function text(it: AsyncIterable<string>, max = Infinity): Promise<string> {
  let s = '';
  for await (const c of it) {
    s += c;
    if (s.length >= max) break;
  }
  return s;
}

// ---------- what a file is

export const KIND_LABEL: Record<ImportKind, string> = {
  'google-activity': 'Google activity',
  'chrome-history': 'Chrome history',
  'maps-timeline': 'Google Maps Timeline',
  'maps-semantic': 'Google Maps Timeline (older export)',
  'spotify-account': 'Spotify listening (last year)',
  'spotify-extended': 'Spotify listening (all years)',
  'netflix-activity': 'Netflix viewing',
  'netflix-history': 'Netflix viewing (days only)',
  'apple-health': 'Apple Health',
  whatsapp: 'WhatsApp chat',
  telegram: 'Telegram chats',
  instagram: 'Instagram messages',
  messenger: 'Messenger chats',
  'x-messages': 'X messages',
  tiktok: 'TikTok messages',
  snapchat: 'Snapchat chats',
  discord: 'Discord messages',
  linkedin: 'LinkedIn messages',
  claude: 'Claude chats',
  chatgpt: 'ChatGPT chats',
  gemini: 'Gemini chats',
  'bank-csv': 'Bank statement',
  obsidian: 'Obsidian notes',
  notion: 'Notion pages',
  'apple-notes': 'Apple Notes',
  notes: 'Notes',
  'note-file': 'A note',
  keep: 'Google Keep notes',
  word: 'Word document',
  pdf: 'PDF',
  fitbit: 'Fitbit',
};

// Notes and documents: one note event each (notes.ts).
export const NOTE_KINDS: ReadonlySet<ImportKind> = new Set(['obsidian', 'notion', 'apple-notes', 'notes', 'note-file', 'keep', 'word', 'pdf']);
// Documents whose words may not be readable (a scanned PDF): then the Player is told.
const DOCUMENTS: ReadonlySet<ImportKind> = new Set(['word', 'pdf']);

// Kinds of chat from a social app: one event per chat per day, read from one or more files.
const SOCIAL: ReadonlySet<ImportKind> = new Set(['telegram', 'instagram', 'messenger', 'x-messages', 'tiktok', 'snapchat', 'discord', 'linkedin']);

// Chats with AI apps: each conversation is listed first (Found.chats), so the Player can pick.
export const AI_KINDS: ReadonlySet<ImportKind> = new Set(['claude', 'chatgpt', 'gemini']);

// Gemini's My Activity, known from its folder in a Takeout ("My Activity/Gemini Apps/", "Bard"
// before 2024, in any language) or from the records' product.
const GEMINI_PATH = /(^|\/)[^/]*(gemini|bard)[^/]*\/[^/]+\.(json|html?)$/i;
const GEMINI_HEAD = /"(header|products)"\s*:\s*\[?\s*"(Gemini|Bard)\b/;

const TELEGRAM_TYPE = /"type"\s*:\s*"(personal_chat|bot_chat|private_group|private_supergroup|public_supergroup)"/;

const isChat = (head: string) => {
  const lines = head.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 15);
  const hits = lines.filter((l) => chatLine(l)?.sender).length;
  return hits >= Math.min(2, lines.length) && hits > 0;
};

// What a file holds, from its name and its first few kilobytes. 'html' for a Google Takeout
// made with HTML instead of JSON. null for anything else.
export function classify(name: string, head: string, inZip: boolean): ImportKind | 'html' | null {
  const t = head.replace(/^﻿/, '').trimStart();
  const lower = name.toLowerCase();
  if (t.startsWith('%PDF-')) return 'pdf';
  if (!inZip && /\.(md|markdown)$/.test(lower)) return 'note-file';
  if (t.startsWith('<')) {
    if (/<HealthData[\s>]|<!DOCTYPE HealthData/.test(t)) return 'apple-health';
    if (/<html/i.test(t) && /outer-cell|content-cell|mdl-grid/.test(t)) return GEMINI_PATH.test(name) || /Gemini Apps/.test(t) ? 'gemini' : 'html';
    // A web page on its own (a note saved as HTML).
    if (!inZip && /\.html?$/.test(lower)) return 'note-file';
    return null;
  }
  // The X archive's messages: JavaScript that sets a variable to JSON.
  if (/^window\.YTD\.direct_messages?(_group)?\.part\d+\s*=/.test(t)) return 'x-messages';
  // JSON: an object, or an array of objects (an iPhone WhatsApp chat starts with "[13/01/24" too).
  if (/^\{|^\[\s*([[{"\]]|$)/.test(t)) {
    if (t.startsWith('{')) {
      // A Google Keep note: when it was made or changed, in microseconds.
      if (KEEP_HEAD.test(t) && /"(textContent|listContent|title)"\s*:/.test(t)) return 'keep';
      // Telegram: a full export (who the Player is, then their chats), or one chat on its own.
      if (/"personal_information"\s*:\s*\{/.test(t) && /"user_id"\s*:/.test(t)) return 'telegram';
      if (/"chats"\s*:\s*\{\s*"about"/.test(t) || (TELEGRAM_TYPE.test(t) && /"messages"\s*:\s*\[/.test(t))) return 'telegram';
      if (!inZip) {
        // On their own (a zip is known by where its files are): a Meta chat, TikTok, Snapchat.
        if (/"participants"\s*:/.test(t) && /"(sender_name|senderName)"\s*:/.test(t)) return /instagram/.test(lower) ? 'instagram' : 'messenger';
        if (TIKTOK.test(lower)) return 'tiktok';
        if (SNAPCHAT.test(lower)) return 'snapchat';
      }
    }
    // An AI app's conversations.json, told apart by shape: Claude's have "chat_messages",
    // ChatGPT's a "mapping" of messages.
    if (/^\[\s*\{/.test(t)) {
      if (/"chat_messages"\s*:/.test(t) && /"uuid"\s*:/.test(t)) return 'claude';
      if (/"mapping"\s*:\s*\{/.test(t) && /"(create_time|current_node|conversation_id)"\s*:/.test(t)) return 'chatgpt';
    }
    if (FITBIT_FILE.test(name) && FITBIT_HEAD.test(t)) return 'fitbit';
    if (/"semanticSegments"\s*:/.test(t)) return 'maps-timeline';
    if (/^\[\s*\{/.test(t) && /"(startTime|endTime)"\s*:/.test(t) && /"(visit|activity|timelinePath|timelineMemory)"\s*:/.test(t)) return 'maps-timeline';
    if (/"timelineObjects"\s*:/.test(t)) return 'maps-semantic';
    if (/"Browser History"\s*:/.test(t)) return 'chrome-history';
    if (/"ms_played"\s*:|"master_metadata_track_name"\s*:/.test(t)) return 'spotify-extended';
    if (/"msPlayed"\s*:/.test(t)) return 'spotify-account';
    if (/^\[\s*\{/.test(t) && /"header"\s*:/.test(t) && /"title"\s*:/.test(t) && /"time"\s*:/.test(t)) return GEMINI_PATH.test(name) || GEMINI_HEAD.test(t) ? 'gemini' : 'google-activity';
    return null;
  }
  const first = (t.split(/\r\n|\n|\r/, 1)[0] ?? '').toLowerCase().replace(/"/g, '').trim();
  if (isLinkedInMessages(first)) return 'linkedin';
  if (/^profile name,start time,duration\b/.test(first)) return 'netflix-activity';
  if (/^title,date$/.test(first)) return 'netflix-history';
  // The same files with the column names in another language: known by their names.
  const columns = first.split(',').length;
  if (/netflixviewinghistory[^/]*\.csv$/.test(lower) && columns === 2) return 'netflix-history';
  if (/viewingactivity\.csv$/.test(lower) && columns >= 7) return 'netflix-activity';
  if ((lower.endsWith('.txt') || !/\.\w{2,4}$/.test(lower)) && isChat(t)) return 'whatsapp';
  if (!inZip && /\.(csv|tsv|txt)$/.test(lower)) return 'bank-csv';
  return null;
}

function labelFor(kind: ImportKind, path: string, outer: string): string {
  if (kind === 'google-activity') {
    if (/youtube/i.test(path)) return /search/i.test(path) ? 'YouTube searches' : 'YouTube history';
    const parts = path.split('/');
    const product = parts.length >= 3 ? parts[parts.length - 2] : '';
    return product ? `Google activity: ${product}` : KIND_LABEL[kind];
  }
  if (kind === 'whatsapp') {
    const who = chatName(path) || chatName(outer);
    return who ? `WhatsApp chat with ${who}` : KIND_LABEL[kind];
  }
  return KIND_LABEL[kind];
}

// Google Photos and the like put a JSON next to every photo: never worth a look.
const SKIP = /\.(jpe?g|png|heic|heif|gif|webp|mp4|mov|avi|3gp|m4v|dng|raw)\.json$|supplemental-metadata|archive_browser\.html$/i;
const LOOK = /\.(json|csv|tsv|txt|xml|html?)$/i;

// What's in a file: which sources, and what to ask before reading them. A big zip can take a
// while, so `signal` stops it (between entries): then nothing is found and `cancelled` is set.
export async function detect(file: Named, signal?: AbortSignal): Promise<Detection> {
  const name = file.name ?? 'file';
  const d: Detection = { name, size: file.size, zip: false, found: [] };
  try {
    return await look(file, d, signal);
  } catch (err) {
    if (err instanceof Cancelled) return { name, size: file.size, zip: d.zip, found: [], cancelled: true };
    throw err;
  }
}

async function look(file: Named, d: Detection, signal?: AbortSignal): Promise<Detection> {
  const name = d.name;
  if (!file.size) return { ...d, problem: 'empty' };
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (magic[0] === 0x1f && magic[1] === 0x8b) return { ...d, problem: 'tgz' };
  let html = 0;
  if (await isZip(file)) {
    d.zip = true;
    let entries: ZipEntry[];
    try {
      entries = await listZip(file);
    } catch {
      return { ...d, problem: 'unknown' };
    }
    // A Word document is a zip: its words are in word/document.xml.
    const body = entries.find((e) => e.name === WORD_BODY);
    if (body) {
      const props = entries.find((e) => e.name === WORD_PROPS);
      const parts = props ? [props, body] : [body];
      d.found.push({ kind: 'word', path: WORD_BODY, size: parts.reduce((s, e) => s + e.packed, 0), label: KIND_LABEL.word, parts: parts.map((e) => e.name), file: name });
      return d;
    }
    let unopenable = 0;
    const social = new Social(name, entries);
    const files = new FileGroups(entries);
    for (const e of entries) {
      if (signal?.aborted) throw new Cancelled();
      if (!e.size || SKIP.test(e.name)) continue;
      if (social.take(e) || files.take(e) || !LOOK.test(e.name)) continue;
      let head: Uint8Array;
      try {
        head = await entryHead(file, e, SNIFF);
      } catch (err) {
        if (err instanceof ZipError && err.code === 'method') unopenable++;
        continue;
      }
      const encoding = encodingOf(head);
      const kind = classify(e.name, new TextDecoder(encoding ?? 'utf-8').decode(head), true);
      if (kind === 'html') html++;
      else if (kind) d.found.push(await describe(kind, e.name, e.packed, name, encoding, () => guard(decode(entryBytes(file, e), encoding), signal)));
    }
    d.found.push(...social.found());
    d.found.push(...files.found(d.found.length));
    // Gemini saved both ways: the JSON is enough.
    if (d.found.some((f) => f.kind === 'gemini' && !/\.html?$/i.test(f.path))) d.found = d.found.filter((f) => f.kind !== 'gemini' || !/\.html?$/i.test(f.path));
    if (!d.found.length) d.problem = html ? 'html' : unopenable ? 'zip-method' : 'unknown';
  } else {
    const head = new Uint8Array(await file.slice(0, SNIFF).arrayBuffer());
    const encoding = encodingOf(head);
    const kind = classify(name, new TextDecoder(encoding ?? 'utf-8').decode(head), false);
    if (kind === 'html') html++;
    else if (kind) {
      const f = await describe(kind, name, file.size, name, encoding, () => guard(decode(fileBytes(file), encoding), signal));
      if (f.kind !== 'bank-csv' || f.csv?.ok) d.found.push(f);
      // A text file that isn't a statement: a note.
      else if (/\.txt$/i.test(name)) d.found.push({ kind: 'note-file', path: name, size: file.size, label: KIND_LABEL['note-file'], ...(encoding ? { encoding } : {}) });
    }
    if (!d.found.length) d.problem = html ? 'html' : 'unknown';
  }
  if (html && d.found.length) d.html = html;
  return d;
}

// Messages from social apps in a zip: known by where their files are, and each app's files read
// together as one part (a Meta inbox has a file or more per chat; Discord a folder per channel).
class Social {
  private groups = new Map<ImportKind, { path: string; parts: ZipEntry[]; extra: ZipEntry[] }>();
  private profiles: ZipEntry[] = [];
  private xAccount: ZipEntry[] = [];
  private discordIndex: ZipEntry[] = [];
  private meta: 'instagram' | 'messenger';

  constructor(outer: string, entries: ZipEntry[]) {
    // An older Meta export has no "your_instagram_activity/": which app it's from, from the zip's
    // name ("instagram-anna-2024-01-01.zip") or the folders only one of them has.
    const names = entries.map((e) => e.name.toLowerCase());
    const insta = /instagram/i.test(outer) || names.some((n) => /(^|\/)(your_instagram_activity|followers_and_following|personal_information\/personal_information)\//.test(n));
    const face = /facebook/i.test(outer) || names.some((n) => /(^|\/)(your_facebook_activity|profile_information|friends_and_followers)\//.test(n));
    this.meta = insta && !face ? 'instagram' : 'messenger';
  }

  private add(kind: ImportKind, path: string, e: ZipEntry) {
    let g = this.groups.get(kind);
    if (!g) this.groups.set(kind, (g = { path, parts: [], extra: [] }));
    g.parts.push(e);
  }

  // Whether the entry is one of theirs (and so needs no other look).
  take(e: ZipEntry): boolean {
    const n = e.name;
    const thread = n.match(META_THREAD);
    if (thread) {
      const kind = /(^|\/)your_instagram_activity\//i.test(n) ? 'instagram' : /(^|\/)your_facebook_activity\//i.test(n) ? 'messenger' : this.meta;
      this.add(kind, n.slice(0, thread.index! + thread[0].indexOf('messages/') + 'messages'.length), e);
      return true;
    }
    if (META_PROFILE.test(n)) return this.profiles.push(e), true;
    if (X_ACCOUNT.test(n)) return this.xAccount.push(e), true;
    if (X_DMS.test(n)) return this.add('x-messages', n, e), true;
    if (TIKTOK.test(n)) return this.add('tiktok', n, e), true;
    if (SNAPCHAT.test(n)) return this.add('snapchat', n, e), true;
    if (DISCORD_INDEX.test(n)) return this.discordIndex.push(e), true;
    const discord = n.match(DISCORD_FILE);
    if (discord) return this.add('discord', n.slice(0, discord.index! + discord[0].search(/messages\//i) + 'messages'.length), e), true;
    return false;
  }

  found(): Found[] {
    const out: Found[] = [];
    for (const [kind, g] of this.groups) {
      const first = kind === 'instagram' || kind === 'messenger' ? this.profiles : kind === 'x-messages' ? this.xAccount : kind === 'discord' ? this.discordIndex : [];
      const all = [...first, ...g.parts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))];
      const f: Found = { kind, path: g.path, size: all.reduce((s, e) => s + e.packed, 0), label: KIND_LABEL[kind] };
      if (all.length > 1 || all[0].name !== g.path) f.parts = all.map((e) => e.name);
      out.push(f);
    }
    return out;
  }
}

// Notes, documents and day totals in a zip, known by where their files are, each kind read as
// one part: an Obsidian vault (the folder with .obsidian in it), Notion's export (names ending in
// a long id), Apple Notes (the "iCloud Notes" folder), Google Keep, Fitbit, and Markdown files.
class FileGroups {
  private vault: string | null = null; // the folder with .obsidian in it
  private notion = false;
  private md: ZipEntry[] = [];
  private csv: ZipEntry[] = []; // Notion's databases
  private apple: ZipEntry[] = [];
  private appleRoot = '';
  private keep: ZipEntry[] = [];
  private fitbit: ZipEntry[] = [];

  constructor(entries: ZipEntry[]) {
    for (const e of entries) {
      const m = e.name.match(/^(.*?)\.obsidian\//);
      if (m && (this.vault === null || m[1].length < this.vault.length)) this.vault = m[1];
      if (NOTION_NAME.test(e.name)) this.notion = true;
    }
  }

  // Whether the entry is one of these (and so needs no other look).
  take(e: ZipEntry): boolean {
    const n = e.name;
    // What a Mac adds to a zip it makes: not the Player's files.
    if (/(^|\/)(__MACOSX\/|\._)/.test(n)) return false;
    // A vault's settings and its bin.
    if (/(^|\/)\.(obsidian|trash)\//.test(n)) return true;
    if (APPLE_NOTES.test(n)) {
      if (isAppleNote(n)) {
        const m = n.match(APPLE_NOTES)!;
        if (!this.apple.length) this.appleRoot = n.slice(0, m.index! + m[0].length);
        this.apple.push(e);
      }
      return true;
    }
    if (KEEP_PATH.test(n)) return this.keep.push(e), true;
    if (FITBIT_FILE.test(n)) return this.fitbit.push(e), true;
    if (/\.(md|markdown)$/i.test(n)) return this.md.push(e), true;
    if (this.notion && /\.csv$/i.test(n) && NOTION_NAME.test(n)) return this.csv.push(e), true;
    return false;
  }

  // `others`: how many other things the zip has. Markdown files alone are notes; next to other
  // things (a README in an app's export), they're left out.
  found(others: number): Found[] {
    const out: Found[] = [];
    const byName = (a: ZipEntry, b: ZipEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const add = (kind: ImportKind, path: string, list: ZipEntry[]) => {
      if (!list.length) return;
      out.push({ kind, path, size: list.reduce((s, e) => s + e.packed, 0), label: KIND_LABEL[kind], parts: list.map((e) => e.name) });
    };
    const md = this.md.sort(byName);
    if (this.notion) {
      // A database written twice: the "_all" one has every row.
      const all = new Set(this.csv.filter((e) => /_all\.csv$/i.test(e.name)).map((e) => e.name.replace(/_all\.csv$/i, '.csv')));
      const csv = this.csv.filter((e) => !all.has(e.name)).sort(byName);
      add('notion', `${commonDir([...md, ...csv])}*.md`, [...md, ...csv]);
    } else if (this.vault !== null) add('obsidian', `${this.vault}*.md`, md);
    else if (!others && !this.apple.length && !this.keep.length && !this.fitbit.length) add('notes', `${commonDir(md)}*.md`, md);
    // Apple's list of notes first, for their dates.
    const csvFirst = (a: ZipEntry, b: ZipEntry) => Number(/\.csv$/i.test(b.name)) - Number(/\.csv$/i.test(a.name)) || byName(a, b);
    add('apple-notes', `${this.appleRoot}*.txt`, this.apple.sort(csvFirst));
    add('keep', `${commonDir(this.keep)}*.json`, this.keep.sort(byName));
    add('fitbit', `${commonDir(this.fitbit)}*.json`, this.fitbit.sort(byName));
    return out;
  }
}

// The folder all of these are in ("Takeout/Keep/"), or ''.
function commonDir(list: ZipEntry[]): string {
  if (!list.length) return '';
  let dir = list[0].name.slice(0, list[0].name.lastIndexOf('/') + 1);
  for (const e of list) while (dir && !e.name.startsWith(dir)) dir = dir.slice(0, dir.slice(0, -1).lastIndexOf('/') + 1);
  return dir;
}

async function describe(kind: ImportKind, path: string, size: number, outer: string, encoding: string | undefined, read: () => AsyncIterable<string>): Promise<Found> {
  const f: Found = { kind, path, size, label: labelFor(kind, path, outer) };
  if (encoding) f.encoding = encoding;
  if (kind === 'netflix-activity') f.profiles = await netflixProfiles({ name: path, text: read() });
  if (kind === 'bank-csv') f.csv = guessCsv(await text(read(), CSV_HEAD));
  if (kind === 'whatsapp') {
    const who = chatName(path) || chatName(outer);
    if (who) f.chat = who;
  }
  // Every conversation, for the picker: the whole file is read once to list them.
  if (kind === 'claude') f.chats = await listClaude({ name: path, text: read() });
  if (kind === 'chatgpt') f.chats = await listChatGPT({ name: path, text: read() });
  if (kind === 'gemini') f.chats = await listGemini({ name: path, text: read() });
  return f;
}

// ---------- reading it in

// Files whose events are totals for a day: a newer export completes the day the older one was
// made on, so the store replaces what it has (see ImportOptions.onEvents).
// Notes too: a newer export has the newer words.
const TOTALS: ReadonlySet<ImportKind> = new Set(['apple-health', 'whatsapp', 'fitbit', ...SOCIAL, ...AI_KINDS, ...NOTE_KINDS]);

// The folder a group of files is in (FileGroups gives it as the part's path: "Vault/*.md").
const rootOf = (path: string) => (path.includes('*') ? path.slice(0, path.lastIndexOf('*')) : '');

function parserFor(f: Found, input: TextInput, choices: ImportChoices, parts: AsyncIterable<TextInput>): AsyncGenerator<LifeEvent[]> {
  switch (f.kind) {
    case 'google-activity':
      return parseMyActivity(input);
    case 'chrome-history':
      return parseChromeHistory(input);
    case 'maps-timeline':
      return parseTimeline(input);
    case 'maps-semantic':
      return parseSemanticHistory(input);
    case 'spotify-account':
    case 'spotify-extended':
      return parseSpotify(input);
    case 'netflix-activity':
      return parseNetflixActivity(input, { profiles: choices.profiles });
    case 'netflix-history':
      return parseNetflixHistory(input);
    case 'apple-health':
      return parseAppleHealth(input);
    case 'whatsapp':
      return parseWhatsApp(input, { chat: f.chat });
    case 'bank-csv':
      return parseBankCsv(input, choices.csv ?? f.csv!.mapping);
    case 'telegram':
      return parseTelegram(parts);
    case 'instagram':
    case 'messenger':
      return parseMeta(parts, f.kind);
    case 'x-messages':
      return parseX(parts);
    case 'tiktok':
      return parseTikTok(parts);
    case 'snapchat':
      return parseSnapchat(parts);
    case 'discord':
      return parseDiscord(parts);
    case 'linkedin':
      return parseLinkedIn(parts);
    case 'claude':
      return parseClaude(input, choices.chats);
    case 'chatgpt':
      return parseChatGPT(input, choices.chats);
    case 'gemini':
      return parseGemini(input, choices.chats);
    case 'obsidian':
      return parseFileNotes(parts, { app: 'Obsidian', root: rootOf(f.path) });
    case 'notes':
    case 'note-file':
      return parseFileNotes(parts, { app: 'Notes', root: f.kind === 'notes' ? rootOf(f.path) : '' });
    case 'notion':
      return parseNotion(parts, rootOf(f.path));
    case 'apple-notes':
      return parseAppleNotes(parts, rootOf(f.path));
    case 'keep':
      return parseKeep(parts);
    case 'word':
      return parseWord(parts, f.file);
    case 'pdf':
      return parsePdf(input);
    case 'fitbit':
      return parseFitbit(parts);
  }
}

// The text of one part, which stops at a damaged spot instead of stopping the rest.
async function* keepGoing(text: AsyncIterable<string>, onDamage: (err: ZipError) => void): AsyncGenerator<string> {
  try {
    yield* text;
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    onDamage(err);
  }
}

export async function importFile(file: Named, opts: ImportOptions): Promise<ImportResult> {
  const detection = opts.detection ?? (await detect(file, opts.signal));
  if (detection.cancelled) return { found: 0, added: 0, labels: [], cancelled: true };
  const parts = detection.found.filter((f) => !opts.paths || opts.paths.includes(f.path));
  const result: ImportResult = { found: 0, added: 0, labels: [] };
  if (detection.problem) result.problem = detection.problem;
  if (!parts.length) return result;
  const total = parts.reduce((s, f) => s + f.size, 0);
  let read = 0;
  let label = '';
  let last = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!opts.onProgress || (!force && now - last < 100)) return;
    last = now;
    const p: Progress = { read: Math.min(read, total), total, found: result.found, label };
    opts.onProgress(p);
  };
  const onRead = (n: number) => {
    read += n;
    report();
  };
  const signal = opts.signal;
  // When the file was last changed: the time of a note that says nothing else.
  const changed = typeof (file as File).lastModified === 'number' && (file as File).lastModified > 0 ? (file as File).lastModified : undefined;
  try {
    const entries = detection.zip ? new Map((await listZip(file)).map((e) => [e.name, e])) : null;
    for (const f of parts) {
      if (signal?.aborted) throw new Cancelled();
      label = f.label;
      report(true);
      const before = read;
      const open = (path: string): TextInput | null => {
        const entry = entries?.get(path);
        if (entries && !entry) return null;
        const bytes = () => (entry ? entryBytes(file, entry, onRead) : fileBytes(file, onRead));
        const one: TextInput = { name: path, text: guard(decode(bytes(), f.encoding), signal), raw: () => guardBytes(bytes(), signal) };
        const modified = entry?.modified ?? changed;
        if (modified) one.modified = modified;
        return one;
      };
      // A part read with others (a chat in a Meta inbox): one that's damaged is left out, and
      // the rest go on.
      const hurt: { err?: ZipError } = {};
      async function* parts(): AsyncGenerator<TextInput> {
        for (const path of f.parts!) {
          const one = open(path);
          if (one) yield { ...one, text: keepGoing(one.text, (err) => (hurt.err ??= err)) };
        }
      }
      const input = f.parts ? { name: f.path, text: (async function* () {})() } : open(f.path);
      if (!input) continue;
      const foundBefore = result.found;
      try {
        for await (const batch of parserFor(f, input, opts, f.parts ? parts() : onePart(input))) {
          if (!batch.length) continue;
          for (const e of batch) {
            if (result.from === undefined || e.at < result.from) result.from = e.at;
            if (result.to === undefined || e.at > result.to) result.to = e.at;
          }
          result.found += batch.length;
          const added = await (TOTALS.has(f.kind) ? opts.onEvents(batch, { replace: true }) : opts.onEvents(batch));
          result.added += typeof added === 'number' && Number.isFinite(added) ? added : batch.length;
          if (signal?.aborted) throw new Cancelled();
          report();
        }
      } catch (err) {
        // One part of the zip is damaged: say which, keep what it gave, and go on with the rest.
        if (!(err instanceof ZipError)) throw err;
        result.problem ??= err.code === 'method' ? 'zip-method' : 'unknown';
        result.failed ??= [];
        if (!result.failed.includes(f.label)) result.failed.push(f.label);
        read = before + f.size;
        continue;
      }
      if (hurt.err) {
        const err = hurt.err;
        result.problem ??= err.code === 'method' ? 'zip-method' : 'unknown';
        result.failed ??= [];
        if (!result.failed.includes(f.label)) result.failed.push(f.label);
      }
      read = before + f.size;
      // A document with no words Arise can read (a scan): say so, as nothing else will.
      if (DOCUMENTS.has(f.kind) && result.found === foundBefore) {
        result.problem ??= 'no-text';
        continue;
      }
      if (!result.labels.includes(f.label)) result.labels.push(f.label);
    }
  } catch (err) {
    if (err instanceof Cancelled) result.cancelled = true;
    else if (err instanceof ZipError) result.problem = err.code === 'method' ? 'zip-method' : 'unknown';
    else throw err;
  }
  report(true);
  return result;
}

