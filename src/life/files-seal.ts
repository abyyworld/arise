// Photos and files, sealed for the cloud (files-sync.ts). Same idea as the life log's packs
// (seal.ts), with keys of their own derived from the life key:
//
//   fileKey    AES-256-GCM. Seals each part of a file, its details (name, day, the small preview),
//              and the list of files (the files index). Each seal is tied to the account, the file,
//              the part's number and how many parts there are (the AAD), so a part can't be swapped,
//              moved to another file, or left out without the file failing to open.
//   fileIdKey  HMAC-SHA-256 of "file:<what>": every document's id, 43 characters of base64url,
//              so the ids in the cloud don't tell which file, or how many files, there are.
//
// Every document has the shape the life log's documents have ({ v: 1, iv, ct, updated }, at most
// 700,000 characters of ciphertext), in the same folder, so the database rules that already guard
// the life log guard these too, and the server only ever holds ciphertext.
//
// A file's bytes aren't compressed (photos and most files already are), only cut into parts of
// PART_BYTES, one document each: sealed and in base64 a part is 699,072 characters.

import { fromB64, open, randomBytes, seal, toB64, toB64url, CryptoError, type Sealed } from '../lib/crypto';
import type { LifeKeys } from './seal';

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

export const PART_BYTES = 512 * 1024;
// The most characters of ciphertext a document may hold (firestore.rules, lifePack).
export const DOC_CHARS = 700_000;

// A new file's id: 16 random bytes, 22 characters of base64url.
export const newFileId = () => toB64url(randomBytes(16));
export const isFileId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v);

// How many parts a file of `size` bytes has (an empty file has one, empty).
export const partCount = (size: number) => Math.max(1, Math.ceil(size / PART_BYTES));

// A file's bytes cut into parts.
export function splitBytes(bytes: Uint8Array, size = PART_BYTES): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out.length ? out : [new Uint8Array(0)];
}

// The parts back together.
export function joinBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------- document ids

async function docId(keys: LifeKeys, what: string): Promise<string> {
  return toB64url(await subtle().sign('HMAC', keys.fileIdKey, enc.encode(`file:${what}`)));
}
export const indexDocId = (keys: LifeKeys) => docId(keys, 'index');
export const metaDocId = (keys: LifeKeys, id: string) => docId(keys, `${id}#meta`);
export const partDocId = (keys: LifeKeys, id: string, i: number) => docId(keys, `${id}#${i}`);

// Every document of a file: its details first, then its parts.
export async function fileDocIds(keys: LifeKeys, id: string, n: number): Promise<string[]> {
  return Promise.all([metaDocId(keys, id), ...Array.from({ length: n }, (_, i) => partDocId(keys, id, i))]);
}

// ---------- sealing

const partLabel = (uid: string, id: string, i: number, n: number) => `${uid}/files/${id}/${i}/${n}`;
const metaLabel = (uid: string, id: string) => `${uid}/files/${id}/meta`;
const indexLabel = (uid: string) => `${uid}/files/index`;

// Part `i` of `n` of a file, sealed.
export async function sealPart(keys: LifeKeys, uid: string, id: string, i: number, n: number, bytes: Uint8Array): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(partLabel(uid, id, i, n)) }, keys.fileKey, new Uint8Array(bytes));
  const s = { iv: toB64(iv), ct: toB64(ct) };
  if (s.ct.length > DOC_CHARS) throw new CryptoError('bad-data', 'A part of that file is too big to sync.');
  return s;
}

// Throws (bad-data) if it isn't part `i` of `n` of this file, sealed with this account's key.
export async function openPart(keys: LifeKeys, uid: string, id: string, i: number, n: number, s: Sealed): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(s.iv), additionalData: enc.encode(partLabel(uid, id, i, n)) }, keys.fileKey, fromB64(s.ct));
    return new Uint8Array(plain);
  } catch {
    throw new CryptoError('bad-data', "Part of a file in the cloud couldn't be opened with this device's key.");
  }
}

export const sealMeta = (keys: LifeKeys, uid: string, id: string, text: string) => seal(keys.fileKey, text, metaLabel(uid, id));
export const openMeta = (keys: LifeKeys, uid: string, id: string, s: Sealed) => open(keys.fileKey, s, metaLabel(uid, id));
export const sealFilesIndex = (keys: LifeKeys, uid: string, text: string) => seal(keys.fileKey, text, indexLabel(uid));
export const openFilesIndex = (keys: LifeKeys, uid: string, s: Sealed) => open(keys.fileKey, s, indexLabel(uid));
