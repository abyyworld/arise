// "Arise reads it for you": a small queue on this device that, for each new note (typed in Arise,
// or brought in from Obsidian, Notion, Apple Notes, Google Keep, Word or a PDF) and each new file
// with words in it in Photos and files, asks the AI for a one-line description, the Player's own
// note tidied ("your note, refined", never with anything added) and 1 to 5 tags.
//
//   - Off until the Player turns it on (Settings, Your life log), at most `perDay` a day (20 by
//     default), a few at a time while the app is open, or now with "Run now".
//   - Only to an AI that may read the record (reads-core.ts gate, the same rule as the coach's),
//     with only the record's own words (ai.js askRead). Background work: on the free plan it
//     waits for Arise Private, or uses the AI on this device.
//   - Kept in the life log's database ('kv', one row each under 'read:'), synced sealed with the
//     rest of it in the 'r:' packs (packs.ts), so the Player's other devices have it too. What the
//     Player puts right ("Not quite? Fix it") is theirs: no AI writes over it, here or elsewhere.
//   - The Days search finds a note by its description and tags too (log.ts useExtraWords), and so
//     does search by meaning (embed/index.ts useExtraText).
//   - A note or file deleted takes what was written about it along, on every device.

import * as AI from '../ai.js';
import * as L from './log';
import * as P from './policy';
import * as C from './reads-core';
import { done, onOtherTabs, open, req, tellOtherTabs } from './db';
import { addTomb, dirtied, markDirty } from './journal';
import { READ_KV, READ_RANGE, readPack } from './packs';
import { dayEnd, dayKey, dayStart } from './dates';
import { cleanLifeRead, cleanReadPrefs, cleanReadQueue, READ_ID, type LifeRead, type ReadPrefs, type ReadQueue } from '../lib/validate';
import type { Engine } from './policy';
import type { LifeEvent } from './types';
import { readDaysSoon, useExtraText } from './embed/index';

export type { LifeRead };

// ---------- the Player's choices and the queue, on this device only

const KEY = 'arise-reads';

interface Kept {
  prefs: ReadPrefs;
  queue: ReadQueue;
}

function kept(): Kept {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as { prefs?: unknown; queue?: unknown };
    return { prefs: cleanReadPrefs(raw?.prefs), queue: cleanReadQueue(raw?.queue) };
  } catch {
    return { prefs: cleanReadPrefs({}), queue: cleanReadQueue({}) };
  }
}
function keep(k: Kept) {
  try {
    localStorage.setItem(KEY, JSON.stringify(k));
  } catch {}
}

export const prefs = (): ReadPrefs => kept().prefs;
export const queue = (): ReadQueue => kept().queue;
const setQueue = (q: ReadQueue) => keep({ prefs: prefs(), queue: q });

// Turning it on starts with the notes and files of the last few weeks, then everything new.
export const START_DAYS = 30;

export async function setPrefs(patch: Partial<Omit<ReadPrefs, 'since'>>): Promise<ReadPrefs> {
  const was = kept();
  const turnedOn = patch.on === true && !was.prefs.on;
  const next = cleanReadPrefs({ ...was.prefs, ...patch, ...(turnedOn ? { since: Date.now() } : {}) });
  keep({ prefs: next, queue: next.on ? was.queue : cleanReadQueue({}) });
  if (turnedOn) {
    const now = Date.now();
    await noticeDays(daysBack(START_DAYS, now)).catch(() => {});
    await noticeFiles({ from: now - START_DAYS * 864e5 }).catch(() => {});
  }
  refreshStatus();
  if (next.on) soon(2000);
  return next;
}

// The device is erased, or the log emptied: it's off again and the queue goes.
export function forget() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  cache.clear();
  loaded = null;
  refreshStatus();
}

const daysBack = (n: number, now: number) => Array.from({ length: n }, (_, i) => dayKey(now - i * 864e5));

// ---------- what was written, kept in the life log's database

const cache = new Map<string, LifeRead>();
let loaded: Promise<void> | null = null;
const watchers = new Set<() => void>();
export function onReadsChange(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}
function told() {
  for (const fn of [...watchers]) {
    try {
      fn();
    } catch {}
  }
}

export function load(force = false): Promise<void> {
  if (!loaded || force) {
    loaded = (async () => {
      const db = await open();
      const rows = (await req(db.transaction('kv').objectStore('kv').getAll(READ_RANGE()))) as { v?: unknown }[];
      cache.clear();
      for (const r of rows) {
        const x = cleanLifeRead(r?.v);
        if (x) cache.set(x.id, x);
      }
    })().catch((err) => {
      loaded = null;
      throw err;
    });
  }
  return loaded;
}

