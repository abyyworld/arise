// @vitest-environment jsdom
// Passkeys, end to end: added under Account, More (the password first), then signing in with one
// on another device, with no password, and the data opening there because the passkey's own
// secret wraps the data key. A passkey that can't make that secret only signs in, and the
// password unlocks once. Removing one removes its wrap. Several simulated devices share one
// in-memory cloud that enforces the database rules; the browser's passkeys and Arise's passkey
// helper (passkey.ts, worker/passkey, tested on their own) are simulated here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from './test/fake-firebase';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

// The passkeys on the person's devices (synced between them, like iCloud Keychain), and the
// helper's store: which account each one signs in to.
const pk = vi.hoisted(() => ({
  helper: new Map<string, { uid: string; name: string; added: number }>(),
  secrets: new Map<string, Uint8Array | null>(), // what each passkey makes when used (null: it can't)
  atCreate: true, // the next passkey gives its secret as it's made
  canSecret: true, // the next passkey can make a secret at all
  use: '', // the passkey the next prompt picks
  made: '',
  n: 0,
}));
vi.mock('./passkey', () => {
  const uidOf = (idToken: string | null) => {
    const uid = /^token-(.+)$/.exec(idToken || '')?.[1];
    if (!uid) throw new Error('Sign in again, then try again.');
    return uid;
  };
  return {
    available: () => true,
    configured: () => true,
    warm: () => {},
    deviceName: () => 'Laptop',
    forgetOnDevice: () => {},
    ask: async () => {
      if (!pk.use) throw new Error('No passkey was used. Try again, or use your password.');
      return { id: pk.use, secret: pk.secrets.get(pk.use) ?? null, answer: { id: pk.use } };
    },
    finishSignIn: async (a: { id: string }) => {
      const p = pk.helper.get(a.id);
      if (!p) throw new Error("Arise doesn't know this passkey. It may have been removed. Sign in with your password.");
      return { token: `custom:${p.uid}`, id: a.id };
    },
    startAdd: async (idToken: string | null) => ({ challenge: 'c', rpId: 'localhost', userId: uidOf(idToken), ids: [] }),
    create: async () => {
      const id = `${'P'.repeat(40)}${String(pk.n++).padStart(3, '0')}`;
      const secret = pk.canSecret ? globalThis.crypto.getRandomValues(new Uint8Array(32)) : null;
      pk.secrets.set(id, secret);
      pk.made = id;
      return { id, clientDataJSON: '', attestationObject: '', secret: pk.atCreate ? secret : null, prf: pk.canSecret };
    },
    // Asked again when the secret didn't come as the passkey was made: this browser can't.
    secretFor: async () => null,
    finishAdd: async (idToken: string | null, made: { id: string }, name: string) => {
      pk.helper.set(made.id, { uid: uidOf(idToken), name, added: Date.now() });
      return { id: made.id, name, added: Date.now() };
    },
    list: async (idToken: string | null) => {
      const uid = uidOf(idToken);
      return [...pk.helper].filter(([, p]) => p.uid === uid).map(([id, p]) => ({ id, name: p.name, added: p.added, used: null, synced: true }));
    },
    remove: async (idToken: string | null, id: string) => {
      const uid = uidOf(idToken);
      const removed = pk.helper.get(id)?.uid === uid ? Number(pk.helper.delete(id)) : 0;
      return { removed };
    },
    removeAll: async (idToken: string | null) => {
      const uid = uidOf(idToken);
      let removed = 0;
      for (const [id, p] of pk.helper) if (p.uid === uid) removed += Number(pk.helper.delete(id));
      return { removed };
    },
  };
});

type Store = typeof import('./store');
type Sync = typeof import('./sync');
type Account = typeof import('./account');
interface Device {
  S: Store;
  SYNC: Sync;
  A: Account;
}
const storage = new Map<string, Map<string, string>>();
let current = '';
const devices: Device[] = [];
function use(name: string) {
  if (current) storage.set(current, new Map(Object.entries({ ...localStorage })));
  localStorage.clear();
  for (const [k, v] of storage.get(name) || []) localStorage.setItem(k, v);
  current = name;
}
async function device(name: string): Promise<Device> {
  use(name);
  vi.resetModules();
  const S = await import('./store');
  const SYNC = await import('./sync');
  const A = await import('./account');
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  const d = { S, SYNC, A };
  devices.push(d);
  return d;
}
const button = (v: string) => {
  const b = document.createElement('button');
  b.dataset.v = v;
  return b;
};

