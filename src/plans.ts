// Plans between people, the app's side (lib/plans.ts has the link, the page and the answers).
//
// Your plan: Plan it with someone makes the link and puts the page up (it needs an account, like a
// shared goal, since the page is kept in the cloud). Their answers come back sealed, and the event
// keeps them (event.plan.answers), so they sync with it. A change you choose to tell them about
// goes on the page; calling it off leaves the page saying so; Stop sharing deletes the answers and
// turns the page off for good.
//
// Someone else's plan: their link opens in Arise, you say I'm in or Can't make it, and with I'm in
// it goes in your calendar, marked as shared with you. Your copy follows their page: a change
// comes in, a plan called off is marked so, and one they stop sharing stays as yours. No account is
// needed for this side, nor anything new in the cloud but your answer.

import * as S from './store';
import * as A from './account';
import * as SYNC from './sync';
import * as L from './lib/plans';
import * as EV from './lib/events';
import { SHARE_OFF } from './lib/share';
import { cleanName, latestAnswers, type EventPlan, type PlanAnswer, type Says } from './lib/plan-link';
import { firstName } from './share';
import { FIREBASE } from './firebase-config.js';

type Project = { projectId: string; apiKey: string };
const DAY = 86_400_000;

function project(): Project {
  if (!FIREBASE?.projectId || !FIREBASE?.apiKey) throw new A.AccountError('no-cloud', "Plans with other people need Arise's cloud, which this copy doesn't have.");
  return FIREBASE as Project;
}
function signedIn() {
  const u = SYNC.status.user;
  if (!u) throw new A.AccountError('signed-out', 'Planning with someone needs an account. Make one, or sign in, under Settings, Account.');
  return u;
}
const denied = (err: unknown) => /permission-denied/.test(String((err as { code?: string })?.code));

// What to tell the person when something didn't work.
export function problem(err: unknown): string {
  const code = String((err as { code?: string })?.code || '');
  if (/unavailable|network|deadline/.test(code) || err instanceof TypeError) return "Couldn't reach the cloud. Check your internet connection and try again.";
  if (denied(err)) return 'This plan is no longer shared.';
  return A.friendly(err);
}

const pageRef = (id: string) => {
  const { fb, db } = A.firebase();
  return fb.doc(db, 'shares', id);
};
const hostName = () => firstName();

async function sealed(ref: L.PlanRef, page: L.PlanPage, owner: string) {
  const s = await L.sealPage(ref, page);
  if (s.ct.length > L.MAX_CT) throw new Error('This event has too much in it to share. Try it with fewer changed times.');
  return { owner, iv: s.iv, ct: s.ct, v: 1 as const, updated: page.updated };
}

// ---------- your plan

export const myPlan = (e: EV.CalEvent | undefined | null) => (e && !e.gone && e.plan && !e.plan.guest ? e.plan : null);
export const theirPlan = (e: EV.CalEvent | undefined | null) => (e && !e.gone && e.plan?.guest ? e.plan : null);
// A change on your side the page doesn't have yet.
export const untold = (e: EV.CalEvent) => !!myPlan(e) && e.plan!.said !== L.fingerprint(e);

// Makes the link: the page goes up first, so a link the event keeps always has one.
export async function start(eventId: string): Promise<EventPlan | null> {
  const user = signedIn();
  const e = S.state.events[eventId];
  if (!e || e.gone || e.plan?.guest) return null;
  if (e.plan) return e.plan;
  const ref = await L.newPlanRef();
  const doc = await sealed(ref, L.pageOf(e, { host: hostName() }), user.uid);
  const { fb } = A.firebase();
  await fb.setDoc(pageRef(ref.id), doc);
  const now = S.state.events[eventId];
  if (!now || now.gone || now.plan) {
    // Deleted meanwhile, or planned from another device: this page goes off (nobody has its link).
    await fb.setDoc(pageRef(ref.id), SHARE_OFF).catch(() => {});
    return now?.plan ?? null;
  }
  const plan: EventPlan = { ...ref, said: L.fingerprint(now) };
  S.setEventPlan(eventId, plan);
  return plan;
}

