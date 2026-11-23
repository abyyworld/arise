// The search model's download: pinned, checked, kept on the device, and run in a worker.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import * as MODEL from './model';

const store = new Map<string, string>();
globalThis.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as Storage;

beforeEach(() => {
  MODEL.closeMeaningDB();
  globalThis.indexedDB = new IDBFactory();
  store.clear();
  MODEL._setEmbedder(null);
});

const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)))].map((x) => x.toString(16).padStart(2, '0')).join('');
async function sources(): Promise<{ list: MODEL.Source[]; bytes: Map<string, Uint8Array> }> {
  const bytes = new Map([
    ['https://x.test/model', new Uint8Array(3000).fill(1)],
    ['https://x.test/vocab', new TextEncoder().encode('[PAD]\n[UNK]\n[CLS]\n[SEP]')],
    ['https://x.test/wasm', new Uint8Array(2000).fill(2)],
  ]);
  const keys = ['model', 'vocab', 'wasm'] as const;
  const list = await Promise.all([...bytes].map(async ([url, b], i) => ({ key: keys[i], url, size: b.length, sha256: await hex(b) })));
  return { list, bytes };
}
const fetcher = (bytes: Map<string, Uint8Array>, asked: string[] = []) =>
  (async (url: string) => {
    asked.push(url);
    const b = bytes.get(url);
    return b ? new Response(b.slice()) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;

describe('where it comes from', () => {
  it('is pinned to exact versions, with sizes and checksums', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies['onnxruntime-web']).toBe(MODEL.ORT_VERSION);
    for (const s of MODEL.SOURCES) {
      expect(s.url).toMatch(/^https:\/\/(huggingface\.co\/Xenova\/all-MiniLM-L6-v2\/resolve\/[0-9a-f]{40}\/|cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\d+\.\d+\.\d+\/dist\/)/);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(MODEL.SOURCES.find((s) => s.key === 'wasm')?.url).toContain(`onnxruntime-web@${MODEL.ORT_VERSION}/`);
    expect(Math.round(MODEL.DOWNLOAD_BYTES / 1048576)).toBe(36);
  });
});

describe('downloading', () => {
  it('downloads each file once, checks it, keeps it, and turns search by meaning on', async () => {
    const { list, bytes } = await sources();
    const seen: number[] = [];
    const asked: string[] = [];
    await MODEL.download({ sources: list, fetcher: fetcher(bytes, asked), onProgress: (p) => seen.push(p.got) });
    expect(seen.at(-1)).toBe(list.reduce((n, s) => n + s.size, 0));
    expect(await MODEL.downloaded(list)).toBe(true);
    expect(MODEL.prefs().on).toBe(true);
    await MODEL.download({ sources: list, fetcher: fetcher(bytes, asked) });
    expect(asked).toHaveLength(3);
  });

  it("keeps nothing that isn't what was pinned, and says so", async () => {
    const { list, bytes } = await sources();
    bytes.set('https://x.test/wasm', new Uint8Array(2000).fill(3));
    await expect(MODEL.download({ sources: list, fetcher: fetcher(bytes) })).rejects.toMatchObject({ code: 'bad-file' });
    expect(await MODEL.downloaded(list)).toBe(false);
    expect(MODEL.prefs().on).toBe(false);
  });

  it('says when it cannot be reached', async () => {
    const { list } = await sources();
    await expect(MODEL.download({ sources: list, fetcher: fetcher(new Map()) })).rejects.toMatchObject({ code: 'network' });
  });

  it('removes everything, and turns it off', async () => {
    const { list, bytes } = await sources();
    await MODEL.download({ sources: list, fetcher: fetcher(bytes) });
    await MODEL.removeAll();
    expect(await MODEL.downloaded(list)).toBe(false);
    expect(MODEL.prefs().on).toBe(false);
  });
});

describe('running it', () => {
  it("hands the worker what's on this device, then texts, and gets vectors back", async () => {
    const { list, bytes } = await sources();
    await MODEL.download({ sources: list, fetcher: fetcher(bytes) });
    const sent: { t: string; [k: string]: unknown }[] = [];
    const fns: ((e: MessageEvent & ErrorEvent) => void)[] = [];
    const worker = {
      postMessage(m: { t: string; id?: number; texts?: string[] }) {
        sent.push(m);
        const reply = m.t === 'init' ? { t: 'ready' } : { t: 'vecs', id: m.id, vecs: (m.texts || []).map(() => new Float32Array([1])) };
        queueMicrotask(() => fns.forEach((f) => f({ data: reply } as MessageEvent & ErrorEvent)));
      },
      addEventListener(type: string, fn: (e: MessageEvent & ErrorEvent) => void) {
        if (type === 'message') fns.push(fn);
      },
      terminate() {},
    };
    const emb = await MODEL.embedder(() => worker);
    expect(sent[0]).toMatchObject({ t: 'init', vocab: '[PAD]\n[UNK]\n[CLS]\n[SEP]' });
    expect((sent[0].model as ArrayBuffer).byteLength).toBe(3000);
    expect(await emb.embed(['a', 'b'])).toHaveLength(2);
    MODEL.stopEmbedder();
  });

  it("won't start without the model", async () => {
    await expect(MODEL.embedder(() => null)).rejects.toMatchObject({ code: 'unsupported' });
  });
});