const PW = 'correct horse battery';
const EMAIL = 'me@example.com';
const KEYS = 'users/uid1/arise/keys';
const session = (id: string) => ({ id, workout: 'a', date: '2026-10-01', started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });
const wraps = () => ((cloud.docs.get(KEYS) as { byPasskey?: unknown[] } | undefined)?.byPasskey || []).length;

// An account with one workout in its cloud copy, signed in on the laptop.
async function laptop() {
  const a = await device('laptop');
  a.S.importData({ sessions: [session('s1')] });
  await a.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW });
  await a.SYNC.handleAction('sync-code-done');
  await a.SYNC.syncNow();
  return a;
}
async function addPasskey(d: Device, name = 'Laptop', password = PW) {
  if (d.SYNC.status.more !== 'passkeys') await d.SYNC.handleAction('sync-more', button('passkeys'));
  await d.SYNC.submit('passkey', { name, password });
  if (d.SYNC.status.error) return '';
  expect(d.SYNC.panel()).toContain('Now make the passkey');
  await d.SYNC.handleAction('sync-passkey-add');
  return pk.made;
}
async function signInWithPasskey(d: Device, id: string) {
  pk.use = id;
  await d.SYNC.handleAction('sync-passkey');
}

beforeEach(() => {
  resetCloud();
  storage.clear();
  current = '';
  localStorage.clear();
  pk.helper.clear();
  pk.secrets.clear();
  pk.atCreate = pk.canSecret = true;
  pk.use = pk.made = '';
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  for (const d of devices.splice(0)) d.SYNC.status.user = null;
  vi.restoreAllMocks();
});

