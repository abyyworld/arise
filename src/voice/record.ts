// Recording a voice note with the microphone (MediaRecorder), and turning the recording into the
// sound the voice model reads: one channel, 16,000 samples a second. All on this device.

import { RATE } from './mel';

export const MAX_SECONDS = 120; // a voice note stops by itself after two minutes

export interface Recording {
  stop(): Promise<Blob>; // the recording (WebM or MP4 audio, whichever the browser makes)
  cancel(): void;
  seconds(): number;
}

// The kind of file to record, the first this browser can make.
export function pickType(can: (t: string) => boolean): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    try {
      if (can(t)) return t;
    } catch {}
  }
  return '';
}

export class MicError extends Error {
  constructor(
    readonly code: 'denied' | 'none' | 'other',
    message: string,
  ) {
    super(message);
  }
}

export async function startRecording(): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied', "Arise can't use the microphone. Allow it in your browser's settings (on iPhone: Settings, Arise, Microphone), then try again.");
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('none', 'No microphone was found on this device.');
    throw new MicError('other', `The microphone couldn't start (${(err as Error)?.message || 'no answer'}).`);
  }
  const type = pickType((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const parts: Blob[] = [];
  const began = Date.now();
  rec.ondataavailable = (e) => {
    if (e.data?.size) parts.push(e.data);
  };
  const off = () => stream.getTracks().forEach((t) => t.stop());
  rec.start(1000);
  return {
    seconds: () => (Date.now() - began) / 1000,
    cancel() {
      rec.onstop = null;
      try {
        rec.stop();
      } catch {}
      off();
    },
    stop() {
      return new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          off();
          resolve(new Blob(parts, { type: (rec.mimeType || type || 'audio/webm').split(';')[0] }));
        };
        try {
          rec.stop();
        } catch {
          off();
          resolve(new Blob(parts, { type: (type || 'audio/webm').split(';')[0] }));
        }
      });
    },
  };
}

// ---------- the recording as the model's sound

// Channels to one, by their average.
export function mixdown(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}

// From one sample rate to another. Going down, each new sample is the average of the old ones it
// covers (so high sounds don't fold back in as noise); going up, a straight line between them.
export function resample(input: Float32Array, from: number, to = RATE): Float32Array {
  if (from === to || !input.length) return input;
  const n = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    if (step > 1) {
      const a = Math.floor(i * step);
      const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * step)));
      let s = 0;
      for (let j = a; j < b; j++) s += input[j];
      out[i] = s / (b - a);
    } else {
      const x = i * step;
      const a = Math.floor(x);
      const b = Math.min(input.length - 1, a + 1);
      out[i] = input[a] + (input[b] - input[a]) * (x - a);
    }
  }
  return out;
}

type Ctx = { decodeAudioData(b: ArrayBuffer): Promise<AudioBuffer>; close?: () => Promise<void> };

// The recording as 16 kHz mono sound. The browser decodes it; an OfflineAudioContext at 16 kHz
// resamples it too, and where that rate isn't allowed (older Safari), Arise resamples it itself.
export async function toSamples(blob: Blob, g: typeof globalThis = globalThis): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const W = g as unknown as { OfflineAudioContext?: new (c: number, n: number, r: number) => Ctx; AudioContext?: new () => Ctx; webkitAudioContext?: new () => Ctx };
  let buf: AudioBuffer | null = null;
  if (W.OfflineAudioContext) {
    try {
      buf = await new W.OfflineAudioContext(1, RATE, RATE).decodeAudioData(bytes.slice(0));
    } catch {
      buf = null;
    }
  }
  if (!buf) {
    const C = W.AudioContext || W.webkitAudioContext;
    if (!C) throw new Error("This browser can't read the recording.");
    const ctx = new C();
    try {
      buf = await ctx.decodeAudioData(bytes.slice(0));
    } finally {
      void ctx.close?.().catch(() => {});
    }
  }
  const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf!.getChannelData(i));
  return resample(mixdown(channels), buf.sampleRate, RATE);
}
