// "Not quite? Fix it" in the life log on the device: a fixed or deleted event stays that way when an
// importer brings it in again and when another device's copy comes in, and the correction goes
// to the other devices in the memory's pack. Also Look back's counts.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import * as L from './log';
import * as LOCAL from './local';
import { closeDB } from './db';
import { readFixes, readKnew, saveKnew } from './fix-store';
import { emptyContent, eventPack, MEM } from './packs';
import { kindText, rangeOf, step, tally } from './lookback';
import type { LifeEvent } from './types';

const T = (s: string) => new Date(s).getTime(); // local time
const song = (id: string, when = '2026-10-05T09:00', title = `Listened to song ${id}`): LifeEvent => ({ id: `spotify:${id}`, source: 'spotify', kind: 'listen', at: T(when), title, tier: 2 });
const titles = async () => (await L.eventsBetween(0, 8.64e15)).map((e) => e.title).sort();

beforeEach(() => {
  closeDB();
  globalThis.indexedDB = new IDBFactory();
});

describe('fixing an event', () => {
  it('changes its title, time and kind, and an import of the same thing again leaves it fixed', async () => {
    await L.addEvents([song('1'), song('2')]);
    const fixed = await L.fixEvent('spotify:1', { title: 'Lunch with Sam', at: T('2026-10-05T12:30'), kind: 'event' });
    expect(fixed).toMatchObject({ title: 'Lunch with Sam', kind: 'event', at: T('2026-10-05T12:30') });
    // The importer runs again with the file as it was.
    expect(await L.addEvents([song('1'), song('2')])).toBe(0);
    // A linked calendar or helper sends its own copy again.
    await L.upsertEvents([song('1')]);
    expect(await L.getEvent('spotify:1')).toMatchObject({ title: 'Lunch with Sam', kind: 'event', at: T('2026-10-05T12:30') });
    // A second fix keeps what the first one said.
    await L.fixEvent('spotify:1', { title: 'Lunch with Sam and Jo' });
    await L.addEvents([song('1')]);
    expect(await L.getEvent('spotify:1')).toMatchObject({ title: 'Lunch with Sam and Jo', kind: 'event', at: T('2026-10-05T12:30') });
    expect((await readFixes()).map((f) => f.id)).toEqual(['spotify:1']);
  });

  it('deletes it for good: importing it again never brings it back', async () => {
    await L.addEvents([song('1'), song('2')]);
    expect(await L.fixEvent('spotify:2', 'delete')).toBeNull();
    expect(await titles()).toEqual(['Listened to song 1']);
    expect(await L.addEvents([song('1'), song('2')])).toBe(0);
    await L.upsertEvents([song('2')]);
    expect(await titles()).toEqual(['Listened to song 1']);
  });

  it("leaves Arise's own events, and changes nothing when nothing is different", async () => {
    await L.addEvents([{ id: 'arise:quest:1', source: 'arise', kind: 'quest', at: T('2026-10-05T09:00'), title: 'Done: Read', tier: 1 }, song('1')]);
    expect(await L.fixEvent('arise:quest:1', { title: 'Something else' })).toBe(false);
    expect(await L.fixEvent('spotify:1', { title: 'Listened to song 1' })).toBe(false);
    expect(await L.fixEvent('spotify:nope', 'delete')).toBe(false);
    expect(await readFixes()).toEqual([]);
  });

  it('sends the correction with the memory, and its month without the old version', async () => {
    await L.addEvents([song('1')]);
    await L.fixEvent('spotify:1', { title: 'Better title' });
    const mem = await LOCAL.buildPack(MEM);
    expect(mem.fixes).toEqual([expect.objectContaining({ id: 'spotify:1', title: 'Better title' })]);
    const month = await LOCAL.buildPack(eventPack(song('1')));
    expect(month.events.map((e) => e.title)).toEqual(['Better title']);
  });
});

