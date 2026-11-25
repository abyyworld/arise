// How the voice model hears: the log-mel spectrogram, checked on known tones.

import { describe, expect, it } from 'vitest';
import { CHUNK, FRAMES, hzToMel, isQuiet, logMel, melBands, melToHz, N_MELS, pieces, RATE } from './mel';

const tone = (hz: number, seconds: number, amp = 0.5) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE));
const column = (mel: Float32Array, t: number) => Array.from({ length: N_MELS }, (_, m) => mel[m * FRAMES + t]);
const loudest = (xs: number[]) => xs.indexOf(Math.max(...xs));
const top = (xs: Float32Array) => xs.reduce((a, b) => (b > a ? b : a), -Infinity);
const nearestBand = (hz: number) => {
  const bands = melBands();
  return loudest(bands.map((b) => -Math.abs(b.center - hz)));
};

describe('the mel scale', () => {
  it("is Slaney's: straight to 1 kHz, then by ratio, and goes both ways", () => {
    expect(hzToMel(1000)).toBeCloseTo(15, 6);
    expect(hzToMel(500)).toBeCloseTo(7.5, 6);
    expect(hzToMel(6400)).toBeCloseTo(42, 6); // 27 steps per ratio of 6.4
    for (const hz of [0, 120, 999, 1000, 3000, 8000]) expect(melToHz(hzToMel(hz))).toBeCloseTo(hz, 3);
  });

  it("matches Whisper's own filters (whisper/assets/mel_filters.npz, mel_80)", () => {
    const bands = melBands();
    const want: [number, number, number[]][] = [
      [0, 1, [0.02486259]],
      [1, 1, [0.001990822, 0.02287177]],
      [10, 10, [0.01990822, 0.004954375]],
      [40, 42, [0.005411105, 0.01473557, 0.00651819]],
      [79, 186, [0.0003667417, 0.00083307, 0.001299398, 0.001765727, 0.002232055, 0.002698383, 0.003164712, 0.003141313, 0.002692554, 0.002243795, 0.001795036, 0.001346277, 0.000897518, 0.000448759]],
    ];
    for (const [m, from, w] of want) {
      expect(bands[m].from).toBe(from);
      expect(bands[m].w).toHaveLength(w.length);
      w.forEach((x, i) => expect(bands[m].w[i]).toBeCloseTo(x, 7));
    }
  });

  it('makes 80 bands from 0 to 8 kHz, in order, each a triangle of the same area', () => {
    const bands = melBands();
    expect(bands).toHaveLength(80);
    for (let m = 1; m < 80; m++) expect(bands[m].center).toBeGreaterThan(bands[m - 1].center);
    expect(bands[79].center).toBeLessThan(8000);
    // Slaney's normalising: the weights times the bin width (40 Hz) come to about one per band.
    for (const m of [10, 40, 70]) {
      const area = bands[m].w.reduce((a, b) => a + b, 0) * 40;
      expect(area).toBeGreaterThan(0.85);
      expect(area).toBeLessThan(1.15);
    }
  });
});

describe('the spectrogram', () => {
  it("is 80 rows of 3000, Whisper's 30 seconds", () => {
    expect(logMel(new Float32Array(10)).length).toBe(N_MELS * FRAMES);
    expect(FRAMES).toBe(3000);
  });

  it('puts a tone in the band around its pitch', () => {
    for (const hz of [300, 1000, 3000]) {
      const mel = logMel(tone(hz, 1));
      expect(loudest(column(mel, 50))).toBe(nearestBand(hz));
    }
  });

  it('is louder where the sound is, and silence after it sits 8 below the loudest', () => {
    const mel = logMel(tone(1000, 1));
    const most = top(mel);
    const band = nearestBand(1000);
    expect(mel[band * FRAMES + 50]).toBeCloseTo(most, 5);
    // After the tone (and its last frame): the floor, (top - 8 + 4) / 4 in Whisper's terms.
    const floor = most - 2;
    for (const t of [120, 1500, 2999]) for (const m of [0, band, 79]) expect(mel[m * FRAMES + t]).toBeCloseTo(floor, 5);
    // Nothing is below the floor.
    expect(Math.min(...column(mel, 50))).toBeGreaterThanOrEqual(floor - 1e-6);
  });

  it('cuts sound longer than 30 seconds', () => {
    const long = new Float32Array(CHUNK + RATE).fill(0);
    long.set(tone(1000, 1), CHUNK); // only after the 30 seconds
    const mel = logMel(long);
    expect(new Set(mel).size).toBe(1); // all silence
  });
});

describe('pieces and silence', () => {
  it('cuts long sound into 30-second pieces, leaving out a tiny last one', () => {
    expect(pieces(new Float32Array(CHUNK * 2 + RATE)).map((p) => p.length)).toEqual([CHUNK, CHUNK, RATE]);
    expect(pieces(new Float32Array(CHUNK + 100)).map((p) => p.length)).toEqual([CHUNK]);
    expect(pieces(new Float32Array(500)).map((p) => p.length)).toEqual([500]);
  });

  it('knows a quiet room from someone talking', () => {
    expect(isQuiet(new Float32Array(RATE))).toBe(true);
    expect(isQuiet(tone(200, 1, 0.001))).toBe(true);
    expect(isQuiet(tone(200, 1, 0.1))).toBe(false);
  });
});
