// Firebase sign-in tokens, both ways:
//   - a custom token (https://firebase.google.com/docs/auth/admin/create-custom-tokens), made here
//     after a passkey signed in, signed with the Firebase project's service account key (a Worker
//     secret only the owner sets). The app hands it to Firebase, which signs in as that account.
//   - the app's own ID token, checked here (Google's public keys) to know which account adds,
//     lists or removes its passkeys.

import { fromB64url, toB64url } from './webauthn';

const te = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
export const AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

export interface ServiceAccount {
  email: string;
  projectId: string;
  key: CryptoKey;
}

/** The service account key file (JSON) as Google makes it. Throws with a plain message. */
export async function serviceAccount(text: string): Promise<ServiceAccount> {
  let sa: { type?: unknown; project_id?: unknown; client_email?: unknown; private_key?: unknown };
  try {
    sa = JSON.parse(text);
  } catch {
    throw new Error("The service account key isn't JSON.");
  }
  if (sa?.type !== 'service_account' || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string' || typeof sa.project_id !== 'string') throw new Error("That isn't a service account key.");
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  let key: CryptoKey;
  try {
    key = await subtle().importKey('pkcs8', fromB64url(pem.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), RSA, false, ['sign']);
  } catch {
    throw new Error("The service account's private key can't be read.");
  }
  return { email: sa.client_email, projectId: sa.project_id, key };
}

const part = (o: unknown) => toB64url(te.encode(JSON.stringify(o)));

/** A custom token for `uid`, good for an hour (Firebase's longest). */
export async function customToken(sa: ServiceAccount, uid: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!uid || uid.length > 128) throw new Error('uid');
  const head = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: sa.email, sub: sa.email, aud: AUDIENCE, iat: now, exp: now + 3600, uid })}`;
  const sig = await subtle().sign(RSA, sa.key, te.encode(head));
  return `${head}.${toB64url(sig)}`;
}

// ---------- the app's ID token
// https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks: { keys: Map<string, CryptoKey>; until: number } | null = null;

export async function googleKey(kid: string): Promise<CryptoKey | undefined> {
  if (!jwks || Date.now() > jwks.until || !jwks.keys.has(kid)) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error('jwks');
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]) || 3600;
    const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const keys = new Map<string, CryptoKey>();
    for (const k of body.keys) keys.set(k.kid, await subtle().importKey('jwk', k, RSA, false, ['verify']));
    jwks = { keys, until: Date.now() + maxAge * 1000 };
  }
  return jwks.keys.get(kid);
}

const claimsOf = (s: string) => JSON.parse(new TextDecoder().decode(fromB64url(s)));

/** The account's uid, and when it last signed in (seconds), from a valid ID token. Throws otherwise. */
export async function verifyIdToken(token: string, projectId: string, now = Date.now() / 1000, keyFor = googleKey): Promise<{ uid: string; authTime: number }> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('shape');
  const header = claimsOf(h);
  const claims = claimsOf(p);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('alg');
  const key = await keyFor(header.kid);
  if (!key) throw new Error('kid');
  if (!(await subtle().verify(RSA, key, fromB64url(s), te.encode(`${h}.${p}`)))) throw new Error('signature');
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('audience');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('expired');
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) throw new Error('issued');
  if (typeof claims.auth_time !== 'number' || claims.auth_time > now + 60) throw new Error('auth_time');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw new Error('sub');
  return { uid: claims.sub, authTime: claims.auth_time };
}
