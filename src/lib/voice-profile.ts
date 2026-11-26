// How someone writes, from their own messages (Write it my way): worked out on the device, shown
// to them, and handed to the AI with their sample. Samples are separated by blank lines; the
// newest are kept when it gets long. An edit they make to a draft and copy becomes a new sample,
// so the next draft sounds more like them.

export const MAX_VOICE = 3000;
export const GOOD_SAMPLES = 15;

export const samplesOf = (voice: string) =>
  voice
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

// One more sample, newest last, trimmed from the oldest to fit.
export function addSample(voice: string, sample: string, max = MAX_VOICE): string {
  const all = [...samplesOf(voice), sample.trim()].filter(Boolean);
  while (all.length > 1 && all.join('\n\n').length > max) all.shift();
  return all.join('\n\n').slice(-max);
}

export interface Traits {
  samples: number;
  avgWords: number; // per sentence
  lowercaseStart: boolean; // most sentences start lower case
  emoji: boolean;
  exclaims: boolean;
  phrases: string[]; // the person's own repeated bits ("no worries", "cheers")
  signoff: string; // how they tend to end ("cheers", "thanks")
}

const STOP = new Set(['the', 'a', 'an', 'to', 'and', 'of', 'in', 'it', 'is', 'i', 'you', 'on', 'for', 'that', 'be', 'at', 'my', 'me', 'we', 'so', 'do', 'this', 'with', 'are', 'was']);

export function traits(voice: string): Traits {
  const samples = samplesOf(voice);
  const sentences = samples.flatMap((s) => s.split(/(?<=[.!?])\s+|\n+/)).map((s) => s.trim()).filter((s) => /[a-z]/i.test(s));
  const words = (s: string) => s.split(/\s+/).filter(Boolean);
  const avgWords = sentences.length ? Math.round((sentences.reduce((a, s) => a + words(s).length, 0) / sentences.length) * 10) / 10 : 0;
  const lower = sentences.filter((s) => /^[a-z]/.test(s)).length;
  const counts = new Map<string, number>();
  for (const s of samples) {
    const w = s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    for (let i = 0; i < w.length - 1; i++) {
      if (STOP.has(w[i]) && STOP.has(w[i + 1])) continue;
      const p = `${w[i]} ${w[i + 1]}`;
      if (seen.has(p)) continue;
      seen.add(p);
      counts.set(p, (counts.get(p) || 0) + 1);
    }
  }
  const phrases = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([p]) => p);
  const ends = samples.map((s) => s.split(/\n/).pop()!.trim().toLowerCase().replace(/[^\p{L}\s]/gu, '').trim()).filter((e) => e && e.split(' ').length <= 3);
  const endCount = new Map<string, number>();
  for (const e of ends) endCount.set(e, (endCount.get(e) || 0) + 1);
  const top = [...endCount.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    samples: samples.length,
    avgWords,
    lowercaseStart: sentences.length >= 3 && lower / sentences.length > 0.6,
    emoji: /\p{Extended_Pictographic}/u.test(voice),
    exclaims: (voice.match(/!/g) || []).length >= Math.max(2, samples.length / 2),
    phrases,
    signoff: top && top[1] >= 2 ? top[0] : '',
  };
}

// In plain words, for the person and for the AI.
export function traitsText(t: Traits): string[] {
  if (!t.samples) return [];
  const out = [`${t.avgWords <= 8 ? 'Short' : t.avgWords <= 16 ? 'Medium' : 'Long'} sentences, about ${Math.round(t.avgWords)} words.`];
  if (t.lowercaseStart) out.push('Often starts sentences in lower case.');
  out.push(t.emoji ? 'Uses emoji.' : 'No emoji.');
  if (t.exclaims) out.push('Uses exclamation marks.');
  if (t.phrases.length) out.push(`Says things like ${t.phrases.map((p) => `"${p}"`).join(', ')}.`);
  if (t.signoff) out.push(`Often ends with "${t.signoff}".`);
  return out;
}
