// Photos and files between two devices through a cloud that only ever sees ciphertext: sent,
// shown on the other device (preview first, bytes when opened), deleted everywhere, "only on this
// device", and the same documents through Firestore under the life log's database rules.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sealed } from '../lib/crypto';
import { newDataKey } from '../lib/crypto';
import { newLifeKey, type LifeKeys } from './seal';
import * as F from './files';
import * as LOCAL from './files-store';
import { PART_BYTES, indexDocId, openFilesIndex } from './files-seal';
import { checkOwnStorage, fetchBytes, firestoreRemote, r2Store, syncFiles, SYNC_FILE_MAX, type FileRemote, type PartsStore, type SyncDeps } from './files-sync';
import * as FB from '../test/fake-firebase';

vi.setConfig({ testTimeout: 20_000 });

function memRemote() {
  const docs = new Map<string, Sealed>();
  const r: FileRemote & { docs: Map<string, Sealed>; writes: number } = {
    docs,
    writes: 0,
    async get(id) {
      return docs.get(id) ?? null;
    },
    async put(list) {
      r.writes++;
      for (const d of list) docs.set(d.id, d.s);
    },
    async del(ids) {
      for (const id of ids) docs.delete(id);
    },
    async swapIndex(id, expect, next) {
      if ((docs.get(id)?.iv ?? '') !== expect) return false;
      docs.set(id, next);
      return true;
    },
  };
  return r;
}

// Two devices: each its own database. `on` switches to one.
const dbs = new Map<string, IDBFactory>();
function on(name: string) {
  LOCAL.closeFilesDB();
  if (!dbs.has(name)) dbs.set(name, new IDBFactory());
  globalThis.indexedDB = dbs.get(name)!;
}

let keys: LifeKeys;
let remote: ReturnType<typeof memRemote>;
const deps = (over: Partial<SyncDeps> = {}): SyncDeps => ({ remote, keys, uid: 'uid1', ...over });
const bytes = (n: number, seed = 1) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) & 255;
  return b;
};
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const read = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

beforeEach(async () => {
  dbs.clear();
  keys = (await newLifeKey(await newDataKey(), 'uid1')).keys;
  remote = memRemote();
  F._setImageTools({ scale: async (_b, max) => ({ blob: new Blob([new Uint8Array(max === F.THUMB_PX ? 64 : 10)]), w: 10, h: 10 }) });
});

