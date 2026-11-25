// Your links: the web addresses in the person's own notes, journal and imported notes, and the
// pages they saved (in Arise, or with the browser extension), as references to find again. Each
// with where it came from and when.
//
// "Keep a copy": the page is fetched once through Arise's fetch-only helper (worker/calendar,
// POST /page), turned into plain text here on the device (readable.ts), and kept in the life log
// next to the link, sealed and synced like everything else there, so it can be searched and read
// even if the site goes away. The helper sees the page's address, nothing else. Without the
// helper set up, nothing is fetched.

import type { LifeEvent, LifeSource } from './types';
import { lifeStore, type LifeStore } from './store-port';
import { hashId } from './import/util';
import { parts, readable } from './readable';
import { SOURCE_NAMES } from './tiers';
import { CALENDAR } from '../calendar-config';

export interface Mention {
  id: string; // the event it's in
  source: LifeSource;
  where: string; // in plain words: "Your notes", "Your journal", "Obsidian", "Saved from Chrome on macOS"
  title: string;
  at: number;
}
export interface Copy {
  at: number;
  title: string;
  text: string;
  from: string; // the address it was fetched from, at the end of any redirects
  cut: boolean; // the page had more than is kept
  ids: string[];
}
export interface LinkItem {
  url: string;
  site: string;
  title: string; // the page's name, if known, else the address made short
  at: number; // the latest mention
  saved: boolean; // saved on purpose, not only written in a note
  note: string; // what they wrote with it when they saved it
  from: Mention[]; // newest first
  copy: Copy | null;
}

const FAR = 8.64e15;
export const COPY_SIZE = 3900; // the life log keeps 4,000 characters of a detail
export const COPY_PARTS = 8;

// ---------- finding links

