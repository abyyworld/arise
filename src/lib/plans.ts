// Plans between people: one of your events, planned with someone through a private link. The parts
// both sides use: the link, the page the other person opens (and checking it), their answer,
// sealing both, and reading and writing them in the cloud. The app's side is src/plans.ts and
// src/plans-ui.js; the page for someone without Arise is src/plan-view.ts.
//
// It works like a shared goal (lib/share.ts). The link is <site>#plan=<id>.<key>; the part after
// the # never reaches a server. The page is shares/<id> in the same shape as a goal's
// ({ owner, iv, ct, v: 1, updated }), sealed with the key and bound to the id and to being a plan,
// and turned off for good the same way. It holds the title, the time (with its time zone and any
// repeat), the place, your first name if you have one in Arise, and whether it's called off.
// Never your notes, your guests or your other events.
//
// An answer is shares/<id>/replies/<answer id>: { iv, ct, v: 1, updated }, sealed with the same
// key and bound to both ids. It holds the name they gave, what they said (in, can't make it, or
// stopped sharing) and when. Anyone with the link may write one, without an account, while the
// page is up (firestore.rules). The answer's id comes from the key and the name, so answering again
// under the same name changes the same answer.

import { cleanEvent, deviceZone, nextTime, occurrences, repeatLabel, type CalEvent, type Change, type Repeat } from './events';
import { fromB64url, linkKey, newLinkKey, open, randomBytes, seal, toB64url, type Sealed } from './crypto';
import { cleanName, type PlanAnswer, type Says } from './plan-link';
export { isPlanHash, hasAriseHere } from './plan-link';
import { fetchShare } from './share';

export interface PlanRef {
  id: string;
  key: string;
}
interface Project {
  projectId: string;
  apiKey: string;
}

const ID = /^[A-Za-z0-9_-]{22}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;

// ---------- the link

export const newPlanRef = async () => ({ id: toB64url(randomBytes(16)), key: await newLinkKey(), at: Date.now() });
export const planLink = (site: string, ref: PlanRef) => `${site.split('#')[0]}#plan=${ref.id}.${ref.key}`;
// The link's id and key, from the # part or from a whole link pasted in. Null if it isn't one.
export function parsePlanLink(text: string): PlanRef | null {
  const m = /#plan=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(String(text || '').trim());
  return m ? { id: m[1], key: m[2] } : null;
}
// The event a plan becomes in the other person's calendar: the same one each time the link opens.
export const guestEventId = (planId: string) => `p_${planId}`;

// ---------- the page

export interface PlanPage {
  v: 1;
  title: string;
  start: string;
  end?: string;
  allDay?: true;
  tz?: string;
  location?: string;
  repeat?: Repeat;
  skip?: string[];
  changes?: Record<string, Change>;
  host?: string; // the first name of who shared it
  cancelled?: true;
  updated: number;
}
// Everything a page may hold. Nothing else is ever sent (plans.test.ts checks it).
export const PAGE_FIELDS = ['v', 'title', 'start', 'end', 'allDay', 'tz', 'location', 'repeat', 'skip', 'changes', 'host', 'cancelled', 'updated'] as const;

export function pageOf(e: CalEvent, { host = '', cancelled = false, now = Date.now() }: { host?: string; cancelled?: boolean; now?: number } = {}): PlanPage {
  const page: PlanPage = { v: 1, title: e.title, start: e.start, updated: now };
  if (e.end) page.end = e.end;
  if (e.allDay) page.allDay = true;
  if (e.tz) page.tz = e.tz;
  if (e.location) page.location = e.location;
  if (e.repeat) {
    page.repeat = e.repeat;
    if (e.skip?.length) page.skip = e.skip;
    if (e.changes) {
      // A time changed on its own keeps its notes to itself too.
      const changes = Object.fromEntries(Object.entries(e.changes).map(([k, c]) => [k, Object.fromEntries(Object.entries(c).filter(([f]) => f !== 'notes')) as Change]));
      if (Object.keys(changes).length) page.changes = changes;
    }
  }
  const name = cleanName(host).split(' ')[0];
  if (name) page.host = name;
  if (cancelled) page.cancelled = true;
  return page;
}

