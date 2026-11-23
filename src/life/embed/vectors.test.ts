// The arithmetic of search by meaning.

import { describe, expect, it } from 'vitest';
import { closeness, fingerprint, meanPool, normalize, quantize, rank, textOf, worthReading } from './vectors';

const unit = (...xs: number[]) => normalize(Float32Array.from(xs));

describe('vectors', () => {
  it('averages over the real words only, then scales to length 1', () => {
    // Two texts, three words each, two numbers a word. The second text's last word is padding.
    const hidden = Float32Array.from([1, 0, 3, 0, 2, 0, 0, 1, 0, 3, 100, 100]);
    const [a, b] = meanPool(hidden, [[1, 1, 1], [1, 1, 0]], 3, 2);
    expect([...a]).toEqual([1, 0]);
    expect(b[0]).toBe(0);
    expect(b[1]).toBeCloseTo(1);
  });

  it('keeps one byte a number and still measures closeness like a cosine', () => {
    const a = unit(1, 2, 3);
    const b = unit(1, 2, 2.5);
    const exact = a.reduce((s, x, i) => s + x * b[i], 0);
    expect(closeness(quantize(a), quantize(b))).toBeCloseTo(exact, 1);
    expect(closeness(quantize(a), quantize(a))).toBeGreaterThan(0.98);
    expect(closeness(quantize(unit(1, 0)), quantize(unit(0, 1)))).toBe(0);
  });

  it('ranks the closest first, within the time asked, and leaves out the far ones', () => {
    const q = quantize(unit(1, 0));
    const items = [
      { id: 'far', at: 10, q: quantize(unit(0, 1)) },
      { id: 'close', at: 20, q: quantize(unit(0.9, 0.1)) },
      { id: 'closest', at: 30, q: quantize(unit(1, 0.01)) },
      { id: 'old', at: 1, q: quantize(unit(1, 0)) },
    ];
    // (Equally close: the newer first.)
    expect(rank(q, items).map((x) => x.id)).toEqual(['closest', 'old', 'close']);
    expect(rank(q, items, { from: 5 }).map((x) => x.id)).toEqual(['closest', 'close']);
    expect(rank(q, items, { from: 5, limit: 1 }).map((x) => x.id)).toEqual(['closest']);
    expect(rank(q, items, { min: 0.999 }).map((x) => x.id)).toEqual(['closest', 'old']);
  });

  it("reads an event's title and details, and only text worth reading", () => {
    expect(textOf({ title: 'Run', detail: 'Easy  5 km\nin the park' })).toBe('Run. Easy 5 km in the park');
    expect(textOf({ title: 'x'.repeat(500) })).toHaveLength(400);
    expect(worthReading('Run')).toBe(true);
    expect(worthReading('12:30 !')).toBe(false);
  });

  it('fingerprints text the same way each time', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
  });
});
