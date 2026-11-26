// Your own database, the pure part: the rows made from the state, what changed since the last
// copy, the batches, and the SQL (run on a real SQLite in memory, so it's checked for real).

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { cleanState } from './validate';
import { DEFAULT_SETTINGS } from '../store';
import * as DB from './own-db';
import type { LifeEvent } from '../life/types';

const T = 1_780_000_000_000;
const state = () =>
  cleanState(
    {
      goals: [
        {
          id: 'g1',
          title: 'Learn Spanish',
          category: 'learning',
          why: 'Talk to my in-laws',
          by: 'June 2027',
          created: '2026-11-01',
          updated: T,
          quests: [
            { id: 'q1', title: 'Duolingo', schedule: { kind: 'days', days: [1, 3, 5] }, amount: { target: 20, unit: 'min' }, created: '2026-11-01' },
            { id: 'q2', title: 'Read', schedule: { kind: 'weekly', times: 3 }, created: '2026-11-01' },
          ],
          measures: [{ id: 'm1', name: 'Words', unit: 'words', start: 0, target: 2000, better: 'up' }],
          milestones: [{ id: 'k1', title: 'A2 test', due: '2027-02-01' }],
        },
      ],
      checks: { '2026-11-20': { q1: { done: true, amount: 25, at: T }, gone: { done: true, at: T } } },
      values: { m1: { '2026-11-20': { v: 340, at: T } } },
      todos: { t1: { id: 't1', title: 'Call the bank', day: '2026-11-27', time: '09:30', big: true, created: T, at: T }, t2: { id: 't2', title: '', created: T, at: T, gone: true } },
      events: { e1: { id: 'e1', title: 'Dentist', start: '2026-12-01T10:00', end: '2026-12-01T10:30', tz: 'Europe/London', location: 'High St', repeat: { freq: 'yearly' }, guests: ['ana@example.com'], created: T, at: T } },
      logs: { '2026-11-20': { s: 4, e: 3, m: 5, t: 'Good day', at: T } },
      debts: { d1: { id: 'd1', who: 'Ana', amount: 12.5, cur: 'GBP', dir: 'owed', what: 'Lunch', created: T, at: T } },
      groceries: { r1: { id: 'r1', name: 'Milk', qty: '2', created: T, at: T } },
      people: { ana: { name: 'Ana', at: T, close: 'week', last: T, dates: [{ label: 'Birthday', md: '03-14' }] }, bo: { name: '', at: T, gone: true } },
      sessions: [{ id: 's1', workout: 'a', date: '2026-11-19', started: T, finished: T + 1, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] }],
      body: { entries: [{ date: '2026-11-19', weight: 80.5, waist: null, shoulders: null, at: T }] },
    },
    DEFAULT_SETTINGS,
  );
const note: LifeEvent = { id: 'manual:n1', source: 'manual', kind: 'note', at: T, title: 'Idea for the garden', detail: 'Raised beds', tier: 2 };
const imported: LifeEvent = { id: 'other:n2', source: 'other', kind: 'note', at: T - 1, title: 'Recipe', tier: 2, meta: { app: 'obsidian' } };

