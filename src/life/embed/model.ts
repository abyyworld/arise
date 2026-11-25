// The search model on this device: a small sentence model (all-MiniLM-L6-v2, made smaller to 8-bit
// numbers, about 23 MB) and the engine that runs it in the browser (ONNX Runtime Web, about 15 MB).
// Downloaded once, only when the Player chooses to, from fixed public addresses pinned to exact
// versions, each checked against its SHA-256 before it's kept. Kept on this device in IndexedDB
// ('arise-meaning'), never synced. It runs in a worker (worker.ts), off the page.
//
//   model and word list   Hugging Face, Xenova/all-MiniLM-L6-v2 at one fixed commit
//   engine                jsDelivr, the onnxruntime-web package at the version in package.json
//
// What it makes of the life log (index.ts) is kept here too, and can be made again at any time.

import { cleanMeaningPrefs, type MeaningPrefs } from '../../lib/validate';

const HF = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9';
export const ORT_VERSION = '1.31.1'; // the same as onnxruntime-web in package.json (a test checks)

export interface Source {
  key: 'model' | 'vocab' | 'wasm';
  url: string;
  size: number;
  sha256: string;
}
export const MODEL_ID = 'minilm-l6-v2-q8-751bff3';
export const SOURCES: readonly Source[] = [
  { key: 'model', url: `${HF}/onnx/model_quantized.onnx`, size: 22_972_370, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
  { key: 'vocab', url: `${HF}/vocab.txt`, size: 231_508, sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' },
  { key: 'wasm', url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.wasm`, size: 14_848_852, sha256: '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d' },
];
export const DOWNLOAD_BYTES = SOURCES.reduce((n, s) => n + s.size, 0);

export class MeaningError extends Error {
  constructor(
    readonly code: 'unsupported' | 'network' | 'bad-file' | 'stopped' | 'engine',
    message: string,
  ) {
    super(message);
  }
}

// ---------- the Player's choice (on this device only)

const KEY = 'arise-meaning';
export function prefs(): MeaningPrefs {
  try {
    return cleanMeaningPrefs(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return cleanMeaningPrefs({});
  }
}
function setPrefs(p: MeaningPrefs) {
  try {
    if (p.on) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {}
}

// ---------- the database: the downloaded files, and the vectors (index.ts)

export const MEANING_DB = 'arise-meaning';
let opening: Promise<IDBDatabase> | null = null;
export function openMeaningDB(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) return reject(new MeaningError('unsupported', "This browser can't keep the search model (it has no on-device database)."));
    const r = idb.open(MEANING_DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('vec')) db.createObjectStore('vec', { keyPath: 'id' }).createIndex('at', 'at');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
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
export function closeMeaningDB() {
  const o = opening;
  opening = null;
  o?.then((db) => db.close()).catch(() => {});
}
export const idbReq = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
export const idbDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Stopped.'));
  });

async function readFile(k: Source['key']): Promise<ArrayBuffer | null> {
  const db = await openMeaningDB();
  const row = (await idbReq(db.transaction('files').objectStore('files').get(`${MODEL_ID}:${k}`))) as { b?: ArrayBuffer } | undefined;
  return row?.b ?? null;
}

// ---------- downloading

export interface Progress {
  got: number;
  total: number;
}

async function sha256(b: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// One pinned file, checked against its size and SHA-256 before it's handed back. Voice notes
// (src/voice/model.ts) download theirs with this too, so `what` names the model in what it says.
export async function fetchOne(src: Pick<Source, 'url' | 'size' | 'sha256'>, onBytes: (n: number) => void, signal?: AbortSignal, fetcher: typeof fetch = fetch, what = 'search model'): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetcher(src.url, { signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (err) {
    if (signal?.aborted) throw new MeaningError('stopped', 'Stopped.');
    throw new MeaningError('network', `The ${what} couldn't be downloaded. Check you're online and try again. (${(err as Error)?.message || 'no answer'})`);
  }
  if (!res.ok) throw new MeaningError('network', `The ${what} couldn't be downloaded (the server said ${res.status}). Try again later.`);
  const parts: Uint8Array[] = [];
  let n = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
      if (n > src.size) throw new MeaningError('bad-file', `The ${what} that came isn't the right one, so it wasn't kept.`);
      onBytes(value.length);
    }
  } else {
    const b = new Uint8Array(await res.arrayBuffer());
    parts.push(b);
    n = b.length;
    onBytes(n);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  if (n !== src.size || (await sha256(all.buffer)) !== src.sha256) throw new MeaningError('bad-file', `The ${what} that came isn't the right one, so it wasn't kept.`);
  return all.buffer;
}

// Downloads what isn't here yet, checks it, keeps it, and turns search by meaning on.
export async function download({ onProgress, signal, fetcher, sources = SOURCES }: { onProgress?: (p: Progress) => void; signal?: AbortSignal; fetcher?: typeof fetch; sources?: readonly Source[] } = {}): Promise<void> {
  const db = await openMeaningDB();
  const have = new Set(((await idbReq(db.transaction('files').objectStore('files').getAllKeys())) as string[]).map(String));
  const total = sources.reduce((n, s) => n + s.size, 0);
  let got = sources.filter((s) => have.has(`${MODEL_ID}:${s.key}`)).reduce((n, s) => n + s.size, 0);
  onProgress?.({ got, total });
  for (const src of sources) {
    if (have.has(`${MODEL_ID}:${src.key}`)) continue;
    const b = await fetchOne(
      src,
      (n) => {
        got += n;
        onProgress?.({ got, total });
      },
      signal,
      fetcher,
    );
    const d = await openMeaningDB();
    const tx = d.transaction('files', 'readwrite');
    tx.objectStore('files').put({ k: `${MODEL_ID}:${src.key}`, b });
    await idbDone(tx);
  }
  // An older model's files go.
  const d = await openMeaningDB();
  const tx = d.transaction('files', 'readwrite');
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
    const db = await openMeaningDB();
    const have = new Set(((await idbReq(db.transaction('files').objectStore('files').getAllKeys())) as string[]).map(String));
    return sources.every((s) => have.has(`${MODEL_ID}:${s.key}`));
  } catch {
    return false;
  }
}

// The model, the engine and what was made with them, all gone from this device.
export async function removeAll(): Promise<void> {
  setPrefs({ on: false, at: 0 });
  stopEmbedder();
  try {
    const db = await openMeaningDB();
    const tx = db.transaction(['files', 'vec', 'kv'], 'readwrite');
    for (const s of ['files', 'vec', 'kv']) tx.objectStore(s).clear();
    await idbDone(tx);
  } catch {}
}

// ---------- running it

export interface Embedder {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

interface WorkerLike {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', fn: (e: MessageEvent & ErrorEvent) => void): void;
  terminate(): void;
}
const defaultWorker = (): WorkerLike | null => (typeof Worker === 'undefined' ? null : (new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike));

let current: Promise<Embedder> | null = null;
let worker: WorkerLike | null = null;
let fake: Embedder | null = null;
// For tests: an embedder that needs no model.
export const _setEmbedder = (e: Embedder | null) => {
  fake = e;
  current = null;
};

export function stopEmbedder() {
  try {
    worker?.terminate();
  } catch {}
  worker = null;
  current = null;
}

// The model, ready to read texts. Throws when it isn't downloaded or can't run here.
export function embedder(make: () => WorkerLike | null = defaultWorker): Promise<Embedder> {
  if (fake) return Promise.resolve(fake);
  if (current) return current;
  current = (async () => {
    const [model, vocab, wasm] = await Promise.all(SOURCES.map((s) => readFile(s.key)));
    if (!model || !vocab || !wasm) throw new MeaningError('unsupported', "The search model isn't on this device.");
    const w = make();
    if (!w) throw new MeaningError('unsupported', "This browser can't run the search model.");
    worker = w;
    let seq = 0;
    const waiting = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();
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
      stopEmbedder();
    };
    w.addEventListener('message', (e) => {
      const m = e.data as { t: string; id?: number; vecs?: Float32Array[]; message?: string };
      if (m.t === 'ready') ready?.();
      else if (m.t === 'error' && m.id === undefined) broke(m.message || "The search model couldn't start.");
      else if (m.id !== undefined) {
        const p = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.t === 'vecs' && m.vecs) p?.resolve(m.vecs);
        else p?.reject(new MeaningError('engine', m.message || "The search model couldn't read that."));
      }
    });
    w.addEventListener('error', (e) => broke(e?.message || "The search model couldn't start."));
    w.postMessage({ t: 'init', model, vocab: new TextDecoder().decode(vocab), wasm }, [model, wasm]);
    await started;
    return {
      embed(texts) {
        if (!texts.length) return Promise.resolve([]);
        const id = ++seq;
        return new Promise<Float32Array[]>((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          w.postMessage({ t: 'embed', id, texts: [...texts] });
        });
      },
    };
  })();
  current.catch(() => {
    current = null;
  });
  return current;
}
