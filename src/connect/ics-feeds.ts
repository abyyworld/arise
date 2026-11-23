// Calendars added by their private link (ICS or webcal): Google Calendar's "secret address",
// Outlook's "publish a calendar" link, iCloud's public calendar, a school's or a team app's feed.
// Arise reads each one every hour while it's open and puts its events into the life log like the
// other calendars (ics.ts reads the text), so they show on the Calendar and in Days.
//
// Where it's read from:
//   - the iPhone and Android apps: straight from the calendar's server (Capacitor's own HTTP, which
//     browsers' cross-site rules don't hold back);
//   - the web app: straight from the server when it allows web pages (few do). Otherwise only if
//     the person turned on the helper for that calendar: a small fetch-only Worker
//     (worker/calendar, address in src/calendar-config.ts) that keeps nothing. That's less
//     private, and the app says so.
//
// The link is a secret (anyone with it can read the calendar). It stays on this device like the
// linked accounts' sign-ins (state.ts): in localStorage, never synced, never in a backup, gone
// with "Erase all data", and never written to a log or shown in full.

import { CALENDAR } from '../calendar-config';
import * as ICS from './ics';
import * as IDS from './ids';
import { ConnectError, nativeHttp, request, retryAfter, type Res } from './http';
import { hash, sink } from './sink';

export interface Feed {
  id: string; // a short id of Arise's own, letters and digits
  name: string;
  named: boolean; // false: named after the calendar's own name, once read
  url: string; // the secret link (https or http)
  helper: boolean; // the web app may go through the helper (less private)
  added: number;
  last: number; // the last read that worked
  next: number; // no automatic read before this (after a problem)
  fails: number; // problems in a row
  error: string;
  count: number; // events from it on this device
  seen: string; // what the last read was (a hash, and the day), to skip one that didn't change
}

const KEY = 'arise-connect-ics';
export const GAP = 60 * 60_000; // between automatic reads
export const MAX_FEEDS = 20;
const DAY = 86_400_000;

// ---------- the list, on this device

const s = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : '');
const t = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.round(v) : 0);

export function cleanFeed(raw: unknown): Feed | null {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const id = s(r.id, 16);
  const url = feedUrl(s(r.url, 2000));
  if (!/^[a-z0-9]{4,16}$/.test(id) || !url) return null;
  return {
    id,
    name: s(r.name, 80).trim() || hostOf(url),
    named: r.named === true,
    url,
    helper: r.helper === true,
    added: t(r.added),
    last: t(r.last),
    next: t(r.next),
    fails: typeof r.fails === 'number' && Number.isInteger(r.fails) && r.fails > 0 ? Math.min(r.fails, 100) : 0,
    error: s(r.error, 300),
    count: typeof r.count === 'number' && Number.isFinite(r.count) && r.count > 0 ? Math.min(Math.round(r.count), 1e7) : 0,
    seen: s(r.seen, 80),
  };
}

export function feeds(): Feed[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    return list
      .map(cleanFeed)
      .filter((f): f is Feed => !!f && !seen.has(f.id) && !!seen.add(f.id))
      .slice(0, MAX_FEEDS);
  } catch {
    return [];
  }
}

function store(list: Feed[]) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {}
}

export const get = (id: string) => feeds().find((f) => f.id === id) || null;

// Saves one feed's state, only while it's still on the list (it may have been removed meanwhile).
function put(f: Feed) {
  const list = feeds();
  const i = list.findIndex((x) => x.id === f.id);
  if (i < 0) return;
  list[i] = f;
  store(list);
}

// What people paste: https://…, http://… or webcal://… (webcal is https underneath).
export function feedUrl(input: string): string {
  let v = input.trim();
  if (/^webcals?:\/\//i.test(v)) v = `https://${v.replace(/^webcals?:\/\//i, '')}`;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password) return '';
    return u.href.length <= 2000 ? u.href : '';
  } catch {
    return '';
  }
}

// What the app shows of a link: only its server, never the secret part.
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'Calendar';
  } catch {
    return 'Calendar';
  }
}

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');
const key = (id: string) => `ics:${id}`;

