// @vitest-environment jsdom
// Search by meaning on the device, with a pretend model that knows a few ideas: the log read in
// the background, kept up to date, ranked by closeness, and the related-word lists when there's
// no model.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import * as L from '../log';
import { closeDB } from '../db';
import * as MODEL from './model';
import * as IDX from './index';
import { normalize } from './vectors';
import type { LifeEvent } from '../types';

// A pretend model: each text is a mix of four ideas, by its words. (Equally close: the newer first.)
const IDEAS: Record<string, number> = { run: 0, jog: 0, gym: 0, workout: 0, exercise: 0, pizza: 1, lunch: 1, food: 1, dinner: 1, mum: 2, call: 2, family: 2, song: 3, music: 3 };
const read: string[] = [];
const fake: MODEL.Embedder = {
  async embed(texts) {
    read.push(...texts);
    return texts.map((t) => {
      const v = new Float32Array(384);
      for (const w of t.toLowerCase().match(/[a-z]+/g) || []) if (w in IDEAS) v[IDEAS[w]] = 1;
      if (!v.some((x) => x)) v[383] = 1; // none of them
      return normalize(v);
    });
  },
};

const T = (s: string) => new Date(s).getTime();
const ev = (id: string, at: string, title: string, extra: Partial<LifeEvent> = {}): LifeEvent => ({ id: `manual:${id}`, source: 'manual', kind: 'note', at: T(at), title, tier: 2, ...extra });
const EVENTS = [ev('a', '2026-11-01T08:00', 'Morning jog by the river'), ev('b', '2026-11-02T13:00', 'Pizza for lunch'), ev('c', '2026-11-03T19:00', 'Gym workout, legs'), ev('d', '2026-11-04T20:00', 'Called mum'), ev('e', '2026-11-05T09:00', '12:30')];

beforeEach(async () => {
  closeDB();
  MODEL.closeMeaningDB();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  read.length = 0;
  MODEL._setEmbedder(fake);
  await IDX.forgetVectors();
  await L.addEvents(EVENTS);
});
const on = () => localStorage.setItem('arise-meaning', JSON.stringify({ on: true, at: 1 }));
const ids = (l: LifeEvent[]) => l.map((e) => e.id.slice(7));

describe('reading the log', () => {
  it('reads every event worth reading once, and again only when its words change', async () => {
    await IDX.readAll(fake);
    expect(read).toHaveLength(4); // not "12:30"
    read.length = 0;
    await IDX.readAll(fake);
    expect(read).toEqual([]);
    await L.upsertEvents([{ ...EVENTS[1], title: 'Sushi dinner' }]);
    await IDX.readAll(fake);
    expect(read).toEqual(['Sushi dinner']);
  });

  it('forgets an event deleted from a day it reads again', async () => {
    on();
    await IDX.readAll(fake);
    expect(ids(await IDX.byMeaning('exercise'))).toEqual(['c', 'a']);
    await L.removeIds(['manual:c']);
    await IDX.readDays(['2026-11-03'], fake);
    expect(ids(await IDX.byMeaning('exercise'))).toEqual(['a']);
  });
});

describe('by meaning', () => {
  it('finds the closest events, closest first, within the time asked', async () => {
    on();
    await IDX.readAll(fake);
    expect(ids(await IDX.byMeaning('when did I exercise?'))).toEqual(['c', 'a']);
    expect(ids(await IDX.byMeaning('food'))).toEqual(['b']);
    expect(ids(await IDX.byMeaning('exercise', { from: T('2026-11-02T00:00') }))).toEqual(['c']);
    expect(await IDX.byMeaning('the weather')).toEqual([]);
  });

  it('finds nothing without the model, or before it has read anything', async () => {
    await IDX.readAll(fake);
    expect(await IDX.byMeaning('exercise')).toEqual([]); // off
    on();
    await IDX.forgetVectors();
    expect(await IDX.byMeaning('exercise')).toEqual([]);
  });
});

describe('the Days search', () => {
  it('with the model: the words first, then the closest in meaning', async () => {
    on();
    await IDX.readAll(fake);
    const both = await IDX.find('gym', L.queryWords('gym'), {});
    expect(both).toMatchObject({ by: 'model', loose: false });
    expect(ids(both.results)).toEqual(['c']);
    expect(ids(both.related)).toEqual(['a']);
    const none = await IDX.find('exercise', L.queryWords('exercise'), {});
    expect(none).toMatchObject({ by: 'model', loose: 'model' });
    expect(ids(none.results)).toEqual(['c', 'a']);
  });

  it('without the model: the lists of related words, as before', async () => {
    const f = await IDX.find('exercise', L.queryWords('exercise'), {});
    expect(f.by).toBe('words');
    expect(f.loose).toBe('meaning');
    expect(f.groups).toEqual(['exercise']);
    expect(ids(f.results).sort()).toEqual(['a', 'c']);
  });

  it('falls back to the words when the model fails', async () => {
    on();
    const f = await IDX.find('exercise', L.queryWords('exercise'), {}, { search: L.search, meaning: () => Promise.reject(new Error('broken')) });
    expect(f.by).toBe('words');
    expect(ids(f.results).sort()).toEqual(['a', 'c']);
  });

  it('runs in the background while on, and forgets everything when the log is emptied', async () => {
    on();
    await IDX.start();
    expect(IDX.status.busy).toBe(false);
    expect(ids(await IDX.byMeaning('lunch'))).toEqual(['b']);
    await L.eraseAll();
    await new Promise((r) => setTimeout(r, 20));
    expect(await IDX.byMeaning('lunch')).toEqual([]);
  });
});