export const readOf = (id: string): LifeRead | null => cache.get(id) || null;
export async function getRead(id: string): Promise<LifeRead | null> {
  await load().catch(() => {});
  return readOf(id);
}
export const allReads = () => [...cache.values()];

// The days of the notes these reads are about (for search by meaning to read again).
const daysOf = (list: readonly LifeRead[]) => [...new Set(list.filter((x) => x.id.startsWith('e:') && x.rat).map((x) => dayKey(x.rat as number)))];

// Keeps reads, in the same go as noting that their packs changed (so they sync).
export async function saveReads(list: readonly LifeRead[]): Promise<void> {
  const clean = list.map(cleanLifeRead).filter((x): x is LifeRead => !!x);
  if (!clean.length) return;
  const db = await open();
  const tx = db.transaction(['kv', 'sync'], 'readwrite');
  const kv = tx.objectStore('kv');
  for (const x of clean) kv.put({ k: `${READ_KV}${x.id}`, v: x });
  markDirty(
    tx,
    clean.map((x) => readPack(x.id)),
  );
  await done(tx);
  dirtied();
  for (const x of clean) cache.set(x.id, x);
  changedHere(clean);
}

// Deletes reads, on every device (a tombstone each, packs.ts).
export async function dropReads(ids: readonly string[], now = Date.now()): Promise<number> {
  const gone = ids.map((id) => cache.get(id)).filter((x): x is LifeRead => !!x);
  if (!gone.length) return 0;
  const db = await open();
  const tx = db.transaction(['kv', 'sync', 'tomb'], 'readwrite');
  const kv = tx.objectStore('kv');
  for (const x of gone) {
    kv.delete(`${READ_KV}${x.id}`);
    addTomb(tx, readPack(x.id), x.id, L.deletedAt(x.at, now));
  }
  markDirty(
    tx,
    gone.map((x) => readPack(x.id)),
  );
  await done(tx);
  dirtied();
  for (const x of gone) cache.delete(x.id);
  changedHere(gone);
  return gone.length;
}

function changedHere(list: readonly LifeRead[]) {
  words = null;
  const days = daysOf(list);
  if (days.length) readDaysSoon(days);
  tellOtherTabs('memory');
  told();
}

// ---------- search: a note is found by its description and tags

let words: Map<string, string[]> | null = null;
export const readWords = (x: Pick<LifeRead, 'desc' | 'tags'>) => [...new Set(L.words(`${x.desc} ${x.tags.join(' ')}`))].slice(0, 60);
function wordMap(): Map<string, string[]> {
  if (!words) {
    words = new Map();
    for (const x of cache.values()) if (x.id.startsWith('e:')) words.set(x.id.slice(2), readWords(x));
  }
  return words;
}
L.useExtraWords(wordMap);
useExtraText((eventId) => {
  const x = cache.get(`e:${eventId}`);
  return x ? `${x.desc}${x.tags.length ? `. ${x.tags.join(', ')}` : ''}` : '';
});

// ---------- the records

// A note in the life log that's worth describing: one the Player wrote, typed in Arise or brought
// in from a notes app (source 'other', with the app in meta.app).
export const isNote = (e: Pick<LifeEvent, 'kind' | 'source'>) => e.kind === 'note' && (e.source === 'manual' || e.source === 'other');
export const noteText = (e: Pick<LifeEvent, 'title' | 'detail'>) => (e.detail ? `${e.title}\n\n${e.detail}` : e.title);

export function noteCandidate(e: LifeEvent): C.Candidate {
  return { id: `e:${e.id}`, kind: 'note', tier: e.tier, title: e.title, text: noteText(e), source: e.source, rat: e.at };
}

// A file with words in it: text, Markdown, CSV or JSON, a PDF or a Word document.
const TEXT_TYPE = /^(text\/[a-z0-9.+-]+|application\/(json|pdf|xml|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))$/;
const TEXT_NAME = /\.(txt|md|markdown|csv|tsv|json|xml|html?|pdf|docx|log|org)$/i;
export const FILE_MAX = 10 * 1024 * 1024;
export const hasWords = (f: { name: string; type: string; size: number }) => f.size > 0 && f.size <= FILE_MAX && (TEXT_TYPE.test(f.type) || TEXT_NAME.test(f.name));

