// The Player's own storage for photos and files: a Cloudflare R2 bucket in their own Cloudflare
// account (10 GB free), so files sync far past what the shared free database has room for
// (life/files-sync.ts). Only encrypted parts ever go there, under ids that say nothing.
//
// The settings sync end-to-end encrypted with the rest of the data (since SCHEMA 12), so every
// device can fetch the files without typing the key again. The key only ever reaches ciphertext.
// They're never in a backup file (store.ts exportData), which isn't encrypted.
//
// Merged as one value: the later change wins, and removing it is a change too (`off`).

export interface OwnStorage {
  account: string; // the Cloudflare account ID (32 hex characters)
  bucket: string;
  keyId: string; // the R2 API token's access key ID
  secret: string; // its secret access key
  at: number; // when it last changed
  off?: true; // removed
}

const ACCOUNT = /^[a-f0-9]{32}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KEY_ID = /^[A-Za-z0-9]{16,128}$/;
const SECRET = /^[A-Za-z0-9/+=_-]{16,256}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// What a person typed, made ready to save, or why not.
export function readOwnStorage(raw: { account?: string; bucket?: string; keyId?: string; secret?: string }, at = Date.now()): OwnStorage | string {
  const account = text(raw.account).toLowerCase();
  const bucket = text(raw.bucket).toLowerCase();
  const keyId = text(raw.keyId);
  const secret = text(raw.secret);
  if (!ACCOUNT.test(account)) return "That account ID doesn't look right. It's 32 letters and numbers, on the right of your Cloudflare dashboard.";
  if (!BUCKET.test(bucket)) return "That bucket name doesn't look right. Use the name exactly as Cloudflare shows it.";
  if (!KEY_ID.test(keyId)) return "That access key ID doesn't look right. Copy it from the token's page again.";
  if (!SECRET.test(secret)) return "That secret doesn't look right. Copy it from the token's page again.";
  return { account, bucket, keyId, secret, at };
}

export function cleanOwnStorage(raw: unknown): OwnStorage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isTime(r.at)) return null;
  if (r.off === true) return { account: '', bucket: '', keyId: '', secret: '', at: r.at, off: true };
  const s = readOwnStorage(r as Record<string, string>, r.at);
  return typeof s === 'string' ? null : s;
}

// The later change wins.
export function mergeOwnStorage(a: OwnStorage | null, b: OwnStorage | null): OwnStorage | null {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

// Set up and not removed.
export const isOn = (s: OwnStorage | null | undefined): s is OwnStorage => !!s && !s.off && !!s.account;

export const endpoint = (s: Pick<OwnStorage, 'account' | 'bucket'>) => `https://${s.account}.r2.cloudflarestorage.com/${s.bucket}`;

// What the bucket must allow, for the person to paste into Cloudflare (R2, the bucket, Settings,
// CORS policy): Arise's address and the phone apps', and only what Arise does.
export const CORS = [
  {
    AllowedOrigins: ['https://abyyworld.github.io', 'capacitor://localhost', 'https://localhost'],
    AllowedMethods: ['GET', 'PUT', 'DELETE'],
    AllowedHeaders: ['authorization', 'x-amz-content-sha256', 'x-amz-date', 'content-type'],
    MaxAgeSeconds: 3600,
  },
];
