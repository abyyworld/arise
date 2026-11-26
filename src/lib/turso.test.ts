// Turso's HTTP API (v2 pipeline), with a mocked fetch: what was pasted, the exact request bodies,
// the answers read back, and trying again only when it's worth it.

import { describe, expect, it, vi } from 'vitest';
import { pipelineBody, readTurso, run, TursoError, value, hostOf } from './turso';

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJhIjoicncifQ.c2ln-bmF0_dXJl';
const DB = { url: 'https://arise-sam.aws-eu-west-1.turso.io', token: TOKEN };

const ok = (results: unknown[]) => new Response(JSON.stringify({ baton: null, base_url: null, results }), { status: 200 });
const exec = (cols: string[] = [], rows: unknown[][] = []) => ({ type: 'ok', response: { type: 'execute', result: { cols: cols.map((name) => ({ name, decltype: null })), rows, affected_row_count: 1 } } });
const close = { type: 'ok', response: { type: 'close' } };

describe('Turso', () => {
  it('takes the database URL and token as pasted, or says what is wrong', () => {
    expect(readTurso({ url: ' libsql://Arise-Sam.aws-eu-west-1.turso.io ', token: ` ${TOKEN} ` })).toEqual(DB);
    expect(readTurso({ url: 'https://arise-sam.aws-eu-west-1.turso.io/', token: `Bearer ${TOKEN}` })).toEqual(DB);
    expect(hostOf(DB)).toBe('arise-sam.aws-eu-west-1.turso.io');
    for (const url of ['', 'arise.turso.io', 'http://arise.turso.io', 'https://user:pw@arise.turso.io', 'https://arise.turso.io/v2/pipeline', 'https://arise.turso.io?x=1', 'https://localhost']) {
      expect(readTurso({ url, token: TOKEN }), url).toContain('database URL');
    }
    for (const token of ['', 'abc', 'a.b', 'a b.c.d', `${TOKEN}"`]) expect(readTurso({ url: DB.url, token }), token).toContain('token');
  });

  it('sends each value typed, never pasted into the SQL', () => {
    expect(value(null)).toEqual({ type: 'null' });
    expect(value(12)).toEqual({ type: 'integer', value: '12' });
    expect(value(1780000000000)).toEqual({ type: 'integer', value: '1780000000000' });
    expect(value(12.5)).toEqual({ type: 'float', value: 12.5 });
    expect(value(Number.NaN)).toEqual({ type: 'null' });
    expect(value("Robert'); DROP TABLE todos;--")).toEqual({ type: 'text', value: "Robert'); DROP TABLE todos;--" });
  });

  it('posts the exact pipeline, with the token, and reads the rows back', async () => {
    const f = vi.fn(async () => ok([exec(), exec(['value'], [[{ type: 'text', value: 'x1' }]]), exec(['n', 'f', 'z'], [[{ type: 'integer', value: '3' }, { type: 'float', value: 1.5 }, { type: 'null' }]]), close]));
    const res = await run(DB, [{ sql: 'INSERT INTO t (id, a) VALUES (?, ?)', args: ['a', 1] }, { sql: "SELECT value FROM arise_info WHERE key = 'check'" }, { sql: 'SELECT n, f, z FROM t' }], { fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://arise-sam.aws-eu-west-1.turso.io/v2/pipeline');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      requests: [
        { type: 'execute', stmt: { sql: 'INSERT INTO t (id, a) VALUES (?, ?)', args: [{ type: 'text', value: 'a' }, { type: 'integer', value: '1' }] } },
        { type: 'execute', stmt: { sql: "SELECT value FROM arise_info WHERE key = 'check'" } },
        { type: 'execute', stmt: { sql: 'SELECT n, f, z FROM t' } },
        { type: 'close' },
      ],
    });
    expect(String(init.body)).toBe(JSON.stringify(pipelineBody([{ sql: 'INSERT INTO t (id, a) VALUES (?, ?)', args: ['a', 1] }, { sql: "SELECT value FROM arise_info WHERE key = 'check'" }, { sql: 'SELECT n, f, z FROM t' }])));
    expect(res).toEqual([
      { cols: [], rows: [] },
      { cols: ['value'], rows: [['x1']] },
      { cols: ['n', 'f', 'z'], rows: [[3, 1.5, null]] },
    ]);
  });

  it('tries again when Turso is busy or the network dropped, then gives up', async () => {
    const wait = vi.fn(async () => {});
    let n = 0;
    const flaky = vi.fn(async () => {
      n++;
      if (n === 1) throw new TypeError('Failed to fetch');
      if (n === 2) return new Response('busy', { status: 503 });
      return ok([exec(), close]);
    });
    expect(await run(DB, [{ sql: 'SELECT 1' }], { fetch: flaky as unknown as typeof fetch, wait })).toEqual([{ cols: [], rows: [] }]);
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[1000], [4000]]);

    const down = vi.fn(async () => new Response('slow down', { status: 429 }));
    const err = await run(DB, [{ sql: 'SELECT 1' }], { fetch: down as unknown as typeof fetch, wait }).catch((e) => e);
    expect(down).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(TursoError);
    expect(err).toMatchObject({ status: 429, again: true, message: 'Turso is busy. Arise tries again soon.' });
  });

  it('does not try again with a wrong token, a wrong address or bad SQL', async () => {
    const wait = vi.fn(async () => {});
    for (const [status, msg] of [
      [401, 'Turso turned down the token'],
      [403, 'Turso turned down the token'],
      [404, 'There is no database at that URL'],
      [400, 'Turso said no (400).'],
    ] as const) {
      const f = vi.fn(async () => new Response('no', { status }));
      const err = await run(DB, [{ sql: 'SELECT 1' }], { fetch: f as unknown as typeof fetch, wait }).catch((e) => e);
      expect(f).toHaveBeenCalledTimes(1);
      expect(err).toMatchObject({ status, again: false });
      expect(err.message).toContain(msg);
    }
    const bad = vi.fn(async () => ok([{ type: 'error', error: { message: 'no such table: todo', code: 'SQLITE_ERROR' } }, close]));
    const err = await run(DB, [{ sql: 'SELECT * FROM todo' }], { fetch: bad as unknown as typeof fetch, wait }).catch((e) => e);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(err.message).toBe('Your database said: no such table: todo');
    expect(wait).not.toHaveBeenCalled();
  });
});