describe('a fix from another device', () => {
  it('changes the event here too, and another copy of it coming in later stays fixed', async () => {
    await L.addEvents([song('1'), song('2')]);
    const now = Date.now();
    // The other device fixed one and deleted the other.
    const remote = { ...emptyContent(), fixes: [{ id: 'spotify:1', at: now, title: 'Fixed there' }, { id: 'spotify:2', at: now, gone: true as const }] };
    const res = await LOCAL.applyPack(MEM, remote, { now });
    expect(res.newFixes).toHaveLength(2);
    expect(await titles()).toEqual(['Fixed there']);
    expect([...(await LOCAL.dirtyMarks()).keys()]).toContain(eventPack(song('1')));
    // A third device that imported the same songs after the fix sends its copy, newer by its clock.
    const key = eventPack(song('1'));
    const later = { ...emptyContent(), events: [{ ...song('1'), m: now + 60_000 }, { ...song('2'), m: now + 60_000 }] };
    await LOCAL.applyPack(key, later, { now: now + 120_000 });
    expect(await titles()).toEqual(['Fixed there']);
    // And an importer here, too.
    await L.addEvents([song('1'), song('2')]);
    expect(await titles()).toEqual(['Fixed there']);
  });
});

describe('snapshots of what Arise knew', () => {
  it('keeps one only when it changed, and sends them with the memory', async () => {
    const snap = (day: string, texts: string[]) => ({ day, at: T(`${day}T12:00`), facts: texts.map((text, i) => ({ id: `f${i}`, text })) });
    expect(await saveKnew(snap('2026-10-01', ['You run.']))).toBe(true);
    expect(await saveKnew(snap('2026-10-02', ['You run.']))).toBe(false);
    expect(await saveKnew(snap('2026-10-03', ['You run.', 'You swim.']))).toBe(true);
    expect((await readKnew()).map((k) => k.day)).toEqual(['2026-10-01', '2026-10-03']);
    expect((await LOCAL.buildPack(MEM)).knew.map((k) => k.day)).toEqual(['2026-10-01', '2026-10-03']);
  });
});

describe('Look back', () => {
  it('counts a month of the log by kind, day, place, person and site', async () => {
    await L.addEvents([
      song('1', '2026-10-05T09:00'),
      song('2', '2026-10-05T10:00'),
      song('3', '2026-10-06T10:00'),
      { id: 'maps:v1', source: 'maps', kind: 'place', at: T('2026-10-05T12:00'), title: 'At The Park Cafe', tier: 3 },
      { id: 'maps:v2', source: 'maps', kind: 'place', at: T('2026-10-07T12:00'), title: 'At The Park Cafe', tier: 3 },
      { id: 'maps:p1', source: 'maps', kind: 'place', at: T('2026-10-07T13:00'), title: 'Where you were', tier: 3 },
      { id: 'whatsapp:c1', source: 'whatsapp', kind: 'message', at: T('2026-10-06T20:00'), title: 'Chatted with Sam: 12 messages', tier: 3, meta: { chat: 'Sam' } },
      { id: 'browser:v1', source: 'browser', kind: 'visit', at: T('2026-10-06T21:00'), title: 'Visited YouTube', url: 'https://www.youtube.com/watch?v=1', tier: 3 },
      song('4', '2026-11-01T10:00'), // the next month
    ]);
    const [from, to] = rangeOf('month', '2026-10');
    const t = await tally(from, to);
    expect(t.total).toBe(8);
    expect(t.kinds[0]).toEqual(['listen', 3]);
    expect(t.days[0][1]).toBe(3);
    expect(t.places).toEqual([['The Park Cafe', 2]]);
    expect(t.people).toEqual([['Sam', 1]]);
    expect(t.sites).toEqual([['YouTube', 1]]);
    expect(kindText('listen', 3)).toBe('3 things listened to');
    expect(step('month', '2026-01', -1)).toBe('2025-12');
    expect(step('year', '2026', 1)).toBe('2027');
    expect(step('day', '2026-03-01', -1)).toBe('2026-02-28');
  });
});
