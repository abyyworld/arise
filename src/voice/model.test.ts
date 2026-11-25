// The voice model's download: pinned, checked, kept on the device, reusing search by meaning's
// engine when it's here, and run in a worker. No real model is downloaded: the files are made up.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import * as MODEL from './model';
import * as MEANING from '../life/embed/model';
import { cleanVoicePrefs } from '../lib/validate';

const store = new Map<string, string>();
globalThis.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as Storage;

beforeEach(() => {
  MODEL.closeVoiceDB();
  MEANING.closeMeaningDB();
  globalThis.indexedDB = new IDBFactory();
  store.clear();
  MODEL._setTranscriber(null);
  MODEL.stopTranscriber();
});

const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const KEYS = ['encoder', 'decoder', 'vocab', 'added', 'wasm'] as const;
async function sources(): Promise<{ list: MODEL.Source[]; bytes: Map<string, Uint8Array> }> {
  const made: Uint8Array[] = [new Uint8Array(3000).fill(1), new Uint8Array(5000).fill(2), new TextEncoder().encode('{"a":0}'), new TextEncoder().encode('{"<|en|>":1}'), new Uint8Array(2000).fill(4)];
  const bytes = new Map(made.map((b, i) => [`https://x.test/${KEYS[i]}`, b]));
  const list = await Promise.all(made.map(async (b, i) => ({ key: KEYS[i], url: `https://x.test/${KEYS[i]}`, size: b.length, sha256: await hex(b) })));
  return { list, bytes };
}
const fetcher = (bytes: Map<string, Uint8Array>, asked: string[] = []) =>
  (async (url: string) => {
    asked.push(url);
    const b = bytes.get(url);
    return b ? new Response(b.slice()) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;

describe('where it comes from', () => {
  it('is Whisper tiny, pinned to one commit, with sizes and checksums, and the same engine as search', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies['onnxruntime-web']).toBe(MEANING.ORT_VERSION);
    expect(MODEL.SOURCES.map((s) => s.key)).toEqual([...KEYS]);
    for (const s of MODEL.SOURCES) {
      expect(s.url).toMatch(/^https:\/\/(huggingface\.co\/Xenova\/whisper-tiny\/resolve\/[0-9a-f]{40}\/|cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\d+\.\d+\.\d+\/dist\/)/);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.size).toBeGreaterThan(1000);
    }
    // The engine is exactly search by meaning's file, so one can stand in for the other.
    const engine = MODEL.SOURCES.find((s) => s.key === 'wasm')!;
    expect(MEANING.SOURCES.find((s) => s.key === 'wasm')).toEqual({ ...engine });
    expect(Math.round(MODEL.DOWNLOAD_BYTES / 1048576)).toBe(54);
  });
});

describe('downloading', () => {
  it('downloads each file once, checks it, keeps it, and turns voice notes on', async () => {
    const { list, bytes } = await sources();
    const seen: number[] = [];
    const asked: string[] = [];
    expect(await MODEL.toDownload(list)).toBe(list.reduce((n, s) => n + s.size, 0));
    await MODEL.download({ sources: list, fetcher: fetcher(bytes, asked), onProgress: (p) => seen.push(p.got) });
    expect(seen.at(-1)).toBe(list.reduce((n, s) => n + s.size, 0));
    expect(await MODEL.downloaded(list)).toBe(true);
    expect(await MODEL.toDownload(list)).toBe(0);
    expect(MODEL.prefs().on).toBe(true);
    await MODEL.download({ sources: list, fetcher: fetcher(bytes, asked) });
    expect(asked).toHaveLength(5);
  });

  it("keeps nothing that isn't what was pinned, and says so", async () => {
    const { list, bytes } = await sources();
    bytes.set('https://x.test/decoder', new Uint8Array(5000).fill(3));
    await expect(MODEL.download({ sources: list, fetcher: fetcher(bytes) })).rejects.toMatchObject({ code: 'bad-file', message: expect.stringContaining('voice model') });
    expect(await MODEL.downloaded(list)).toBe(false);
    expect(MODEL.prefs().on).toBe(false);
  });

  it('says when it cannot be reached', async () => {
    const { list } = await sources();
    await expect(MODEL.download({ sources: list, fetcher: fetcher(new Map()) })).rejects.toMatchObject({ code: 'network' });
  });

  it("takes search by meaning's engine when that's here, instead of downloading it again", async () => {
    const { list, bytes } = await sources();
    const engine = bytes.get('https://x.test/wasm')!;
    // Search by meaning, on, with the same engine file kept.
    const db = await MEANING.openMeaningDB();
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put({ k: `${MEANING.MODEL_ID}:wasm`, b: engine.slice().buffer });
    await MEANING.idbDone(tx);
    store.set('arise-meaning', JSON.stringify({ on: true, at: 1 }));
    expect(await MODEL.toDownload(list)).toBe(list.reduce((n, s) => n + s.size, 0) - engine.length);
    const asked: string[] = [];
    await MODEL.download({ sources: list, fetcher: fetcher(bytes, asked) });
    expect(asked).not.toContain('https://x.test/wasm');
    expect(await MODEL.downloaded(list)).toBe(true);
  });

  it("doesn't take an engine that isn't the pinned one", async () => {
    const { list, bytes } = await sources();
    const db = await MEANING.openMeaningDB();
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put({ k: `${MEANING.MODEL_ID}:wasm`, b: new Uint8Array(2000).fill(9).buffer });
    await MEANING.idbDone(tx);
    store.set('arise-meaning', JSON.stringify({ on: true, at: 1 }));
    const asked: string[] = [];
    await MODEL.download({ sources: list, fetcher: fetcher(bytes, asked) });
    expect(asked).toContain('https://x.test/wasm');
  });

  it('removes the model and turns it off, keeping the language', async () => {
    const { list, bytes } = await sources();
    MODEL.setPrefs({ lang: 'uz' });
    await MODEL.download({ sources: list, fetcher: fetcher(bytes) });
    await MODEL.removeAll();
    expect(await MODEL.downloaded(list)).toBe(false);
    expect(MODEL.prefs()).toMatchObject({ on: false, lang: 'uz' });
  });
});

