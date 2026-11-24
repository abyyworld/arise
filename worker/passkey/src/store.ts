// Where the passkeys are kept: one Durable Object with its own SQLite database. For each passkey,
// only its id, its public key, which account it signs in to, the name the person gave it, when
// it was added and last used, and its count. Never anything of the account's data, and nothing
// that could sign in by itself: a public key only checks signatures.
//
// Each request to add a passkey or sign in gets a random challenge that can be used once, for
// five minutes.

import { challengeOf, fromB64url, toB64url, verifyAssertion, verifyRegistration, WebAuthnError, type Alg } from './webauthn';

export interface SqlLike {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}
export interface StateLike {
  storage: { sql: SqlLike };
}

export const MAX_PER_ACCOUNT = 10; // as many as firestore.rules keeps wraps for
export const CHALLENGE_MS = 5 * 60_000;
const MAX_CHALLENGES = 5000;
const te = new TextEncoder();

export type Op =
  | { op: 'start'; kind: 'add' | 'signin'; origin: string; uid?: string }
  | { op: 'add'; uid: string; origin: string; name: string; clientDataJSON: string; attestationObject: string }
  | { op: 'signin'; origin: string; id: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null }
  | { op: 'list'; uid: string }
  | { op: 'remove'; uid: string; id?: string };

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const no = (status: number, message: string) => reply(status, { error: { message } });

/** A name for the passkey as the person typed it: plain text, one line, at most 60 characters. */
export function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return s || 'Passkey';
}

export class Passkeys {
  private sql: SqlLike;

  constructor(
    state: StateLike,
    _env?: unknown,
    private now: () => number = Date.now,
  ) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY, uid TEXT NOT NULL, alg INTEGER NOT NULL, jwk TEXT NOT NULL, count INTEGER NOT NULL,
      name TEXT NOT NULL, added INTEGER NOT NULL, used INTEGER, synced INTEGER NOT NULL)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS passkeys_uid ON passkeys (uid)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS challenges (c TEXT PRIMARY KEY, kind TEXT NOT NULL, uid TEXT, origin TEXT NOT NULL, until INTEGER NOT NULL)');
  }

  async fetch(req: Request): Promise<Response> {
    let op: Op;
    try {
      op = (await req.json()) as Op;
    } catch {
      return no(400, 'Bad request.');
    }
    try {
      return await this.run(op);
    } catch (err) {
      if (err instanceof WebAuthnError) return no(400, err.message);
      throw err;
    }
  }

  private ofAccount(uid: string) {
    return this.sql.exec('SELECT id, name, added, used, synced FROM passkeys WHERE uid = ? ORDER BY added', uid).toArray();
  }

  // The challenge, once: gone as soon as it's read. Null when it's unknown, used or too old.
  private take(c: string, kind: 'add' | 'signin', origin: string) {
    if (!c) return null;
    const row = this.sql.exec('DELETE FROM challenges WHERE c = ? RETURNING kind, uid, origin, until', c).toArray()[0];
    if (!row || row.kind !== kind || row.origin !== origin || Number(row.until) < this.now()) return null;
    return { uid: (row.uid as string | null) ?? '' };
  }

  private async run(op: Op): Promise<Response> {
    switch (op.op) {
      case 'start': {
        const now = this.now();
        this.sql.exec('DELETE FROM challenges WHERE until < ?', now);
        const n = Number(this.sql.exec('SELECT COUNT(*) AS n FROM challenges').toArray()[0]?.n ?? 0);
        if (n >= MAX_CHALLENGES) return no(503, 'Too busy right now. Try again in a few minutes.');
        let ids: string[] = [];
        if (op.kind === 'add') {
          ids = this.ofAccount(op.uid || '').map((r) => String(r.id));
          if (ids.length >= MAX_PER_ACCOUNT) return no(409, `You have ${MAX_PER_ACCOUNT} passkeys, the most an account can have. Remove one first.`);
        }
        const challenge = toB64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
        this.sql.exec('INSERT INTO challenges (c, kind, uid, origin, until) VALUES (?, ?, ?, ?, ?)', challenge, op.kind, op.kind === 'add' ? op.uid || '' : null, op.origin, now + CHALLENGE_MS);
        return reply(200, op.kind === 'add' ? { challenge, ids } : { challenge });
      }
      case 'add': {
        const clientDataJSON = fromB64url(op.clientDataJSON);
        const challenge = challengeOf(clientDataJSON);
        const asked = this.take(challenge, 'add', op.origin);
        if (!asked || asked.uid !== op.uid) return no(400, 'That took too long, or was already used. Try again.');
        const made = await verifyRegistration({ clientDataJSON, attestationObject: fromB64url(op.attestationObject) }, { challenge, origin: op.origin, rpId: new URL(op.origin).hostname });
        if (this.ofAccount(op.uid).length >= MAX_PER_ACCOUNT) return no(409, `You have ${MAX_PER_ACCOUNT} passkeys, the most an account can have. Remove one first.`);
        if (this.sql.exec('SELECT id FROM passkeys WHERE id = ?', made.id).toArray().length) return no(409, 'That passkey is already added.');
        const name = cleanName(op.name);
        const added = this.now();
        this.sql.exec(
          'INSERT INTO passkeys (id, uid, alg, jwk, count, name, added, used, synced) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
          made.id,
          op.uid,
          made.alg,
          JSON.stringify(made.jwk),
          made.count,
          name,
          added,
          made.backedUp ? 1 : 0,
        );
        return reply(200, { id: made.id, name, added });
      }
      case 'signin': {
        const clientDataJSON = fromB64url(op.clientDataJSON);
        const challenge = challengeOf(clientDataJSON);
        if (!this.take(challenge, 'signin', op.origin)) return no(400, 'That took too long, or was already used. Try again.');
        const row = typeof op.id === 'string' ? this.sql.exec('SELECT uid, alg, jwk, count FROM passkeys WHERE id = ?', op.id).toArray()[0] : undefined;
        if (!row) return no(404, "Arise doesn't know this passkey. It may have been removed. Sign in with your password.");
        const uid = String(row.uid);
        // The account the passkey was made for, as the passkey itself says.
        if (op.userHandle && op.userHandle !== toB64url(te.encode(uid))) return no(400, "The passkey's account doesn't match.");
        const done = await verifyAssertion(
          { clientDataJSON, authenticatorData: fromB64url(op.authenticatorData), signature: fromB64url(op.signature) },
          { alg: Number(row.alg) as Alg, jwk: JSON.parse(String(row.jwk)), count: Number(row.count) },
          { challenge, origin: op.origin, rpId: new URL(op.origin).hostname },
        );
        this.sql.exec('UPDATE passkeys SET count = ?, used = ?, synced = ? WHERE id = ?', done.count, this.now(), done.backedUp ? 1 : 0, op.id);
        return reply(200, { uid, id: op.id });
      }
      case 'list':
        return reply(200, { passkeys: this.ofAccount(op.uid).map((r) => ({ id: r.id, name: r.name, added: r.added, used: r.used ?? null, synced: r.synced === 1 })) });
      case 'remove': {
        const gone = op.id
          ? this.sql.exec('DELETE FROM passkeys WHERE uid = ? AND id = ? RETURNING id', op.uid, op.id).toArray()
          : this.sql.exec('DELETE FROM passkeys WHERE uid = ? RETURNING id', op.uid).toArray();
        return reply(200, { removed: gone.length });
      }
      default:
        return no(400, 'Bad request.');
    }
  }
}
