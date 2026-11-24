// Checking what a passkey sends (WebAuthn, https://www.w3.org/TR/webauthn-3/), with Web Crypto
// only: a new passkey's public key when it's added, and its signature each time it signs in.
//
// Two kinds of key: ES256 (ECDSA on P-256, what nearly every passkey uses) and RS256 (RSA, some
// Windows Hello keys). Attestation (which company made the authenticator) isn't asked for or
// checked: Arise only needs the key itself.

import { decode, decodeFirst, type Cbor } from './cbor';

export class WebAuthnError extends Error {}

const te = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

// ---------- bytes

export function toB64url(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: unknown): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new WebAuthnError('Something sent is not in the right form.');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await subtle().digest('SHA-256', bytes));

// ---------- what the browser says (clientDataJSON)

export interface Expect {
  challenge: string; // base64url, as Arise gave it
  origin: string; // the Arise address that asked
  rpId: string; // the passkey's site: that address's host name
  userVerified?: boolean; // the device checked who it is (face, fingerprint or screen lock); default true
}

function clientData(bytes: Uint8Array, type: 'webauthn.create' | 'webauthn.get', expect: Expect) {
  let c: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown; topOrigin?: unknown };
  try {
    c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new WebAuthnError("The browser's answer can't be read.");
  }
  if (!c || c.type !== type) throw new WebAuthnError("The browser's answer is for something else.");
  if (c.challenge !== expect.challenge) throw new WebAuthnError("The browser's answer doesn't fit this request.");
  if (c.origin !== expect.origin) throw new WebAuthnError("The browser's answer came from another site.");
  if (c.crossOrigin === true || c.topOrigin !== undefined) throw new WebAuthnError('Passkeys only work on the Arise page itself.');
}

/** Reads the challenge out of a clientDataJSON, to find the request it answers. */
export function challengeOf(bytes: Uint8Array): string {
  try {
    const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof c?.challenge === 'string' && c.challenge.length <= 200 ? c.challenge : '';
  } catch {
    return '';
  }
}

// ---------- what the authenticator says (authenticatorData)

const UP = 0x01; // someone was there
const UV = 0x04; // and the device checked who
const BE = 0x08; // the passkey can be synced
const BS = 0x10; // and it is
const AT = 0x40; // a new key follows
const ED = 0x80; // extensions follow

export interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  count: number;
  backedUp: boolean;
  credential?: { id: Uint8Array; key: Map<Cbor, Cbor> };
}

export function parseAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) throw new WebAuthnError("The passkey's answer is too short.");
  const flags = bytes[32];
  const count = ((bytes[33] << 24) >>> 0) + (bytes[34] << 16) + (bytes[35] << 8) + bytes[36];
  let at = 37;
  let credential: AuthData['credential'];
  if (flags & AT) {
    if (bytes.length < at + 18) throw new WebAuthnError("The passkey's answer is too short.");
    at += 16; // the authenticator's model (AAGUID), not used
    const n = (bytes[at] << 8) | bytes[at + 1];
    at += 2;
    if (n < 16 || n > 1023 || bytes.length < at + n) throw new WebAuthnError("The passkey's id doesn't look right.");
    const id = bytes.slice(at, at + n);
    at += n;
    let read;
    try {
      read = decodeFirst(bytes, at);
    } catch {
      throw new WebAuthnError("The passkey's key can't be read.");
    }
    if (!(read.value instanceof Map)) throw new WebAuthnError("The passkey's key can't be read.");
    credential = { id, key: read.value };
    at = read.end;
  }
  if (flags & ED) {
    try {
      at = decodeFirst(bytes, at).end;
    } catch {
      throw new WebAuthnError("The passkey's answer can't be read.");
    }
  }
  if (at !== bytes.length) throw new WebAuthnError("The passkey's answer has more in it than it should.");
  return { rpIdHash: bytes.slice(0, 32), flags, count, backedUp: !!(flags & BS), credential };
}

async function checkAuthData(auth: AuthData, expect: Expect) {
  if (!same(auth.rpIdHash, await sha256(te.encode(expect.rpId)))) throw new WebAuthnError('That passkey is for another site.');
  if (!(auth.flags & UP)) throw new WebAuthnError("The passkey didn't check that someone was there.");
  if ((expect.userVerified ?? true) && !(auth.flags & UV)) throw new WebAuthnError("The device didn't check it's you (face, fingerprint or screen lock).");
  if (auth.flags & BS && !(auth.flags & BE)) throw new WebAuthnError("The passkey's answer doesn't add up.");
}

// ---------- keys (COSE, RFC 9052 and 9053)

export type Alg = -7 | -257;
export const ALGS: Alg[] = [-7, -257];

const bytesAt = (m: Map<Cbor, Cbor>, k: number) => {
  const v = m.get(k);
  if (!(v instanceof Uint8Array)) throw new WebAuthnError("The passkey's key isn't complete.");
  return v;
};

