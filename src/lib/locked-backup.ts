// A backup locked with a backup password, for places that must never see the data itself (the
// GitHub backup, github-backup.ts). The file is JSON, so Load backup takes it like any other and
// asks for the password:
//
//   { "arise": "locked-backup", "v": 1, "iter": 600000, "salt": "...", "iv": "...", "ct": "..." }
//
//   backup password ──PBKDF2 (salted with `salt`, `iter` rounds)──▶ AES-256-GCM key
//   the backup (Save backup's JSON) ──gzip, then AES-GCM──▶ ct
//
// Without the password nobody can open it: not GitHub, not the people who run Arise.

import { CryptoError, KDF_ITERATIONS, fromB64, open, randomBytes, seal, toB64 } from './crypto';

export const KIND = 'locked-backup';
const AAD = 'arise backup v1';
export const MIN_PASSWORD = 10;

export interface LockedFile {
  arise: typeof KIND;
  v: 1;
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

// A key from a backup password, and what's needed to make it again.
export interface BackupKey {
  key: CryptoKey;
  salt: string; // base64, 16 bytes
  iter: number;
}

const b64 = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(v);

// Whether a file read for Load backup is a locked one (its other fields checked too).
export function isLocked(raw: unknown): raw is LockedFile {
  const o = raw as Record<string, unknown>;
  return !!o && typeof o === 'object' && o.arise === KIND;
}

function check(raw: LockedFile) {
  const ok = raw.v === 1 && Number.isInteger(raw.iter) && raw.iter >= 100_000 && raw.iter <= 10_000_000 && b64(raw.salt, 64) && b64(raw.iv, 24) && b64(raw.ct, 200_000_000);
  if (!ok) throw new CryptoError('bad-data', "This locked backup isn't complete, or it's from a newer Arise.");
}

export async function deriveBackupKey(password: string, salt = toB64(randomBytes(16)), iter = KDF_ITERATIONS): Promise<BackupKey> {
  const subtle = globalThis.crypto.subtle;
  const pw = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations: iter }, pw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { key, salt, iter };
}

// The backup's text, locked: the file's text.
export async function lock(k: BackupKey, text: string): Promise<string> {
  const sealed = await seal(k.key, text, AAD);
  const file: LockedFile = { arise: KIND, v: 1, iter: k.iter, salt: k.salt, iv: sealed.iv, ct: sealed.ct };
  return JSON.stringify(file);
}

// Whether `k` was made for this file (the same salt and rounds), so it can be tried without
// asking for the password.
export const fits = (k: BackupKey | null, file: LockedFile) => !!k && k.salt === file.salt && k.iter === file.iter;

// The backup's text again, with the backup password (or a key that fits). Throws 'wrong-key'
// when it doesn't open it.
export async function unlock(file: LockedFile, secret: string | BackupKey): Promise<string> {
  check(file);
  const k = typeof secret === 'string' ? await deriveBackupKey(secret, file.salt, file.iter) : secret;
  try {
    return await open(k.key, { iv: file.iv, ct: file.ct }, AAD);
  } catch {
    throw new CryptoError('wrong-key', "That password doesn't open this backup.");
  }
}