// Puts what the event says now on its page (or that it's called off). 'ok', or 'gone' when the
// page was turned off meanwhile (the event then forgets the link).
async function publish(e: EV.CalEvent, cancelled = false): Promise<'ok' | 'gone'> {
  const user = signedIn();
  const plan = myPlan(e) || (cancelled && e.plan && !e.plan.guest ? e.plan : null);
  if (!plan) return 'gone';
  const doc = await sealed(plan, L.pageOf(e, { host: hostName(), cancelled }), user.uid);
  const { fb, db } = A.firebase();
  const result = await fb.runTransaction(db, async (tx) => {
    const now = await tx.get(pageRef(plan.id));
    if (!now.exists() || (now.data() as { off?: boolean }).off || (now.data() as { owner?: string }).owner !== user.uid) return 'gone' as const;
    tx.set(pageRef(plan.id), doc);
    return 'ok' as const;
  });
  return result;
}

// Tells them: the page now says what the event says. True once it does.
export async function tell(eventId: string): Promise<boolean> {
  const e = S.state.events[eventId];
  if (!myPlan(e)) return false;
  const result = await publish(e!);
  const now = S.state.events[eventId];
  if (!now || now.gone || now.plan?.id !== e!.plan!.id) return result === 'ok';
  if (result === 'gone') {
    S.setEventPlan(eventId, undefined);
    return false;
  }
  S.setEventPlan(eventId, { ...now.plan!, said: L.fingerprint(e!) });
  return true;
}

// Called off: the page says so, for whoever has the link. `e` as it was before it was deleted.
export async function cancel(e: EV.CalEvent): Promise<boolean> {
  if (!e.plan || e.plan.guest) return false;
  return (await publish(e, true)) === 'ok';
}

// Deletes the answers and turns the page off for good. The event stays, without the link.
export async function stop(eventId: string) {
  const e = S.state.events[eventId];
  const plan = myPlan(e);
  if (!plan) return;
  await stopLink(plan);
  const now = S.state.events[eventId];
  if (now?.plan?.id === plan.id) S.setEventPlan(eventId, undefined);
}

// The answers go, then the page is turned off for good (also for an event being deleted).
export async function stopLink(plan: EventPlan) {
  if (plan.guest) return;
  signedIn();
  const { fb, db } = A.firebase();
  try {
    const answers = await L.fetchReplies(plan.id, project());
    for (const { rid } of answers) await fb.deleteDoc(fb.doc(db, 'shares', plan.id, 'replies', rid));
    await fb.setDoc(pageRef(plan.id), SHARE_OFF);
  } catch (err) {
    // Off already, or another account's page (this data joined this account from it).
    if (!denied(err)) throw err;
  }
}

// Brings in the answers. True when something new came.
export async function pullAnswers(eventId: string): Promise<boolean> {
  const e = S.state.events[eventId];
  const plan = myPlan(e);
  if (!plan) return false;
  const got = await L.readAnswers(plan, project());
  const now = S.state.events[eventId];
  if (now?.plan?.id !== plan.id || now.plan.guest) return false;
  const was = now.plan.answers || [];
  const next = latestAnswers([...was, ...got]);
  if (JSON.stringify(next) === JSON.stringify(latestAnswers(was))) return false;
  S.setEventPlan(eventId, { ...now.plan, answers: next });
  return true;
}

// Who's in, who can't, who stopped sharing: the latest answer from each.
export function answersOf(e: EV.CalEvent): { yes: PlanAnswer[]; no: PlanAnswer[]; left: PlanAnswer[] } {
  const all = latestAnswers(myPlan(e)?.answers || []);
  return { yes: all.filter((a) => a.says === 'yes'), no: all.filter((a) => a.says === 'no'), left: all.filter((a) => a.says === 'left') };
}

// ---------- someone else's plan

// An event's own fields, for updateEvent.
const keep = (e: EV.CalEvent) => {
  const { id: _id, created: _c, at: _a, gone: _g, ...rest } = e;
  return rest;
};

export type Look = { page: L.PlanPage } | { gone: true } | { broken: true };

// The page behind a link. Throws when the cloud can't be reached.
export async function look(ref: L.PlanRef): Promise<Look> {
  const s = await L.fetchPage(ref.id, project());
  if (!s) return { gone: true };
  try {
    const page = await L.openPage(ref, s);
    return page ? { page } : { broken: true };
  } catch {
    return { broken: true };
  }
}

