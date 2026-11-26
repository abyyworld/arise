// Arise as the Player's "me" for other apps (the format is lib/me.ts): what Arise knows, put
// together for an app, and the me links that keep an app up to date.
//
// A me link belongs to one app. It's a page in the cloud (shares/<id>: the same place and shape as
// a shared goal's page, so firestore.rules needs nothing new), sealed with a key that's only in
// the link. It needs an account, holds only what the Player picked for that app, and updates
// itself after changes. Turning it off, or making a new one, leaves the empty page a goal's link
// leaves, for good.
//
// The links are kept on this device, not synced, like the memory they're made from: another
// device doesn't know what this one learned, so it could only ever send an app less. Deleting the
// account turns them all off (sync.ts turns off every page the account keeps), and so does
// removing this device's data while signed in (Erase all data, Sign out and remove my data). Only
// a page's own account can turn it off: one this device can't turn off now (erased while signed
// out, or its data taken over by another account) waits, with whose it is, until that account is
// signed in here again.

import * as S from './store';
import * as A from './account';
import * as SYNC from './sync';
import * as M from './life/memory';
import { firstName, goalStreak, problem } from './share';
import * as LS from './lib/share';
import * as ME from './lib/me';
import { cleanAboutChoice, cleanFeedLog, cleanMeAsks, cleanMeLinks, cleanOffLater, MAX_FEED_SHOWN, MAX_ME_LINKS, type FeedLog, type LinkWeb, type MeAsk, type MeLink, type OffLater, type SharedParts } from './lib/validate';
import { feedKey, newFeedToken, openEntry, tokenHash, type FeedEntry, type SealedEntry } from './lib/feed';
import { FILE_MAX, filesKey, fromB64, INLINE_MAX, INLINE_TOTAL, MAX_FILES, newUpload, PART_BYTES, partCount, partId, sealPart, SHARED_MAX, toB64, type MeFile, type SavedFile } from './lib/me-files';
import { CONNECTOR } from './connector-config';
import { lifeStore, hasLifeStore } from './life/store-port';
import type { LifeEvent } from './life/types';

export type { MeLink, MeAsk };
export { problem };

const LINKS = 'arise-me-links';
const FEED = 'arise-me-feed';
const OFF_LATER = 'arise-me-off';
const ASKS = 'arise-me-asks';
const ABOUT = 'arise-about-me';
const DELAY = 10_000; // after a change, once things are quiet
const AFTER_SYNC = 1500;

// ---------- this device's storage

