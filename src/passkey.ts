// Passkeys in the browser (WebAuthn): making one, signing in with one, and talking to Arise's
// passkey helper (worker/passkey), which checks them and gives back a Firebase sign-in token.
// account.ts does the rest (signing in to Firebase, and each passkey's wrap of the data key).
//
// Each passkey is also asked for its own secret (the `prf` extension): made on the device, the
// same every time, never sent anywhere. Where the browser or passkey can't, it's null, and the
// passkey only signs in.
//
// Web only for now: the phone apps run from an address passkeys can't belong to.

import { PASSKEY } from './passkey-config';
import { PASSKEY_PRF_INPUT, fromB64url, toB64url } from './lib/crypto';

export class PasskeyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const server = () => (typeof PASSKEY.server === 'string' ? PASSKEY.server.replace(/\/+$/, '') : '');
export const configured = () => !!server();

// Whether this browser can offer passkeys at all (and the helper's address is set).
export function available(native = false): boolean {
  return !native && configured() && typeof globalThis.PublicKeyCredential === 'function' && typeof navigator !== 'undefined' && !!navigator.credentials?.create;
}

async function call<T>(path: string, body: unknown = {}, idToken?: string | null): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${server()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PasskeyError('offline', "Couldn't reach Arise's passkey helper. Check your connection and try again.");
  }
  const out = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw new PasskeyError(`http-${res.status}`, out?.error?.message || "Arise's passkey helper didn't answer. Try again later.");
  return out as T;
}

// What the browser says when a passkey prompt doesn't finish, in plain words.
function plain(err: unknown): never {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') throw new PasskeyError('cancelled', 'No passkey was used. Try again, or use your password.');
  if (name === 'InvalidStateError') throw new PasskeyError('exists', 'This device already has a passkey for your account.');
  if (name === 'SecurityError') throw new PasskeyError('address', "Passkeys don't work on this address.");
  if (name === 'NotSupportedError') throw new PasskeyError('unsupported', "This device can't make a passkey Arise can use.");
  throw err;
}

const prfInput = () => new TextEncoder().encode(PASSKEY_PRF_INPUT);
type PrfOut = { enabled?: boolean; results?: { first?: BufferSource } };
const prfOf = (cred: PublicKeyCredential) => (cred.getClientExtensionResults() as { prf?: PrfOut }).prf;
function secretOf(cred: PublicKeyCredential): Uint8Array | null {
  const r = prfOf(cred)?.results?.first;
  if (!r) return null;
  const u8 = r instanceof ArrayBuffer ? new Uint8Array(r) : new Uint8Array(r.buffer, r.byteOffset, r.byteLength);
  return u8.length >= 32 ? new Uint8Array(u8) : null;
}
const prfAsk = { prf: { eval: { first: prfInput() } } } as AuthenticationExtensionsClientInputs;

// ---------- signing in

// A challenge from the helper, fetched ahead, so the passkey's prompt comes straight from the
// tap (Safari wants that). Each one is used once.
let ahead: { at: number; p: Promise<{ challenge: string; rpId: string }> } | null = null;
const FRESH_MS = 4 * 60_000;
export function warm() {
  if (ahead && Date.now() - ahead.at < FRESH_MS) return;
  const p = call<{ challenge: string; rpId: string }>('/v1/signin/start');
  ahead = { at: Date.now(), p };
  p.catch(() => {
    if (ahead?.p === p) ahead = null;
  });
}

export interface Asserted {
  id: string; // the credential id, base64url
  secret: Uint8Array | null;
  answer: { id: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string };
}

