// Whisper's words: the numbers the voice model writes, turned back into text. Whisper uses GPT-2's
// way of cutting text: every piece is a run of bytes, each byte shown as one printable character
// (a space is "Ġ", a new line "Ċ"). So a piece is looked up in the word list (vocab.json), its
// characters turned back into bytes, and the bytes read as UTF-8. That is all decoding needs: no
// merges, since Arise never turns text into pieces here.
//
// The special pieces (where a text starts and ends, which language, transcribe, no timestamps)
// come from the model's own list (added_tokens.json), so nothing about them is guessed.

export interface Words {
  pieces: string[]; // the piece for each number ('' where there's none)
  eot: number; // <|endoftext|>: the end
  sot: number; // <|startoftranscript|>
  transcribe: number;
  noTimestamps: number;
  languages: Map<string, number>; // 'en' -> <|en|>
}

// GPT-2's bytes_to_unicode: the printable character that stands for each byte.
export function byteChars(): string[] {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (bs.includes(b)) continue;
    bs.push(b);
    cs.push(256 + n++);
  }
  const out: string[] = new Array(256);
  bs.forEach((b, i) => (out[b] = String.fromCharCode(cs[i])));
  return out;
}
const BYTE_OF = new Map(byteChars().map((c, b) => [c, b]));

// A piece of text as GPT-2 writes it (for tests, and to read a piece's bytes the other way).
export const asPiece = (text: string) => {
  const chars = byteChars();
  return [...new TextEncoder().encode(text)].map((b) => chars[b]).join('');
};

const need = (m: Map<string, number>, k: string) => {
  const v = m.get(k);
  if (v === undefined) throw new Error(`The voice model's word list has no ${k}.`);
  return v;
};

// The word list and the special pieces, from the model's two files (JSON text).
export function parseWords(vocabJson: string, addedJson: string): Words {
  const all = new Map<string, number>();
  for (const src of [vocabJson, addedJson]) {
    const o = JSON.parse(src) as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000) all.set(k, v);
  }
  const size = Math.max(...all.values()) + 1;
  const pieces: string[] = new Array(size).fill('');
  const languages = new Map<string, number>();
  for (const [k, v] of all) {
    pieces[v] = k;
    const lang = /^<\|([a-z]{2,3})\|>$/.exec(k);
    if (lang && v > (all.get('<|startoftranscript|>') ?? Infinity)) languages.set(lang[1], v);
  }
  return {
    pieces,
    eot: need(all, '<|endoftext|>'),
    sot: need(all, '<|startoftranscript|>'),
    transcribe: need(all, '<|transcribe|>'),
    noTimestamps: need(all, '<|notimestamps|>'),
    languages,
  };
}

// The numbers the model wrote, as text. Special pieces (anything from <|endoftext|> on) are left out.
export function decode(ids: readonly number[], words: Words): string {
  const bytes: number[] = [];
  for (const id of ids) {
    if (id >= words.eot) continue;
    for (const c of words.pieces[id] || '') {
      const b = BYTE_OF.get(c);
      if (b !== undefined) bytes.push(b);
    }
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes)).replace(/\s+/g, ' ').trim();
}

// Pieces Whisper is told never to write (its generation_config.json, for the multilingual
// models): odd marks like music notes and brackets that it makes up for noise.
export const SUPPRESS: readonly number[] = [
  1, 2, 7, 8, 9, 10, 14, 25, 26, 27, 28, 29, 31, 58, 59, 60, 61, 62, 63, 90, 91, 92, 93, 359, 503, 522, 542, 873, 893, 902, 918, 922, 931, 1350, 1853, 1982, 2460, 2627, 3246, 3253, 3268, 3536, 3846, 3961, 4183, 4667, 6585, 6647, 7273, 9061, 9383, 10428, 10929, 11938, 12033, 12331, 12562, 13793, 14157, 14635, 15265, 15618, 16553, 16604, 18362, 18956, 20075, 21675, 22520,
  26130, 26161, 26435, 28279, 29464, 31650, 32302, 32470, 36865, 42863, 47425, 49870, 50254,
];
export const SPACE = 220; // " " on its own: never the first piece

// The languages offered in Settings (Whisper knows 99; with Auto it can hear any of them).
export const LANGUAGE_NAMES: readonly [string, string][] = [
  ['en', 'English'],
  ['uz', 'Uzbek'],
  ['ru', 'Russian'],
  ['tr', 'Turkish'],
  ['kk', 'Kazakh'],
  ['tg', 'Tajik'],
  ['uk', 'Ukrainian'],
  ['ar', 'Arabic'],
  ['fa', 'Persian'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
  ['hi', 'Hindi'],
  ['ur', 'Urdu'],
  ['zh', 'Chinese'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['id', 'Indonesian'],
];