const read = (k: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null');
  } catch {
    return null;
  }
};
const write = (k: string, v: unknown) => {
  try {
    if (v == null || (Array.isArray(v) && !v.length)) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

export const links = (): MeLink[] => cleanMeLinks(read(LINKS));
const saveLinks = (list: MeLink[]) => write(LINKS, list);
const offLater = () => cleanOffLater(read(OFF_LATER));
// Pages to turn off once their account can (an entry's owner is '' while not known).
const putOff = (list: OffLater[]) => write(OFF_LATER, cleanOffLater([...offLater(), ...list]));
const forget = (id: string) => {
  notes.delete(id);
  saveAsks(asks().filter((a) => a.link !== id));
  saveLinks(links().filter((l) => l.id !== id));
  const log = feedLog();
  delete log[id];
  write(FEED, Object.keys(log).length ? log : null);
};

// Only while it's still the same link: it may have been turned off or replaced meanwhile.
function patchLink(id: string, key: string, patch: Partial<MeLink>) {
  saveLinks(links().map((l) => (l.id === id && l.key === key ? { ...l, ...patch } : l)));
}

export const aboutChoice = (): ME.MeChoice => cleanAboutChoice(read(ABOUT));
export const setAboutChoice = (c: ME.MeChoice) => write(ABOUT, cleanAboutChoice(c));

// ---------- what Arise knows, for an app

// From the app's data and the memory as it's loaded now: the Player's first name, active goals,
// facts (the best first, as in the profile), today's quests and the summaries of the last 7 days.
// Facts and days carry how private they are to share (memory.ts shareOf), not the tier the AI
// reads them at: to the AI, Arise's own journal, weigh-ins and coach questions are tier 1.
// A fact the Player marked "Never send to an AI" never goes to any app (an app may be an AI).
export function sourceNow(): ME.MeSource {
  const today = S.todayKey();
  const week = S.addDays(today, -7);
  return {
    name: firstName(),
    goals: S.activeGoals().map((g) => ({ title: g.title, why: g.why, streak: goalStreak(g, today) })),
    facts: M.rankFacts(M.forAI(M.activeFacts())).map((f) => ({ text: f.text, since: f.since, tier: M.shareOf(f) })),
    today: { day: today, quests: S.questsFor(today).map(({ quest, done }) => ({ title: quest.title, done })) },
    days: M.daySummaries()
      .filter((s) => s.key < today && s.key >= week)
      .sort((a, b) => b.key.localeCompare(a.key))
      .map((s) => ({ day: s.key, text: s.text, tier: M.shareOf(s) })),
  };
}

export async function source(): Promise<ME.MeSource> {
  await M.load();
  return sourceNow();
}

// Exactly what an app with this choice gets now (before any trimming to fit a page).
export const payloadFor = async (c: ME.MeChoice, now = Date.now(), web: ME.MeWeb | null = null, rules?: ME.MeRules) => ME.buildMe(await source(), c, now, web, rules);

// What an app's web page says about the web, while it's on: nothing once it's off or its end date
// has passed (Arise then empties the page, and still says when it ended).
// (A link whose rules say never to both notes and to-dos says it takes neither, so even a
// connector from before rules offers the app no way to add anything.)
// With the shared folder's name, it also says what the app may do with that folder's files (a
// "never" rule for saving files turns saving off there too).
export const webNow = (l: Pick<MeLink, 'web' | 'rules'>, now = Date.now(), folder = ''): ME.MeWeb | null => {
  const w = l.web;
  if (!w || w.off || (w.until && now > w.until)) return null;
  const write = !!w.fwrite && ME.ruleOf(l.rules, 'file') !== 'never';
  return {
    notes: w.notes && !addsNever(l.rules),
    ...(w.read === false ? { read: false as const } : {}),
    ...(w.until ? { until: w.until } : {}),
    feed: w.fh,
    ...(folder && (w.fread || write) ? { files: { read: !!w.fread, write, folder } } : {}),
  };
};
const addsNever = (r: ME.MeRules | undefined) => ME.ruleOf(r, 'note') === 'never' && ME.ruleOf(r, 'todo') === 'never';
// What an app on the web may read about the Player: nothing at all once they switched reading off.
const webChoice = (l: Pick<MeLink, 'web' | 'choice'>): ME.MeChoice => (l.web?.read === false ? { ...l.choice, sections: [] } : l.choice);

// Only while it's still the same web page.
function patchWeb(id: string, webId: string, patch: Partial<LinkWeb>) {
  saveLinks(links().map((l) => (l.id === id && l.web?.id === webId ? { ...l, web: { ...l.web, ...patch } } : l)));
}

// ---------- the pages in the cloud

// What went wrong with each link's last update here, if it did.
const notes = new Map<string, string>();
export const note = (id: string) => notes.get(id) || '';

const pageRef = (id: string) => {
  const { fb, db } = A.firebase();
  return fb.doc(db, 'shares', id);
};

function signedIn() {
  const u = SYNC.status.user;
  if (!u) throw new A.AccountError('signed-out', 'Connecting an app needs an account. Make one, or sign in, under Settings, Account.');
  return u;
}

const sigOf = (p: ME.MePayload) => M.fingerprint([ME.bodyOf(p)]);

// The page as the cloud keeps it, and the fingerprint of what it says.
async function page(ref: { id: string; key: string }, full: ME.MePayload, owner: string): Promise<{ doc: LS.ShareDoc; sig: string }> {
  const { sealed } = await ME.sealMe(ref, full);
  return { doc: { owner, iv: sealed.iv, ct: sealed.ct, v: 1, updated: full.updated }, sig: sigOf(full) };
}

const denied = (err: unknown) => /permission-denied/.test(String((err as { code?: string })?.code));

const OTHER = 'This link was made with another account, so only that account can change it or turn it off. It goes off the next time that account is signed in here.';

// After the cloud refused a write to a page: '' when the page is off (or gone), so it never works
// again anyway; the account whose page it is when it's another one's. Anything else: `err`.
async function refusedBy(id: string, uid: string, err: unknown): Promise<string> {
  const { fb } = A.firebase();
  const snap = await fb.getDoc(pageRef(id));
  const d = snap.exists() ? (snap.data() as { off?: boolean; owner?: unknown }) : null;
  if (!d || d.off) return '';
  if (typeof d.owner === 'string' && d.owner && d.owner !== uid) return d.owner;
  throw err;
}

// Turns a page off for good: '' once it is off, or the account whose page it is, when that's
// another one, which only it can turn off.
async function pageOff(id: string, uid: string): Promise<string> {
  try {
    const { fb } = A.firebase();
    await fb.setDoc(pageRef(id), LS.SHARE_OFF);
    return '';
  } catch (err) {
    if (!denied(err)) throw err;
    return refusedBy(id, uid, err);
  }
}

// ---------- what the Player does

// A new link for one app: its page goes up first, so a link on the list always has one.
export async function connect(app: string, choice: ME.MeChoice): Promise<MeLink> {
  const user = signedIn();
  if (links().length >= MAX_ME_LINKS) throw new Error(`You can connect up to ${MAX_ME_LINKS} apps. Turn one off first.`);
  const ref = await LS.newShareRef();
  const c = ME.cleanChoice(choice, ME.LINK_DEFAULT);
  const { doc, sig } = await page(ref, await payloadFor(c), user.uid);
  const { fb } = A.firebase();
  await fb.setDoc(pageRef(ref.id), doc);
  const link = cleanMeLinks([{ id: ref.id, key: ref.key, app: app.trim(), at: ref.at, choice: c, owner: user.uid, sig, sent: doc.updated }])[0];
  saveLinks([...links(), link]);
  return link;
}

// A new link for the same app. The old one stops working for good, in the same go.
export async function newLink(id: string): Promise<MeLink | null> {
  const user = signedIn();
  const old = links().find((l) => l.id === id);
  if (!old) return null;
  const ref = await LS.newShareRef();
  const { doc, sig } = await page(ref, await payloadFor(old.choice, Date.now(), null, old.rules), user.uid);
  const { fb, db } = A.firebase();
  const batch = fb.writeBatch(db);
  batch.set(pageRef(ref.id), doc);
  batch.set(pageRef(old.id), LS.SHARE_OFF);
  try {
    await batch.commit();
  } catch (err) {
    if (!denied(err)) throw err;
    // The old page is off already: the new one goes up on its own. Another account's: only that
    // account can turn it off, so nothing changes here but that it waits for it.
    const other = await refusedBy(old.id, user.uid, err);
    if (other) {
      putOff([{ id: old.id, owner: other }]);
      forget(old.id);
      throw new A.AccountError('me-other', OTHER);
    }
    await fb.setDoc(pageRef(ref.id), doc);
  }
  const link: MeLink = { ...old, id: ref.id, key: ref.key, at: ref.at, owner: user.uid, sig, sent: doc.updated };
  notes.delete(old.id);
  // In its place, or after the rest if a refresh meanwhile found the old page off and let it go.
  const list = links();
  saveLinks(list.some((l) => l.id === old.id) ? list.map((l) => (l.id === old.id ? link : l)) : [...list, link]);
  return link;
}

// Turns the page off for good, so the link stops working, and forgets the link. Another
// account's page waits for that account (and this says so).
export async function turnOff(id: string): Promise<void> {
  const user = signedIn();
  const l = links().find((x) => x.id === id);
  if (l?.web) await webOff(l, user.uid);
  const other = await pageOff(id, user.uid);
  if (other) putOff([{ id, owner: other }]);
  forget(id);
  if (other) throw new A.AccountError('me-other', OTHER);
}

// Empties an app's web page for good, after taking what the app left there.
async function webOff(l: MeLink, uid: string) {
  const w = l.web!;
  try {
    await pullOne(l);
  } catch {}
  await partsOff(Object.values(w.parts || {}), uid);
  let other = '';
  try {
    other = await pageOff(w.id, uid);
  } catch {
    other = uid; // try again later
  }
  if (other) putOff([{ id: w.id, owner: other }]);
}

// What an app gets from now on. True once its page says so; throws if it couldn't be updated
// (the choice stays, and the page follows with a later update).
export async function setChoice(id: string, choice: ME.MeChoice): Promise<boolean> {
  signedIn();
  const l = links().find((x) => x.id === id);
  if (!l) return false;
  patchLink(l.id, l.key, { choice: ME.cleanChoice(choice, ME.LINK_DEFAULT), sig: undefined });
  await refresh();
  if (note(id)) throw new A.AccountError('me-update', note(id));
  return links().some((x) => x.id === id);
}

// The web connector for one app: on (whether it may add notes, and until when) or off (null).
// On, it gets a page of its own with its own key: the address given to AI apps on the web, apart
// from the app's link. Off, that page is emptied for good, after taking what the app left there.
// True once the page says so; throws if it couldn't be updated.
// The switches (lib/validate.ts LinkWeb): `read` (on unless false), `notes`, and for one folder
// (`dir`), `fread` and `fwrite`. Those left out stay as they are (a new page: reading on, files off).
export interface WebPicks {
  notes: boolean;
  until?: number;
  read?: boolean;
  dir?: string;
  fread?: boolean;
  fwrite?: boolean;
}
const picksOf = (web: WebPicks, was: Partial<LinkWeb> = {}): Pick<LinkWeb, 'notes' | 'read' | 'dir' | 'fread' | 'fwrite'> => {
  const read = web.read ?? was.read !== false;
  const dir = web.dir !== undefined ? web.dir || undefined : was.dir;
  const fread = (web.fread ?? !!was.fread) && !!dir;
  const fwrite = (web.fwrite ?? !!was.fwrite) && !!dir;
  return { notes: web.notes === true, read: read ? undefined : false, dir, fread: fread || undefined, fwrite: fwrite || undefined };
};
const tidy = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export async function setWeb(id: string, web: WebPicks | null): Promise<boolean> {
  const user = signedIn();
  const l = links().find((x) => x.id === id);
  if (!l) return false;
  if (!web) {
    if (l.web) await webOff(l, user.uid);
    patchLink(l.id, l.key, { web: undefined });
    return true;
  }
  const until = web.until && web.until > Date.now() ? web.until : undefined;
  if (l.web && !l.web.off) {
    // The same page, with what the Player changed.
    const w = l.web;
    saveLinks(links().map((x) => (x.id === l.id && x.web?.id === w.id ? { ...x, web: tidy({ ...x.web, ...picksOf(web, x.web), until, sig: undefined }) } : x)));
  } else {
    // A new page (the old one, if any, is off for good). Its files follow with the update below.
    const ref = await LS.newShareRef();
    const tok = newFeedToken();
    const fh = await tokenHash(tok);
    const base: LinkWeb = tidy({ ...picksOf(web), ...(until ? { until } : {}), id: ref.id, key: ref.key, tok, fh });
    const full = await payloadFor(webChoice({ web: base, choice: l.choice }), Date.now(), webNow({ web: base, rules: l.rules }), l.rules);
    const { doc, sig } = await page(ref, full, user.uid);
    const { fb } = A.firebase();
    await fb.setDoc(pageRef(ref.id), doc);
    const next: LinkWeb = { ...base, sig: base.fread || base.fwrite ? undefined : sig, sent: doc.updated };
    saveLinks(links().map((x) => (x.id === l.id && x.key === l.key ? { ...x, web: tidy(next) } : x)));
  }
  await refresh();
  if (note(id)) throw new A.AccountError('me-update', note(id));
  return links().some((x) => x.id === id && !!x.web);
}

// The Player's rules for one app (lib/me.ts MeRules): what it may just do, must ask about first,
// or may never do, and their house rules. Both its pages carry them. True once the pages say so;
// throws if they couldn't be updated (the rules stay, and the pages follow with a later update).
export async function setRules(id: string, rules: ME.MeRules | null): Promise<boolean> {
  signedIn();
  const l = links().find((x) => x.id === id);
  if (!l) return false;
  const clean = ME.cleanRules(rules);
  saveLinks(links().map((x) => (x.id === l.id && x.key === l.key ? { ...x, rules: clean, sig: undefined, ...(x.web ? { web: { ...x.web, sig: undefined } } : {}) } : x)));
  await refresh();
  if (note(id)) throw new A.AccountError('me-update', note(id));
  return links().some((x) => x.id === id);
}

const waiting = (l: MeLink): OffLater => ({ id: l.id, owner: l.owner || '' });
// A link's pages: its own and, if the web was ever on for it, its web page and the parts of the
// files it shares there.
const allWaiting = (list: MeLink[]): OffLater[] =>
  list.flatMap((l) => [waiting(l), ...(l.web && !l.web.off ? [{ id: l.web.id, owner: l.owner || '' }] : []), ...Object.values(l.web?.parts || {}).flatMap((p) => p.ids.map((id) => ({ id, owner: l.owner || '' })))]);

// Every link off, before this device's data is removed (sync.ts calls it then, once that's
// sure). Those it can't turn off now go off the next time their account is signed in here.
export async function turnOffAll(): Promise<void> {
  const list = links();
  if (!list.length) return;
  if (!SYNC.status.user) {
    putOff(allWaiting(list));
    saveLinks([]);
    return;
  }
  for (const l of list) {
    try {
      await turnOff(l.id);
    } catch {
      const still = links().find((x) => x.id === l.id);
      if (still) putOff(allWaiting([still]));
      forget(l.id);
    }
  }
}

// This device's data was erased, or replaced by another account's: the links and the About me
// choice belong to the person whose data it was. Pages still up go off once their account can.
function forgetHere() {
  putOff(allWaiting(links()));
  saveLinks([]);
  write(ABOUT, null);
  write(FEED, null);
  write(ASKS, null);
  notes.clear();
}

// ---------- keeping the pages up to date

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let next: Promise<void> | null = null;

// Brings every link's page up to date after `ms`, unless asked again before then.
export function soon(ms = DELAY) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!SYNC.status.user || (!links().length && !offLater().length)) return;
  timer = setTimeout(() => void refresh(), ms);
}

