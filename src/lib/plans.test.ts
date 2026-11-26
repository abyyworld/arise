// @vitest-environment jsdom
// Plans between people, the parts both sides use: the link, the page (only what it may hold), the
// answers, sealing both ways, and reading and writing them as a browser that isn't signed in.

import { beforeEach, describe, expect, it } from 'vitest';
import { cloud, resetCloud, restFetch } from '../test/fake-firebase';
import * as L from './plans';
import { cleanEvent, mergeEvents, type CalEvent } from './events';
import { cleanEventPlan, latestAnswers } from './plan-link';
import { sealSnapshot, type Snapshot } from './share';

const PROJECT = { projectId: 'p', apiKey: 'k' };
const get = restFetch as typeof fetch;
const at = Date.UTC(2026, 10, 20, 12);

const dinner = (over: Partial<CalEvent> = {}): CalEvent => ({
  id: 'dinner',
  title: "Dinner at Lia's",
  start: '2026-12-04T19:00',
  end: '2026-12-04T21:00',
  tz: 'Europe/London',
  location: '4 Hill Street',
  notes: 'Bring the cake. It is a surprise for Jo.',
  guests: ['sam@example.com', 'Jo'],
  remind: [60],
  color: 'red',
  created: at,
  at,
  ...over,
});

// A page in the cloud, as the maker's Arise leaves it.
async function up(e: CalEvent, opts: { host?: string; cancelled?: boolean } = {}) {
  const ref = await L.newPlanRef();
  const page = L.pageOf(e, { now: at, ...opts });
  const s = await L.sealPage(ref, page);
  cloud.docs.set(`shares/${ref.id}`, { owner: 'uid1', iv: s.iv, ct: s.ct, v: 1, updated: at });
  return { ref, page };
}

beforeEach(() => resetCloud());

