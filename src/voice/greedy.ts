// Writing down what was said, one piece at a time: the simplest way Whisper can be read ("greedy":
// always the piece the model likes best). The model itself is behind `next` (the worker runs it);
// this part is pure, so it's tested with a made-up model (greedy.test.ts).
//
// It starts the text the way Whisper expects: start, the language, "transcribe", "no timestamps".
// With the language on Auto, the model's first guess after "start" picks it.

import { SPACE, SUPPRESS, type Words } from './tokens';

// Feeds the model these pieces after the ones fed before, and gives back its scores for what
// comes next (one score for every piece in the word list).
export type Next = (ids: number[]) => Promise<Float32Array>;

export const MAX_PIECES = 200; // Whisper writes at most 224 for 30 seconds; this leaves room

export function argmax(scores: Float32Array, among?: Iterable<number>): number {
  let best = -1;
  let top = -Infinity;
  for (const i of among ?? scores.keys()) {
    if (scores[i] > top) {
      top = scores[i];
      best = i;
    }
  }
  return best;
}

// Takes away what the model may not write next: special pieces (other than the end), the odd marks
// in SUPPRESS, and at the very start, a lone space or ending at once.
export function suppress(scores: Float32Array, words: Words, first: boolean) {
  for (let i = words.eot + 1; i < scores.length; i++) scores[i] = -Infinity;
  for (const i of SUPPRESS) if (i < scores.length) scores[i] = -Infinity;
  if (first) {
    scores[SPACE] = -Infinity;
    scores[words.eot] = -Infinity;
  }
}

// Whisper sometimes gets stuck saying the same thing over and over. When the end of what it wrote
// is one run of pieces said four times, it says where the first one ends; otherwise -1.
export function stuckAt(ids: readonly number[], times = 4, longest = 12): number {
  for (let n = 1; n <= longest; n++) {
    if (ids.length < n * times) break;
    const end = ids.length;
    let same = true;
    for (let r = 1; r < times && same; r++) for (let i = 0; i < n && same; i++) if (ids[end - n + i] !== ids[end - n - r * n + i]) same = false;
    if (same) return end - (times - 1) * n;
  }
  return -1;
}

export interface Heard {
  ids: number[]; // the pieces written (no special ones)
  language: string; // the language it was read as ('en')
}

// `language`: a code ('en', 'uz', 'ru') or 'auto'.
export async function greedy(next: Next, words: Words, { language = 'auto', max = MAX_PIECES }: { language?: string; max?: number } = {}): Promise<Heard> {
  let scores = await next([words.sot]);
  let lang = words.languages.has(language) ? language : '';
  if (!lang) {
    const id = argmax(scores, words.languages.values());
    lang = [...words.languages].find(([, v]) => v === id)?.[0] || 'en';
  }
  for (const id of [words.languages.get(lang)!, words.transcribe, words.noTimestamps]) scores = await next([id]);
  const ids: number[] = [];
  while (ids.length < max) {
    suppress(scores, words, ids.length === 0);
    const id = argmax(scores);
    if (id < 0 || id === words.eot) break;
    ids.push(id);
    const stuck = stuckAt(ids);
    if (stuck >= 0) {
      ids.length = stuck;
      break;
    }
    if (ids.length >= max) break;
    scores = await next([id]);
  }
  return { ids, language: lang };
}