// Done once a round that began after this call has brought every page up to date.
export function refresh(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (running) {
    next ||= running.then(() => {
      next = null;
      return refresh();
    });
    return next;
  }
  running = (async () => {
    const user = SYNC.status.user;
    if (!user) return;
    await turnOffLeftOver(user.uid);
    if (!links().length) return;
    // Never from a memory that couldn't be read: that would send an app nothing.
    try {
      await M.load();
    } catch {
      return;
    }
    for (const l of links()) await update(l, user.uid);
  })().finally(() => {
    running = null;
  });
  return running;
}

// Only this account's pages (and those whose account isn't known yet): another account's waits
// for it.
async function turnOffLeftOver(uid: string) {
  for (const { id, owner } of offLater()) {
    if (owner && owner !== uid) continue;
    let other: string;
    try {
      other = await pageOff(id, uid);
    } catch {
      continue; // try again next time
    }
    const rest = offLater().filter((x) => x.id !== id);
    write(OFF_LATER, other ? [...rest, { id, owner: other }] : rest);
  }
}

// Only while the page is up and this account's: one that's off (or gone) was turned off, here,
// in another tab or when the account was deleted, and stays off. Another account's (this device's
// data went to this account) can't be kept up to date from here, so it goes off once that account
// is signed in here again.
async function update(l: MeLink, uid: string) {
  try {
    if (l.web) await updateWeb(l, uid);
    const full = ME.buildMe(sourceNow(), l.choice, Date.now(), null, l.rules);
    const sig = sigOf(full);
    if (l.sig === sig) {
      notes.delete(l.id);
      return;
    }
    const { doc } = await page(l, full, uid);
    const { fb, db } = A.firebase();
    const result: { ok?: true; owner?: string } = await fb.runTransaction(db, async (tx) => {
      const now = await tx.get(pageRef(l.id));
      if (!now.exists() || (now.data() as { off?: boolean }).off) return {};
      const owner = (now.data() as LS.ShareDoc).owner;
      if (owner !== uid) return { owner };
      tx.set(pageRef(l.id), doc);
      return { ok: true };
    });
    notes.delete(l.id);
    if (result.ok) return patchLink(l.id, l.key, { sig, sent: doc.updated });
    if (result.owner && links().some((x) => x.id === l.id)) putOff([{ id: l.id, owner: result.owner }]);
    forget(l.id);
  } catch (err) {
    notes.set(l.id, problem(err));
  }
}