describe('two devices', () => {
  it('sends a file sealed, and the other device shows it, then fetches its bytes when opened', async () => {
    on('phone');
    const data = bytes(PART_BYTES + 100);
    const f = await F.putFile(data, { name: 'scan.pdf', type: 'application/pdf', day: '2026-11-20' });
    expect(await syncFiles(deps())).toBe(true);
    expect((await LOCAL.getStored(f.id))?.up).toBe(true);
    // The cloud: the index, the details and two parts. Ids say nothing, and nothing is plain.
    expect(remote.docs.size).toBe(4);
    for (const [id, s] of remote.docs) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(s.ct.length).toBeLessThanOrEqual(700_000);
      expect(atob(s.ct.slice(0, 4000)).includes('scan.pdf')).toBe(false);
    }

    on('laptop');
    expect(await syncFiles(deps())).toBe(true);
    const there = await LOCAL.getStored(f.id);
    expect(there).toMatchObject({ name: 'scan.pdf', day: '2026-11-20', size: data.length, here: false, up: true });
    const parts = await fetchBytes(deps(), f.id);
    expect(parts?.length).toBe(2);
    expect((await LOCAL.getStored(f.id))?.here).toBe(true);
    const got = await F.getFile(f.id);
    expect(same(await read(got!.blob), data)).toBe(true);
  });

  it('brings a photo preview across with the details', async () => {
    on('phone');
    const f = await F.putFile(new Blob([bytes(5000)], { type: 'image/jpeg' }), { name: 'sea.jpg', day: '2026-11-21' });
    expect(f.thumb?.length).toBe(64);
    await syncFiles(deps());
    on('laptop');
    await syncFiles(deps());
    const there = (await F.listFiles({ day: '2026-11-21' }))[0];
    expect(there.thumb).toEqual(f.thumb);
    expect(there.here).toBe(false);
  });

  it('deletes everywhere: from the cloud, and from the other device on its next sync', async () => {
    on('phone');
    const f = await F.putFile(bytes(PART_BYTES * 2), { name: 'a' });
    const keep = await F.putFile(bytes(10), { name: 'b' });
    await syncFiles(deps());
    on('laptop');
    await syncFiles(deps());
    expect((await F.listFiles()).length).toBe(2);

    on('phone');
    await F.deleteFile(f.id);
    await syncFiles(deps());
    expect(await LOCAL.tombs()).toEqual([]);
    // Left in the cloud: the index, and the other file's details and part.
    expect(remote.docs.size).toBe(3);

    on('laptop');
    expect(await syncFiles(deps())).toBe(true);
    expect((await F.listFiles()).map((x) => x.id)).toEqual([keep.id]);
  });

  it('keeps a deletion made before the first sync from coming back', async () => {
    on('phone');
    const f = await F.putFile(bytes(10), { name: 'a' });
    await syncFiles(deps());
    on('laptop');
    await syncFiles(deps());
    // Deleted on the laptop while the phone, offline, still had it.
    await F.deleteFile(f.id);
    await syncFiles(deps());
    on('phone');
    await syncFiles(deps());
    expect(await F.listFiles()).toEqual([]);
    on('laptop');
    await syncFiles(deps());
    expect(await F.listFiles()).toEqual([]);
  });

  it('"only on this device" takes it from the cloud and the other device, and keeps it here', async () => {
    on('phone');
    const f = await F.putFile(bytes(10), { name: 'a' });
    await syncFiles(deps());
    on('laptop');
    await syncFiles(deps());
    on('phone');
    await F.setSynced(f.id, false);
    await syncFiles(deps());
    expect(await LOCAL.getStored(f.id)).toMatchObject({ sync: false, up: false, here: true });
    on('laptop');
    await syncFiles(deps());
    expect(await F.listFiles()).toEqual([]);
    // And back again.
    on('phone');
    await F.setSynced(f.id, true);
    await syncFiles(deps());
    on('laptop');
    await syncFiles(deps());
    expect((await F.listFiles()).map((x) => x.id)).toEqual([f.id]);
  });

  it('keeps big files and files set to stay here off the cloud', async () => {
    on('phone');
    await F.putFile(bytes(10), { name: 'mine', sync: false });
    const big = await F.putFile(new Uint8Array(SYNC_FILE_MAX + 1), { name: 'big' });
    await syncFiles(deps());
    expect((await LOCAL.getStored(big.id))?.up).toBe(false);
    on('laptop');
    await syncFiles(deps());
    expect(await F.listFiles()).toEqual([]);
  });

  it('takes the other device in first when it wrote in between', async () => {
    on('phone');
    const a = await F.putFile(bytes(10), { name: 'a' });
    on('laptop');
    const b = await F.putFile(bytes(10), { name: 'b' });
    await syncFiles(deps());
    on('phone');
    // The laptop writes again right as the phone is about to.
    let once = true;
    const swap = remote.swapIndex;
    remote.swapIndex = async (id, expect, next) => {
      if (once) {
        once = false;
        on('laptop');
        await F.putFile(bytes(10), { name: 'c' });
        await syncFiles(deps());
        on('phone');
      }
      return swap(id, expect, next);
    };
    await syncFiles(deps());
    expect((await F.listFiles()).map((x) => x.name).sort()).toEqual(['a', 'b', 'c']);
    on('laptop');
    await syncFiles(deps());
    expect((await F.listFiles()).map((x) => x.id)).toContain(a.id);
    expect((await F.listFiles()).map((x) => x.id)).toContain(b.id);
  });

  it("never sends one account's files to another", async () => {
    on('phone');
    await F.putFile(bytes(10), { name: 'a' });
    await syncFiles(deps());
    await expect(syncFiles(deps({ uid: 'uid2' }))).rejects.toMatchObject({ code: 'other-account' });
  });

  it("won't open another account's cloud", async () => {
    on('phone');
    await F.putFile(bytes(10), { name: 'a' });
    await syncFiles(deps());
    on('laptop');
    const other = (await newLifeKey(await newDataKey(), 'uid1')).keys;
    // Another key finds no index of its own (the ids differ), so it sees no files.
    await syncFiles(deps({ keys: other }));
    expect(await F.listFiles()).toEqual([]);
  });
});

