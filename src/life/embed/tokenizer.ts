// Words to the numbers the search model reads: the tokenizer the model was trained with (BERT's,
// lower case, "WordPiece"), written out here so nothing else has to be downloaded or bundled.
// The model's own list of word pieces (vocab.txt, one per line) comes with the model.
//
//   1. Clean: drop control characters, lower case, take accents off (é is e).
//   2. Split on spaces, and around every punctuation mark and Chinese, Japanese or Korean character.
//   3. Each word into the longest pieces the list has, left to right: "running" is "running",
//      "unwinding" may be "un", "##wind", "##ing". A word that can't be cut that way is [UNK].
//   4. [CLS] first, [SEP] last, at most `max` in all.

export interface Vocab {
  ids: Map<string, number>;
  unk: number;
  cls: number;
  sep: number;
  pad: number;
}

export function parseVocab(text: string): Vocab {
  const ids = new Map<string, number>();
  text.split(/\r?\n/).forEach((t, i) => {
    if (t && !ids.has(t)) ids.set(t, i);
  });
  const need = (t: string) => {
    const id = ids.get(t);
    if (id === undefined) throw new Error(`The model's word list has no ${t}.`);
    return id;
  };
  return { ids, unk: need('[UNK]'), cls: need('[CLS]'), sep: need('[SEP]'), pad: need('[PAD]') };
}

const isControl = (c: string) => /[\p{Cc}\p{Cf}]/u.test(c) && !/[\t\n\r]/.test(c);
const isSpace = (c: string) => /\s/u.test(c);
// BERT counts every ASCII sign that isn't a letter or digit as punctuation, and Unicode's P*.
const isPunct = (c: string) => {
  const n = c.codePointAt(0)!;
  return (n >= 33 && n <= 47) || (n >= 58 && n <= 64) || (n >= 91 && n <= 96) || (n >= 123 && n <= 126) || /\p{P}/u.test(c);
};
const isCJK = (n: number) =>
  (n >= 0x4e00 && n <= 0x9fff) || (n >= 0x3400 && n <= 0x4dbf) || (n >= 0x20000 && n <= 0x2a6df) || (n >= 0x2a700 && n <= 0x2b73f) || (n >= 0x2b740 && n <= 0x2b81f) || (n >= 0x2b820 && n <= 0x2ceaf) || (n >= 0xf900 && n <= 0xfaff) || (n >= 0x2f800 && n <= 0x2fa1f);

// Steps 1 and 2: the words.
export function basicTokens(text: string): string[] {
  let clean = '';
  for (const c of text) {
    const n = c.codePointAt(0)!;
    if (n === 0 || n === 0xfffd || isControl(c)) continue;
    if (isCJK(n)) clean += ` ${c} `;
    else clean += isSpace(c) ? ' ' : c;
  }
  const out: string[] = [];
  for (const raw of clean.split(' ')) {
    if (!raw) continue;
    const w = raw
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Mn}/gu, '');
    let cur = '';
    for (const c of w) {
      if (isPunct(c)) {
        if (cur) out.push(cur);
        out.push(c);
        cur = '';
      } else cur += c;
    }
    if (cur) out.push(cur);
  }
  return out;
}

// Step 3: one word into pieces.
export function wordPiece(word: string, v: Vocab, maxChars = 100): number[] {
  const chars = [...word];
  if (chars.length > maxChars) return [v.unk];
  const out: number[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let found = -1;
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
      const id = v.ids.get(piece);
      if (id !== undefined) {
        found = id;
        break;
      }
      end--;
    }
    if (found < 0) return [v.unk];
    out.push(found);
    start = end;
  }
  return out;
}

// Step 4: a text as the model reads it.
export function encode(text: string, v: Vocab, max = 128): number[] {
  const ids: number[] = [v.cls];
  for (const w of basicTokens(text)) {
    for (const id of wordPiece(w, v)) {
      if (ids.length >= max - 1) break;
      ids.push(id);
    }
    if (ids.length >= max - 1) break;
  }
  ids.push(v.sep);
  return ids;
}