// An app's web page: up to date while it's on, emptied once its end date has passed.
async function updateWeb(l: MeLink, uid: string) {
  const w = l.web!;
  if (w.off) return;
  if (!webNow(l)) {
    await partsOff(Object.values(w.parts || {}), uid);
    const other = await pageOff(w.id, uid);
    if (other) putOff([{ id: w.id, owner: other }]);
    patchWeb(l.id, w.id, { off: true, parts: undefined });
    return;
  }
  const { folder, files, parts } = await shared(w, uid);
  const web = webNow(l, Date.now(), folder);
  // Parts made just now are noted first, so they can be turned off whatever happens next; those
  // they replace go off with the next update, once the page points to the new ones.
  const kept = { ...(w.parts || {}), ...parts };
  if (Object.keys(parts).some((id) => parts[id] !== w.parts?.[id])) {
    const replaced = Object.entries(w.parts || {}).flatMap(([id, p]) => (parts[id] && parts[id] !== p ? p.ids : []));
    if (replaced.length) putOff(replaced.map((id) => ({ id, owner: uid })));
    patchWeb(l.id, w.id, { parts: kept });
  }
  const full = ME.buildMe(sourceNow(), webChoice(l), Date.now(), web, l.rules, files);
  const sig = sigOf(full);
  const stale = Object.entries(kept).filter(([id]) => !parts[id]);
  if (w.sig === sig && !stale.length) return;
  if (w.sig !== sig) {
    const { doc } = await page(w, full, uid);
    const { fb, db } = A.firebase();
    const done = await fb.runTransaction(db, async (tx) => {
      const now = await tx.get(pageRef(w.id));
      if (!now.exists() || (now.data() as { off?: boolean }).off || (now.data() as LS.ShareDoc).owner !== uid) return false;
      tx.set(pageRef(w.id), doc);
      return true;
    });
    if (!done) {
      await partsOff(Object.values(kept), uid);
      patchWeb(l.id, w.id, { off: true, parts: undefined });
      return;
    }
    patchWeb(l.id, w.id, { sig, sent: doc.updated });
  }
  // Parts the page no longer lists (the file changed, left the folder, or reading files was
  // switched off) go off for good, once the page doesn't point to them.
  if (stale.length) {
    await partsOff(stale.map(([, p]) => p), uid);
    patchWeb(l.id, w.id, { parts: Object.keys(parts).length ? parts : undefined });
  }
}

