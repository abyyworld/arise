// Your own database (optional, less private): a readable copy of Arise's data in a Turso database
// the Player owns, kept up to date a few seconds after each save, in small batches. The
// end-to-end encrypted sync stays the main copy; this is a copy they can query with SQL.
//
// The connection (the database URL and its token) and the sections they picked stay on this
// device: never synced, never in a backup, and gone with Stop or "Erase all data". Only this
// device copies; on another device the Player connects again if they want it there too. The
// tables are in lib/own-db.ts and docs/OWN-DATABASE.md.

import * as S from './store';
import * as DB from './lib/own-db';
import { readTurso, run, hostOf, TursoError, type Turso, type Options } from './lib/turso';
import type { LifeEvent } from './life/types';

const STATE = 'arise-own-db';
const COPIED = 'arise-own-db-copied'; // what this device last copied, row by row (fingerprints)
export const DELAY = 5000; // after a save, before copying
const RETRY = [30_000, 120_000, 600_000, 1_800_000]; // after a copy that didn't work

export interface Conn {
  kind: 'turso';
  url: string;
  token: string;
  sections: DB.SectionId[];
  ready: boolean; // the tables are made
  last: number; // the last copy that worked
  lastWhat: Record<string, number>; // what it changed, by table
  rows: number; // rows in the database from Arise, as far as this device knows
  error: string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.round(v) : 0);

// Read back field by field, like everything from storage. Null when not connected.
export function conn(): Conn | null {
  try {
    const r = obj(JSON.parse(localStorage.getItem(STATE) || 'null'));
    const db = readTurso({ url: r.url as string, token: r.token as string });
    if (r.kind !== 'turso' || typeof db === 'string') return null;
    const lastWhat: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj(r.lastWhat))) if (DB.table(k) && Number.isInteger(v) && (v as number) > 0) lastWhat[k] = v as number;
    return {
      kind: 'turso',
      ...db,
      sections: DB.cleanSections(r.sections),
      ready: r.ready === true,
      last: time(r.last),
      lastWhat,
      rows: Number.isInteger(r.rows) && (r.rows as number) >= 0 ? (r.rows as number) : 0,
      error: typeof r.error === 'string' ? r.error.slice(0, 300) : '',
    };
  } catch {
    return null;
  }
}
function setConn(next: Conn) {
  try {
    localStorage.setItem(STATE, JSON.stringify(next));
  } catch {}
  changed();
}
function patch(p: Partial<Conn>) {
  const c = conn();
  if (c) setConn({ ...c, ...p });
}

function copied(): DB.Copied {
  try {
    const r = obj(JSON.parse(localStorage.getItem(COPIED) || 'null'));
    const out: DB.Copied = {};
    for (const [k, v] of Object.entries(r)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}
function setCopied(c: DB.Copied) {
  try {
    localStorage.setItem(COPIED, JSON.stringify(c));
  } catch {}
}

export const isOn = () => !!conn();
export const host = () => {
  const c = conn();
  return c ? hostOf(c) : '';
};

const listeners = new Set<() => void>();
export const onChange = (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb));
const changed = () => listeners.forEach((cb) => cb());

// ---------- the life log's notes (only when the Player turned that section on)

type LogModule = {
  eventsBetween?(from: number, to: number, filter?: { kinds?: string[]; limit?: number; newest?: boolean }): Promise<LifeEvent[]>;
  onChange?(cb: () => void): () => void;
};
const logs = import.meta.glob<LogModule>('./life/log.ts');
const logModule = async (): Promise<LogModule | null> => {
  try {
    return (await logs['./life/log.ts']?.()) || null;
  } catch {
    return null;
  }
};
let readNotes = async (): Promise<LifeEvent[]> => (await (await logModule())?.eventsBetween?.(0, 8.64e15, { kinds: ['note'], newest: true, limit: DB.NOTES_MAX })) || [];
export function _setNotesReader(fn: () => Promise<LifeEvent[]>) {
  readNotes = fn;
}

// ---------- copying

let net: Options = {};
export function _setNet(o: Options) {
  net = o;
}
const send = (db: Turso, stmts: DB.Stmt[]) => run(db, stmts, net);

let running: Promise<number> | null = null;
let again = false;

// Copies what changed since the last copy (everything: empties the tables first and copies it
// all). Says how many rows it wrote or took out.
export function copyNow({ everything = false } = {}): Promise<number> {
  if (running) {
    if (!everything) {
      again = true;
      return running;
    }
    return running.catch(() => 0).then(() => copyNow({ everything }));
  }
  running = copy(everything).finally(() => {
    running = null;
    if (again) {
      again = false;
      schedule(0);
    }
  });
  return running;
}
export const busy = () => !!running;

async function copy(everything: boolean): Promise<number> {
  const c = conn();
  if (!c) return 0;
  const db: Turso = { url: c.url, token: c.token };
  let done = everything ? {} : copied();
  const first: DB.Stmt[] = everything ? [...DB.setupSql(), ...DB.emptySql()] : c.ready ? [] : DB.setupSql();
  if (first.length) {
    await send(db, first);
    if (everything) setCopied((done = {}));
    patch({ ready: true });
  }
  const notes = c.sections.includes('notes') ? await readNotes().catch(() => []) : [];
  const ops = DB.changes(DB.rowsFrom(S.state, c.sections, notes), done);
  const parts = DB.batches(ops);
  for (const [i, part] of parts.entries()) {
    const stmts = part.map(DB.opSql);
    if (i === parts.length - 1) stmts.push(DB.infoSql('copied_at', String(Date.now())));
    await send(db, stmts);
    done = DB.applied(done, part);
    setCopied(done);
    if (!conn()) return 0; // stopped while copying
  }
  if (ops.length || everything) patch({ last: Date.now(), lastWhat: DB.counts(ops), rows: Object.keys(done).length, error: '' });
  else if (c.error) patch({ error: '' });
  fails = 0;
  return ops.length;
}

// ---------- when

let timer: ReturnType<typeof setTimeout> | null = null;
let fails = 0;

export function schedule(ms = DELAY) {
  if (!isOn()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void tick();
  }, ms);
}

