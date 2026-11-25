// The voice model on this device: Whisper tiny (OpenAI's speech model, the multilingual one, so
// Uzbek, Russian and English all work), made smaller to 8-bit numbers: the part that listens
// (about 10 MB) and the part that writes (about 31 MB), with its word list (1 MB). It runs with
// the same engine as search by meaning (ONNX Runtime Web, about 15 MB), so when that model is
// already here, its engine is reused and not downloaded again.
//
// Downloaded once, only when the person chooses to, from fixed public addresses pinned to exact
// versions, each checked against its SHA-256 before it's kept (with the same download code as
// search by meaning: fetchOne in life/embed/model.ts). Kept on this device in IndexedDB
// ('arise-voice'), never synced. It runs in a worker (worker.ts), off the page.
//
//   model and word list   Hugging Face, Xenova/whisper-tiny at one fixed commit
//   engine                jsDelivr, the onnxruntime-web package at the version in package.json
//
// What is said never leaves the device: the browser's own speech service is never used (Chrome
// sends that to Google).

import { cleanVoicePrefs, type VoicePrefs } from '../lib/validate';
import * as MEANING from '../life/embed/model';
import { fetchOne, idbDone, idbReq, MeaningError, ORT_VERSION } from '../life/embed/model';

const HF = 'https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1';