// A page as it came out of the cloud, rebuilt from what's allowed, or null.
export function cleanPage(raw: unknown): PlanPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || !isTime(p.updated)) return null;
  const e = cleanEvent({ id: 'plan', title: p.title, start: p.start, end: p.end, allDay: p.allDay, tz: p.tz, location: p.location, repeat: p.repeat, skip: p.skip, changes: p.changes, created: p.updated, at: p.updated });
  if (!e || e.gone) return null;
  return pageOf(e, { host: typeof p.host === 'string' ? p.host : '', cancelled: p.cancelled === true, now: p.updated });
}

// What an event's page would say, apart from who and when: if it's the same, there's nothing to tell.
export function fingerprint(e: CalEvent): string {
  const { updated: _u, host: _h, ...rest } = pageOf(e, { now: 1 });
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(rest)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// The fields of the other person's copy, from the page.
export function eventFields(p: PlanPage): Partial<CalEvent> {
  return { title: p.title, start: p.start, end: p.end, allDay: p.allDay, tz: p.tz, location: p.location, repeat: p.repeat, skip: p.skip, changes: p.changes };
}

// When it is, in words, on this device's clock: "Fri 20 Nov, 19:00 to 21:00", the next time of a
// repeat with the repeat after it.
export function whenOf(p: PlanPage, now = Date.now()): string {
  const ev = { id: 'plan', ...eventFields(p), created: p.updated, at: p.updated } as CalEvent;
  const o = (p.repeat && nextTime(ev, now)) || occurrences({ plan: ev }, -8.64e15, 8.64e15)[0];
  if (!o) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
  const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  let s: string;
  if (o.allDay) s = o.lastDay !== o.day ? `${day(o.start)} to ${day(o.end - 1)}, all day` : `${day(o.start)}, all day`;
  else if (o.end > o.start) s = o.lastDay !== o.day ? `${day(o.start)}, ${clock(o.start)} to ${day(o.end)}, ${clock(o.end)}` : `${day(o.start)}, ${clock(o.start)} to ${clock(o.end)}`;
  else s = `${day(o.start)}, ${clock(o.start)}`;
  if (!o.allDay && p.tz && p.tz !== deviceZone()) s += ' (your time)';
  if (p.repeat) s += `. ${repeatLabel(p.repeat)}`;
  return s;
}

// ---------- sealing

export const MAX_CT = 20_000; // a page (firestore.rules, as for a shared goal)
export const MAX_REPLY_CT = 2_000; // an answer (firestore.rules)
const pageAad = (id: string) => `plan/${id}`;
const replyAad = (id: string, rid: string) => `plan-reply/${id}/${rid}`;

export async function sealPage(ref: PlanRef, page: PlanPage): Promise<Sealed> {
  return seal(await linkKey(ref.key), JSON.stringify(page), pageAad(ref.id));
}
// Null when what's inside isn't a plan. Throws a CryptoError when it doesn't open with this key,
// or isn't this plan's (a goal's page, or another plan's put in its place).
export async function openPage(ref: PlanRef, sealed: Sealed): Promise<PlanPage | null> {
  const text = await open(await linkKey(ref.key), sealed, pageAad(ref.id));
  try {
    return cleanPage(JSON.parse(text));
  } catch {
    return null;
  }
}

export interface Reply {
  v: 1;
  name: string;
  says: Says;
  at: number;
}
export function cleanReply(raw: unknown): Reply | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = cleanName(r.name);
  if (r.v !== 1 || !name || !isTime(r.at) || (r.says !== 'yes' && r.says !== 'no' && r.says !== 'left')) return null;
  return { v: 1, name, says: r.says, at: r.at };
}