async function tick() {
  try {
    await copyNow();
  } catch (err) {
    const e = err instanceof TursoError ? err : new TursoError(err instanceof Error ? err.message : "That didn't work.");
    patch({ error: e.message });
    // Busy or offline: later, then less and less often. A wrong token waits for the Player.
    if (e.again) schedule(RETRY[Math.min(fails++, RETRY.length - 1)]);
  }
}

// ---------- what the Player does

// Connects, checks it can write and read, then copies everything.
export async function connect(raw: { url?: string; token?: string }): Promise<number> {
  const db = readTurso(raw);
  if (typeof db === 'string') throw new Error(db);
  await send(db, DB.setupSql());
  await checkDb(db);
  const before = conn();
  setCopied({});
  setConn({ kind: 'turso', ...db, sections: before?.sections || [...DB.DEFAULT_SECTIONS], ready: true, last: 0, lastWhat: {}, rows: 0, error: '' });
  watchNotes();
  return copyNow({ everything: true });
}

async function checkDb(db: Turso) {
  const mark = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const res = await send(db, [{ sql: DB.INFO_SQL }, DB.infoSql('check', mark), { sql: "SELECT value FROM arise_info WHERE key = 'check'" }]);
  if (res[2]?.rows[0]?.[0] !== mark) throw new TursoError('Arise wrote a test row but could not read it back.');
}

// Check: writes a test row and reads it back.
export async function check(): Promise<void> {
  const c = conn();
  if (!c) throw new Error('Not connected.');
  try {
    await checkDb(c);
    patch({ error: '' });
  } catch (err) {
    patch({ error: err instanceof Error ? err.message : "That didn't work." });
    throw err;
  }
}

// A section on or off. Off takes its rows out of the database with the next copy.
export function setSection(id: DB.SectionId, on: boolean) {
  const c = conn();
  if (!c || !DB.SECTION_IDS.includes(id)) return;
  const sections = DB.SECTION_IDS.filter((s) => (s === id ? on : c.sections.includes(s)));
  setConn({ ...c, sections });
  if (id === 'notes' && on) watchNotes();
  schedule(1000);
}

// Stop: the connection goes from this device. The database and what's in it stay the Player's.
export function forget() {
  if (timer) clearTimeout(timer);
  timer = null;
  fails = 0;
  try {
    localStorage.removeItem(STATE);
    localStorage.removeItem(COPIED);
  } catch {}
  changed();
}

let watchingNotes = false;
function watchNotes() {
  if (watchingNotes || !conn()?.sections.includes('notes')) return;
  watchingNotes = true;
  void logModule().then((m) => m?.onChange?.(() => conn()?.sections.includes('notes') && schedule()));
}

let started = false;
export function initOwnDb() {
  if (started) return;
  started = true;
  S.onSave(() => schedule());
  if (isOn()) {
    watchNotes();
    schedule(2000); // catch up with what changed while Arise was closed, or on another device
  }
}