describe('through Firestore', () => {
  it('writes only what the life log rules allow, and reads it back', async () => {
    FB.resetCloud();
    FB.initializeAuth();
    const { user } = await FB.createUserWithEmailAndPassword(null as never, 'a@example.com', 'secret12');
    const uid = user.uid;
    const k = (await newLifeKey(await newDataKey(), uid)).keys;
    await FB.setDoc(FB.doc({}, 'users', uid, 'arise', 'keys'), { v: 1, iter: 1, byPassword: { iv: 'a', ct: 'b' }, byRecovery: { iv: 'a', ct: 'b' } });
    const c = {
      uid,
      keys: k,
      fb: FB as never,
      db: {} as never,
      ref: (id: string) => FB.doc({}, 'users', uid, 'life', id) as never,
      account: FB.doc({}, 'users', uid, 'arise', 'keys') as never,
      live: () => true,
    };
    const r = firestoreRemote(c);
    on('phone');
    const data = bytes(PART_BYTES * 2 + 1);
    const f = await F.putFile(data, { name: 'a.bin' });
    expect(await syncFiles({ remote: r, keys: k, uid })).toBe(true);
    const life = [...FB.cloud.docs.keys()].filter((p) => p.startsWith(`users/${uid}/life/`));
    expect(life.length).toBe(5); // index, details, three parts
    on('laptop');
    await syncFiles({ remote: r, keys: k, uid });
    expect(await fetchBytes({ remote: r, keys: k, uid }, f.id)).toHaveLength(3);
    const got = await F.getFile(f.id);
    expect(same(await read(got!.blob), data)).toBe(true);
    await F.deleteFile(f.id);
    await syncFiles({ remote: r, keys: k, uid });
    expect([...FB.cloud.docs.keys()].filter((p) => p.startsWith(`users/${uid}/life/`)).length).toBe(1);
  });
});

// The Player's own storage (a Cloudflare R2 bucket, lib/own-storage.ts) as a map.
function memOwn() {
  const docs = new Map<string, Sealed>();
  const o: PartsStore & { docs: Map<string, Sealed> } = {
    docs,
    async get(id) {
      return docs.get(id) ?? null;
    },
    async put(list) {
      for (const d of list) docs.set(d.id, d.s);
    },
    async del(ids) {
      for (const id of ids) docs.delete(id);
    },
  };
  return o;
}
const indexOf = async () => JSON.parse(await openFilesIndex(keys, 'uid1', remote.docs.get(await indexDocId(keys))!));