// ---------- the folder shared with an app on the web (lib/me-files.ts)

// What the app's page lists of the shared folder, and the parts of its bigger files, sent now if
// they're new or changed. Nothing without reading files switched on, or once the folder is gone.
async function shared(w: LinkWeb, uid: string): Promise<{ folder: string; files: MeFile[] | null; parts: Record<string, SharedParts> }> {
  const none = { folder: '', files: null, parts: {} };
  if (!w.dir || (!w.fread && !w.fwrite) || !hasLifeStore()) return none;
  const F = await import('./life/files');
  const tree = await F.listFolders();
  const d = tree.dirs[w.dir];
  if (!d) return none;
  if (!w.fread) return { ...none, folder: d.name };
  const inDir = (await F.listFiles())
    .filter((f) => f.dir === w.dir)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_FILES);
  const files: MeFile[] = [];
  const parts: Record<string, SharedParts> = {};
  let inline = 0;
  let inParts = 0;
  const bytesOf = async (id: string) => {
    const got = await F.getFile(id).catch(() => null);
    return got ? { bytes: new Uint8Array(await got.blob.arrayBuffer()), hash: got.info.hash || '' } : null;
  };
  for (const f of inDir) {
    const base = { id: f.id, name: f.name, type: f.type, size: f.size, at: f.at };
    if (f.size <= INLINE_MAX && inline + f.size <= INLINE_TOTAL) {
      const got = await bytesOf(f.id);
      if (!got) continue; // not here now: next time
      inline += f.size;
      files.push({ ...base, data: toB64(got.bytes) });
      continue;
    }
    if (f.size > FILE_MAX || inParts + f.size > SHARED_MAX) {
      files.push({ ...base, big: true });
      continue;
    }
    const had = w.parts?.[f.id];
    if (had && f.hash && had.h === f.hash && had.n === partCount(f.size)) {
      inParts += f.size;
      parts[f.id] = had;
      files.push({ ...base, p: { v: had.v, n: had.n } });
      continue;
    }
    const got = await bytesOf(f.id);
    if (!got || got.bytes.length !== f.size) continue;
    inParts += f.size;
    parts[f.id] = had && had.h === got.hash ? had : await sendParts(w, uid, f.id, got.bytes, got.hash);
    files.push({ ...base, p: { v: parts[f.id].v, n: parts[f.id].n } });
  }
  return { folder: d.name, files, parts };
}

