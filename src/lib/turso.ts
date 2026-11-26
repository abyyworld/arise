// Turso (libSQL) over HTTPS, straight from this device: the v2 pipeline of its HTTP API
// (POST {database}/v2/pipeline with the token as a bearer). Each call sends a few statements and
// a close, so nothing stays open on Turso's side between calls.
//
// Values go as the API's typed values, never pasted into the SQL.

import type { Cell, Stmt } from './own-db';

export interface Turso {
  url: string; // https://<database>-<org>.<region>.turso.io
  token: string;
}

// What the Player pasted: the database URL (libsql:// or https://) and its token.
export function readTurso(raw: { url?: string; token?: string }): Turso | string {
  let url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const token = typeof raw.token === 'string' ? raw.token.trim().replace(/^Bearer\s+/i, '') : '';
  url = url.replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '');
  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch {}
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/') || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) {
    return "That database URL doesn't look right. In Turso, open the database and copy its URL. It starts with libsql://.";
  }
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 4000) {
    return "That token doesn't look right. In Turso, open the database, make a token with read and write, and copy all of it.";
  }
  return { url: `https://${u.hostname.toLowerCase()}`, token };
}

export const hostOf = (t: Pick<Turso, 'url'>) => t.url.replace(/^https:\/\//, '');

export class TursoError extends Error {
  constructor(
    message: string,
    readonly status = 0, // the HTTP status, 0 when nothing came back
    readonly again = false, // worth trying again later
  ) {
    super(message);
  }
}

type Value = { type: 'null' } | { type: 'integer'; value: string } | { type: 'float'; value: number } | { type: 'text'; value: string };

export function value(v: Cell): Value {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? { type: 'integer', value: String(v) } : Number.isFinite(v) ? { type: 'float', value: v } : { type: 'null' };
  return { type: 'text', value: v };
}

// The request body for these statements.
export const pipelineBody = (stmts: readonly Stmt[]) => ({
  requests: [...stmts.map((st) => ({ type: 'execute', stmt: st.args?.length ? { sql: st.sql, args: st.args.map(value) } : { sql: st.sql } })), { type: 'close' }],
});

export interface Result {
  cols: string[];
  rows: Cell[][];
}

const cell = (v: unknown): Cell => {
  const x = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (x.type === 'integer' || x.type === 'float') return Number(x.value);
  if (x.type === 'text') return String(x.value);
  return null;
};

const WAITS = [1000, 4000]; // between tries, when Turso is busy or the network dropped

export interface Options {
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}

// Runs the statements in order and gives each one's rows. Tries twice more when it's worth it.
export async function run(db: Turso, stmts: readonly Stmt[], { fetch: f = globalThis.fetch.bind(globalThis), wait = (ms) => new Promise((r) => setTimeout(r, ms)) }: Options = {}): Promise<Result[]> {
  const body = JSON.stringify(pipelineBody(stmts));
  for (let i = 0; ; i++) {
    try {
      return await once(db, body, stmts.length, f);
    } catch (err) {
      const e = err instanceof TursoError ? err : new TursoError("Couldn't reach your database. Check your connection.", 0, true);
      if (!e.again || i >= WAITS.length) throw e;
      await wait(WAITS[i]);
    }
  }
}

async function once(db: Turso, body: string, count: number, f: typeof fetch): Promise<Result[]> {
  const res = await f(`${db.url}/v2/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${db.token}`, 'content-type': 'application/json' }, body });
  if (res.status === 401 || res.status === 403) throw new TursoError('Turso turned down the token. Make a new one with read and write, and connect again.', res.status);
  if (res.status === 404) throw new TursoError('There is no database at that URL. Check it in Turso.', res.status);
  if (res.status === 429 || res.status >= 500) throw new TursoError('Turso is busy. Arise tries again soon.', res.status, true);
  if (!res.ok) throw new TursoError(`Turso said no (${res.status}).`, res.status);
  let data: { results?: unknown[] };
  try {
    data = await res.json();
  } catch {
    throw new TursoError('Turso sent back something Arise could not read.', res.status, true);
  }
  const results = Array.isArray(data?.results) ? data.results : [];
  if (results.length < count) throw new TursoError('Turso sent back something Arise could not read.', res.status, true);
  return results.slice(0, count).map((r) => {
    const x = (r && typeof r === 'object' ? r : {}) as { type?: string; error?: { message?: string }; response?: { result?: { cols?: { name?: string }[]; rows?: unknown[][] } } };
    if (x.type !== 'ok') throw new TursoError(`Your database said: ${String(x.error?.message || 'an error').slice(0, 200)}`, res.status);
    const result = x.response?.result;
    return { cols: (result?.cols || []).map((c) => String(c?.name ?? '')), rows: (result?.rows || []).map((row) => (Array.isArray(row) ? row.map(cell) : [])) };
  });
}
