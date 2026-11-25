// How the voice model hears: sound turned into a log-mel spectrogram, the picture of a sound that
// Whisper was trained on. 80 bands of pitch, one column every 10 ms, 30 seconds at a time, worked
// out the way Whisper's own code does it:
//
//   16,000 samples a second; frames of 400 samples (25 ms) with a Hann window, 160 apart (10 ms);
//   the edges padded by reflection; the power at each of 201 frequencies; 80 mel bands (the
//   Slaney mel scale with Slaney's area normalising, as librosa makes them); log10; anything more
//   than 8 below the loudest raised to that; then (x + 4) / 4.
//
// Pure: no browser needed, so it's tested on a known tone (mel.test.ts).

export const RATE = 16000; // samples a second
export const N_FFT = 400; // samples in a frame
export const HOP = 160; // samples between frames
export const N_MELS = 80;
export const CHUNK = 30 * RATE; // Whisper reads 30 seconds at a time
export const FRAMES = CHUNK / HOP; // 3000 columns
const BINS = N_FFT / 2 + 1; // 201 frequencies

// ---------- the mel scale (Slaney's: straight up to 1 kHz, then by ratio)

const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOGSTEP = Math.log(6.4) / 27;
export const hzToMel = (hz: number) => (hz >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOGSTEP : hz / F_SP);
export const melToHz = (m: number) => (m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOGSTEP * (m - MIN_LOG_MEL)) : F_SP * m);

export interface Band {
  from: number; // first frequency bin with any weight
  w: Float32Array; // the weights from there on
  center: number; // the band's middle, in Hz
}

// The 80 triangle filters, each kept only where it isn't zero.
export function melBands(nMels = N_MELS, nFft = N_FFT, rate = RATE): Band[] {
  const bins = nFft / 2 + 1;
  const lo = hzToMel(0);
  const hi = hzToMel(rate / 2);
  const pts = Array.from({ length: nMels + 2 }, (_, i) => melToHz(lo + (i * (hi - lo)) / (nMels + 1)));
  const bands: Band[] = [];
  for (let m = 0; m < nMels; m++) {
    const norm = 2 / (pts[m + 2] - pts[m]);
    const row: number[] = [];
    let from = -1;
    for (let k = 0; k < bins; k++) {
      const f = (k * rate) / nFft;
      const up = (f - pts[m]) / (pts[m + 1] - pts[m]);
      const down = (pts[m + 2] - f) / (pts[m + 2] - pts[m + 1]);
      const v = Math.max(0, Math.min(up, down)) * norm;
      if (v > 0) {
        if (from < 0) from = k;
        row[k - from] = v;
      } else if (from >= 0) break;
    }
    bands.push({ from: Math.max(0, from), w: Float32Array.from(row, (x) => x || 0), center: pts[m + 1] });
  }
  return bands;
}

// ---------- the spectrogram

let tables: { cos: Float32Array; sin: Float32Array; hann: Float32Array; bands: Band[] } | null = null;
function made() {
  if (tables) return tables;
  const cos = new Float32Array(N_FFT);
  const sin = new Float32Array(N_FFT);
  const hann = new Float32Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) {
    cos[n] = Math.cos((2 * Math.PI * n) / N_FFT);
    sin[n] = Math.sin((2 * Math.PI * n) / N_FFT);
    hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT); // periodic, as torch.hann_window
  }
  tables = { cos, sin, hann, bands: melBands() };
  return tables;
}

// Up to 30 seconds of 16 kHz sound (shorter is padded with silence, longer is cut) in, Whisper's
// input out: 80 rows of 3000 numbers, row after row.
export function logMel(audio: Float32Array): Float32Array {
  const { cos, sin, hann, bands } = made();
  const x = new Float32Array(CHUNK);
  x.set(audio.length > CHUNK ? audio.subarray(0, CHUNK) : audio);
  const pad = N_FFT / 2;
  // The sample at i in the padded sound: mirrored at both ends (as numpy's "reflect").
  const at = (i: number) => {
    let j = i - pad;
    if (j < 0) j = -j;
    else if (j >= CHUNK) j = 2 * (CHUNK - 1) - j;
    return x[j];
  };
  const out = new Float32Array(N_MELS * FRAMES);
  const frame = new Float32Array(N_FFT);
  const power = new Float32Array(BINS);
  for (let t = 0; t < FRAMES; t++) {
    let any = false;
    for (let n = 0; n < N_FFT; n++) {
      const v = at(t * HOP + n) * hann[n];
      frame[n] = v;
      if (v !== 0) any = true;
    }
    if (!any) continue; // silence (the padding after the words): every band stays at zero
    // The power at each frequency (a plain DFT: 400 isn't a power of two, and this is clear).
    for (let k = 0; k < BINS; k++) {
      let re = 0;
      let im = 0;
      let idx = 0;
      for (let n = 0; n < N_FFT; n++) {
        re += frame[n] * cos[idx];
        im -= frame[n] * sin[idx];
        idx += k;
        if (idx >= N_FFT) idx -= N_FFT;
      }
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < N_MELS; m++) {
      const b = bands[m];
      let s = 0;
      for (let i = 0; i < b.w.length; i++) s += b.w[i] * power[b.from + i];
      out[m * FRAMES + t] = s;
    }
  }
  let top = -Infinity;
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.log10(Math.max(out[i], 1e-10));
    if (out[i] > top) top = out[i];
  }
  const floor = top - 8;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4) / 4;
  return out;
}

// Longer sound in 30-second pieces (the last may be shorter). A last piece under half a second is
// left out: too short to hold a word, and Whisper tends to make one up.
export function pieces(audio: Float32Array): Float32Array[] {
  const out: Float32Array[] = [];
  for (let at = 0; at < audio.length; at += CHUNK) out.push(audio.subarray(at, Math.min(audio.length, at + CHUNK)));
  if (out.length > 1 && out[out.length - 1].length < RATE / 2) out.pop();
  return out;
}

// Nearly silent (the room, no words): not read at all, since Whisper makes up words for silence.
export function isQuiet(audio: Float32Array, floor = 0.004): boolean {
  if (!audio.length) return true;
  let s = 0;
  for (let i = 0; i < audio.length; i++) s += audio[i] * audio[i];
  return Math.sqrt(s / audio.length) < floor;
}