// A bigger file's parts, each sealed and a page of its own.
async function sendParts(w: LinkWeb, uid: string, fileId: string, bytes: Uint8Array, hash: string): Promise<SharedParts> {
  const key = await filesKey(w.id, w.key);
  const v = newUpload();
  const n = partCount(bytes.length);
  const ids: string[] = [];
  const { fb, db } = A.firebase();
  const at = Date.now();
  for (let i = 0; i < n; i += 100) {
    const batch = fb.writeBatch(db);
    for (let j = i; j < Math.min(n, i + 100); j++) {
      const s = await sealPart(key, w.id, fileId, v, j, n, bytes.subarray(j * PART_BYTES, (j + 1) * PART_BYTES));
      const id = await partId(w.id, w.key, fileId, v, j);
      ids.push(id);
      batch.set(pageRef(id), { owner: uid, iv: s.iv, ct: s.ct, v: 1, updated: at } satisfies LS.ShareDoc);
    }
    await batch.commit();
  }
  return { v, n, h: hash || '0'.repeat(64), ids };
}

// Parts no longer needed, off for good. Those that can't go now go with the next update.
async function partsOff(list: SharedParts[], uid: string) {
  const ids = list.flatMap((p) => p.ids);
  if (!ids.length) return;
  try {
    const { fb, db } = A.firebase();
    for (let i = 0; i < ids.length; i += 400) {
      const batch = fb.writeBatch(db);
      for (const id of ids.slice(i, i + 400)) batch.set(pageRef(id), LS.SHARE_OFF);
      await batch.commit();
    }
  } catch {
    putOff(ids.map((id) => ({ id, owner: uid })));
  }
}

// Into the shared folder: a file an app saved there, or asked to (once the Player said yes). Once
// only: the same file, from the same moment, isn't added twice.
async function putShared(dir: string | undefined, f: SavedFile, at: number): Promise<boolean> {
  const F = await import('./life/files');
  const bytes = fromB64(f.data);
  const there = (await F.listFiles()).some((x) => x.at === at && x.name === f.name && x.size === bytes.length);
  if (there) return false;
  await F.putFile(bytes, { name: f.name, type: f.type, at, shrink: false, ...(dir ? { dir } : {}) });
  return true;
}

// ---------- AI apps on the web: the connector's address, and what each app did

export const connectorReady = () => !!CONNECTOR.server;
export const connectorAddress = (l: Pick<MeLink, 'web'>) => (l.web ? `${CONNECTOR.server.replace(/\/+$/, '')}/mcp/${l.web.id}.${l.web.key}` : '');

// Whether the connector answers (it's deployed by the owner): true, false, or null while unknown.
// And whether it keeps to the Player's rules (its /health says `rules`, from 1.1.0): one from
// before doesn't, until the owner deploys it again.
let reachable: boolean | null = null;
let keepsRules: boolean | null = null;
let doesFiles: boolean | null = null;
let checking: Promise<boolean> | null = null;
export const connectorReachable = () => reachable;
export const connectorKeepsRules = () => keepsRules;
// Whether it serves files (its /health says `files`, from 1.2.0). Until it does, the file
// switches wait for its update.
export const connectorDoesFiles = () => doesFiles;
export function checkConnector(): Promise<boolean> {
  if (!CONNECTOR.server) return Promise.resolve((reachable = false));
  checking ||= fetch(`${CONNECTOR.server.replace(/\/+$/, '')}/health`, { cache: 'no-store', credentials: 'omit' })
    .then(async (r) => {
      const h = r.ok ? ((await r.json()) as { name?: string; features?: unknown }) : null;
      if (h?.name !== 'arise-connector') return false;
      keepsRules = Array.isArray(h.features) && h.features.includes('rules');
      doesFiles = Array.isArray(h.features) && h.features.includes('files');
      return true;
    })
    .catch(() => false)
    .then((ok) => {
      reachable = ok;
      checking = null;
      return ok;
    });
  return checking;
}
// An app on the web with rules, while the connector doesn't keep to them yet. (Arise still holds
// back what they keep from it, and checks what it adds against them.)
export const needsConnectorUpdate = (l: Pick<MeLink, 'web' | 'rules'>) => !!l.web && !l.web.off && !!l.rules && keepsRules === false;

// ---------- what apps asked to add: waiting for the Player's yes

export const asks = (): MeAsk[] => cleanMeAsks(read(ASKS));
const saveAsks = (list: MeAsk[]) => write(ASKS, cleanMeAsks(list));
export const asksFor = (id: string) => asks().filter((a) => a.link === id);
export const askKey = (a: Pick<MeAsk, 'web' | 'n' | 'at'>) => `${a.web}/${a.n}/${a.at}`;

