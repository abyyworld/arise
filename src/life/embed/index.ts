// Search by meaning with the model on this device: every event in the life log read once by the
// model (in the background, newest first, a few at a time) and kept as a small vector in
// IndexedDB ('arise-meaning', model.ts), never synced and made again whenever needed. A question
// is read the same way, and the closest events are found. Without the model (not downloaded, or
// it can't run here), search falls back to lists of related words (meaning.ts).
//
//   find(query, words, range)    the Days search: the question's own words first, then the
//                                closest in meaning (the model) or the related words (fallback)
//   byMeaning(query, range)      the closest events, for the coach's look into the log (memory.ts)
//   start() / status             reading the log in the background, and how far it got

import * as L from '../log';
import type { LifeEvent } from '../types';
import { widen } from '../meaning';
import { dayEnd, dayStart } from '../dates';
import { embedder, idbDone, idbReq, MODEL_ID, openMeaningDB, prefs, type Embedder } from './model';
import { fingerprint, quantize, rank, textOf, worthReading, type Item } from './vectors';

const BATCH = 16; // texts per go to the model
const PAGE = 400; // events read from the log at a time
const MIN = 0.28; // how close a match must be (about a cosine: with this model, "exercise" and "Gym session" are 0.39, and "Pizza for lunch" 0.08)

export const status = { busy: false, done: 0, error: '' };
const listeners = new Set<() => void>();
export const onStatus = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
const told = () => listeners.forEach((fn) => fn());

// ---------- the vectors

interface Row extends Item {
  h: number; // fingerprint of the text it was made from
  m: string; // the model that made it
}

let cache: Item[] | null = null; // every vector, once read (search reads all of them)

async function rowsFor(ids: readonly string[]): Promise<Map<string, Row>> {
  const db = await openMeaningDB();
  const store = db.transaction('vec').objectStore('vec');
  const rows = await Promise.all(ids.map((id) => idbReq(store.get(id)) as Promise<Row | undefined>));
  return new Map(rows.filter((r): r is Row => !!r).map((r) => [r.id, r]));
}

async function putRows(rows: readonly Row[], drop: readonly string[] = []) {
  if (!rows.length && !drop.length) return;
  const db = await openMeaningDB();
  const tx = db.transaction('vec', 'readwrite');
  const store = tx.objectStore('vec');
  for (const r of rows) store.put(r);
  for (const id of drop) store.delete(id);
  await idbDone(tx);
  cache = null;
}

async function allItems(): Promise<Item[]> {
  if (cache) return cache;
  const db = await openMeaningDB();
  const rows = (await idbReq(db.transaction('vec').objectStore('vec').getAll())) as Row[];
  cache = rows.filter((r) => r.m === MODEL_ID).map((r) => ({ id: r.id, at: r.at, q: new Int8Array(r.q) }));
  return cache;
}

// Every vector goes (the log was emptied, or the model removed).
export async function forgetVectors() {
  cache = null;
  try {
    const db = await openMeaningDB();
    const tx = db.transaction('vec', 'readwrite');
    tx.objectStore('vec').clear();
    await idbDone(tx);
  } catch {}
}

// ---------- reading the log

// What an AI wrote about a note (life/reads.ts registers this): its description and tags, read
// first, so a note is found by them too.
let extraText: (id: string) => string = () => '';
export function useExtraText(fn: (id: string) => string) {
  extraText = fn;
}
function textFor(e: LifeEvent): string {
  let extra = '';
  try {
    extra = extraText(e.id);
  } catch {}
  return extra ? `${extra}. ${textOf(e)}`.slice(0, 400) : textOf(e);
}

// Reads these events with the model where it hasn't yet (or their words changed). Says how many.
export async function readEvents(events: readonly LifeEvent[], emb: Embedder): Promise<number> {
  const todo: { e: LifeEvent; text: string; h: number }[] = [];
  const have = await rowsFor(events.map((e) => e.id));
  for (const e of events) {
    const text = textFor(e);
    if (!worthReading(text)) continue;
    const h = fingerprint(text);
    const r = have.get(e.id);
    if (r && r.h === h && r.m === MODEL_ID && r.at === e.at) continue;
    todo.push({ e, text, h });
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    const vecs = await emb.embed(part.map((x) => x.text));
    await putRows(part.map((x, k) => ({ id: x.e.id, at: x.e.at, q: quantize(vecs[k]), h: x.h, m: MODEL_ID })));
    status.done += part.length;
    told();
  }
  return todo.length;
}

// The whole log, newest first, a page at a time. Events already read are passed over quickly.
export async function readAll(emb: Embedder, { live = (): boolean => true } = {}): Promise<void> {
  let to = Infinity;
  let seen = new Set<string>();
  for (;;) {
    if (!live()) return;
    const page = await L.eventsBetween(-Infinity, to, { limit: PAGE, newest: true });
    const fresh = page.filter((e) => !seen.has(e.id));
    if (!fresh.length) return;
    await readEvents(fresh, emb);
    const last = page[page.length - 1].at;
    // The next page starts at the last time seen (events at the same moment may be on both).
    seen = new Set(page.filter((e) => e.at === last).map((e) => e.id));
    if (page.length < PAGE) return;
    to = last + 1;
    await new Promise((r) => setTimeout(r, 0));
  }
}

// Some days changed: read them again, and forget events no longer there.
export async function readDays(days: readonly string[], emb: Embedder): Promise<void> {
  for (const d of days) {
    const [from, to] = [dayStart(d), dayEnd(d)];
    const events = await L.eventsBetween(from, to, { limit: 20000 });
    const db = await openMeaningDB();
    const ids = (await idbReq(db.transaction('vec').objectStore('vec').index('at').getAllKeys(IDBKeyRange.bound(from, to, false, true)))) as string[];
    const now = new Set(events.map((e) => e.id));
    await putRows(
      [],
      ids.map(String).filter((id) => !now.has(id)),
    );
    await readEvents(events, emb);
  }
}

