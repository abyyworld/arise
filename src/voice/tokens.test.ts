// Whisper's words: numbers back to text, in English, Russian and Uzbek.

import { describe, expect, it } from 'vitest';
import { asPiece, byteChars, decode, parseWords } from './tokens';

// A small word list in Whisper's own shape: vocab.json (pieces up to <|endoftext|>) and
// added_tokens.json (the special pieces after it).
const pieces = ['Hello', ',', ' world', '!', ' Привет', ' мир', ' Men', ' bugun', ' o', "'", 'qidim', ' ', 'é'].map(asPiece);
const vocab = Object.fromEntries([...pieces.map((p, i) => [p, i]), ['<|endoftext|>', pieces.length]]);
const EOT = pieces.length;
const added = { '<|startoftranscript|>': EOT + 1, '<|en|>': EOT + 2, '<|ru|>': EOT + 3, '<|uz|>': EOT + 4, '<|translate|>': EOT + 5, '<|transcribe|>': EOT + 6, '<|notimestamps|>': EOT + 7 };
const words = parseWords(JSON.stringify(vocab), JSON.stringify(added));

describe('the byte characters', () => {
  it("are GPT-2's: a space is Ġ, a new line Ċ, letters stay letters", () => {
    const c = byteChars();
    expect(c[32]).toBe('Ġ');
    expect(c[10]).toBe('Ċ');
    expect(c[65]).toBe('A');
    expect(new Set(c).size).toBe(256);
    expect(asPiece(' Привет')).toBe('ĠÐŁÑĢÐ¸Ð²ÐµÑĤ');
  });
});

describe('the word list', () => {
  it('finds the special pieces and the languages', () => {
    expect(words.eot).toBe(EOT);
    expect(words.sot).toBe(EOT + 1);
    expect(words.transcribe).toBe(EOT + 6);
    expect(words.noTimestamps).toBe(EOT + 7);
    expect([...words.languages]).toEqual([
      ['en', EOT + 2],
      ['ru', EOT + 3],
      ['uz', EOT + 4],
    ]);
  });

  it("says so when one it needs isn't there", () => {
    expect(() => parseWords(JSON.stringify(vocab), '{}')).toThrow(/startoftranscript/);
  });
});

describe('decoding', () => {
  it('turns numbers into text', () => {
    expect(decode([0, 1, 2, 3], words)).toBe('Hello, world!');
  });
  it('reads Russian and Uzbek, whose letters are several bytes', () => {
    expect(decode([4, 5], words)).toBe('Привет мир');
    expect(decode([6, 7, 8, 9, 10], words)).toBe("Men bugun o'qidim");
  });
  it('leaves out the special pieces, and tidies the spaces', () => {
    expect(decode([EOT + 1, EOT + 2, EOT + 7, 11, 0, 11, 11, 2, EOT], words)).toBe('Hello world');
  });
  it('joins a letter cut across two pieces', () => {
    // "é" is two bytes: as two pieces of one byte each, it still comes out whole.
    const [a, b] = [...asPiece('é')];
    const split = parseWords(JSON.stringify({ [a]: 0, [b]: 1, '<|endoftext|>': 2 }), JSON.stringify({ '<|startoftranscript|>': 3, '<|transcribe|>': 4, '<|notimestamps|>': 5 }));
    expect(decode([0, 1], split)).toBe('é');
  });
});
