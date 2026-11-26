// Your own database: a readable copy of Arise's data, in tables, in a database the Player owns
// (Turso for now: lib/turso.ts, src/own-db.ts). This file is pure: which tables there are, the rows
// made from the state, what changed since the last copy, and the SQL for it.
//
// The tables are written up for the Player in docs/OWN-DATABASE.md. Keep the two in step.
// Every table has `id TEXT PRIMARY KEY`; times are milliseconds since 1970 (UTC), days are
// YYYY-MM-DD, yes or no is 1 or 0, and anything not set is NULL.

import type { State } from './validate';
import type { LifeEvent } from '../life/types';

export type Cell = string | number | null;
export type Row = Cell[]; // in the table's column order, id first

type Kind = 'TEXT' | 'INTEGER' | 'REAL';
export interface Table {
  name: string;
  cols: [string, Kind][]; // id first
}

const t = (name: string, cols: string): Table => ({
  name,
  cols: [['id', 'TEXT'], ...cols.split(' ').map((c) => (c.includes(':') ? (c.split(':') as [string, Kind]) : ([c, 'TEXT'] as [string, Kind])))],
});

// Bumped when a table changes shape; written to arise_info as `schema`.
export const DB_SCHEMA = 1;

export const TABLES: Table[] = [
  t('goals', 'title category why by_when status created_day changed_at:INTEGER'),
  t('quests', 'goal_id title how schedule target:REAL unit created_day archived_day'),
  t('ticks', 'day quest_id done:INTEGER amount:REAL changed_at:INTEGER'),
  t('milestones', 'goal_id title due_day done_day'),
  t('measures', 'goal_id name unit start:REAL target:REAL better'),
  t('measure_values', 'measure_id day value:REAL changed_at:INTEGER'),
  t('todos', 'title day at_time done_at:INTEGER big:INTEGER added_by created_at:INTEGER changed_at:INTEGER'),
  t('events', 'title starts ends all_day:INTEGER time_zone location notes repeats guests added_by created_at:INTEGER changed_at:INTEGER'),
  t('checkins', 'day sleep:INTEGER energy:INTEGER mood:INTEGER words journal changed_at:INTEGER'),
  t('money_owed', 'who amount:REAL currency direction what due_day settled_at:INTEGER created_at:INTEGER changed_at:INTEGER'),
  t('groceries', 'name qty got_at:INTEGER created_at:INTEGER changed_at:INTEGER'),
  t('people', 'name keep_in_touch last_in_touch:INTEGER dates hidden:INTEGER changed_at:INTEGER'),
  t('workouts', 'day workout name started_at:INTEGER finished_at:INTEGER easy:INTEGER exercises'),
  t('weigh_ins', 'day weight:REAL waist:REAL shoulders:REAL changed_at:INTEGER'),
  t('notes', 'at:INTEGER title detail source app'),
];
const TABLE = new Map(TABLES.map((x) => [x.name, x]));
export const table = (name: string) => TABLE.get(name);

// What the Player can turn on or off, and the tables each one fills.
export const SECTIONS = [
  { id: 'goals', name: 'Goals and quests', what: 'Goals, their quests, ticks, milestones and numbers', tables: ['goals', 'quests', 'ticks', 'milestones', 'measures', 'measure_values'] },
  { id: 'todos', name: 'To-dos', what: 'Title, day, time, done or not', tables: ['todos'] },
  { id: 'events', name: 'Calendar events', what: 'Your own events, not the ones from linked calendars', tables: ['events'] },
  { id: 'checkins', name: 'Check-ins', what: 'Sleep, energy, mood and what you wrote each day', tables: ['checkins'] },
  { id: 'money', name: 'Money owed', what: 'Who owes whom, how much, and what for', tables: ['money_owed'] },
  { id: 'groceries', name: 'Groceries', what: 'Your grocery list', tables: ['groceries'] },
  { id: 'people', name: 'People', what: 'Names, how often to keep in touch, birthdays', tables: ['people'] },
  { id: 'workouts', name: 'Workouts and weigh-ins', what: 'Each workout with its sets, and your weight', tables: ['workouts', 'weigh_ins'] },
  { id: 'notes', name: 'Notes from your days', what: 'Notes you added to your days and notes you brought in, the newest 5,000', tables: ['notes'] },
] as const;
export type SectionId = (typeof SECTIONS)[number]['id'];
export const SECTION_IDS = SECTIONS.map((s) => s.id) as SectionId[];
// On to start with: everything but the notes, which are the most personal.
export const DEFAULT_SECTIONS: SectionId[] = SECTION_IDS.filter((s) => s !== 'notes');
export const NOTES_MAX = 5000;