// ---------- in the app: in the background while it's on

let gen = 0;
let running: Promise<void> | null = null;
const dirty = new Set<string>();
let whole = true;

export function start(): Promise<void> {
  if (running) return running;
  if (!prefs().on) return Promise.resolve();
  const g = gen;
  running = (async () => {
    status.busy = true;
    status.error = '';
    told();
    try {
      const emb = await embedder();
      while (g === gen && (whole || dirty.size)) {
        if (whole) {
          whole = false;
          dirty.clear();
          await readAll(emb, { live: () => g === gen });
        } else {
          const days = [...dirty];
          dirty.clear();
          await readDays(days, emb);
        }
      }
    } catch (err) {
      status.error = (err as Error)?.message || "The search model couldn't read your log.";
    } finally {
      status.busy = false;
      running = null;
      told();
    }
  })();
  return running;
}

// Turned off or removed: what's on stops.
export function stop() {
  gen++;
  whole = true;
  dirty.clear();
}

let timer: ReturnType<typeof setTimeout> | null = null;
function soon() {
  if (!prefs().on) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void start();
  }, 5000);
}
L.onChange((c) => {
  if (c.type === 'clear') {
    // (Only when there may be any: without the model, nothing was ever made.)
    if (prefs().on || cache) void forgetVectors();
    whole = true;
  } else for (const d of c.days) dirty.add(d);
  cache = null;
  soon();
});

// What an AI wrote about notes on these days changed (life/reads.ts): they're read again.
export function readDaysSoon(days: readonly string[]) {
  for (const d of days) dirty.add(d);
  soon();
}

// ---------- searching

const ready = () => prefs().on;

// The events closest in meaning to the question, closest first. Empty without the model.
export async function byMeaning(query: string, { from = -Infinity, to = Infinity, limit = 30, min = MIN }: { from?: number; to?: number; limit?: number; min?: number } = {}): Promise<LifeEvent[]> {
  const q = query.trim().slice(0, 300);
  if (!ready() || !worthReading(q)) return [];
  let emb: Embedder;
  try {
    emb = await embedder();
  } catch {
    return [];
  }
  const items = await allItems();
  if (!items.length) return [];
  const [v] = await emb.embed([q]);
  const hits = rank(quantize(v), items, { limit: limit * 2, min, from, to });
  const out: LifeEvent[] = [];
  for (const h of hits) {
    const e = await L.getEvent(h.id);
    if (e) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

// Which of `texts` is closest in meaning to `query`, when one is at least `min` close (the same
// subject, for a note that grows: area-ui.js). Null without the model.
export async function closest(query: string, texts: readonly string[], min = 0.6): Promise<{ i: number; score: number } | null> {
  const q = query.trim().slice(0, 300);
  if (!ready() || !worthReading(q) || !texts.length) return null;
  let emb: Embedder;
  try {
    emb = await embedder();
  } catch {
    return null;
  }
  const unit = (v: Float32Array) => {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return Array.from(v, (x) => x / n);
  };
  const [qv, ...vs] = (await emb.embed([q, ...texts.map((t) => t.slice(0, 300))])).map(unit);
  let best: { i: number; score: number } | null = null;
  vs.forEach((v, i) => {
    const score = v.reduce((s, x, j) => s + x * qv[j], 0);
    if (score >= min && (!best || score > best.score)) best = { i, score };
  });
  return best;
}

export interface Found {
  results: LifeEvent[];
  related: LifeEvent[];
  loose: false | true | 'meaning' | 'model';
  groups: string[]; // the related words' groups (the fallback)
  by: 'model' | 'words';
}

export interface FindDeps {
  search: typeof L.search;
  meaning: typeof byMeaning;
}

// The Days search for a question's words (already without its dates): what has all of them,
// then the closest in meaning. With the model: what it finds. Without: the related words.
export async function find(query: string, words: readonly string[], range: { from?: number; to?: number }, deps: FindDeps = { search: L.search, meaning: byMeaning }): Promise<Found> {
  const out: Found = { results: [], related: [], loose: false, groups: [], by: 'words' };
  if (!words.length) return out;
  out.results = await deps.search(words.join(' '), { ...range, limit: 50 });
  const close = await deps.meaning(query, { ...range, limit: 40 }).catch(() => []);
  if (close.length) {
    out.by = 'model';
    if (!out.results.length) {
      out.results = close;
      out.loose = 'model';
    } else {
      const have = new Set(out.results.map((e) => e.id));
      out.related = close.filter((e) => !have.has(e.id)).slice(0, 20);
    }
  } else {
    // The fallback: lists of related words (meaning.ts, no model).
    const wide = widen(words);
    out.groups = wide.groups;
    if (!out.results.length && wide.related.length) {
      out.results = await deps.search('', { ...range, limit: 50, any: true, words: wide.words });
      out.loose = out.results.length > 0 ? 'meaning' : false;
    } else if (wide.related.length) {
      const have = new Set(out.results.map((e) => e.id));
      out.related = (await deps.search('', { ...range, limit: 40, any: true, words: wide.related })).filter((e) => !have.has(e.id)).slice(0, 20);
    }
  }
  if (!out.results.length) {
    out.results = await deps.search(words.join(' '), { ...range, limit: 30, any: true });
    out.loose = out.results.length > 0;
  }
  return out;
}