describe('with your own storage', () => {
  it("sends the parts there and only the details to the database; another device fetches them from there", async () => {
    const own = memOwn();
    on('phone');
    const data = bytes(PART_BYTES * 2 + 5);
    const f = await F.putFile(data, { name: 'film.mov', type: 'video/quicktime', day: '2026-11-22' });
    await syncFiles(deps({ own }));
    expect(own.docs.size).toBe(3);
    expect(remote.docs.size).toBe(2); // the index and the details
    for (const s of own.docs.values()) expect(atob(s.ct.slice(0, 4000)).includes('film')).toBe(false);
    const idx = await indexOf();
    expect(idx.schema).toBe(2);
    expect(idx.files[f.id]).toEqual({ n: 3, size: data.length, o: 1 });

    on('laptop');
    await syncFiles(deps({ own }));
    expect(await LOCAL.getStored(f.id)).toMatchObject({ where: 'own', here: false });
    // Without the storage set up there, the bytes can't be fetched.
    expect(await fetchBytes(deps(), f.id)).toBeNull();
    const parts = await fetchBytes(deps({ own }), f.id);
    expect(parts?.length).toBe(3);
    expect(same(await read((await F.getFile(f.id))!.blob), data)).toBe(true);
  });

  it('takes files far past the database limits, and deletes them from there', async () => {
    const own = memOwn();
    on('phone');
    const big = await F.putFile(bytes(SYNC_FILE_MAX + 10), { name: 'big' });
    const small = await F.putFile(bytes(10), { name: 'small' });
    await syncFiles(deps());
    expect((await LOCAL.getStored(big.id))?.up).toBe(false); // too big for the database
    expect((await indexOf()).schema).toBe(1);
    await syncFiles(deps({ own }));
    expect((await LOCAL.getStored(big.id))?.up).toBe(true);
    expect((await indexOf()).files[small.id]).toEqual({ n: 1, size: 10 }); // where it was
    await F.deleteFile(big.id);
    await syncFiles(deps({ own }));
    expect(own.docs.size).toBe(0);
    const idx = await indexOf();
    expect(idx.schema).toBe(1); // nothing listed there any more
    expect(idx.gone[big.id]).toMatchObject({ o: 1 });
  });
});

describe('your own storage in Cloudflare R2', () => {
  const cfg = { account: 'a'.repeat(32), bucket: 'my-arise', keyId: 'AKIA1234567890ABCDEF', secret: 'secret/Key+1234567890abcdefghijklmnop', at: 1 };
  function fakeR2() {
    const objects = new Map<string, string>();
    const calls: { method: string; url: string; auth: string }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      calls.push({ method: init.method!, url, auth: h.authorization });
      if (!h.authorization?.startsWith(`AWS4-HMAC-SHA256 Credential=${cfg.keyId}/`) || !h['x-amz-date'] || !h['x-amz-content-sha256']) return new Response('', { status: 403 });
      if (init.method === 'PUT') {
        objects.set(url, new TextDecoder().decode(init.body as Uint8Array));
        return new Response('', { status: 200 });
      }
      if (init.method === 'GET') return objects.has(url) ? new Response(objects.get(url), { status: 200 }) : new Response('', { status: 404 });
      objects.delete(url);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    return { objects, calls, fetcher };
  }

  it('signs every request, keeps each part under arise/ in the bucket, and reads it back', async () => {
    const r2 = fakeR2();
    const store = r2Store(cfg, r2.fetcher);
    await store.put([{ id: 'abc', s: { iv: 'i', ct: 'c' } }]);
    expect(r2.calls[0].url).toBe(`https://${'a'.repeat(32)}.r2.cloudflarestorage.com/my-arise/arise/abc`);
    expect(await store.get('abc')).toEqual({ iv: 'i', ct: 'c' });
    expect(await store.get('nothing')).toBeNull();
    await store.del(['abc', 'nothing']);
    expect(r2.objects.size).toBe(0);
  });

  it('checks before saving, and says plainly when the key is wrong', async () => {
    const r2 = fakeR2();
    await checkOwnStorage(cfg, r2.fetcher);
    expect(r2.objects.size).toBe(0); // the test part is gone again
    const no = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(checkOwnStorage(cfg, no)).rejects.toThrow('Your own storage said no.');
    const off = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(checkOwnStorage(cfg, off)).rejects.toThrow('CORS policy');
  });
});
