// The search model's tokenizer (BERT, lower case, WordPiece), with a small word list. (Checked by
// hand against the model's own list: "Hello, world!" is 101 7592 1010 2088 999 102.)

import { describe, expect, it } from 'vitest';
import { basicTokens, encode, parseVocab, wordPiece } from './tokenizer';

const LIST = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'hello', ',', 'world', '!', 'una', '##ff', '##able', 'run', '##ning', 'cafe', 'after', '.', '東', '京', 'trip'];
const v = parseVocab(LIST.join('\n'));
const id = (t: string) => LIST.indexOf(t);

describe('the tokenizer', () => {
  it('reads the word list by line', () => {
    expect([v.pad, v.unk, v.cls, v.sep]).toEqual([0, 1, 2, 3]);
    expect(() => parseVocab('a\nb')).toThrow(/\[UNK\]/);
  });

  it('lower-cases, takes accents off, and splits around punctuation and CJK characters', () => {
    expect(basicTokens('Hello, World!')).toEqual(['hello', ',', 'world', '!']);
    expect(basicTokens('  Café\tafter.\u0000 ')).toEqual(['cafe', 'after', '.']);
    expect(basicTokens('東京trip')).toEqual(['東', '京', 'trip']);
    expect(basicTokens('7:30')).toEqual(['7', ':', '30']);
  });

  it('cuts a word into the longest pieces the list has, or [UNK]', () => {
    expect(wordPiece('unaffable', v)).toEqual([id('una'), id('##ff'), id('##able')]);
    expect(wordPiece('running', v)).toEqual([id('run'), id('##ning')]);
    expect(wordPiece('zebra', v)).toEqual([v.unk]);
    expect(wordPiece('x'.repeat(101), v)).toEqual([v.unk]);
  });

  it('puts [CLS] first and [SEP] last, and keeps to the length', () => {
    expect(encode('Hello, world!', v)).toEqual([v.cls, id('hello'), id(','), id('world'), id('!'), v.sep]);
    expect(encode('', v)).toEqual([v.cls, v.sep]);
    const long = encode('hello '.repeat(300), v, 10);
    expect(long).toHaveLength(10);
    expect(long.at(-1)).toBe(v.sep);
  });
});