describe('your own database: the rows', () => {
  it('has a row in every table that fits its columns', () => {
    const rows = DB.rowsFrom(state(), DB.SECTION_IDS, [note]);
    for (const x of DB.TABLES) {
      const m = rows.get(x.name);
      expect(m?.size, x.name).toBeGreaterThan(0);
      for (const row of m!.values()) expect(row.length, x.name).toBe(x.cols.length);
    }
    // Every table belongs to one section.
    expect(DB.SECTIONS.flatMap((s) => s.tables).sort()).toEqual(DB.TABLES.map((x) => x.name).sort());
  });

  it('makes plain rows from the state', () => {
    const rows = DB.rowsFrom(state(), DB.SECTION_IDS, [note, imported]);
    const get = (t: string, id: string) => rows.get(t)?.get(id);
    expect(get('goals', 'g1')).toEqual(['g1', 'Learn Spanish', 'learning', 'Talk to my in-laws', 'June 2027', 'active', '2026-11-01', T]);
    expect(get('quests', 'q1')).toEqual(['q1', 'g1', 'Duolingo', null, 'Mon Wed Fri', 20, 'min', '2026-11-01', null]);
    expect(get('quests', 'q2')![4]).toBe('3 a week');
    expect(get('ticks', '2026-11-20:q1')).toEqual(['2026-11-20:q1', '2026-11-20', 'q1', 1, 25, T]);
    expect(rows.get('ticks')!.size).toBe(1); // not a tick of a quest that isn't there
    expect(get('measure_values', 'm1:2026-11-20')).toEqual(['m1:2026-11-20', 'm1', '2026-11-20', 340, T]);
    expect(get('milestones', 'k1')).toEqual(['k1', 'g1', 'A2 test', '2027-02-01', null]);
    expect(get('todos', 't1')).toEqual(['t1', 'Call the bank', '2026-11-27', '09:30', null, 1, null, T, T]);
    expect(get('todos', 't2')).toBeUndefined(); // deleted
    expect(get('events', 'e1')).toEqual(['e1', 'Dentist', '2026-12-01T10:00', '2026-12-01T10:30', 0, 'Europe/London', 'High St', null, '{"freq":"yearly"}', 'ana@example.com', null, T, T]);
    expect(get('checkins', '2026-11-20')).toEqual(['2026-11-20', '2026-11-20', 4, 3, 5, 'Good day', null, T]);
    expect(get('money_owed', 'd1')).toEqual(['d1', 'Ana', 12.5, 'GBP', 'they owe you', 'Lunch', null, null, T, T]);
    expect(get('groceries', 'r1')).toEqual(['r1', 'Milk', '2', null, T, T]);
    expect(get('people', 'ana')).toEqual(['ana', 'Ana', 'week', T, 'Birthday 03-14', 0, T]);
    expect(get('people', 'bo')).toBeUndefined();
    expect(get('workouts', 's1')).toEqual(['s1', '2026-11-19', 'a', null, T, T + 1, 0, '[{"exercise":"band_row","reps":[10]}]']);
    expect(get('weigh_ins', '2026-11-19')).toEqual(['2026-11-19', '2026-11-19', 80.5, null, null, T]);
    expect(get('notes', 'manual:n1')).toEqual(['manual:n1', T, 'Idea for the garden', 'Raised beds', 'manual', null]);
    expect(get('notes', 'other:n2')).toEqual(['other:n2', T - 1, 'Recipe', null, 'other', 'obsidian']);
  });

  it('makes only the sections that are on', () => {
    const rows = DB.rowsFrom(state(), ['todos', 'money'], [note]);
    expect([...rows.keys()].sort()).toEqual(['money_owed', 'todos']);
    expect(DB.DEFAULT_SECTIONS).not.toContain('notes');
    expect(DB.cleanSections(['notes', 'todos', 'nope', 'todos'])).toEqual(['todos', 'notes']);
    expect(DB.cleanSections(undefined)).toEqual(DB.DEFAULT_SECTIONS);
    expect(DB.cleanSections([])).toEqual([]);
  });

  it('keeps the newest 5,000 notes at most', () => {
    const many = Array.from({ length: 5003 }, (_, i): LifeEvent => ({ ...note, id: `manual:${i}`, at: T - i }));
    expect(DB.rowsFrom(state(), ['notes'], many).get('notes')!.size).toBe(DB.NOTES_MAX);
  });
});

