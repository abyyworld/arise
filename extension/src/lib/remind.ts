// Arise's reminders in this browser: to-dos with a time, your own events' reminders and the
// morning brief, for the next few days. Arise hands them over while it's open in this browser
// (src/life/browser-remind.ts), sealed for this extension; the extension keeps them only in its
// own storage, never sends them anywhere, and shows each one at its time as a desktop
// notification and a small Arise window, with a count on its button. They're in the plain words
// Arise picked (no details unless details in notifications are on), and none pops up in the
// quiet hours: those only add to the count.
//
// All of it is off until the person turns it on, here or in Arise's browser panel. Turning it off
// (or unlinking) deletes what's kept.
//
// The sealing goes the other way from the rest: the extension makes its own key pair, gives Arise
// the public half (in its status answer), and Arise seals the list for it with the same code
// (seal.ts). So other extensions that can see messages on Arise's page can't read them.

import { fromB64url, toB64url } from './bytes';
import { type SealedBatch, isSealedBatch, openBatch } from './seal';

export interface KV {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface RemindItem {
  id: string; // stable for the same reminder
  at: number;
  title: string;
  body: string;
}
export interface RemindPack {
  v: 1;
  made: number;
  items: RemindItem[];
  quietFrom: string; // HH:MM ('' or the same as quietTo: no quiet hours)
  quietTo: string;
}
export interface Kept {
  pack: RemindPack | null;
  fired: string[]; // ids already shown (or let go of)
  unread: RemindItem[]; // shown, not looked at yet
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const LATE = 60 * MIN; // missed while the browser was closed: still shown up to an hour late
const MAX_ITEMS = 100;
const MAX_UNREAD = 30;
export const ALARM = 'remind:';
const K = { on: 'remind:on', key: 'remind:key', pack: 'remind:pack', fired: 'remind:fired', unread: 'remind:unread' };
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[A-Za-z0-9:._-]{1,160}$/;

const tidy = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// ---------- what arrives, checked field by field

export function parsePack(x: unknown, now: number): RemindPack | null {
  const p = x as Record<string, unknown>;
  if (!p || typeof p !== 'object' || p.v !== 1 || !Array.isArray(p.items)) return null;
  const seen = new Set<string>();
  const items: RemindItem[] = [];
  for (const raw of p.items.slice(0, MAX_ITEMS * 2)) {
    const r = raw as Record<string, unknown>;
    if (!r || typeof r.id !== 'string' || !ID.test(r.id) || seen.has(r.id)) continue;
    if (typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at < now - DAY || r.at > now + 8 * DAY) continue;
    const title = tidy(r.title, 140);
    if (!title) continue;
    seen.add(r.id);
    items.push({ id: r.id, at: Math.round(r.at), title, body: tidy(r.body, 240) });
  }
  items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const q = (s: unknown) => (typeof s === 'string' && TIME.test(s) ? s : '');
  return { v: 1, made: typeof p.made === 'number' && Number.isFinite(p.made) ? p.made : now, items: items.slice(0, MAX_ITEMS), quietFrom: q(p.quietFrom), quietTo: q(p.quietTo) };
}

// ---------- the quiet hours (which may run past midnight)

const mins = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
export function isQuiet(t: number, quietFrom: string, quietTo: string): boolean {
  if (!TIME.test(quietFrom) || !TIME.test(quietTo)) return false;
  const d = new Date(t);
  const m = d.getHours() * 60 + d.getMinutes();
  const a = mins(quietFrom);
  const b = mins(quietTo);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

// ---------- when

// The alarms to set: one for each reminder still to come.
export function alarmsFor(pack: RemindPack | null, now: number): { name: string; when: number }[] {
  return (pack?.items || []).filter((r) => r.at > now).map((r) => ({ name: `${ALARM}${r.id}`, when: r.at }));
}

// What's due now and not shown yet, and whether it may pop up (outside the quiet hours). Ones more
// than an hour late are let go of without a word.
export function dueNow(k: Kept, now: number): { show: RemindItem[]; quiet: boolean; skip: string[] } {
  const fired = new Set(k.fired);
  const due = (k.pack?.items || []).filter((r) => r.at <= now && !fired.has(r.id));
  const show = due.filter((r) => r.at > now - LATE);
  return { show, quiet: !!k.pack && isQuiet(now, k.pack.quietFrom, k.pack.quietTo), skip: due.filter((r) => r.at <= now - LATE).map((r) => r.id) };
}

// ---------- kept in the extension's own storage

export async function isOn(kv: KV): Promise<boolean> {
  return (await kv.get([K.on]))[K.on] === true;
}

export async function kept(kv: KV): Promise<Kept> {
  const got = await kv.get([K.pack, K.fired, K.unread]);
  return { pack: (got[K.pack] as RemindPack) || null, fired: (got[K.fired] as string[]) || [], unread: (got[K.unread] as RemindItem[]) || [] };
}

// Turned on or off. Off: everything kept for reminders goes, the key too.
export async function setOn(kv: KV, on: boolean): Promise<void> {
  if (!on) return forget(kv);
  await kv.set({ [K.on]: true });
  await publicKey(kv); // made now, so two quick questions for it can't each make one
}

export async function forget(kv: KV): Promise<void> {
  await kv.remove([K.on, K.key, K.pack, K.fired, K.unread]);
}

// The extension's own key pair for reminders: made when first needed, the private half kept here.
export async function publicKey(kv: KV): Promise<string> {
  const got = (await kv.get([K.key]))[K.key] as { pub: string; priv: string } | undefined;
  if (got?.pub && got.priv) return got.pub;
  const pair = (await crypto.subtle.generateKey(CURVE, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = toB64url(await crypto.subtle.exportKey('raw', pair.publicKey));
  const priv = toB64url(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  await kv.set({ [K.key]: { pub, priv } });
  return pub;
}

async function privateKey(kv: KV): Promise<CryptoKey | null> {
  const got = (await kv.get([K.key]))[K.key] as { pub: string; priv: string } | undefined;
  if (!got?.priv) return null;
  try {
    return await crypto.subtle.importKey('pkcs8', fromB64url(got.priv), CURVE, false, ['deriveBits']);
  } catch {
    return null;
  }
}

// A sealed list from Arise: opened, checked, and kept in place of the last one. Says how many it
// holds, or why not.
export async function take(kv: KV, link: string, box: unknown, now: number): Promise<{ ok: true; n: number } | { ok: false; error: string }> {
  if (!(await isOn(kv))) return { ok: false, error: 'off' };
  const b = box as SealedBatch;
  if (!isSealedBatch(b) || b.link !== link) return { ok: false, error: 'bad' };
  const key = await privateKey(kv);
  if (!key) return { ok: false, error: 'no-key' };
  let pack: RemindPack | null;
  try {
    pack = parsePack(await openBatch(key, b), now);
  } catch {
    return { ok: false, error: 'bad' };
  }
  if (!pack) return { ok: false, error: 'bad' };
  // What was already shown stays shown (the same reminder sent again doesn't pop up twice).
  const ids = new Set(pack.items.map((r) => r.id));
  const k = await kept(kv);
  await kv.set({ [K.pack]: pack, [K.fired]: k.fired.filter((id) => ids.has(id)) });
  return { ok: true, n: pack.items.length };
}

// Marks these as shown, and adds them to the unread ones.
export async function fire(kv: KV, show: RemindItem[], skip: string[] = []): Promise<Kept> {
  const k = await kept(kv);
  const fired = [...new Set([...k.fired, ...show.map((r) => r.id), ...skip])].slice(-500);
  const have = new Set(k.unread.map((r) => r.id));
  const unread = [...k.unread, ...show.filter((r) => !have.has(r.id))].slice(-MAX_UNREAD);
  await kv.set({ [K.fired]: fired, [K.unread]: unread });
  return { ...k, fired, unread };
}

// Looked at: the count goes back to nothing.
export async function markRead(kv: KV, ids?: string[]): Promise<RemindItem[]> {
  const k = await kept(kv);
  const unread = ids ? k.unread.filter((r) => !ids.includes(r.id)) : [];
  await kv.set({ [K.unread]: unread });
  return unread;
}

// The badge on the extension's button: the unread count, or nothing.
export const badgeText = (unread: number, paused: boolean) => (unread > 0 ? (unread > 99 ? '99+' : String(unread)) : paused ? 'off' : '');
