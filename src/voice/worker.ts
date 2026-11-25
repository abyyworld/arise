// The voice model, run off the page (model.ts starts it). It's handed Whisper's two parts, its word
// list and the engine's WebAssembly, all from this device's own database, so it fetches nothing.
// Sound in (16 kHz, mono), words out.
//
//   1. the sound in 30-second pieces, each as a log-mel spectrogram (mel.ts)
//   2. the listening part (the encoder) reads it once
//   3. the writing part (the decoder) writes one piece of text at a time (greedy.ts), keeping
//      what it worked out so far (its key and value memory) so each step only reads the new piece
//   4. the pieces turned back into text (tokens.ts)

import * as ort from 'onnxruntime-web/wasm';
import { FRAMES, isQuiet, logMel, N_MELS, pieces } from './mel';
import { greedy, type Next } from './greedy';
import { decode, parseWords, type Words } from './tokens';

let encoder: ort.InferenceSession | null = null;
let decoder: ort.InferenceSession | null = null;
let words: Words | null = null;
let heads = 6;

interface Port {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}
const port = self as unknown as Port;

async function init(m: { encoder: ArrayBuffer; decoder: ArrayBuffer; vocab: string; added: string; wasm: ArrayBuffer; heads?: number }) {
  words = parseWords(m.vocab, m.added);
  heads = m.heads || 6;
  ort.env.wasm.wasmBinary = m.wasm;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  encoder = await ort.InferenceSession.create(new Uint8Array(m.encoder), opts);
  decoder = await ort.InferenceSession.create(new Uint8Array(m.decoder), opts);
}

// One piece of up to 30 seconds: what was said, and the language it was heard as.
async function hearPiece(audio: Float32Array, language: string): Promise<{ text: string; language: string }> {
  const enc = encoder!;
  const dec = decoder!;
  const out = await enc.run({ [enc.inputNames[0]]: new ort.Tensor('float32', logMel(audio), [1, N_MELS, FRAMES]) });
  const hidden = out.last_hidden_state ?? out[enc.outputNames[0]];
  const headDim = Number(hidden.dims[2]) / heads;
  const idsName = dec.inputNames.find((n) => n.includes('input_ids')) || 'input_ids';
  const hiddenName = dec.inputNames.find((n) => n.includes('encoder_hidden_states')) || 'encoder_hidden_states';
  const pastNames = dec.inputNames.filter((n) => n.startsWith('past_key_values.'));
  const branch = dec.inputNames.includes('use_cache_branch');
  let past: Record<string, ort.Tensor> | null = null;
  const next: Next = async (ids) => {
    const feeds: Record<string, ort.Tensor> = {
      [idsName]: new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, ids.length]),
      [hiddenName]: hidden,
    };
    if (branch) feeds.use_cache_branch = new ort.Tensor('bool', [past !== null], [1]);
    // The first step has no memory yet: empty, of the right shape.
    for (const n of pastNames) feeds[n] = past?.[n] ?? new ort.Tensor('float32', new Float32Array(0), [1, heads, 0, headDim]);
    const r = await dec.run(feeds);
    const kept: Record<string, ort.Tensor> = {};
    for (const n of pastNames) {
      // The memory of the sound (".encoder.") is made once, on the first step, and kept as it is.
      kept[n] = past && n.includes('.encoder.') ? past[n] : r[n.replace('past_key_values.', 'present.')];
    }
    past = kept;
    const logits = r.logits ?? r[dec.outputNames[0]];
    const [, s, v] = logits.dims.map(Number);
    return (logits.data as Float32Array).slice((s - 1) * v, s * v);
  };
  const heard = await greedy(next, words!, { language });
  return { text: decode(heard.ids, words!), language: heard.language };
}

async function hear(audio: Float32Array, language: string): Promise<{ text: string; language: string }> {
  if (!encoder || !decoder || !words) throw new Error("The voice model isn't ready.");
  const texts: string[] = [];
  let lang = language;
  for (const piece of pieces(audio)) {
    if (isQuiet(piece)) continue;
    const r = await hearPiece(piece, lang);
    // Auto: the language heard in the first piece is kept for the rest.
    lang = r.language;
    if (r.text) texts.push(r.text);
  }
  return { text: texts.join(' ').trim(), language: lang === 'auto' ? '' : lang };
}

port.addEventListener('message', async (e) => {
  const m = e.data as { t: string; id?: number; audio?: Float32Array; language?: string };
  if (m.t === 'init') {
    try {
      await init(e.data);
      port.postMessage({ t: 'ready' });
    } catch (err) {
      port.postMessage({ t: 'error', message: `The voice model couldn't start: ${(err as Error)?.message || 'unknown error'}.` });
    }
  } else if (m.t === 'transcribe') {
    try {
      const r = await hear(m.audio || new Float32Array(0), m.language || 'auto');
      port.postMessage({ t: 'text', id: m.id, text: r.text, language: r.language });
    } catch (err) {
      port.postMessage({ t: 'error', id: m.id, message: (err as Error)?.message || "The voice model couldn't hear that." });
    }
  }
});