describe('passkeys', () => {
  it('offers "Sign in with a passkey" on the sign-in screen, and Passkeys under More', async () => {
    const a = await device('laptop');
    expect(a.SYNC.panel()).toContain('Sign in with a passkey');
    await a.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW });
    await a.SYNC.handleAction('sync-code-done');
    expect(a.SYNC.panel()).toContain('data-v="passkeys">Passkeys</button>');
    await a.SYNC.handleAction('sync-more', button('passkeys'));
    expect(a.SYNC.panel()).toContain('No passkeys yet.');
    expect(a.SYNC.panel()).toContain('only learns which account a passkey belongs to, never your data');
  });

  it('adds a passkey after the password, then signs in and unlocks with it on another device, no password typed', async () => {
    const a = await laptop();
    const id = await addPasskey(a, 'My laptop');
    expect(a.SYNC.status.error).toBe('');
    expect(wraps()).toBe(1);
    expect(JSON.stringify(cloud.docs.get(KEYS))).not.toContain(id); // the wrap names a hash, not the passkey
    expect(a.SYNC.status.pk?.list.map((p) => p.name)).toEqual(['My laptop']);
    expect(a.SYNC.panel()).toContain('Signs you in and unlocks your data.');

    const b = await device('phone');
    await signInWithPasskey(b, id);
    expect(b.SYNC.status.error).toBe('');
    expect(b.SYNC.status.user?.id).toBe(EMAIL);
    expect(b.SYNC.status.locked).toBe(false);
    expect(await b.A.deviceKey(b.SYNC.status.user!.uid)).not.toBeNull();
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it("a passkey that can't make a secret signs in, and the password unlocks the data once", async () => {
    const a = await laptop();
    pk.canSecret = false;
    const id = await addPasskey(a);
    expect(wraps()).toBe(0);
    expect(a.SYNC.panel()).toContain('Signs you in. Your password unlocks your data once on each device.');

    const b = await device('phone');
    await signInWithPasskey(b, id);
    expect(b.SYNC.status.error).toBe('');
    expect(b.SYNC.status.locked).toBe(true);
    expect(b.SYNC.panel()).toContain("It can't unlock your encrypted data on this device, so enter your password once.");
    expect(b.S.state.sessions).toEqual([]); // nothing synced while locked
    await b.SYNC.submit('unlock', { password: 'not it' });
    expect(b.SYNC.status.locked).toBe(true);
    await b.SYNC.submit('unlock', { password: PW });
    expect(b.SYNC.status.locked).toBe(false);
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(wraps()).toBe(0);
  });

  it('a passkey whose secret only comes later unlocks from the first time the password is typed after it', async () => {
    const a = await laptop();
    pk.atCreate = false; // made where the browser couldn't ask for the secret yet
    const id = await addPasskey(a);
    expect(wraps()).toBe(0);

    const b = await device('phone');
    await signInWithPasskey(b, id);
    expect(b.SYNC.status.locked).toBe(true);
    expect(b.SYNC.panel()).toContain('After that, your passkey unlocks it too.');
    await b.SYNC.submit('unlock', { password: PW });
    expect(b.SYNC.status.locked).toBe(false);
    expect(wraps()).toBe(1);

    const c = await device('tablet');
    await signInWithPasskey(c, id);
    expect(c.SYNC.status.locked).toBe(false);
    expect(c.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('never adds a passkey without the right password', async () => {
    const a = await laptop();
    await addPasskey(a, 'Laptop', 'not the password');
    expect(a.SYNC.status.error).toBe("That password isn't right.");
    expect(a.SYNC.status.pkReady).toBeNull();
    expect(pk.helper.size).toBe(0);
    expect(wraps()).toBe(0);
  });

  it('removing a passkey removes its wrap, and it signs in no more', async () => {
    const a = await laptop();
    const one = await addPasskey(a, 'One');
    const two = await addPasskey(a, 'Two');
    expect(wraps()).toBe(2);
    await a.SYNC.handleAction('sync-passkey-remove', button(one));
    expect(a.SYNC.status.error).toBe('');
    expect(wraps()).toBe(1);
    expect(a.SYNC.status.pk?.list.map((p) => p.name)).toEqual(['Two']);

    const b = await device('phone');
    await signInWithPasskey(b, one);
    expect(b.SYNC.status.error).toContain("doesn't know this passkey");
    expect(b.SYNC.status.user).toBeNull();
    await signInWithPasskey(b, two);
    expect(b.SYNC.status.locked).toBe(false);
  });

  it("a removed passkey's secret no longer opens anything, even if the helper still knew it", async () => {
    const a = await laptop();
    const id = await addPasskey(a);
    const kept = pk.helper.get(id)!;
    await a.SYNC.handleAction('sync-passkey-remove', button(id));
    pk.helper.set(id, kept); // as if forgetting it at the helper hadn't gone through
    const b = await device('phone');
    await signInWithPasskey(b, id);
    expect(b.SYNC.status.locked).toBe(true); // signed in, but the data stays locked
  });

  it("keeps the passkeys' wraps when the password or recovery code changes (the data key stays the same)", async () => {
    const a = await laptop();
    const id = await addPasskey(a);
    await a.SYNC.submit('password', { old: PW, password: 'another long password', password2: 'another long password' });
    expect(a.SYNC.status.error).toBe('');
    await a.SYNC.handleAction('sync-code-done');
    await a.SYNC.submit('code', { password: 'another long password' });
    expect(a.SYNC.status.error).toBe('');
    expect(wraps()).toBe(1);
    const b = await device('phone');
    await signInWithPasskey(b, id);
    expect(b.SYNC.status.locked).toBe(false);
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it("deleting the account removes its passkeys; a deleted account's passkey leaves no login behind", async () => {
    const a = await laptop();
    const id = await addPasskey(a);
    const kept = pk.helper.get(id)!;
    await a.SYNC.submit('delete', { password: PW });
    expect(a.SYNC.status.error).toBe('');
    expect(pk.helper.size).toBe(0);
    expect(cloud.docs.get(KEYS)).toBeUndefined();

    pk.helper.set(id, kept); // as if the helper still had it
    const b = await device('phone');
    await signInWithPasskey(b, id);
    expect(b.SYNC.status.error).toContain('no longer exists');
    expect(b.SYNC.status.user).toBeNull();
    expect(cloud.users.has(kept.uid)).toBe(false); // the empty login Firebase made went again
  });

  it('a cancelled passkey prompt changes nothing', async () => {
    const b = await device('phone');
    pk.use = '';
    await b.SYNC.handleAction('sync-passkey');
    expect(b.SYNC.status.error).toContain('No passkey was used');
    expect(b.SYNC.status.user).toBeNull();
    expect(b.SYNC.status.busy).toBe(false);
  });
});
