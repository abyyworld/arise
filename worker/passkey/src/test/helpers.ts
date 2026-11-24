// For the tests: a passkey in software (an authenticator that makes its own ES256 key and signs
// like a real one), a small CBOR writer for what it sends, and a Durable Object's storage on
// Node's own SQLite.

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { StateLike } from '../store';
import { toB64url } from '../webauthn';

const subtle = () => globalThis.crypto.subtle;
const te = new TextEncoder();

export const hex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));

// ---------- CBOR, written

type Value = number | string | Uint8Array | Value[] | Map<number | string, Value>;
function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function cbor(v: Value): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  const put = (x: Value) => {
    if (typeof x === 'number') out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (typeof x === 'string') {
      const b = te.encode(x);
      out.push(...head(3, b.length), ...b);
    } else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      x.forEach(put);
    } else {
      out.push(...head(5, x.size));
      for (const [k, val] of x) {
        put(k);
        put(val);
      }
    }
  };
  put(v);
  return new Uint8Array(out);
}

// ---------- a passkey in software

export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return v[0] & 0x80 ? [0x02, v.length + 1, 0, ...v] : [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

export interface SoftPasskey {
  id: Uint8Array<ArrayBuffer>;
  userId: Uint8Array;
  count: number;
  create(o: { challenge: string; origin: string; rpId: string; flags?: number }): Promise<{ id: string; clientDataJSON: string; attestationObject: string }>;
  get(o: { challenge: string; origin: string; rpId: string; flags?: number; count?: number }): Promise<{ id: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string }>;
}

export async function softPasskey(userId: Uint8Array): Promise<SoftPasskey> {
  const keys = (await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await subtle().exportKey('jwk', keys.publicKey);
  const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const cose = cbor(
    new Map<number, Value>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, b64(jwk.x!)],
      [-3, b64(jwk.y!)],
    ]),
  );
  const id = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const rpHash = async (rpId: string) => new Uint8Array(await subtle().digest('SHA-256', te.encode(rpId)));
  const counter = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const p: SoftPasskey = {
    id,
    userId,
    count: 0,
    async create({ challenge, origin, rpId, flags = FLAG.UP | FLAG.UV | FLAG.BE | FLAG.BS | FLAG.AT }) {
      const clientDataJSON = te.encode(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      const authData = new Uint8Array([...(await rpHash(rpId)), flags, ...counter(p.count), ...new Uint8Array(16), 0, id.length, ...id, ...cose]);
      const attestationObject = cbor(
        new Map<string, Value>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      return { id: toB64url(id), clientDataJSON: toB64url(clientDataJSON), attestationObject: toB64url(attestationObject) };
    },
    async get({ challenge, origin, rpId, flags = FLAG.UP | FLAG.UV | FLAG.BE | FLAG.BS, count = p.count }) {
      const clientDataJSON = te.encode(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
      const authData = new Uint8Array([...(await rpHash(rpId)), flags, ...counter(count)]);
      const hash = new Uint8Array(await subtle().digest('SHA-256', clientDataJSON));
      const raw = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new Uint8Array([...authData, ...hash])));
      return { id: toB64url(id), clientDataJSON: toB64url(clientDataJSON), authenticatorData: toB64url(authData), signature: toB64url(rawToDer(raw)), userHandle: toB64url(userId) };
    },
  };
  return p;
}

// ---------- a Durable Object's storage

export function fakeStorage(): StateLike {
  const db = new DatabaseSync(':memory:');
  return {
    storage: {
      sql: {
        exec(query: string, ...bindings: (string | number | null)[]) {
          const st = db.prepare(query);
          const rows = /^\s*SELECT|\bRETURNING\b/i.test(query) ? (st.all(...(bindings as SQLInputValue[])) as Record<string, unknown>[]) : (st.run(...(bindings as SQLInputValue[])), []);
          return { toArray: () => rows.map((r) => ({ ...r })) };
        },
      },
    },
  };
}

// ---------- RSA keys for tokens

export async function rsaKeys() {
  return (await subtle().generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
}

// A service account key file, as Google makes it, around a throwaway key.
export async function serviceAccountJson(keys: CryptoKeyPair, projectId = 'arise-test') {
  const der = new Uint8Array(await subtle().exportKey('pkcs8', keys.privateKey));
  const b64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ type: 'service_account', project_id: projectId, private_key_id: 'k1', private_key: pem, client_email: `firebase-adminsdk-x@${projectId}.iam.gserviceaccount.com` });
}

// An ID token like Firebase's, signed with a throwaway key.
export async function idToken(keys: CryptoKeyPair, claims: Record<string, unknown>) {
  const part = (o: unknown) => toB64url(te.encode(JSON.stringify(o)));
  const headPart = `${part({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })}.${part(claims)}`;
  const sig = await subtle().sign('RSASSA-PKCS1-v1_5', keys.privateKey, te.encode(headPart));
  return `${headPart}.${toB64url(sig)}`;
}
