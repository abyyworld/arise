// For the tests: a Durable Object's storage on Node's own SQLite (the same engine Cloudflare uses).

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { StateLike } from '../index';

export function fakeStorage() {
  const db = new DatabaseSync(':memory:');
  const state = {
    queries: [] as { query: string; bindings: (string | number | null)[] }[],
    // Every value in every table, as text: to check what is (and isn't) kept.
    dump: () =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .flatMap(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[])
        .map((r) => JSON.stringify(r))
        .join('\n'),
    storage: {
      sql: {
        exec(query: string, ...bindings: (string | number | null)[]) {
          state.queries.push({ query, bindings });
          const st = db.prepare(query);
          const rows = /^\s*SELECT|\bRETURNING\b/i.test(query) ? (st.all(...(bindings as SQLInputValue[])) as Record<string, unknown>[]) : (st.run(...(bindings as SQLInputValue[])), []);
          return { toArray: () => rows.map((r) => ({ ...r })) };
        },
      },
    },
  };
  return state satisfies StateLike;
}
