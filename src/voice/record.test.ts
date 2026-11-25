// Turning a recording into the sound the voice model reads.

import { describe, expect, it } from 'vitest';
import { mixdown, pickType, resample } from './record';

describe('the recording', () => {
  it("picks the first kind of file the browser can make (Safari's is MP4)", () => {
    expect(pickType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickType(() => false)).toBe('');
    expect(
      pickType(() => {
        throw new Error('no');
      }),
    ).toBe('');
  });

  it('makes one channel from two', () => {
    expect([...mixdown([Float32Array.from([1, 0, 0.5]), Float32Array.from([0, 1, 0.5])])]).toEqual([0.5, 0.5, 0.5]);
  });

  it('goes from 48 kHz to 16 kHz, keeping a low tone and its length', () => {
    const from = 48000;
    const input = Float32Array.from({ length: from }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / from));
    const out = resample(input, from, 16000);
    expect(out.length).toBe(16000);
    // The same tone, read at the new rate (averaging three samples barely changes a 200 Hz tone).
    for (const i of [100, 5000, 12345]) expect(out[i]).toBeCloseTo(Math.sin((2 * Math.PI * 200 * (i * 3 + 1)) / from), 2);
  });

  it('goes up too, and leaves 16 kHz alone', () => {
    const x = Float32Array.from([0, 1, 0, -1]);
    expect(resample(x, 16000, 16000)).toBe(x);
    expect([...resample(Float32Array.from([0, 1]), 8000, 16000)]).toEqual([0, 0.5, 1, 1]);
  });
});
