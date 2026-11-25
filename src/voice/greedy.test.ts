// Writing down what was said, with a made-up model: the start Whisper expects, the language on
// Auto, what may not be written, and stopping.

import { describe, expect, it } from 'vitest';
import { greedy, stuckAt, type Next } from './greedy';
import { SPACE, type Words } from './tokens';

const V = 400; // a small word list: text 0..299, specials from 300
const words: Words = {
  pieces: [],
  eot: 300,
  sot: 301,
  transcribe: 302,
  noTimestamps: 303,
  languages: new Map([
    ['en', 310],
    ['ru', 311],
    ['uz', 312],
  ]),
};

// A model that says `script` one piece at a time (pieces not in SUPPRESS), then ends; after "start" alone it likes `lang`.
function model(script: number[], lang = 312) {
  const fed: number[][] = [];
  let said = 0;
  const next: Next = async (ids) => {
    fed.push(ids);
    const s = new Float32Array(V).fill(-5);
    const all = fed.flat();
    if (all.length === 1) {
      s[lang] = 9;
      s[words.eot] = 3;
    } else if (all.length >= 4) {
      const want = script[said++] ?? words.eot;
      s[want] = 10;
      s[301] = 20; // a special piece it must never pick
      s[WORD] = 1; // something else it could say
    }
    return s;
  };
  return { next, fed };
}
const WORD = 42;

describe('greedy decoding', () => {
  it('starts as Whisper expects, writes the pieces it likes best, and stops at the end', async () => {
    const { next, fed } = model([5, 6, 11]);
    const r = await greedy(next, words, { language: 'en' });
    expect(fed.slice(0, 4)).toEqual([[301], [310], [302], [303]]);
    expect(r).toEqual({ ids: [5, 6, 11], language: 'en' });
    expect(fed.slice(4)).toEqual([[5], [6], [11]]); // one new piece at a time
  });

  it('on Auto, picks the language the model hears first', async () => {
    const { next, fed } = model([5], 312);
    const r = await greedy(next, words, { language: 'auto' });
    expect(r.language).toBe('uz');
    expect(fed[1]).toEqual([312]);
  });

  it('never starts with a lone space or by ending', async () => {
    const { next } = model([SPACE, 11]);
    const r = await greedy(next, words, { language: 'en' });
    expect(r.ids[0]).toBe(WORD); // the space was taken away, so the next best
    const ends = model([300]);
    expect((await greedy(ends.next, words, { language: 'en' })).ids[0]).toBe(WORD);
  });

  it('stops after the most pieces allowed', async () => {
    const { next } = model(Array.from({ length: 50 }, (_, i) => i));
    expect((await greedy(next, words, { language: 'en', max: 10 })).ids).toHaveLength(10);
  });

  it('stops when it gets stuck saying the same thing', async () => {
    const { next } = model([3, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5, 6]);
    expect((await greedy(next, words, { language: 'en' })).ids).toEqual([3, 4, 5]);
  });
});

describe('stuck', () => {
  it('finds a run said four times at the end', () => {
    expect(stuckAt([7, 7, 7, 7])).toBe(1);
    expect(stuckAt([1, 4, 5, 4, 5, 4, 5, 4, 5])).toBe(3);
    expect(stuckAt([1, 2, 3, 1, 2, 3])).toBe(-1);
    expect(stuckAt([7, 7, 7])).toBe(-1);
  });
});