describe('the choices', () => {
  it('keeps only what it understands, with keeping the recording off unless turned on', () => {
    expect(cleanVoicePrefs({})).toEqual({ on: false, at: 0, lang: 'auto', keep: false });
    expect(cleanVoicePrefs({ on: true, at: 5, lang: 'ru', keep: true })).toEqual({ on: true, at: 5, lang: 'ru', keep: true });
    expect(cleanVoicePrefs({ on: 'yes', lang: '<script>', keep: 1 })).toEqual({ on: false, at: 0, lang: 'auto', keep: false });
  });

  it("knows a device that can't run it", () => {
    expect(MODEL.canRun({} as typeof globalThis)).toBe(false);
    const ok = { navigator: { mediaDevices: { getUserMedia() {} } }, MediaRecorder: function () {}, WebAssembly: {}, Worker: function () {}, indexedDB: {}, crypto: { subtle: {} }, OfflineAudioContext: function () {} };
    expect(MODEL.canRun(ok as unknown as typeof globalThis)).toBe(true);
    expect(MODEL.canRun({ ...ok, MediaRecorder: undefined } as unknown as typeof globalThis)).toBe(false);
  });
});

describe('running it', () => {
  it("won't start without the model", async () => {
    await expect(MODEL.transcriber(() => null)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it("hands the worker what's on this device, then sound, and gets words back", async () => {
    // The real file list (the worker is told its parts by key), with made-up files kept for it.
    const db = await MODEL.openVoiceDB();
    const tx = db.transaction('files', 'readwrite');
    const made: Record<string, Uint8Array> = { encoder: new Uint8Array(30), decoder: new Uint8Array(50), vocab: new TextEncoder().encode('{"hi":0}'), added: new TextEncoder().encode('{}'), wasm: new Uint8Array(20) };
    for (const k of KEYS) tx.objectStore('files').put({ k: `${MODEL.MODEL_ID}:${k}`, b: made[k].slice().buffer });
    await MEANING.idbDone(tx);
    const sent: { t: string; [k: string]: unknown }[] = [];
    const fns: ((e: MessageEvent & ErrorEvent) => void)[] = [];
    const worker = {
      postMessage(m: { t: string; id?: number; language?: string }) {
        sent.push(m);
        const reply = m.t === 'init' ? { t: 'ready' } : { t: 'text', id: m.id, text: 'Buy milk', language: m.language === 'auto' ? 'en' : m.language };
        queueMicrotask(() => fns.forEach((f) => f({ data: reply } as MessageEvent & ErrorEvent)));
      },
      addEventListener(type: string, fn: (e: MessageEvent & ErrorEvent) => void) {
        if (type === 'message') fns.push(fn);
      },
      terminate() {},
    };
    const t = await MODEL.transcriber(() => worker);
    expect(sent[0]).toMatchObject({ t: 'init', vocab: '{"hi":0}', added: '{}', heads: 6 });
    expect((sent[0].decoder as ArrayBuffer).byteLength).toBe(50);
    expect(await t.transcribe(new Float32Array(16000), { language: 'uz' })).toEqual({ text: 'Buy milk', language: 'uz' });
    expect(sent[1]).toMatchObject({ t: 'transcribe', language: 'uz' });
    expect((sent[1].audio as Float32Array).length).toBe(16000);
  });
});
