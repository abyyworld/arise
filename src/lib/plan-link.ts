// A plan between people: the part an event of your own keeps (CalEvent.plan, lib/events.ts), so
// it syncs end-to-end encrypted with the event. The link (its id and key), and then either the
// answers that came back (your plan) or what you said and where the plan stands (someone else's
// plan, in your calendar). How the link and its page work: lib/plans.ts.

export type Says = 'yes' | 'no' | 'left';

// A plan's link opens with #plan= (lib/plans.ts). Here, with nothing else, so the first page
// (main.ts) can tell without loading more.
export const isPlanHash = (hash: string) => /^#plan=/.test(hash);
// This browser has Arise in it (its data, from store.ts): a plan link then opens in the app.
export function hasAriseHere(): boolean {
  try {
    return !!globalThis.localStorage?.getItem('pit-data-v1');
  } catch {
    return false;
  }
}

// One person's answer to your plan.
export interface PlanAnswer {
  id: string; // the answer's own id (lib/plans.ts replyId)
  name: string; // the name they gave
  says: Says; // in, can't make it, or stopped sharing
  at: number; // when they said it
}

export interface EventPlan {
  id: string; // the page's id: 128 random bits, base64url
  key: string; // the link's key: 256 bits, base64url
  at: number; // when the link was made
  // Your plan:
  said?: string; // what the page says now (a short fingerprint of it), so a change not sent yet shows
  answers?: PlanAnswer[];
  // Someone else's plan, in your calendar:
  guest?: true;
  host?: string; // the first name of who shared it, if they have one in Arise
  me?: string; // the id of your answer
  name?: string; // the name you answered with
  says?: 'yes' | 'no';
  took?: number; // when the page this copy last took was made
  ended?: 'off' | 'cancelled'; // they stopped sharing it, or called it off
}

export const MAX_ANSWERS = 50;
export const NAME_MAX = 40;
const ID = /^[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
export const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');

export function cleanAnswer(raw: unknown): PlanAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const name = cleanName(a.name);
  if (typeof a.id !== 'string' || !ID.test(a.id) || !name || !isTime(a.at)) return null;
  if (a.says !== 'yes' && a.says !== 'no' && a.says !== 'left') return null;
  return { id: a.id, name, says: a.says, at: a.at };
}

// The latest answer from each person (by answer id, then by name), the newest first.
export function latestAnswers(list: PlanAnswer[]): PlanAnswer[] {
  const out: PlanAnswer[] = [];
  for (const a of [...list].sort((x, y) => y.at - x.at)) {
    if (out.some((b) => b.id === a.id || b.name.toLowerCase() === a.name.toLowerCase())) continue;
    out.push(a);
  }
  return out.slice(0, MAX_ANSWERS);
}

export function cleanEventPlan(raw: unknown): EventPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || !ID.test(p.id) || typeof p.key !== 'string' || !KEY.test(p.key) || !isTime(p.at)) return undefined;
  const out: EventPlan = { id: p.id, key: p.key, at: p.at };
  if (p.guest === true) {
    out.guest = true;
    const host = cleanName(p.host);
    if (host) out.host = host;
    if (typeof p.me === 'string' && ID.test(p.me)) out.me = p.me;
    const name = cleanName(p.name);
    if (name) out.name = name;
    if (p.says === 'yes' || p.says === 'no') out.says = p.says;
    if (isTime(p.took)) out.took = p.took;
    if (p.ended === 'off' || p.ended === 'cancelled') out.ended = p.ended;
    return out;
  }
  if (typeof p.said === 'string' && /^[a-z0-9]{1,16}$/.test(p.said)) out.said = p.said;
  if (Array.isArray(p.answers)) {
    const answers = latestAnswers(p.answers.map(cleanAnswer).filter((a): a is PlanAnswer => !!a));
    if (answers.length) out.answers = answers;
  }
  return out;
}