// The passkey prompt: which passkey, and its signature (and secret).
export async function ask(): Promise<Asserted> {
  warm();
  const o = await ahead!.p;
  ahead = null;
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: { challenge: fromB64url(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: 120_000, extensions: prfAsk },
    })) as PublicKeyCredential | null;
  } catch (err) {
    plain(err);
  }
  if (!cred) throw new PasskeyError('cancelled', 'No passkey was used. Try again, or use your password.');
  const r = cred.response as AuthenticatorAssertionResponse;
  const id = toB64url(cred.rawId);
  return {
    id,
    secret: secretOf(cred),
    answer: { id, clientDataJSON: toB64url(r.clientDataJSON), authenticatorData: toB64url(r.authenticatorData), signature: toB64url(r.signature), userHandle: r.userHandle ? toB64url(r.userHandle) : '' },
  };
}

// The helper checks it: a Firebase custom token for the passkey's account.
export const finishSignIn = (a: Asserted) => call<{ token: string; id: string }>('/v1/signin/finish', a.answer);

// ---------- adding one (signed in)

export interface AddOptions {
  challenge: string;
  rpId: string;
  userId: string;
  ids: string[]; // the account's passkeys already: the device won't make a second one
}
export const startAdd = (idToken: string | null) => call<AddOptions>('/v1/add/start', {}, idToken);

export interface Made {
  id: string;
  clientDataJSON: string;
  attestationObject: string;
  secret: Uint8Array | null;
  prf: boolean; // the passkey can make a secret, even if it didn't say it yet
}

// The device makes the passkey. `name`: the account's email or code, as the device shows it.
export async function create(o: AddOptions, name: string): Promise<Made> {
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: o.rpId, name: 'Arise' },
        user: { id: fromB64url(o.userId), name, displayName: name },
        challenge: fromB64url(o.challenge),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none',
        excludeCredentials: o.ids.map((id) => ({ type: 'public-key' as const, id: fromB64url(id) })),
        timeout: 120_000,
        extensions: prfAsk,
      },
    })) as PublicKeyCredential;
  } catch (err) {
    plain(err);
  }
  if (!cred) throw new PasskeyError('cancelled', 'No passkey was made. Try again.');
  const r = cred.response as AuthenticatorAttestationResponse;
  const secret = secretOf(cred);
  return { id: toB64url(cred.rawId), clientDataJSON: toB64url(r.clientDataJSON), attestationObject: toB64url(r.attestationObject), secret, prf: !!secret || prfOf(cred)?.enabled === true };
}

export const finishAdd = (idToken: string | null, made: Made, name: string) =>
  call<{ id: string; name: string; added: number }>('/v1/add/finish', { name, clientDataJSON: made.clientDataJSON, attestationObject: made.attestationObject }, idToken);

// Some passkeys only give their secret when used, not when made: one more prompt, here on the
// device (nothing is sent anywhere).
export async function secretFor(id: string, rpId: string): Promise<Uint8Array | null> {
  try {
    const cred = (await navigator.credentials.get({
      publicKey: { challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)), rpId, allowCredentials: [{ type: 'public-key', id: fromB64url(id) }], userVerification: 'required', timeout: 120_000, extensions: prfAsk },
    })) as PublicKeyCredential | null;
    return cred ? secretOf(cred) : null;
  } catch {
    return null;
  }
}

// ---------- the account's passkeys

export interface Listed {
  id: string;
  name: string;
  added: number;
  used: number | null;
  synced: boolean;
}
export const list = (idToken: string | null) => call<{ passkeys: Listed[] }>('/v1/list', {}, idToken).then((r) => r.passkeys || []);
export const remove = (idToken: string | null, id: string) => call<{ removed: number }>('/v1/remove', { id }, idToken);
export const removeAll = (idToken: string | null) => call<{ removed: number }>('/v1/remove', { all: true }, idToken);

// Tells the device's password manager the passkey is gone, where it can be told (newer browsers).
export function forgetOnDevice(id: string) {
  const signal = (globalThis.PublicKeyCredential as unknown as { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> })?.signalUnknownCredential;
  if (typeof signal === 'function') signal.call(globalThis.PublicKeyCredential, { rpId: location.hostname, credentialId: id }).catch(() => {});
}

// A name for a new passkey, from the device it's made on. The person can change it.
export function deviceName(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Passkey';
}
