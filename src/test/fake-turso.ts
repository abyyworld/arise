// A pretend Turso database for the own database's tests: the v2 pipeline of its HTTP API, run on a
// real SQLite database in memory (node:sqlite), so the SQL Arise sends is checked for real.

// (Loaded at run time: the jsdom tests can't bundle a Node built-in.)
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export const URL_ = 'https://arise-sam.aws-eu-west-1.turso.io';
export const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJhIjoicnciLCJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJlLXNpZ25hdHVyZQ';

type Value = { type: string; value?: string | number };
interface Req {
  type: string;
  stmt?: { sql: string; args?: Value[] };
}

export function fakeTurso() {
  const db = new DatabaseSync(':memory:');
  const calls: { url: string; headers: Record<string, string>; body: { requests: Req[] } }[] = [];
  const t = {
    db,
    calls,
    // Answers with this status instead, for the next calls (one each).
    fail: [] as number[],
    offline: 0, // the next calls that never reach Turso
    rows: (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map((r) => ({ ...r })),
    count: (table: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n),
    tables: () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name),
    // The statements sent, call by call.
    sql: () => calls.map((c) => c.body.requests.filter((r) => r.type === 'execute').map((r) => r.stmt!.sql)),
    fetch: async (url: string, init: RequestInit = {}) => {
      const headers = { ...((init.headers as Record<string, string>) || {}) };
      const body = JSON.parse(String(init.body || '{}'));
      calls.push({ url, headers, body });
      if (t.offline > 0) {
        t.offline--;
        throw new TypeError('Failed to fetch');
      }
      const status = t.fail.shift();
      if (status) return new Response(JSON.stringify({ error: 'no' }), { status });
      if (url !== `${URL_}/v2/pipeline` || init.method !== 'POST') return new Response('Not found', { status: 404 });
      if (headers.authorization !== `Bearer ${TOKEN}`) return new Response('Unauthorized', { status: 401 });
      const results = (body.requests as Req[]).map((r) => {
        if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
        try {
          const args = (r.stmt!.args || []).map((a) => (a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.value!));
          const st = db.prepare(r.stmt!.sql);
          const reads = /^\s*SELECT/i.test(r.stmt!.sql);
          const rows = reads ? (st.all(...(args as (string | number | null)[])) as Record<string, unknown>[]) : [];
          if (!reads) st.run(...(args as (string | number | null)[]));
          const cols = reads ? st.columns().map((c) => ({ name: c.name, decltype: c.type })) : [];
          const typed = (v: unknown) => (v === null ? { type: 'null' } : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v }) : { type: 'text', value: String(v) });
          return { type: 'ok', response: { type: 'execute', result: { cols, rows: rows.map((row) => cols.map((c) => typed(row[c.name]))), affected_row_count: 0, last_insert_rowid: null } } };
        } catch (err) {
          return { type: 'error', error: { message: (err as Error).message, code: 'SQLITE_ERROR' } };
        }
      });
      return new Response(JSON.stringify({ baton: null, base_url: null, results }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
  return t;
}
export type FakeTurso = ReturnType<typeof fakeTurso>;