// The words in a file's bytes ('' when there are none Arise can read).
export async function fileText(f: { name: string; type: string }, bytes: Uint8Array): Promise<string> {
  const name = f.name.toLowerCase();
  if (f.type === 'application/pdf' || name.endsWith('.pdf')) {
    const { pdfText } = await import('./import/pdf');
    try {
      return pdfText(bytes).text;
    } catch {
      return '';
    }
  }
  if (name.endsWith('.docx') || f.type.includes('wordprocessingml')) {
    const [{ unzipSync }, { wordText }] = await Promise.all([import('fflate'), import('./import/word')]);
    try {
      const files = unzipSync(bytes, { filter: (x) => x.name === 'word/document.xml' && x.originalSize <= 32 << 20 });
      const xml = files['word/document.xml'];
      return xml ? wordText(new TextDecoder().decode(xml)) : '';
    } catch {
      return '';
    }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return /html?$/.test(name) || f.type === 'text/html' ? text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ') : text;
}

// The files module, loaded only when needed (it brings the files' sync with it).
const files = () => import('./files');

async function fileCandidate(fileId: string): Promise<C.Candidate | null> {
  const F = await files();
  const f = (await F.listFiles({ trash: 'all' })).find((x) => x.id === fileId);
  // Only what's on this device: a file from another device is read there.
  if (!f || f.bin || !f.here || !hasWords(f)) return null;
  const got = await F.getFile(fileId);
  if (!got) return null;
  const bytes = new Uint8Array(await got.blob.arrayBuffer());
  const text = (await fileText(f, bytes)).replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  // Everything in Photos and files counts as the most private (it can be anything).
  return { id: `f:${fileId}`, kind: 'file', tier: 3, title: f.name, text, rat: f.at };
}

export async function candidate(id: string): Promise<C.Candidate | null> {
  if (id.startsWith('e:')) {
    const e = await L.getEvent(id.slice(2)).catch(() => null);
    return e && isNote(e) ? noteCandidate(e) : null;
  }
  if (id.startsWith('f:')) return fileCandidate(id.slice(2)).catch(() => null);
  return null;
}

// ---------- noticing what's new

// Notes on these days that have nothing written about them yet (or whose words changed since).
export async function noticeDays(days: readonly string[]): Promise<number> {
  if (!prefs().on || !days.length) return 0;
  await load().catch(() => {});
  const ids: string[] = [];
  for (const d of days.slice(0, 400)) {
    const list = await L.eventsBetween(dayStart(d), dayEnd(d), { kinds: ['note'], limit: 2000 }).catch(() => [] as LifeEvent[]);
    for (const e of list) {
      if (!isNote(e)) continue;
      const c = noteCandidate(e);
      if (!C.worthReading(c.text)) continue;
      const was = cache.get(c.id);
      if (was && (was.from === 'you' || was.src === C.fingerprint(c.text))) continue;
      ids.push(c.id);
    }
  }
  if (ids.length) {
    setQueue(C.enqueue(queue(), ids, Date.now()));
    refreshStatus();
  }
  return ids.length;
}

// Files with words in them added since it was turned on (or since `from`), not read yet.
const seenFiles = new Set<string>();
export async function noticeFiles({ from }: { from?: number } = {}): Promise<number> {
  await load().catch(() => {});
  // Off, and nothing written about any file: nothing to do.
  if (!prefs().on && ![...cache.keys()].some((id) => id.startsWith('f:'))) return 0;
  const F = await files();
  const list = await F.listFiles({ trash: 'all' }).catch(() => []);
  // A file this device had that's gone now (deleted for good): what was written about it goes too.
  const now = new Set(list.map((f) => f.id));
  const gone = [...seenFiles].filter((id) => !now.has(id)).map((id) => `f:${id}`);
  for (const f of list) seenFiles.add(f.id);
  for (const id of gone) seenFiles.delete(id.slice(2));
  if (gone.length) await dropReads(gone).catch(() => 0);
  const p = prefs();
  if (!p.on) return 0;
  await load().catch(() => {});
  const since = from ?? p.since;
  const ids = list.filter((f) => !f.bin && f.at >= since && hasWords(f) && !cache.has(`f:${f.id}`)).map((f) => `f:${f.id}`);
  const have = new Set(queue().jobs.map((j) => j.id));
  const fresh = ids.filter((id) => !have.has(id));
  if (fresh.length) {
    setQueue(C.enqueue(queue(), fresh, Date.now()));
    refreshStatus();
  }
  return fresh.length;
}

// Notes deleted on these days: what was written about them goes too.
async function forgetDeleted(days: readonly string[]) {
  await load().catch(() => {});
  const set = new Set(days);
  const maybe = [...cache.values()].filter((x) => x.id.startsWith('e:') && (!x.rat || set.has(dayKey(x.rat))));
  const gone: string[] = [];
  for (const x of maybe) if (!(await L.getEvent(x.id.slice(2)).catch(() => null))) gone.push(x.id);
  if (gone.length) await dropReads(gone);
}

// ---------- the Player's own words ("Not quite? Fix it") and "Describe again"

export async function fixRead(id: string, change: { desc: string; tags?: string[]; tidy?: string }): Promise<LifeRead | null> {
  if (!READ_ID.test(id)) return null;
  await load().catch(() => {});
  const was = cache.get(id);
  const c = was ? null : await candidate(id);
  const base = was || (c ? { id, tier: c.tier, src: C.fingerprint(c.text), ...(c.rat ? { rat: c.rat } : {}), ...(c.source ? { source: c.source } : {}) } : null);
  if (!base) return null;
  const next = cleanLifeRead({ ...base, at: Math.max(Date.now(), (was?.at || 0) + 1), desc: change.desc, tags: change.tags ?? was?.tags ?? [], tidy: change.tidy ?? was?.tidy, from: 'you', by: undefined });
  if (!next) return null;
  await saveReads([next]);
  // Nothing in the queue writes over it.
  setQueue(C.without(queue(), id));
  refreshStatus();
  return next;
}

export function describeAgain(id: string) {
  if (!READ_ID.test(id)) return;
  setQueue(C.enqueue(queue(), [id], Date.now(), { again: true }));
  refreshStatus();
  soon(300);
}

// ---------- the queue at work

export interface RunDeps {
  engine(): Engine | null; // the AI that would answer background work
  ask(o: { prompt: string; schema: unknown; engine: Engine }): Promise<{ json: unknown; by: string }>;
  candidate(id: string): Promise<C.Candidate | null>;
  now(): number;
  lessPrivateOk(): boolean;
}

const appDeps: RunDeps = {
  engine: () => AI.engine({ background: true }) as Engine | null,
  ask: (o) => AI.askRead(o),
  candidate,
  now: () => Date.now(),
  lessPrivateOk: () => P.prefs().lessPrivate,
};

// Errors that say nothing about the record: no AI now, or it changed. Nothing is counted.
const STOPS = new Set(['no-ai', 'changed', 'no-account', 'plan']);

let running: Promise<number> | null = null;

// Reads what's due, newest first, until the day's allowance is used or the AI can't go on.
// Resolves with how many were described.
export function run(deps: RunDeps = appDeps): Promise<number> {
  if (running) return running;
  running = (async () => {
    let made = 0;
    const p = prefs();
    if (!p.on) {
      refreshStatus();
      return 0;
    }
    await load().catch(() => {});
    // Always on the queue as kept now, so what's noticed meanwhile isn't lost.
    const day = () => dayKey(deps.now());
    const update = (fn: (q: ReadQueue) => ReadQueue) => {
      const q = fn(C.today(queue(), day()));
      setQueue(q);
      return q;
    };
    const q = update((x) => x);
    const e = deps.engine();
    if (!e) {
      refreshStatus({ stopped: AI.engine() ? 'plan' : 'no-ai' });
      return 0;
    }
    const opts: C.GateOptions = { lessPrivateOk: deps.lessPrivateOk(), allow: p };
    C.status.error = '';
    for (const job of C.ordered(q.jobs, deps.now())) {
      if (!prefs().on || C.left(C.today(queue(), day()), p.perDay) <= 0) break;
      const c = await deps.candidate(job.id).catch(() => null);
      const was = cache.get(job.id);
      // Gone, not a note any more, too short, or already done (here or on another device).
      if (!c || !C.worthReading(c.text) || (!job.again && was && (was.from === 'you' || was.src === C.fingerprint(c.text)))) {
        update((x) => C.without(x, job.id));
        continue;
      }
      if (C.gate(c, e, opts)) continue; // held: it waits for an AI that may read it, or the Player's yes
      update((x) => ({ ...x, done: x.done + 1 }));
      refreshStatus({ reading: true });
      try {
        const { json, by } = await deps.ask({ prompt: C.readPrompt(c, e), schema: C.READ_SCHEMA, engine: e });
        const parsed = C.parseRead(json, c.text);
        if (!parsed) throw Object.assign(new Error('The AI sent an answer Arise could not use.'), { code: 'format' });
        const at = Math.max(deps.now(), (was?.at || 0) + 1);
        const read = cleanLifeRead({ id: c.id, at, tier: c.tier, desc: parsed.desc, tidy: parsed.tidy, tags: parsed.tags, src: C.fingerprint(c.text), by, from: 'ai', rat: c.rat, source: c.source });
        if (read) await saveReads([read]);
        update((x) => C.without(x, job.id));
        made++;
      } catch (err) {
        const code = String((err as { code?: string })?.code || '');
        C.status.error = (err as Error)?.message || "Arise couldn't read it.";
        if (STOPS.has(code)) {
          update((x) => ({ ...x, done: Math.max(0, x.done - 1) })); // nothing was asked
          break;
        }
        update((x) => C.failed(x, job.id, deps.now()));
        // A busy or failing AI: the rest waits for the next go.
        if (code !== 'format' && code !== 'cut') break;
      }
    }
    refreshStatus();
    return made;
  })().finally(() => {
    running = null;
  });
  return running;
}

// ---------- how it's going

const busy = () => !!running;

// Works out the status from the queue (no AI asked, no record read).
export function refreshStatus(o: { stopped?: 'plan' | 'no-ai'; reading?: boolean } = {}): C.Status {
  const p = prefs();
  const q = C.today(queue(), dayKey(Date.now()));
  const s = C.status;
  s.perDay = p.perDay;
  s.done = q.done;
  const live = q.jobs.filter((j) => !j.failed);
  s.notes = live.filter((j) => j.id.startsWith('e:')).length;
  s.files = live.filter((j) => j.id.startsWith('f:')).length;
  s.failed = q.jobs.length - live.length;
  s.held = heldCount;
  if (!p.on) s.state = 'off';
  else if (o.stopped) s.state = o.stopped;
  else if (!live.length) s.state = 'done';
  else if (o.reading) s.state = 'reading';
  else {
    const e = appDeps.engine();
    if (!e) s.state = AI.engine() ? 'plan' : 'no-ai';
    else if (C.left(q, p.perDay) <= 0) s.state = 'cap';
    else if (waitingForPrivate && !busy()) s.state = 'waiting';
    else s.state = 'reading';
  }
  told();
  return s;
}

// Counted on each go through the queue (held records cost no AI request).
let heldCount = 0;
let waitingForPrivate = false;
async function countHeld() {
  const p = prefs();
  const e = appDeps.engine();
  let held = 0;
  let waits = 0;
  const live = queue().jobs.filter((j) => !j.failed);
  for (const j of live.slice(0, 200)) {
    const c = await candidate(j.id).catch(() => null);
    if (!c) continue;
    const why = C.gate(c, e, { lessPrivateOk: P.prefs().lessPrivate, allow: p });
    if (why === 'health' || why === 'money' || why === 'id') held++;
    else if (why === 'less-private' || why === 'tier') waits++;
  }
  heldCount = held;
  waitingForPrivate = !!e && waits > 0 && waits + held >= live.length;
}

// ---------- in the app

let timer: ReturnType<typeof setTimeout> | null = null;
function soon(ms = 30000) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void go();
  }, ms);
}