/** The key as a JWK Web Crypto can import, and its algorithm. Only ES256 and RS256. */
export async function keyFromCose(cose: Map<Cbor, Cbor>): Promise<{ alg: Alg; jwk: JsonWebKey }> {
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk: JsonWebKey;
  if (kty === 2 && alg === -7) {
    if (cose.get(-1) !== 1) throw new WebAuthnError('Arise only takes passkeys on the P-256 curve.');
    const x = bytesAt(cose, -2);
    const y = bytesAt(cose, -3);
    if (x.length !== 32 || y.length !== 32) throw new WebAuthnError("The passkey's key isn't complete.");
    jwk = { kty: 'EC', crv: 'P-256', x: toB64url(x), y: toB64url(y) };
  } else if (kty === 3 && alg === -257) {
    const n = bytesAt(cose, -1);
    const e = bytesAt(cose, -2);
    const bits = (n.length - (n[0] === 0 ? 1 : 0)) * 8;
    if (bits < 2048 || bits > 8192 || e.length > 8) throw new WebAuthnError('That RSA key is too weak or too big.');
    jwk = { kty: 'RSA', n: toB64url(n), e: toB64url(e) };
  } else {
    throw new WebAuthnError('Arise only takes passkeys with ES256 or RS256 keys.');
  }
  await importKey(alg, jwk); // throws for a point that isn't on the curve, and the like
  return { alg, jwk };
}

async function importKey(alg: Alg, jwk: JsonWebKey): Promise<CryptoKey> {
  try {
    return alg === -7
      ? await subtle().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      : await subtle().importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch {
    throw new WebAuthnError("The passkey's key doesn't work.");
  }
}

// ECDSA signatures come as DER (SEQUENCE of two INTEGERs); Web Crypto wants r and s side by side.
export function derToRaw(der: Uint8Array, size = 32): Uint8Array<ArrayBuffer> {
  const bad = () => new WebAuthnError("The passkey's signature doesn't look right.");
  let at = 0;
  if (der[at++] !== 0x30) throw bad();
  let len = der[at++];
  if (len === 0x81) len = der[at++];
  else if (len > 0x80) throw bad();
  if (len !== der.length - at) throw bad();
  const out = new Uint8Array(size * 2);
  for (let i = 0; i < 2; i++) {
    if (der[at++] !== 0x02) throw bad();
    const n = der[at++];
    if (!n || n > size + 1 || at + n > der.length) throw bad();
    let v = der.subarray(at, at + n);
    at += n;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw bad();
    out.set(v, size * (i + 1) - v.length);
  }
  if (at !== der.length) throw bad();
  return out;
}

// ---------- adding a passkey

export interface NewPasskey {
  id: string; // base64url
  alg: Alg;
  jwk: JsonWebKey;
  count: number;
  backedUp: boolean;
}

export async function verifyRegistration(r: { clientDataJSON: Uint8Array; attestationObject: Uint8Array }, expect: Expect): Promise<NewPasskey> {
  clientData(r.clientDataJSON, 'webauthn.create', expect);
  let att: Cbor;
  try {
    att = decode(r.attestationObject);
  } catch {
    throw new WebAuthnError("The passkey's answer can't be read.");
  }
  const authData = att instanceof Map ? att.get('authData') : null;
  if (!(authData instanceof Uint8Array) || typeof (att as Map<Cbor, Cbor>).get('fmt') !== 'string') throw new WebAuthnError("The passkey's answer can't be read.");
  const auth = parseAuthData(authData);
  await checkAuthData(auth, expect);
  if (!auth.credential) throw new WebAuthnError('The passkey sent no key.');
  const { alg, jwk } = await keyFromCose(auth.credential.key);
  return { id: toB64url(auth.credential.id), alg, jwk, count: auth.count, backedUp: auth.backedUp };
}

// ---------- signing in

export interface Known {
  alg: Alg;
  jwk: JsonWebKey;
  count: number; // the last count it sent (0 for passkeys that don't count)
}

/** Checks a sign-in. Returns the count to keep. */
export async function verifyAssertion(r: { clientDataJSON: Uint8Array<ArrayBuffer>; authenticatorData: Uint8Array<ArrayBuffer>; signature: Uint8Array<ArrayBuffer> }, known: Known, expect: Expect): Promise<{ count: number; backedUp: boolean }> {
  clientData(r.clientDataJSON, 'webauthn.get', expect);
  const auth = parseAuthData(r.authenticatorData);
  await checkAuthData(auth, expect);
  if (auth.credential) throw new WebAuthnError("The passkey's answer has more in it than it should.");
  const key = await importKey(known.alg, known.jwk);
  const signed = concat(r.authenticatorData, await sha256(r.clientDataJSON));
  const ok =
    known.alg === -7
      ? await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(r.signature), signed)
      : await subtle().verify('RSASSA-PKCS1-v1_5', key, r.signature, signed);
  if (!ok) throw new WebAuthnError("The passkey's signature doesn't match.");
  // A count that doesn't go up may mean a copy of the passkey: refused. (Synced passkeys always
  // send 0.)
  if ((auth.count !== 0 || known.count !== 0) && auth.count <= known.count) throw new WebAuthnError('This passkey may have been copied, so it was refused. Remove it and add it again.');
  return { count: auth.count, backedUp: auth.backedUp };
}