export function addFeed({ name, url, helper = false }: { name: string; url: string; helper?: boolean }, now = Date.now()): Feed {
  const link = feedUrl(url);
  if (!link) throw new ConnectError('other', "That isn't a calendar link. It starts with https:// or webcal://.");
  const list = feeds();
  if (list.length >= MAX_FEEDS) throw new ConnectError('other', `You can add up to ${MAX_FEEDS} calendars.`);
  if (list.some((f) => f.url === link)) throw new ConnectError('other', 'That calendar is already here.');
  const clean = name.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80);
  const f = cleanFeed({ id: newId(), name: clean || hostOf(link), named: !!clean, url: link, helper, added: now })!;
  store([...list, f]);
  return f;
}

export function renameFeed(id: string, name: string): boolean {
  const f = get(id);
  const clean = name.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80);
  if (!f || !clean) return false;
  f.name = clean;
  f.named = true;
  f.seen = ''; // its events carry the name: read it again
  f.next = 0;
  put(f);
  return true;
}

export function setHelper(id: string, on: boolean) {
  const f = get(id);
  if (!f) return;
  f.helper = on;
  f.next = 0;
  f.fails = 0;
  f.error = '';
  put(f);
}

// Takes the calendar off the list, and its events out of the life log.
export async function removeFeed(id: string): Promise<void> {
  stopped.add(id);
  store(feeds().filter((f) => f.id !== id));
  await running.get(id)?.catch(() => {});
  const ids = await IDS.list(key(id));
  if (ids.length) {
    const log = await sink();
    if (log.removeIds) for (let i = 0; i < ids.length; i += 500) await log.removeIds(ids.slice(i, i + 500));
  }
  await IDS.forget(key(id));
}

// "Erase all data", or another account's data taking this one's place: every link goes.
export async function forgetAll(): Promise<void> {
  const list = feeds();
  for (const f of list) stopped.add(f.id);
  store([]);
  for (const f of list) await IDS.forget(key(f.id)).catch(() => {});
}

// ---------- reading one

export const BLOCKED = "This calendar's server doesn't let web pages read it. Use the Arise app on your phone, or turn on the helper for it.";
export const NO_HELPER = "This calendar's server doesn't let web pages read it, and Arise's helper isn't set up yet. Use the Arise app on your phone.";

// Whether this copy of Arise can go through the helper (the web app, with the helper deployed).
export const helperReady = () => !nativeHttp() && !!CALENDAR.server;
export const onWeb = () => !nativeHttp();

function answer(res: Res): string {
  if (res.status >= 200 && res.status < 300) {
    if (typeof res.data !== 'string') throw new ConnectError('other', "That link isn't a calendar.");
    return res.data;
  }
  if (res.status === 429) throw new ConnectError('rate', 'The calendar is busy. Arise will try again later.', retryAfter(res), 429);
  if (res.status === 413) throw new ConnectError('other', 'This calendar is too big to read.', 0, 413);
  if (res.status === 422) throw new ConnectError('other', "That link isn't a calendar.", 0, 422);
  if (res.status === 401 || res.status === 403) throw new ConnectError('auth', "The calendar's server said no. Its link may have changed: copy it again and add it again.", 0, res.status);
  if (res.status === 404 || res.status === 410) throw new ConnectError('auth', "That calendar link doesn't work any more. Copy it again and add it again.", 0, res.status);
  if (res.status >= 500 || res.status === 0) throw new ConnectError('net', "The calendar's server didn't answer. Arise will try again later.", 0, res.status);
  throw new ConnectError('other', `The calendar's server said no (${res.status}).`, 0, res.status);
}

export async function fetchText(f: Feed): Promise<string> {
  if (nativeHttp()) return answer(await request({ url: f.url }));
  // The web app: straight from the calendar's server first, which works when it allows web pages.
  try {
    return answer(await request({ url: f.url }));
  } catch (e) {
    // (A server that doesn't allow web pages looks like no answer at all.)
    if (!(e instanceof ConnectError && e.kind === 'net' && !e.status)) throw e;
  }
  if (!f.helper) throw new ConnectError('other', BLOCKED);
  if (!CALENDAR.server) throw new ConnectError('other', NO_HELPER);
  // The link goes in the body, never in the helper's address.
  return answer(await request({ url: `${CALENDAR.server.replace(/\/+$/, '')}/fetch`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: f.url }) }));
}