async function go() {
  if (!prefs().on) return;
  await run().catch(() => 0);
  await countHeld().catch(() => {});
  refreshStatus();
}

// "Run now": the same go, straight away. Resolves with how many were described.
export async function runNow(): Promise<number> {
  if (!prefs().on) return 0;
  await noticeFiles().catch(() => 0);
  const n = await run().catch(() => 0);
  await countHeld().catch(() => {});
  refreshStatus();
  return n;
}

let started = false;
export function initReads() {
  if (started) return;
  started = true;
  L.onChange((c) => {
    if (c.type === 'clear') {
      cache.clear();
      words = null;
      loaded = null;
      setQueue(cleanReadQueue({}));
      refreshStatus();
      return;
    }
    if (c.type === 'sync' && c.memory) {
      words = null;
      void load(true).then(told, () => {});
    }
    if (c.type === 'delete') void forgetDeleted(c.days).catch(() => {});
    if (c.days.length && prefs().on && c.type !== 'delete') void noticeDays(c.days).then((n) => n && soon(), () => {});
  });
  onOtherTabs((type) => {
    if (type !== 'memory') return;
    words = null;
    void load(true).then(told, () => {});
  });
  void files()
    .then((F) =>
      F.onFilesChange(() => {
        void noticeFiles().then((n) => n && soon(), () => {});
      }),
    )
    .catch(() => {});
  void load().catch(() => {});
  void noticeFiles().catch(() => {});
  refreshStatus();
  // A little after the app opens, then every 15 minutes while it's open.
  soon(20000);
  setInterval(() => {
    if (prefs().on) void go();
  }, 15 * 60000);
}

export const _test = {
  forgetDeleted,
  reset() {
    cache.clear();
    words = null;
    loaded = null;
    seenFiles.clear();
    heldCount = 0;
    waitingForPrivate = false;
    running = null;
  },
};