// The Player said yes: Arise adds it, marked with the app's name, as if the app had added it.
// False when it's no longer waiting (or the link is gone, and it's let go).
export async function allowAsk(key: string): Promise<boolean> {
  const a = asks().find((x) => askKey(x) === key);
  if (!a) return false;
  const l = links().find((x) => x.id === a.link);
  if (l) {
    if (a.want === 'add_todo') S.addTodo({ id: `ai-${a.web}-${a.n}-${a.at}`, title: a.text, ...(a.day ? { day: a.day } : {}), from: l.app });
    else if (a.want === 'save_file') {
      if (!hasLifeStore()) throw new Error("This copy of Arise can't keep files.");
      if (a.file) await putShared(l.web?.dir, a.file, a.at);
    } else {
      if (!hasLifeStore()) throw new Error("This copy of Arise can't add notes to your day.");
      await (await lifeStore()).addEvents([noteEvent({ app: l.app, web: { id: a.web } }, a.n, { at: a.at, tool: 'add_note', ok: true, note: a.text, ...(a.client ? { client: a.client } : {}) })]);
    }
  }
  saveAsks(asks().filter((x) => askKey(x) !== key));
  feedListeners.forEach((cb) => cb());
  return !!l;
}

// The Player said no: it's let go, and nothing is added.
export function dismissAsk(key: string) {
  saveAsks(asks().filter((x) => askKey(x) !== key));
  feedListeners.forEach((cb) => cb());
}

export const feedLog = (): FeedLog => cleanFeedLog(read(FEED));
export const feedOf = (id: string): FeedEntry[] => feedLog()[id] || [];
const feedListeners = new Set<() => void>();
export function onFeed(cb: () => void): () => void {
  feedListeners.add(cb);
  return () => feedListeners.delete(cb);
}

// A note an app added, as it goes into the life log: one event per note, so taking it twice adds
// it once.
export function noteEvent(l: Pick<MeLink, 'app'> & { web?: Pick<LinkWeb, 'id'> }, n: number, e: FeedEntry): LifeEvent {
  const text = e.note || '';
  const first = text.split('\n')[0].trim();
  return {
    // (With the time too: the connector numbers afresh after 60 days without use.)
    id: `other:ai-note-${l.web?.id || ''}-${n}-${e.at}`,
    source: 'other',
    kind: 'note',
    at: e.at,
    title: `${l.app}: ${first.length > 80 ? `${first.slice(0, 79)}…` : first}`,
    detail: `${text}\n\nAdded by ${l.app}${e.client && e.client !== l.app ? ` (${e.client})` : ''}, through the web connector.`,
    tier: 2,
    meta: { from: l.app },
  };
}

const PULL_GAP = 60_000;
let lastPull = 0;
let pulling: Promise<number> | null = null;

// Takes what each app on the web did since last time: the log is kept here (the last 50 per app),
// notes go into the day and to-dos onto the list, then the connector lets them go. Says how many
// notes and to-dos came in.
export function pullFeeds({ force = false } = {}): Promise<number> {
  if (pulling) return pulling;
  const due = links().filter((l) => l.web);
  if (!CONNECTOR.server || !due.length || (!force && Date.now() - lastPull < PULL_GAP)) return Promise.resolve(0);
  lastPull = Date.now();
  pulling = (async () => {
    let added = 0;
    for (const l of due) {
      try {
        added += await pullOne(l);
      } catch {}
    }
    return added;
  })().finally(() => {
    pulling = null;
  });
  return pulling;
}