describe('the link', () => {
  it('is the page and its key after #plan=, and reads back from a whole link pasted in', async () => {
    const ref = await L.newPlanRef();
    expect(ref.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ref.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const link = L.planLink('https://abyyworld.github.io/arise/#calendar', ref);
    expect(link).toBe(`https://abyyworld.github.io/arise/#plan=${ref.id}.${ref.key}`);
    expect(L.isPlanHash(`#plan=${ref.id}.${ref.key}`)).toBe(true);
    expect(L.parsePlanLink(`#plan=${ref.id}.${ref.key}`)).toEqual({ id: ref.id, key: ref.key });
    expect(L.parsePlanLink(`  Say if you can come: ${link} `)).toEqual({ id: ref.id, key: ref.key });
    expect(L.parsePlanLink(`#plan=${ref.id}.${ref.key.slice(1)}`)).toBeNull();
    expect(L.parsePlanLink(`#share=${ref.id}.${ref.key}`)).toBeNull();
    expect(L.guestEventId(ref.id)).toBe(`p_${ref.id}`);
  });

  it('opens in the app only in a browser that has Arise in it', () => {
    localStorage.clear();
    expect(L.hasAriseHere()).toBe(false);
  });
});

describe('the page', () => {
  it('holds the title, the time, the place and a first name: never the notes, guests, reminders or colour', () => {
    const page = L.pageOf(dinner(), { host: 'Akbar Juraev', now: at });
    expect(page).toEqual({ v: 1, title: "Dinner at Lia's", start: '2026-12-04T19:00', end: '2026-12-04T21:00', tz: 'Europe/London', location: '4 Hill Street', host: 'Akbar', updated: at });
    for (const k of Object.keys(page)) expect(L.PAGE_FIELDS).toContain(k);
    expect(JSON.stringify(page)).not.toMatch(/cake|sam@|remind|red/);
  });

  it("keeps a repeat with its times, but not a changed time's notes", () => {
    const e = cleanEvent({ ...dinner(), repeat: { freq: 'weekly', days: [5] }, skip: ['2026-12-11T19:00'], changes: { '2026-12-18T19:00': { start: '2026-12-18T20:00', notes: 'Secret' } } })!;
    const page = L.pageOf(e, { now: at });
    expect(page.repeat).toEqual({ freq: 'weekly', days: [5] });
    expect(page.skip).toEqual(['2026-12-11T19:00']);
    expect(page.changes).toEqual({ '2026-12-18T19:00': { start: '2026-12-18T20:00' } });
    expect(L.cleanPage(JSON.parse(JSON.stringify(page)))).toEqual(page);
  });

  it('checks what comes out of the cloud', () => {
    expect(L.cleanPage({ v: 1, title: 'x', start: 'tomorrow', updated: at })).toBeNull();
    expect(L.cleanPage({ v: 2, title: 'x', start: '2026-12-04', allDay: true, updated: at })).toBeNull();
    const p = L.cleanPage({ v: 1, title: '  Picnic  ', start: '2026-12-04', allDay: true, updated: at, notes: 'sneaked in', guests: ['a@b.c'], host: 'Sam Lee', cancelled: true, extra: 1 });
    expect(p).toEqual({ v: 1, title: 'Picnic', start: '2026-12-04', allDay: true, host: 'Sam', cancelled: true, updated: at });
  });

  it('has a fingerprint that changes with the time or place, not with notes, reminders or colour', () => {
    const f = L.fingerprint(dinner());
    expect(L.fingerprint(dinner({ notes: 'other', remind: [5], color: 'blue', guests: [] }))).toBe(f);
    expect(L.fingerprint(dinner({ start: '2026-12-04T20:00' }))).not.toBe(f);
    expect(L.fingerprint(dinner({ location: 'Somewhere else' }))).not.toBe(f);
    expect(f).toMatch(/^[a-z0-9]{1,16}$/);
  });

  it('says when, on this clock', () => {
    const page = L.pageOf(dinner({ tz: undefined }), { now: at });
    expect(L.whenOf(page)).toMatch(/Dec 4, 19:00 to 21:00$/);
    expect(L.whenOf(L.pageOf(dinner({ start: '2026-12-04', end: undefined, allDay: true, tz: undefined }), { now: at }))).toMatch(/Dec 4, all day$/);
  });
});

describe('sealing', () => {
  it('opens a page only with its own key and id, and not a goal page in its place', async () => {
    const { ref, page } = await up(dinner(), { host: 'Akbar' });
    const sealed = await L.fetchPage(ref.id, PROJECT, get);
    expect(sealed).not.toBeNull();
    expect(await L.openPage(ref, sealed!)).toEqual(page);
    expect(JSON.stringify(cloud.docs.get(`shares/${ref.id}`))).not.toMatch(/Dinner at Lia|4 Hill Street|Akbar|19:00/);
    const other = await L.newPlanRef();
    await expect(L.openPage({ id: ref.id, key: other.key }, sealed!)).rejects.toThrow();
    await expect(L.openPage({ id: other.id, key: ref.key }, sealed!)).rejects.toThrow();
    // A goal's page sealed with the same key doesn't open as a plan.
    const snap = await sealSnapshot(ref, { v: 1, title: 'Goal' } as Snapshot);
    await expect(L.openPage(ref, snap)).rejects.toThrow();
  });

  it('gives an answer the same id for the same name, whatever the case, and another link another id', async () => {
    const a = await L.newPlanRef();
    const b = await L.newPlanRef();
    const sam = await L.replyId(a.key, 'Sam');
    expect(sam).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await L.replyId(a.key, '  sam ')).toBe(sam);
    expect(await L.replyId(a.key, 'Jo')).not.toBe(sam);
    expect(await L.replyId(b.key, 'Sam')).not.toBe(sam);
  });

  it('seals an answer back: written without an account, read with the key, and the same name changes its answer', async () => {
    const { ref } = await up(dinner());
    const rid = await L.answer(ref, 'Sam', 'yes', PROJECT, get, at + 1);
    await L.answer(ref, 'Jo Price', 'no', PROJECT, get, at + 2);
    expect(cloud.docs.get(`shares/${ref.id}/replies/${rid}`)).toMatchObject({ v: 1, updated: at + 1 });
    expect(JSON.stringify([...cloud.docs])).not.toMatch(/"Sam"|Jo Price|"yes"|"no"/);
    let got = await L.readAnswers(ref, PROJECT, get);
    expect(got.map((a) => [a.name, a.says]).sort()).toEqual([
      ['Jo Price', 'no'],
      ['Sam', 'yes'],
    ]);
    await L.answer(ref, 'sam', 'no', PROJECT, get, at + 3);
    got = await L.readAnswers(ref, PROJECT, get);
    expect(got).toHaveLength(2);
    expect(got.find((a) => a.id === rid)).toMatchObject({ name: 'sam', says: 'no' });
    // An answer with another link's key, or put under another answer's id, is left out.
    const other = await L.newPlanRef();
    const fake = await L.sealReply(other, 'x'.repeat(22), { v: 1, name: 'Mallory', says: 'yes', at });
    await L.putReply(ref.id, 'x'.repeat(22), fake, PROJECT, get);
    const moved = cloud.docs.get(`shares/${ref.id}/replies/${rid}`)!;
    cloud.docs.set(`shares/${ref.id}/replies/${'y'.repeat(22)}`, moved);
    expect((await L.readAnswers(ref, PROJECT, get)).map((a) => a.name).sort()).toEqual(['Jo Price', 'sam']);
  });

  it("can't answer a page that isn't there or was turned off", async () => {
    const ref = await L.newPlanRef();
    await expect(L.answer(ref, 'Sam', 'yes', PROJECT, get)).rejects.toMatchObject({ code: 'permission-denied' });
    const { ref: off } = await up(dinner());
    cloud.docs.set(`shares/${off.id}`, { v: 1, off: true });
    await expect(L.answer(off, 'Sam', 'yes', PROJECT, get)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(await L.fetchPage(off.id, PROJECT, get)).toBeNull();
    await expect(L.answer(off, '   ', 'yes', PROJECT, get)).rejects.toThrow('Write your name first');
  });
});

describe('the event keeps it', () => {
  it('cleans the plan of your event and of your copy of theirs', () => {
    const id = 'A'.repeat(22);
    const key = 'B'.repeat(43);
    const answers = [
      { id: 'C'.repeat(22), name: 'Sam', says: 'yes', at: at + 1 },
      { id: 'D'.repeat(22), name: 'sam', says: 'no', at: at + 2 },
      { id: 'E'.repeat(22), name: 'Jo', says: 'left', at: at + 3 },
      { id: 'bad', name: 'X', says: 'yes', at },
      { id: 'F'.repeat(22), name: 'Y', says: 'maybe', at },
    ];
    expect(cleanEventPlan({ id, key, at, said: 'abc', answers, guest: false, host: 'x' })).toEqual({
      id,
      key,
      at,
      said: 'abc',
      answers: [
        { id: 'E'.repeat(22), name: 'Jo', says: 'left', at: at + 3 },
        { id: 'D'.repeat(22), name: 'sam', says: 'no', at: at + 2 },
      ],
    });
    expect(cleanEventPlan({ id, key, at, guest: true, host: 'Akbar', me: 'C'.repeat(22), name: 'Sam', says: 'yes', took: at, ended: 'cancelled', answers })).toEqual({ id, key, at, guest: true, host: 'Akbar', me: 'C'.repeat(22), name: 'Sam', says: 'yes', took: at, ended: 'cancelled' });
    expect(cleanEventPlan({ id, key: 'short', at })).toBeUndefined();
    expect(latestAnswers([])).toEqual([]);
  });

  it('goes with the event through cleaning and merging (so it syncs with it)', () => {
    const plan = { id: 'A'.repeat(22), key: 'B'.repeat(43), at, said: 'abc', answers: [{ id: 'C'.repeat(22), name: 'Sam', says: 'yes' as const, at }] };
    const e = cleanEvent({ ...dinner(), plan })!;
    expect(e.plan).toEqual(plan);
    expect(cleanEvent({ ...dinner(), plan: { id: 'nope' } })!.plan).toBeUndefined();
    const later = { ...e, plan: { ...plan, answers: [...plan.answers, { id: 'D'.repeat(22), name: 'Jo', says: 'no' as const, at: at + 5 }] }, at: at + 5 };
    expect(mergeEvents({ dinner: e }, { dinner: later }, at + 10).dinner.plan!.answers!.map((a) => a.name)).toEqual(['Jo', 'Sam']);
  });
});