// Your answer to a plan you opened from its link: sent sealed, and with I'm in, the plan goes in
// your calendar (or your copy changes). The event, if there is one.
export async function reply(ref: L.PlanRef, page: L.PlanPage, says: 'yes' | 'no', name: string): Promise<EV.CalEvent | null> {
  if (page.cancelled) throw new Error('This plan was called off.');
  const rid = await L.answer(ref, name, says, project());
  const id = L.guestEventId(ref.id);
  const e = S.state.events[id];
  const plan: EventPlan = { id: ref.id, key: ref.key, at: e?.plan?.at || Date.now(), guest: true, me: rid, name: cleanName(name), says, took: page.updated, ...(page.host ? { host: page.host } : {}) };
  if (e && !e.gone) {
    if (says === 'no') S.setEventPlan(id, plan);
    else S.updateEvent(id, { ...keep(e), ...L.eventFields(page), plan });
    return S.state.events[id];
  }
  if (says === 'no') return null;
  return S.addEvent({ id, ...L.eventFields(page), color: 'teal', plan });
}

// Your answer again, from your copy of their plan.
export async function changeAnswer(eventId: string, says: 'yes' | 'no', name: string): Promise<boolean> {
  const e = S.state.events[eventId];
  const plan = theirPlan(e);
  if (!plan || plan.ended) return false;
  const rid = await L.answer(plan, name, says, project());
  const now = S.state.events[eventId];
  if (now?.plan?.id === plan.id) S.setEventPlan(eventId, { ...now.plan, me: rid, name: cleanName(name), says });
  return true;
}

// Your copy follows their page. What happened: 'same', 'changed', 'cancelled' or 'off'.
export async function follow(eventId: string): Promise<'same' | 'changed' | 'cancelled' | 'off'> {
  const e = S.state.events[eventId];
  const plan = theirPlan(e);
  if (!plan || plan.ended) return 'same';
  const got = await look(plan);
  const now = S.state.events[eventId];
  if (!theirPlan(now) || now!.plan!.id !== plan.id) return 'same';
  if ('gone' in got) {
    S.setEventPlan(eventId, { ...now!.plan!, ended: 'off' });
    return 'off';
  }
  if ('broken' in got) return 'same';
  if (got.page.cancelled) {
    S.setEventPlan(eventId, { ...now!.plan!, ended: 'cancelled', took: got.page.updated });
    return 'cancelled';
  }
  if (now!.plan!.took && got.page.updated <= now!.plan!.took) return 'same';
  // Their time and place; your colour, reminders and notes stay.
  S.updateEvent(eventId, { ...keep(now!), ...L.eventFields(got.page), plan: { ...now!.plan!, took: got.page.updated, ...(got.page.host ? { host: got.page.host } : {}) } });
  return 'changed';
}

// You stop following their plan: they see you stopped, and the event stays as your own.
export async function leave(eventId: string, name: string) {
  const e = S.state.events[eventId];
  const plan = theirPlan(e);
  if (!plan) return;
  if (!plan.ended && name) await L.answer(plan, name, 'left', project()).catch(() => {});
  if (S.state.events[eventId]?.plan?.id === plan.id) S.setEventPlan(eventId, undefined);
}

// Before you delete your copy: tell them you can't make it.
export async function tellNo(e: EV.CalEvent, name: string) {
  const plan = e.plan?.guest ? e.plan : null;
  if (!plan || plan.ended || !name) return false;
  await L.answer(plan, name, 'no', project());
  return true;
}

// ---------- keeping up

let last = 0;
let running: Promise<boolean> | null = null;
const EVERY = 60_000;

// Answers to your plans and changes to theirs, for the ones not over yet. True when something
// changed. At most once a minute unless `now`.
export function refresh({ force = false } = {}): Promise<boolean> {
  if (running) return running;
  if (!force && Date.now() - last < EVERY) return Promise.resolve(false);
  if (!FIREBASE) return Promise.resolve(false);
  const list = EV.liveEvents(S.state.events).filter((e) => e.plan && !e.plan.ended && EV.nextTime(e, Date.now() - DAY));
  if (!list.length) return Promise.resolve(false);
  last = Date.now();
  running = (async () => {
    let changed = false;
    for (const e of list.slice(0, 30)) {
      try {
        if (e.plan!.guest) changed = (await follow(e.id)) !== 'same' || changed;
        else changed = (await pullAnswers(e.id)) || changed;
      } catch {}
    }
    return changed;
  })().finally(() => {
    running = null;
  });
  return running;
}

export function _reset() {
  last = 0;
  running = null;
}

export type { Says };