async function pullOne(l: MeLink): Promise<number> {
  const w = l.web;
  if (!w) return 0;
  const base = CONNECTOR.server.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${w.tok}` };
  const res = await fetch(`${base}/feed/${w.id}`, { headers: auth, cache: 'no-store', credentials: 'omit' });
  if (!res.ok) return 0;
  const { entries } = (await res.json()) as { entries?: SealedEntry[] };
  const key = await feedKey(w.id, w.key);
  let got: { n: number; e: FeedEntry }[] = [];
  for (const s of Array.isArray(entries) ? entries.slice(0, 400) : []) {
    if (!s || !Number.isSafeInteger(s.n) || typeof s.iv !== 'string' || typeof s.ct !== 'string') continue;
    const e = await openEntry(key, w.id, s);
    if (e) got.push({ n: s.n, e });
  }
  got.sort((a, b) => a.n - b.n);
  // What each entry adds, by the Player's rules as they are here: an older connector doesn't keep
  // to them, so a note or to-do they say never to is let go, and one they say to ask about first
  // waits for their yes, as a request does. A file only while saving files is still on.
  const hasFile = (e: FeedEntry) => !!e.file && 'data' in e.file;
  const wantOf = (e: FeedEntry) => {
    if (!e.ok) return null;
    const want = e.tool === 'ask' ? e.want! : e.tool === 'add_note' || e.tool === 'add_todo' || e.tool === 'save_file' ? e.tool : null;
    return !want ? null : want === 'save_file' ? (hasFile(e) && w.fwrite && w.dir ? want : null) : e.note ? want : null;
  };
  const ruleFor = (e: FeedEntry) => {
    const want = wantOf(e);
    if (!want) return null;
    const rule = ME.ruleOf(l.rules, want === 'add_note' ? 'note' : want === 'add_todo' ? 'todo' : 'file');
    return rule === 'never' ? null : e.tool === 'ask' ? 'ask' : rule;
  };
  const isNote = (x: { e: FeedEntry }) => x.e.tool === 'add_note' && ruleFor(x.e) === 'yes';
  const isTodo = (x: { e: FeedEntry }) => x.e.tool === 'add_todo' && ruleFor(x.e) === 'yes';
  const isFile = (x: { e: FeedEntry }) => x.e.tool === 'save_file' && ruleFor(x.e) === 'yes';
  const isAsk = (x: { e: FeedEntry }) => ruleFor(x.e) === 'ask';
  // Without a life log here, notes and files stay with the connector (for a device that has one),
  // and so does everything after the first of them.
  if (!hasLifeStore()) {
    const first = got.findIndex((x) => isNote(x) || isFile(x));
    if (first >= 0) got = got.slice(0, first);
  }
  if (!got.length) return 0;
  // Notes first into the day: if that fails, they stay with the connector for next time.
  const fresh = got.filter((x) => x.n > (w.fed || 0));
  const notesIn = fresh.filter(isNote);
  let added = 0;
  if (notesIn.length) added = await (await lifeStore()).addEvents(notesIn.map((x) => noteEvent(l, x.n, x.e)));
  // Files go into the shared folder (once each: the same file from the same moment is let be).
  for (const x of fresh.filter(isFile)) if (await putShared(w.dir, x.e.file as SavedFile, x.e.at)) added++;
  // To-dos go on the list (once each: the id comes from the entry).
  for (const x of fresh.filter(isTodo)) if (S.addTodo({ id: `ai-${w.id}-${x.n}-${x.e.at}`, title: x.e.note!, ...(x.e.day ? { day: x.e.day } : {}), from: l.app })) added++;
  const upTo = got.at(-1)!.n;
  // Only while it's still this web page here (it may have been turned off meanwhile).
  if (links().some((x) => x.id === l.id && x.web?.id === w.id)) {
    const asked = fresh.filter(isAsk).map((x) => ({ link: l.id, web: w.id, n: x.n, at: x.e.at, want: wantOf(x.e)!, text: x.e.note || (x.e.file?.name ?? ''), ...(x.e.day ? { day: x.e.day } : {}), ...(x.e.client ? { client: x.e.client } : {}), ...(x.e.file && 'data' in x.e.file ? { file: x.e.file } : {}) }));
    if (asked.length) saveAsks([...asks(), ...asked]);
    if (fresh.length) {
      const log = feedLog();
      // (The log keeps a file's name and type, not its bytes.)
      const shown = (e: FeedEntry): FeedEntry => (e.file ? { ...e, file: { name: e.file.name, type: e.file.type } } : e);
      log[l.id] = [...(log[l.id] || []), ...fresh.map((x) => shown(x.e))].slice(-MAX_FEED_SHOWN);
      write(FEED, log);
    }
    patchWeb(l.id, w.id, { fed: Math.max(upTo, w.fed || 0) });
  }
  await fetch(`${base}/feed/${w.id}/done`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ upTo }), credentials: 'omit' }).catch(() => {});
  feedListeners.forEach((cb) => cb());
  return added;
}

// An AI app on the web that hasn't been used for 60 days is turned off by itself, like Eternal's
// connected apps. "Used": anything in its access log; before any, from when this device first saw
// it on. Says which apps it turned off.
const IDLE = 'arise-me-idle';
export const IDLE_DAYS = 60;
export async function offWhenIdle(now = Date.now()): Promise<string[]> {
  const raw = read(IDLE);
  const seen: Record<string, number> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, number>) } : {};
  const off: string[] = [];
  const live = new Set<string>();
  for (const l of links()) {
    const w = l.web;
    if (!w || w.off) continue;
    live.add(w.id);
    if (!(typeof seen[w.id] === 'number' && seen[w.id] > 0)) seen[w.id] = now;
    const last = Math.max(seen[w.id], ...feedOf(l.id).map((e) => e.at));
    if (now - last <= IDLE_DAYS * 86_400_000) continue;
    try {
      await setWeb(l.id, null);
      off.push(l.app);
      live.delete(w.id);
    } catch {}
  }
  for (const id of Object.keys(seen)) if (!live.has(id)) delete seen[id];
  write(IDLE, seen);
  if (off.length) idleOff = { apps: off, at: now };
  return off;
}
// The apps turned off last time, for the AI apps screen to say so.
let idleOff: { apps: string[]; at: number } | null = null;
export const lastIdleOff = () => idleOff;

export function initMe() {
  S.onSave(() => soon());
  M.onMemoryChange(() => soon());
  SYNC.onSynced(() => soon(AFTER_SYNC));
  SYNC.onClearing(turnOffAll);
  S.onReset(forgetHere);
  // About to be put away: now, rather than after the wait. Back again, maybe on a new day: soon.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) void refresh();
    else if (document.visibilityState === 'visible') {
      soon();
      void pullFeeds();
    }
  });
  void pullFeeds()
    .catch(() => 0)
    .then(() => offWhenIdle())
    .catch(() => []);
  // Today's quests and the last 7 days move on by themselves.
  soon();
}