export const cleanSections = (raw: unknown): SectionId[] => (Array.isArray(raw) ? SECTION_IDS.filter((s) => raw.includes(s)) : [...DEFAULT_SECTIONS]);

// ---------- rows from the state

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const yes = (v: unknown) => (v ? 1 : 0);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function schedule(q: State['goals'][number]['quests'][number]['schedule']): string {
  if (q.kind === 'days') return q.days.map((d) => DAYS[d]).join(' ');
  if (q.kind === 'weekly') return `${q.times} a week`;
  return 'daily';
}

export type Rows = Map<string, Map<string, Row>>; // table -> id -> row

// Every row the chosen sections make. `notes`: the life log's notes, read by the caller.
export function rowsFrom(st: State, sections: readonly SectionId[], notes: readonly LifeEvent[] = []): Rows {
  const out: Rows = new Map();
  const add = (name: string, row: Row) => {
    let m = out.get(name);
    if (!m) out.set(name, (m = new Map()));
    m.set(row[0] as string, row);
  };
  const on = new Set(sections);
  if (on.has('goals')) {
    const quests = new Set<string>();
    for (const g of st.goals) {
      add('goals', [g.id, g.title, g.category, s(g.why), s(g.by), g.status, s(g.created), n(g.updated) || null]);
      for (const q of g.quests) {
        quests.add(q.id);
        add('quests', [q.id, g.id, q.title, s(q.how), schedule(q.schedule), n(q.amount?.target), s(q.amount?.unit), s(q.created), s(q.archived)]);
      }
      for (const m of g.milestones) add('milestones', [m.id, g.id, m.title, s(m.due), s(m.done)]);
      for (const m of g.measures) add('measures', [m.id, g.id, m.name, s(m.unit), n(m.start), n(m.target), m.better]);
    }
    for (const [day, ticks] of Object.entries(st.checks)) for (const [q, c] of Object.entries(ticks)) if (quests.has(q)) add('ticks', [`${day}:${q}`, day, q, yes(c.done), n(c.amount), n(c.at)]);
    const measures = new Set(st.goals.flatMap((g) => g.measures.map((m) => m.id)));
    for (const [m, byDay] of Object.entries(st.values)) if (measures.has(m)) for (const [day, v] of Object.entries(byDay)) add('measure_values', [`${m}:${day}`, m, day, n(v.v), n(v.at)]);
  }
  if (on.has('todos')) for (const x of Object.values(st.todos)) if (!x.gone) add('todos', [x.id, x.title, s(x.day), s(x.time), n(x.done), yes(x.big), s(x.from), n(x.created), n(x.at)]);
  if (on.has('events')) {
    for (const x of Object.values(st.events)) {
      if (x.gone) continue;
      add('events', [x.id, x.title, x.start, s(x.end), yes(x.allDay), s(x.tz), s(x.location), s(x.notes), x.repeat ? JSON.stringify(x.repeat) : null, x.guests?.length ? x.guests.join(', ') : null, s(x.from), n(x.created), n(x.at)]);
    }
  }
  if (on.has('checkins')) for (const [day, l] of Object.entries(st.logs)) add('checkins', [day, day, n(l.s), n(l.e), n(l.m), s(l.t), s(l.ai), n(l.at) || null]);
  if (on.has('money')) for (const x of Object.values(st.debts)) if (!x.gone) add('money_owed', [x.id, x.who, x.amount, x.cur, x.dir === 'owed' ? 'they owe you' : 'you owe them', s(x.what), s(x.due), n(x.settled), n(x.created), n(x.at)]);
  if (on.has('groceries')) for (const x of Object.values(st.groceries)) if (!x.gone) add('groceries', [x.id, x.name, s(x.qty), n(x.got), n(x.created), n(x.at)]);
  if (on.has('people')) {
    for (const [key, p] of Object.entries(st.people)) {
      if (p.gone || !p.name) continue;
      const dates = p.dates?.length ? p.dates.map((d) => `${d.label} ${d.md}`).join(', ') : null;
      add('people', [key, p.name, s(p.close), n(p.last), dates, yes(p.hidden), n(p.at)]);
    }
  }
  if (on.has('workouts')) {
    for (const x of st.sessions) {
      const sets = x.items.map((it) => ({ exercise: it.ex, reps: it.sets.map((r) => r.r) }));
      add('workouts', [x.id, x.date, x.workout, s(x.name), n(x.started) || null, n(x.finished) || null, yes(x.easy), JSON.stringify(sets)]);
    }
    for (const e of st.body.entries) add('weigh_ins', [e.date, e.date, n(e.weight), n(e.waist), n(e.shoulders), n(e.at)]);
  }
  if (on.has('notes')) {
    for (const e of notes.slice(0, NOTES_MAX)) {
      const app = typeof e.meta?.app === 'string' ? e.meta.app : null;
      add('notes', [e.id, e.at, e.title, s(e.detail), e.source, app]);
    }
  }
  return out;
}

