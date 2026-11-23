// The arithmetic of search by meaning, kept apart so it's tested on its own: what the model gives
// becomes one vector per text (the average over its words, scaled to length 1), kept small
// (one byte a number), and two texts are as close as their vectors' dot product.

import type { LifeEvent } from '../types';

export const DIM = 384; // the model's numbers per text

// The model's output for a batch ([texts][words][DIM], flat) and which words were real (1) or
// padding (0): one vector per text, of length 1.
export function meanPool(hidden: Float32Array, mask: readonly (readonly number[])[], seq: number, dim = DIM): Float32Array[] {
  return mask.map((m, b) => {
    const v = new Float32Array(dim);
    let n = 0;
    for (let t = 0; t < seq; t++) {
      if (!m[t]) continue;
      n++;
      const base = (b * seq + t) * dim;
      for (let d = 0; d < dim; d++) v[d] += hidden[base + d];
    }
    if (n) for (let d = 0; d < dim; d++) v[d] /= n;
    return normalize(v);
  });
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const len = Math.sqrt(s);
  if (len > 0) for (let i = 0; i < v.length; i++) v[i] /= len;
  return v;
}

// One byte a number: a unit vector's numbers are between -1 and 1.
export function quantize(v: Float32Array): Int8Array {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)));
  return q;
}

// How close two texts are, from -1 to 1 (about their cosine).
export function closeness(a: Int8Array, b: Int8Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s / (127 * 127);
}

export interface Item {
  id: string;
  at: number;
  q: Int8Array;
}

// The items closest to the question, at least `min` close, within [from, to), closest first.
export function rank(query: Int8Array, items: Iterable<Item>, { limit = 30, min = 0.3, from = -Infinity, to = Infinity } = {}): { id: string; score: number }[] {
  const out: { id: string; score: number; at: number }[] = [];
  for (const it of items) {
    if (it.at < from || it.at >= to) continue;
    const score = closeness(query, it.q);
    if (score >= min) out.push({ id: it.id, score, at: it.at });
  }
  out.sort((a, b) => b.score - a.score || b.at - a.at);
  return out.slice(0, limit).map(({ id, score }) => ({ id, score }));
}

// The text of an event the model reads: its title and details, short.
export function textOf(e: Pick<LifeEvent, 'title' | 'detail'>): string {
  const t = `${e.title || ''}${e.detail ? `. ${e.detail}` : ''}`.replace(/\s+/g, ' ').trim();
  return t.length > 400 ? t.slice(0, 400) : t;
}
export const worthReading = (text: string) => (text.match(/\p{L}/gu) || []).length >= 3;

// A short fingerprint of a text, to tell when an event's words changed (FNV-1a, 32 bits).
export function fingerprint(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
