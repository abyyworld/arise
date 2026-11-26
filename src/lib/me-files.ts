// Files an AI app on the web may read from, or save to, the one folder the Player shares with it
// (me.ts puts them in the app's web page, mcp/core.mjs offers the tools, worker/connector serves
// them). On its own, with no app imports, so the connector uses the same code.
//
//   a small file          its bytes go in the app's web page, sealed with the page
//   a bigger one          cut into parts, each a page of its own in the cloud (shares/<id>, the
//                         same shape as a me link's page, so no new database rule), sealed with a
//                         key made from the web page's key. The page lists it with `p`: which
//                         upload (v) and how many parts (n). The parts' ids come from the same key,
//                         so only someone with the app's address can find or open them.
//   too big to share      listed with `big`, never sent
//
// The connector opens a part only for a moment, while it answers the app, as it does the page.
// A file the app saves comes back the other way, sealed in the app's log (lib/feed.ts).

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export const INLINE_MAX = 2 * 1024; // a file this small goes in the page itself
export const INLINE_TOTAL = 6 * 1024; // and this much in all
export const FILE_MAX = 1024 * 1024; // the biggest file an app may read
export const SHARED_MAX = 2 * 1024 * 1024; // the bigger files of one folder, in all
// One part per page: sealed and in base64 it stays under the 20,000 characters a page may hold.
export const PART_BYTES = 14 * 1024;
export const SAVE_MAX = 256 * 1024; // the biggest file an app may save
export const MAX_FILES = 40; // listed in a page

export interface MeFile {
  id: string; // the file's id in Photos and files
  name: string;
  type: string;
  size: number;
  at: number; // when it was added
  data?: string; // a small file's bytes, base64
  p?: { v: string; n: number }; // a bigger one's parts: which upload, how many
  big?: true; // too big to share
}

// A file an app saved, as it comes back in its log.
export interface SavedFile {
  name: string;
  type: string;
  data: string; // base64
}

export const partCount = (size: number) => Math.max(1, Math.ceil(size / PART_BYTES));

// ---------- base64

export function toB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u8: Uint8Array) => toB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
// How many bytes a base64 text holds.
export const b64Size = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);

// ---------- keys, from the web page's key

async function hmac(webKey: string, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = unb64url(webKey);
  if (raw.length !== 32) throw new Error("That address isn't complete.");
  const k = await subtle().importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, enc.encode(label)));
}

export async function filesKey(webId: string, webKey: string): Promise<CryptoKey> {
  return subtle().importKey('raw', await hmac(webKey, `arise-me-files/${webId}`), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Part i's page id: 22 characters, like any page's.
export async function partId(webId: string, webKey: string, fileId: string, v: string, i: number): Promise<string> {
  return b64url((await hmac(webKey, `arise-me-part/${webId}/${fileId}/${v}/${i}`)).subarray(0, 16));
}
export async function partIds(webId: string, webKey: string, f: Pick<MeFile, 'id' | 'p'>): Promise<string[]> {
  if (!f.p) return [];
  return Promise.all(Array.from({ length: f.p.n }, (_, i) => partId(webId, webKey, f.id, f.p!.v, i)));
}

// A new upload's mark: a file that changes gets new parts, at new ids.
export const newUpload = () => b64url(globalThis.crypto.getRandomValues(new Uint8Array(9)));

const aad = (webId: string, fileId: string, v: string, i: number, n: number) => enc.encode(`me-file/${webId}/${fileId}/${v}/${i}/${n}`);

// Part i of n, sealed: tied to the page, the file, the upload and its place, so no part can be
// swapped, moved or left out without the file failing to open.
export async function sealPart(key: CryptoKey, webId: string, fileId: string, v: string, i: number, n: number, bytes: Uint8Array): Promise<{ iv: string; ct: string }> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(webId, fileId, v, i, n) }, key, new Uint8Array(bytes)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function openPart(key: CryptoKey, webId: string, fileId: string, v: string, i: number, n: number, s: { iv: string; ct: string }): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(s.iv), additionalData: aad(webId, fileId, v, i, n) }, key, fromB64(s.ct)));
  } catch {
    throw Object.assign(new Error("Part of that file doesn't open."), { say: "Part of that file doesn't open. Ask them to open Arise, so it sends the file again." });
  }
}

export function joinParts(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------- checking what comes back

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const FILE_ID = /^[A-Za-z0-9_-]{22}$/;
export const MIME = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,80}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;

// A file's name as Arise keeps it: one line, no slashes, at most 120 characters.
export const fileName = (v: unknown) =>
  String(v ?? '')
    .replace(CONTROL, ' ')
    .replace(/[/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

// A type from a file's name, for what an app saves without one.
const BY_END: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', ics: 'text/calendar', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };
export function typeFor(name: string, given: unknown, text: boolean): string {
  const t = typeof given === 'string' ? given.toLowerCase().trim() : '';
  if (MIME.test(t)) return t;
  const end = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() || '';
  return BY_END[end] || (text ? 'text/plain' : 'application/octet-stream');
}

export function cleanMeFile(raw: unknown): MeFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !FILE_ID.test(r.id) || !isTime(r.at)) return null;
  const size = typeof r.size === 'number' && Number.isSafeInteger(r.size) && r.size >= 0 ? r.size : -1;
  if (size < 0) return null;
  const type = typeof r.type === 'string' && MIME.test(r.type) ? r.type : 'application/octet-stream';
  const out: MeFile = { id: r.id, name: fileName(r.name) || 'File', type, size, at: r.at };
  if (r.big === true) out.big = true;
  else if (typeof r.data === 'string' && B64.test(r.data) && r.data.length % 4 === 0 && b64Size(r.data) === size && size <= INLINE_MAX) out.data = r.data;
  else {
    const p = r.p && typeof r.p === 'object' ? (r.p as Record<string, unknown>) : null;
    if (p && typeof p.v === 'string' && /^[A-Za-z0-9_-]{8,22}$/.test(p.v) && p.n === partCount(size) && size <= FILE_MAX) out.p = { v: p.v, n: p.n };
    else return null;
  }
  return out;
}

export const cleanMeFiles = (raw: unknown): MeFile[] => (Array.isArray(raw) ? raw.slice(0, MAX_FILES) : []).flatMap((f) => cleanMeFile(f) || []);

export function cleanSaved(raw: unknown): SavedFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = fileName(r.name);
  if (!name || typeof r.data !== 'string' || !B64.test(r.data) || r.data.length % 4 !== 0 || b64Size(r.data) > SAVE_MAX) return null;
  return { name, type: typeof r.type === 'string' && MIME.test(r.type) ? r.type : 'application/octet-stream', data: r.data };
}