// ---------- what changed since the last copy

// A short fingerprint of a row, to tell if it changed (FNV-1a, two seeds, so a clash is rare).
export function fingerprint(row: Row): string {
  const text = JSON.stringify(row);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

// What this device last copied: `${table}\t${id}` -> fingerprint.
export type Copied = Record<string, string>;
export const keyOf = (name: string, id: string) => `${name}\t${id}`;

export type Op = { put: string; row: Row } | { drop: string; id: string };

// Rows to write and rows to take out, against what was copied before.
export function changes(rows: Rows, copied: Copied): Op[] {
  const ops: Op[] = [];
  const seen = new Set<string>();
  for (const [name, m] of rows) {
    for (const [id, row] of m) {
      const k = keyOf(name, id);
      seen.add(k);
      if (copied[k] !== fingerprint(row)) ops.push({ put: name, row });
    }
  }
  for (const k of Object.keys(copied)) {
    if (seen.has(k)) continue;
    const i = k.indexOf('\t');
    if (i > 0 && TABLE.has(k.slice(0, i))) ops.push({ drop: k.slice(0, i), id: k.slice(i + 1) });
  }
  return ops;
}

// What `copied` is once these went through.
export function applied(copied: Copied, ops: readonly Op[]): Copied {
  const next = { ...copied };
  for (const op of ops) {
    if ('put' in op) next[keyOf(op.put, op.row[0] as string)] = fingerprint(op.row);
    else delete next[keyOf(op.drop, op.id)];
  }
  return next;
}

// Small batches, so one request never gets big.
export const BATCH = 40;
export function batches<T>(list: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// How many of each table the ops touch ("todos 2, checkins 1").
export function counts(ops: readonly Op[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const op of ops) {
    const name = 'put' in op ? op.put : op.drop;
    out[name] = (out[name] || 0) + 1;
  }
  return out;
}

// ---------- SQL

export interface Stmt {
  sql: string;
  args?: Cell[];
}

export const createSql = (x: Table) => `CREATE TABLE IF NOT EXISTS ${x.name} (${x.cols.map(([c, k]) => `${c} ${k}${c === 'id' ? ' PRIMARY KEY' : ''}`).join(', ')})`;
export const INFO_SQL = 'CREATE TABLE IF NOT EXISTS arise_info (key TEXT PRIMARY KEY, value TEXT)';
export const infoSql = (key: string, value: string): Stmt => ({ sql: 'INSERT INTO arise_info (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: [key, value] });

// Every table, and which shape they are.
export const setupSql = (): Stmt[] => [{ sql: INFO_SQL }, ...TABLES.map((x) => ({ sql: createSql(x) })), infoSql('schema', String(DB_SCHEMA))];

export function opSql(op: Op): Stmt {
  if ('drop' in op) return { sql: `DELETE FROM ${op.drop} WHERE id = ?`, args: [op.id] };
  const x = TABLE.get(op.put)!;
  const names = x.cols.map(([c]) => c);
  const rest = names.slice(1);
  return {
    sql: `INSERT INTO ${x.name} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT(id) DO UPDATE SET ${rest.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    args: op.row,
  };
}

// Empties every table (before Copy everything now, so the database holds exactly what's on).
export const emptySql = (): Stmt[] => TABLES.map((x) => ({ sql: `DELETE FROM ${x.name}` }));