const RAW = /\bhttps?:\/\/[^\s<>"'`{}|\\^[\]]+/gi;

// One address, as it would open: http or https only, no user name or password, no trailing
// punctuation from the sentence around it.
export function cleanLink(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  for (;;) {
    const before = s;
    s = s.replace(/[.,;:!?'"*_~>]+$/, '');
    // A ")" that closes a bracket opened before the link, as in "(see https://a.com/b)".
    if (s.endsWith(')') && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = s.slice(0, -1);
    if (s === before) break;
  }
  if (s.length > 2000) return null;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.') || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

// The addresses in some text, each once, in the order they come.
export function findUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || '').matchAll(RAW)) {
    const u = cleanLink(m[0]);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

// The same page however it was written: no part after # (unless it's a page's own route), no
// trailing slash.
export function linkKey(url: string): string {
  try {
    const u = new URL(url);
    if (!/^#[!/]/.test(u.hash)) u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

export const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^(www\d?|m)\./, '');
  } catch {
    return '';
  }
};

// The address made short, to show when the page's name isn't known.
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).replace(/\/$/, '');
    const s = `${u.hostname.replace(/^www\./, '')}${path}`;
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  } catch {
    return url.slice(0, 80);
  }
}

const isCopy = (e: LifeEvent) => typeof e.meta?.copyOf === 'string';
const isSaved = (e: LifeEvent) => e.meta?.saved === true;

// Whether an event is the person's own writing (or a page they saved), where links count.
export function isNote(e: LifeEvent): boolean {
  if (e.kind !== 'note' || isCopy(e)) return false;
  if (e.source === 'manual' || e.source === 'other') return true;
  if (e.source === 'arise') return e.id.startsWith('arise:journal:');
  return isSaved(e);
}

function whereOf(e: LifeEvent): string {
  if (isSaved(e)) return e.source === 'browser' ? `Saved from ${typeof e.meta?.browser === 'string' ? e.meta.browser : 'your browser'}` : 'Saved in Arise';
  if (e.source === 'manual') return 'Your notes';
  if (e.source === 'arise') return 'Your journal';
  if (e.source === 'other') return typeof e.meta?.app === 'string' && e.meta.app ? e.meta.app : 'Imported notes';
  return SOURCE_NAMES[e.source] || 'Your log';
}

// Every link in these events, newest first, with the kept copies matched to theirs.
export function gatherLinks(events: readonly LifeEvent[]): LinkItem[] {
  const byKey = new Map<string, LinkItem>();
  const copies = new Map<string, LifeEvent[]>();
  for (const e of events) {
    if (isCopy(e)) {
      const k = linkKey(String(e.meta!.copyOf));
      copies.set(k, [...(copies.get(k) || []), e]);
      continue;
    }
    if (!isNote(e)) continue;
    const urls = isSaved(e) && e.url ? [e.url] : findUrls(`${e.url || ''}\n${e.title}\n${e.detail || ''}`);
    for (const url of urls) {
      const k = linkKey(url);
      let item = byKey.get(k);
      if (!item) {
        item = { url, site: siteOf(url), title: '', at: e.at, saved: false, note: '', from: [], copy: null };
        byKey.set(k, item);
      }
      item.from.push({ id: e.id, source: e.source, where: whereOf(e), title: e.title, at: e.at });
      item.at = Math.max(item.at, e.at);
      if (isSaved(e)) {
        item.saved = true;
        // (Saved in Arise, its name is the address made short: the copy's page name is better.)
        if (e.title && e.title !== shortUrl(url) && !/^https?:\/\//i.test(e.title) && !item.title) item.title = e.title;
        if (e.detail && !item.note) item.note = e.detail;
      }
    }
  }
  for (const [k, list] of copies) {
    const item = byKey.get(k);
    if (item) item.copy = copyOf(list);
  }
  for (const item of byKey.values()) {
    item.from.sort((a, b) => b.at - a.at);
    if (!item.title) item.title = item.copy?.title || shortUrl(item.url);
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at);
}

// A kept copy from its parts.
export function copyOf(list: readonly LifeEvent[]): Copy | null {
  const ps = [...list].sort((a, b) => Number(a.meta?.part || 1) - Number(b.meta?.part || 1));
  if (!ps.length) return null;
  const first = ps[0];
  return {
    at: first.at,
    title: typeof first.meta?.page === 'string' ? first.meta.page : first.title,
    text: ps.map((e) => e.detail || '').join('\n\n'),
    from: typeof first.meta?.from === 'string' ? first.meta.from : first.url || '',
    cut: ps.some((e) => e.meta?.cut === true),
    ids: ps.map((e) => e.id),
  };
}

// Whether a link has every word of the question in it: its address, its name, the note with it,
// where it was mentioned, or its kept copy.
export function matches(item: LinkItem, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [item.url, item.title, item.note, ...item.from.map((m) => `${m.title} ${m.where}`), item.copy?.text || ''].join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

// ---------- saving a link (the box on Your links)

export function savedLink({ url, note = '', at }: { url: string; note?: string; at: number }): LifeEvent | null {
  const link = cleanLink(url) || (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(url.trim()) ? cleanLink(`https://${url.trim()}`) : null);
  if (!link) return null;
  const words = note.replace(/\r\n?/g, '\n').trim().slice(0, 2000);
  return {
    id: `manual:link:${hashId(linkKey(link))}`,
    source: 'manual',
    kind: 'note',
    at,
    title: shortUrl(link),
    url: link,
    tier: 2,
    ...(words ? { detail: words } : {}),
    meta: { saved: true, site: siteOf(link) },
  };
}

// ---------- keeping a copy

const copyId = (url: string, n: number) => `manual:copy:${hashId(linkKey(url))}:${n}`;

// The events that keep a copy: one for each part of the text.
export function copyEvents(url: string, page: { title: string; text: string }, at: number, from = url): LifeEvent[] {
  const { parts: ps, cut } = parts(page.text, COPY_SIZE, COPY_PARTS);
  const name = page.title || shortUrl(url);
  return ps.map((text, i) => ({
    id: copyId(url, i + 1),
    source: 'manual',
    kind: 'note',
    at,
    title: ps.length > 1 ? `Kept a copy: ${name} (part ${i + 1} of ${ps.length})` : `Kept a copy: ${name}`,
    detail: text,
    url,
    // What people read can say a lot about them: as private as browsing.
    tier: 3,
    meta: { copyOf: url, page: name.slice(0, 300), site: siteOf(url), part: i + 1, parts: ps.length, ...(from !== url ? { from } : {}), ...(cut ? { cut: true } : {}) },
  }));
}

export type CopyResult = { ok: true; title: string; parts: number; cut: boolean } | { ok: false; code: 'no-helper' | 'bad' | 'failed' | 'empty'; error: string };

export const NO_HELPER = "Keeping a copy needs Arise's helper, and it isn't set up yet. Nothing was fetched.";

function failText(status: number): string {
  if (status === 404 || status === 410) return "The site says that page isn't there.";
  if (status === 401 || status === 403) return "The site didn't let Arise read that page. Pages behind a sign-in can't be kept.";
  if (status === 413) return 'That page is too big to keep.';
  if (status === 415) return "That address isn't a web page Arise can keep (only web pages, not files).";
  if (status === 429) return 'Too many at once. Try again in a minute.';
  if (status === 400) return "That address can't be fetched (only public web pages).";
  return "Couldn't get the page. Try again later.";
}

// Fetches the page through the helper, makes it plain text, and keeps it in the life log (in
// place of an older copy of the same page).
export async function keepCopy(url: string, d: { server?: string; fetch?: typeof fetch; store?: LifeStore; now?: number } = {}): Promise<CopyResult> {
  const server = (d.server ?? CALENDAR.server).replace(/\/+$/, '');
  if (!server) return { ok: false, code: 'no-helper', error: NO_HELPER };
  const link = cleanLink(url);
  if (!link) return { ok: false, code: 'bad', error: "That address can't be fetched (only public web pages)." };
  const get = d.fetch || globalThis.fetch.bind(globalThis);
  let body: { url?: unknown; html?: unknown };
  try {
    const res = await get(`${server}/page`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: link }), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return { ok: false, code: 'failed', error: failText(res.status) };
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, code: 'failed', error: "Couldn't reach Arise's helper. Check you're online and try again." };
  }
  const page = readable(typeof body.html === 'string' ? body.html : '');
  if (!page.text) return { ok: false, code: 'empty', error: 'That page had no words Arise could keep. Some pages only show them with scripts running.' };
  const from = typeof body.url === 'string' && cleanLink(body.url) ? cleanLink(body.url)! : link;
  const events = copyEvents(link, page, d.now ?? Date.now(), from);
  const store = d.store || (await lifeStore());
  if (store.upsertEvents) await store.upsertEvents(events);
  else await store.addEvents(events);
  // An older copy with more parts: its extra parts go.
  const stale = Array.from({ length: COPY_PARTS - events.length }, (_, i) => copyId(link, events.length + i + 1));
  if (stale.length && store.removeIds) await store.removeIds(stale);
  return { ok: true, title: page.title || shortUrl(link), parts: events.length, cut: events.some((e) => e.meta?.cut === true) };
}

// Deletes a kept copy (the link itself stays where it was written).
export async function dropCopy(item: LinkItem, store?: LifeStore): Promise<void> {
  const s = store || (await lifeStore());
  if (item.copy && s.removeIds) await s.removeIds(item.copy.ids);
}

// ---------- reading the log

type Reader = (from: number, to: number, f: { kinds: readonly ['note']; limit: number; newest: boolean }) => Promise<LifeEvent[]>;

// Everything in the log that can hold a link: the notes (and the copies kept), newest first.
export async function loadLinks(read?: Reader): Promise<LinkItem[]> {
  const r = read || ((await import('./log')).eventsBetween as unknown as Reader);
  return gatherLinks(await r(0, FAR, { kinds: ['note'], limit: 100_000, newest: true }));
}