describe('your own database: what changed', () => {
  it('writes what is new or changed and takes out what went', () => {
    const st = state();
    const first = DB.changes(DB.rowsFrom(st, ['todos', 'groceries']), {});
    expect(first.map((o) => ('put' in o ? `${o.put} ${o.row[0]}` : ''))).toEqual(['todos t1', 'groceries r1']);
    const copied = DB.applied({}, first);
    expect(Object.keys(copied)).toEqual(['todos\tt1', 'groceries\tr1']);
    expect(DB.changes(DB.rowsFrom(st, ['todos', 'groceries']), copied)).toEqual([]);

    st.todos.t1 = { ...st.todos.t1, done: T + 5, at: T + 5 };
    delete st.groceries.r1;
    const next = DB.changes(DB.rowsFrom(st, ['todos', 'groceries']), copied);
    expect(next).toEqual([{ put: 'todos', row: ['t1', 'Call the bank', '2026-11-27', '09:30', T + 5, 1, null, T, T + 5] }, { drop: 'groceries', id: 'r1' }]);
    expect(DB.counts(next)).toEqual({ todos: 1, groceries: 1 });
    expect(DB.applied(copied, next)).toEqual({ 'todos\tt1': DB.fingerprint((next[0] as { row: DB.Row }).row) });
  });

  it('takes out the rows of a section turned off, and ignores what it does not know', () => {
    const st = state();
    const copied = DB.applied({ 'nope\tx': 'abc' }, DB.changes(DB.rowsFrom(st, ['todos', 'money']), {}));
    expect(DB.changes(DB.rowsFrom(st, ['todos']), copied)).toEqual([{ drop: 'money_owed', id: 'd1' }]);
  });

  it('tells rows apart by every value', () => {
    expect(DB.fingerprint(['a', 1, null])).toBe(DB.fingerprint(['a', 1, null]));
    expect(DB.fingerprint(['a', 1, null])).not.toBe(DB.fingerprint(['a', 1, '']));
    expect(DB.fingerprint(['a', 1])).not.toBe(DB.fingerprint(['a', 2]));
  });

  it('sends small batches', () => {
    const list = Array.from({ length: 95 }, (_, i) => i);
    expect(DB.batches(list).map((b) => b.length)).toEqual([40, 40, 15]);
    expect(DB.batches([])).toEqual([]);
  });
});

describe('your own database: the SQL', () => {
  it('reads as plain SQL', () => {
    expect(DB.createSql(DB.table('todos')!)).toBe(
      'CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT, day TEXT, at_time TEXT, done_at INTEGER, big INTEGER, added_by TEXT, created_at INTEGER, changed_at INTEGER)',
    );
    expect(DB.opSql({ put: 'groceries', row: ['r1', 'Milk', '2', null, T, T] })).toEqual({
      sql: 'INSERT INTO groceries (id, name, qty, got_at, created_at, changed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, qty = excluded.qty, got_at = excluded.got_at, created_at = excluded.created_at, changed_at = excluded.changed_at',
      args: ['r1', 'Milk', '2', null, T, T],
    });
    expect(DB.opSql({ drop: 'todos', id: 't1' })).toEqual({ sql: 'DELETE FROM todos WHERE id = ?', args: ['t1'] });
  });

  it('runs on SQLite: every table made, every row written, changed and taken out', () => {
    const db = new DatabaseSync(':memory:');
    const exec = (s: DB.Stmt) => db.prepare(s.sql).run(...((s.args || []) as (string | number | null)[]));
    DB.setupSql().forEach(exec);
    DB.setupSql().forEach(exec); // twice is fine
    const st = state();
    const ops = DB.changes(DB.rowsFrom(st, DB.SECTION_IDS, [note]), {});
    ops.map(DB.opSql).forEach(exec);
    for (const x of DB.TABLES) expect(Number((db.prepare(`SELECT count(*) AS n FROM ${x.name}`).get() as { n: number }).n), x.name).toBeGreaterThan(0);
    expect({ ...db.prepare('SELECT title, day, big FROM todos WHERE id = ?').get('t1') }).toEqual({ title: 'Call the bank', day: '2026-11-27', big: 1 });
    expect({ ...db.prepare("SELECT value FROM arise_info WHERE key = 'schema'").get() }).toEqual({ value: String(DB.DB_SCHEMA) });

    st.todos.t1 = { ...st.todos.t1, title: 'Call the bank again', at: T + 9 };
    delete st.debts.d1;
    DB.changes(DB.rowsFrom(st, DB.SECTION_IDS, [note]), DB.applied({}, ops)).map(DB.opSql).forEach(exec);
    expect({ ...db.prepare('SELECT title FROM todos WHERE id = ?').get('t1') }).toEqual({ title: 'Call the bank again' });
    expect(db.prepare('SELECT * FROM money_owed').all()).toEqual([]);

    DB.emptySql().forEach(exec);
    for (const x of DB.TABLES) expect(db.prepare(`SELECT * FROM ${x.name}`).all(), x.name).toEqual([]);
  });
});