export interface Source {
  key: 'encoder' | 'decoder' | 'vocab' | 'added' | 'wasm';
  url: string;
  size: number;
  sha256: string;
}
export const MODEL_ID = 'whisper-tiny-q8-5332fcc';
export const MODEL_NAME = 'Whisper tiny';
export const SOURCES: readonly Source[] = [
  { key: 'encoder', url: `${HF}/onnx/encoder_model_quantized.onnx`, size: 10_124_910, sha256: 'fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e' },
  { key: 'decoder', url: `${HF}/onnx/decoder_model_merged_quantized.onnx`, size: 30_727_765, sha256: '6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0' },
  { key: 'vocab', url: `${HF}/vocab.json`, size: 1_036_584, sha256: '50d6a919f0a0601d56a04eb583c780d18553aa388254ba3158eb6a00f13e2c1a' },
  { key: 'added', url: `${HF}/added_tokens.json`, size: 2_082, sha256: 'ce949fe720c14311cb6c446e69cfe340dc669d7b006077a6feed6ae571dd7e88' },
  // The very same file as search by meaning's engine (life/embed/model.ts).
  { key: 'wasm', url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.wasm`, size: 14_848_852, sha256: '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d' },
];
export const DOWNLOAD_BYTES = SOURCES.reduce((n, s) => n + s.size, 0);
// Whisper tiny's writing part: 6 attention heads (its key and value memory has this shape).
export const HEADS = 6;

const WHAT = 'voice model';

// ---------- the person's choices (on this device only)

const KEY = 'arise-voice';
export function prefs(): VoicePrefs {
  try {
    return cleanVoicePrefs(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return cleanVoicePrefs({});
  }
}
export function setPrefs(p: Partial<VoicePrefs>) {
  const next = cleanVoicePrefs({ ...prefs(), ...p });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  return next;
}

// ---------- whether this device can do it at all

// Recording, an on-device database, WebAssembly, a worker and the checks. Without one of them,
// voice notes can't run here, and Arise says so.
export function canRun(g: typeof globalThis = globalThis): boolean {
  const nav = g.navigator as Navigator | undefined;
  return !!(
    nav?.mediaDevices?.getUserMedia &&
    typeof (g as { MediaRecorder?: unknown }).MediaRecorder === 'function' &&
    typeof (g as { WebAssembly?: unknown }).WebAssembly === 'object' &&
    typeof (g as { Worker?: unknown }).Worker === 'function' &&
    (g as { indexedDB?: unknown }).indexedDB &&
    g.crypto?.subtle &&
    (typeof (g as { OfflineAudioContext?: unknown }).OfflineAudioContext === 'function' || typeof (g as { AudioContext?: unknown }).AudioContext === 'function')
  );
}

// ---------- the database

export const VOICE_DB = 'arise-voice';
let opening: Promise<IDBDatabase> | null = null;
export function openVoiceDB(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) return reject(new MeaningError('unsupported', "This browser can't keep the voice model (it has no on-device database)."));
    const r = idb.open(VOICE_DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files', { keyPath: 'k' });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      db.onclose = () => {
        opening = null;
      };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
  }).catch((err) => {
    opening = null;
    throw err;
  });
  return opening;
}
export function closeVoiceDB() {
  const o = opening;
  opening = null;
  o?.then((db) => db.close()).catch(() => {});
}

async function haveKeys(): Promise<Set<string>> {
  const db = await openVoiceDB();
  return new Set(((await idbReq(db.transaction('files').objectStore('files').getAllKeys())) as IDBValidKey[]).map(String));
}
async function readFile(k: Source['key']): Promise<ArrayBuffer | null> {
  const db = await openVoiceDB();
  const row = (await idbReq(db.transaction('files').objectStore('files').get(`${MODEL_ID}:${k}`))) as { b?: ArrayBuffer } | undefined;
  return row?.b ?? null;
}
async function keep(k: Source['key'], b: ArrayBuffer) {
  const db = await openVoiceDB();
  const tx = db.transaction('files', 'readwrite');
  tx.objectStore('files').put({ k: `${MODEL_ID}:${k}`, b });
  await idbDone(tx);
}

async function sha256(b: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Search by meaning's engine, when it's on this device and exactly the file pinned here.
async function engineFromSearch(src: Source): Promise<ArrayBuffer | null> {
  try {
    if (!MEANING.prefs().on) return null;
    const db = await MEANING.openMeaningDB();
    const row = (await idbReq(db.transaction('files').objectStore('files').get(`${MEANING.MODEL_ID}:wasm`))) as { b?: ArrayBuffer } | undefined;
    const b = row?.b;
    return b && b.byteLength === src.size && (await sha256(b)) === src.sha256 ? b : null;
  } catch {
    return null;
  }
}

// ---------- downloading

export interface Progress {
  got: number;
  total: number;
}

// How much is left to download (the engine counts only when search by meaning doesn't have it).
export async function toDownload(sources: readonly Source[] = SOURCES): Promise<number> {
  let have = new Set<string>();
  try {
    have = await haveKeys();
  } catch {}
  let n = 0;
  for (const s of sources) {
    if (have.has(`${MODEL_ID}:${s.key}`)) continue;
    if (s.key === 'wasm' && (await engineFromSearch(s))) continue;
    n += s.size;
  }
  return n;
}

// Downloads what isn't here yet, checks it, keeps it, and turns voice notes on.
export async function download({ onProgress, signal, fetcher, sources = SOURCES }: { onProgress?: (p: Progress) => void; signal?: AbortSignal; fetcher?: typeof fetch; sources?: readonly Source[] } = {}): Promise<void> {
  const have = await haveKeys();
  // The engine first, from search by meaning if it's here.
  for (const s of sources) {
    if (s.key !== 'wasm' || have.has(`${MODEL_ID}:${s.key}`)) continue;
    const b = await engineFromSearch(s);
    if (b) {
      await keep(s.key, b);
      have.add(`${MODEL_ID}:${s.key}`);
    }
  }
  const left = sources.filter((s) => !have.has(`${MODEL_ID}:${s.key}`));
  const total = left.reduce((n, s) => n + s.size, 0);
  let got = 0;
  onProgress?.({ got, total });
  for (const src of left) {
    const b = await fetchOne(
      src,
      (n) => {
        got += n;
        onProgress?.({ got, total });
      },
      signal,
      fetcher,
      WHAT,
    );
    await keep(src.key, b);
  }
  // An older model's files go.
  const db = await openVoiceDB();
  const tx = db.transaction('files', 'readwrite');
  const store = tx.objectStore('files');
  const keys = store.getAllKeys();
  keys.onsuccess = () => {
    for (const k of keys.result) if (!String(k).startsWith(`${MODEL_ID}:`)) store.delete(k);
  };
  await idbDone(tx);
  setPrefs({ on: true, at: Date.now() });
}

// Whether all of it is here.
export async function downloaded(sources: readonly Source[] = SOURCES): Promise<boolean> {
  try {
    const have = await haveKeys();
    return sources.every((s) => have.has(`${MODEL_ID}:${s.key}`));
  } catch {
    return false;
  }
}

// The model gone from this device (the language and the other choices stay).
export async function removeAll(): Promise<void> {
  setPrefs({ on: false, at: 0 });
  stopTranscriber();
  try {
    const db = await openVoiceDB();
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').clear();
    await idbDone(tx);
  } catch {}
}

// ---------- running it

export interface Transcript {
  text: string;
  language: string; // what it was heard as ('en')
}
// The seam: 16 kHz mono sound in, words out. The worker is the real one; tests use a fake.
export interface Transcriber {
  transcribe(audio: Float32Array, opts?: { language?: string }): Promise<Transcript>;
}

export interface WorkerLike {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', fn: (e: MessageEvent & ErrorEvent) => void): void;
  terminate(): void;
}
const defaultWorker = (): WorkerLike | null => (typeof Worker === 'undefined' ? null : (new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike));

let current: Promise<Transcriber> | null = null;
let worker: WorkerLike | null = null;
let fake: Transcriber | null = null;
// For tests: a transcriber that needs no model.
export const _setTranscriber = (t: Transcriber | null) => {
  fake = t;
  current = null;
};

export function stopTranscriber() {
  try {
    worker?.terminate();
  } catch {}
  worker = null;
  current = null;
}

// The model, ready to listen. Throws when it isn't downloaded or can't run here.
export function transcriber(make: () => WorkerLike | null = defaultWorker): Promise<Transcriber> {
  if (fake) return Promise.resolve(fake);
  if (current) return current;
  current = (async () => {
    const files = await Promise.all(SOURCES.map((s) => readFile(s.key)));
    if (files.some((f) => !f)) throw new MeaningError('unsupported', "The voice model isn't on this device.");
    const [encoder, decoder, vocab, added, wasm] = files as ArrayBuffer[];
    const w = make();
    if (!w) throw new MeaningError('unsupported', "This browser can't run the voice model.");
    worker = w;
    let seq = 0;
    const waiting = new Map<number, { resolve: (v: Transcript) => void; reject: (e: Error) => void }>();
    let ready: (() => void) | null = null;
    let failed: ((e: Error) => void) | null = null;
    const started = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    const broke = (msg: string) => {
      const err = new MeaningError('engine', msg);
      failed?.(err);
      for (const p of waiting.values()) p.reject(err);
      waiting.clear();
      stopTranscriber();
    };
    w.addEventListener('message', (e) => {
      const m = e.data as { t: string; id?: number; text?: string; language?: string; message?: string };
      if (m.t === 'ready') ready?.();
      else if (m.t === 'error' && m.id === undefined) broke(m.message || "The voice model couldn't start.");
      else if (m.id !== undefined) {
        const p = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.t === 'text') p?.resolve({ text: m.text || '', language: m.language || '' });
        else p?.reject(new MeaningError('engine', m.message || "The voice model couldn't hear that."));
      }
    });
    w.addEventListener('error', (e) => broke(e?.message || "The voice model couldn't start."));
    const dec = new TextDecoder();
    w.postMessage({ t: 'init', encoder, decoder, vocab: dec.decode(vocab), added: dec.decode(added), wasm, heads: HEADS }, [encoder, decoder, wasm]);
    await started;
    return {
      transcribe(audio, { language = 'auto' } = {}) {
        const id = ++seq;
        const copy = new Float32Array(audio);
        return new Promise<Transcript>((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          w.postMessage({ t: 'transcribe', id, audio: copy, language }, [copy.buffer]);
        });
      },
    };
  })();
  current.catch(() => {
    current = null;
  });
  return current;
}
