// The search model, run off the page (model.ts starts it). It's handed the model, its word list
// and the engine's WebAssembly, all from this device's own database, so it fetches nothing.
// Texts in, one vector per text out (vectors.ts).

import * as ort from 'onnxruntime-web/wasm';
import { encode, parseVocab, type Vocab } from './tokenizer';
import { DIM, meanPool } from './vectors';

const MAX_WORDS = 128; // pieces per text the model reads (it was trained on this many)

let session: ort.InferenceSession | null = null;
let vocab: Vocab | null = null;

interface Port {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}
const port = self as unknown as Port;

async function init(model: ArrayBuffer, words: string, wasm: ArrayBuffer) {
  vocab = parseVocab(words);
  ort.env.wasm.wasmBinary = wasm;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!session || !vocab) throw new Error("The search model isn't ready.");
  const enc = texts.map((t) => encode(t, vocab!, MAX_WORDS));
  const seq = Math.max(...enc.map((e) => e.length));
  const n = enc.length;
  const ids = new BigInt64Array(n * seq);
  const mask = new BigInt64Array(n * seq);
  const masks = enc.map((e) => Array.from({ length: seq }, (_, i) => (i < e.length ? 1 : 0)));
  enc.forEach((e, b) =>
    e.forEach((id, i) => {
      ids[b * seq + i] = BigInt(id);
      mask[b * seq + i] = 1n;
    }),
  );
  for (let b = 0; b < n; b++) for (let i = enc[b].length; i < seq; i++) ids[b * seq + i] = BigInt(vocab.pad);
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor('int64', ids, [n, seq]),
    attention_mask: new ort.Tensor('int64', mask, [n, seq]),
  };
  if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n * seq), [n, seq]);
  const out = await session.run(feeds);
  const hidden = (out.last_hidden_state ?? out[session.outputNames[0]]).data as Float32Array;
  return meanPool(hidden, masks, seq, DIM);
}

port.addEventListener('message', async (e) => {
  const m = e.data as { t: string; id?: number; model?: ArrayBuffer; vocab?: string; wasm?: ArrayBuffer; texts?: string[] };
  if (m.t === 'init') {
    try {
      await init(m.model!, m.vocab!, m.wasm!);
      port.postMessage({ t: 'ready' });
    } catch (err) {
      port.postMessage({ t: 'error', message: `The search model couldn't start: ${(err as Error)?.message || 'unknown error'}.` });
    }
  } else if (m.t === 'embed') {
    try {
      const vecs = await embed(m.texts || []);
      port.postMessage({ t: 'vecs', id: m.id, vecs }, vecs.map((v) => v.buffer as ArrayBuffer));
    } catch (err) {
      port.postMessage({ t: 'error', id: m.id, message: (err as Error)?.message || "The search model couldn't read that." });
    }
  }
});