// Puts the events in, and takes out the ones the calendar no longer has (only in the window it
// reads: events older than a year stay as they were, like the rest of your history).
async function handOver(f: Feed, parsed: ICS.Parsed, alive: () => boolean) {
  const log = await sink();
  if (!alive()) return;
  const ids = parsed.events.map((e) => e.id);
  for (let i = 0; i < parsed.events.length; i += 500) {
    const part = parsed.events.slice(i, i + 500);
    if (log.upsertEvents) await log.upsertEvents(part);
    else await log.addEvents(part);
    await IDS.add(key(f.id), part.map((e) => e.id));
    if (!alive()) return;
  }
  const keep = new Set(ids);
  const gone = (await IDS.list(key(f.id))).filter((id) => !keep.has(id) && ICS.timeOfId(id) >= parsed.from - DAY);
  if (gone.length && log.removeIds) {
    for (let i = 0; i < gone.length; i += 500) await log.removeIds(gone.slice(i, i + 500));
    await IDS.drop(gone);
  }
}

// How long to wait after a problem: 15 minutes, doubling, at most 6 hours (or what the server asked).
export function backoff(fails: number, err?: ConnectError): number {
  if (err?.kind === 'rate' && err.retryAfter) return Math.max(err.retryAfter, 60_000);
  return Math.min(6 * 3600_000, 15 * 60_000 * 2 ** Math.max(0, fails - 1));
}

export const due = (f: Feed, now = Date.now()) => now >= f.next && now - f.last >= GAP;

const running = new Map<string, Promise<void>>();
const stopped = new Set<string>(); // removed (or erased) while a read may still be going
let hooks = { render: () => {}, toast: (_msg: string) => {} };
export const busy = (id: string) => running.has(id);

async function run(id: string, now: number, manual: boolean) {
  const f = get(id);
  if (!f) return;
  stopped.delete(id);
  const alive = () => !stopped.has(id) && !!get(id);
  try {
    await sink(); // nothing is fetched until the life log can take it
    const text = await fetchText(f);
    const seen = `${hash(text)}:${Math.floor(now / DAY)}`; // the window moves each day
    if (seen !== f.seen) {
      const parsed = ICS.readCalendar(text, { id: f.id, name: f.name }, now);
      // Added with no name: the calendar's own, if it has one.
      if (!f.named) {
        f.named = true;
        if (parsed.name && parsed.name !== f.name) {
          f.name = parsed.name;
          Object.assign(parsed, ICS.readCalendar(text, { id: f.id, name: f.name }, now));
        }
      }
      if (!alive()) return;
      await handOver(f, parsed, alive);
      f.seen = seen;
    }
    f.last = Date.now();
    f.fails = 0;
    f.next = 0;
    f.error = '';
  } catch (e) {
    const err = e instanceof ConnectError ? e : e instanceof ICS.NotACalendar ? new ConnectError('other', "That link isn't a calendar. Copy the ICS or webcal link again.") : new ConnectError('other', "Couldn't read this calendar. Arise will try again later.");
    f.fails++;
    f.next = now + backoff(f.fails, err);
    f.error = err.message;
    if (manual) hooks.toast(err.message);
  }
  if (!alive()) return;
  f.count = await IDS.count(key(id)).catch(() => f.count);
  put(f);
}

export function syncFeed(id: string, { now = Date.now(), manual = false } = {}): Promise<void> {
  const already = running.get(id);
  if (already) return already;
  const p = run(id, now, manual).finally(() => {
    running.delete(id);
    hooks.render();
  });
  running.set(id, p);
  hooks.render();
  return p;
}

// Every calendar whose turn it is (engine.ts calls this with the linked accounts).
export function syncDue(now = Date.now()) {
  for (const f of feeds()) if (due(f, now) && !running.has(f.id)) void syncFeed(f.id, { now });
}

export function initFeeds(h: Partial<typeof hooks> = {}) {
  hooks = { ...hooks, ...h };
}