// An answer's id: from the key and the name, so the same name answering again changes its answer,
// and nobody without the link can tell whose it is.
export async function replyId(key: string, name: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.digest('SHA-256', new Uint8Array([...fromB64url(key), ...new TextEncoder().encode('arise plan answers')]));
  const mac = await subtle.importKey('raw', base, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('HMAC', mac, new TextEncoder().encode(cleanName(name).toLowerCase()));
  return toB64url(new Uint8Array(sig).slice(0, 16));
}

export async function sealReply(ref: PlanRef, rid: string, reply: Reply): Promise<Sealed> {
  return seal(await linkKey(ref.key), JSON.stringify(reply), replyAad(ref.id, rid));
}
export async function openReply(ref: PlanRef, rid: string, sealed: Sealed): Promise<Reply | null> {
  const text = await open(await linkKey(ref.key), sealed, replyAad(ref.id, rid));
  try {
    return cleanReply(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------- the cloud, read and written the way a browser that isn't signed in does

const base = (p: Project) => `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(p.projectId)}/databases/(default)/documents`;
const failed = (status: number) => Object.assign(new Error(`The cloud said ${status}.`), { code: status === 403 ? 'permission-denied' : 'unavailable' });

// The sealed page, or null when there's none or it was turned off.
export const fetchPage = (id: string, project: Project, get: typeof fetch = fetch) => fetchShare(id, project, get);

export async function fetchReplies(id: string, project: Project, get: typeof fetch = fetch): Promise<{ rid: string; sealed: Sealed }[]> {
  if (!ID.test(id)) return [];
  const res = await get(`${base(project)}/shares/${id}/replies?pageSize=100&key=${encodeURIComponent(project.apiKey)}`, { cache: 'no-store', credentials: 'omit' });
  if (res.status === 404) return [];
  if (!res.ok) throw failed(res.status);
  const docs = ((await res.json()) as { documents?: { name?: string; fields?: Record<string, { stringValue?: unknown }> }[] }).documents || [];
  return docs.flatMap((d) => {
    const rid = String(d.name || '').split('/').pop() || '';
    const iv = d.fields?.iv?.stringValue;
    const ct = d.fields?.ct?.stringValue;
    return ID.test(rid) && typeof iv === 'string' && typeof ct === 'string' ? [{ rid, sealed: { iv, ct } }] : [];
  });
}

export async function putReply(id: string, rid: string, sealed: Sealed, project: Project, get: typeof fetch = fetch, now = Date.now()) {
  if (!ID.test(id) || !ID.test(rid)) throw failed(400);
  if (sealed.ct.length > MAX_REPLY_CT) throw new Error('That answer is too long.');
  const fields = { iv: { stringValue: sealed.iv }, ct: { stringValue: sealed.ct }, v: { integerValue: '1' }, updated: { integerValue: String(Math.floor(now)) } };
  const res = await get(`${base(project)}/shares/${id}/replies/${rid}?key=${encodeURIComponent(project.apiKey)}`, {
    method: 'PATCH',
    cache: 'no-store',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw failed(res.status);
}

// ---------- the two sides

// Says `says` for `name`, sealed. The answer's id.
export async function answer(ref: PlanRef, name: string, says: Says, project: Project, get: typeof fetch = fetch, now = Date.now()): Promise<string> {
  const clean = cleanName(name);
  if (!clean) throw new Error('Write your name first, so they know who answered.');
  const rid = await replyId(ref.key, clean);
  await putReply(ref.id, rid, await sealReply(ref, rid, { v: 1, name: clean, says, at: now }), project, get, now);
  return rid;
}

// Every answer that opens with this link's key (anything else in the folder is left out).
export async function readAnswers(ref: PlanRef, project: Project, get: typeof fetch = fetch): Promise<PlanAnswer[]> {
  const out: PlanAnswer[] = [];
  for (const { rid, sealed } of await fetchReplies(ref.id, project, get)) {
    try {
      const r = await openReply(ref, rid, sealed);
      if (r) out.push({ id: rid, name: r.name, says: r.says, at: r.at });
    } catch {}
  }
  return out;
}
