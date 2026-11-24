// @vitest-environment jsdom
// Signing in with Google: a second way into an email account, never a way around its
// password. A new account made this way gets the email login too (for the phone apps); an
// existing one opens with its Arise password, and gets its email login back if Firebase took it
// away. Several simulated devices share one in-memory cloud that enforces the database rules.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from './test/fake-firebase';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});
vi.mock('./firebase-config.js', async (orig) => ({ ...(await orig<typeof import('./firebase-config.js')>()), SIGN_IN_WITH: { google: 'test-client.apps.googleusercontent.com' } }));
// Google's pop-up (signin-google.ts, tested on its own): the next one brings back this account's
// ID token, or is closed.
const popup = vi.hoisted(() => ({ next: '' }));
vi.mock('./signin-google', () => ({
  askGoogle: async () => {
    const t = popup.next;
    popup.next = '';
    if (!t) throw new Error('cancelled');
    return `google:${t}`;
  },
  pickUpGoogle: () => null,
}));

type Store = typeof import('./store');
type Sync = typeof import('./sync');
interface Device {
  S: Store;
  SYNC: Sync;
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
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  const d = { S, SYNC };
  devices.push(d);
  return d;
}
const button = (v: string) => {
  const b = document.createElement('button');
  b.dataset.v = v;
  return b;
};
const PW = 'correct horse battery';
const GMAIL = 'me@gmail.com';
const session = (id: string) => ({ id, workout: 'a', date: '2026-10-01', started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });
const login = (email: string) => [...cloud.users.values()].find((u) => u.email === email)!;
const cloudText = () => JSON.stringify([...cloud.docs.values()]);

beforeEach(() => {
  resetCloud();
  storage.clear();
  current = '';
  localStorage.clear();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
});
afterEach(() => {
  for (const d of devices.splice(0)) d.SYNC.status.user = null;
});

describe('signing in with Google', () => {
  it('offers it on the sign-in and sign-up forms, marked less private, and not in the phone apps', async () => {
    const a = await device('laptop');
    expect(a.SYNC.panel()).toContain('Continue with Google');
    expect(a.SYNC.panel()).toContain('Less private');
    a.SYNC.status.form = 'up';
    expect(a.SYNC.panel()).toContain('Sign up with Google');
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    try {
      expect(a.SYNC.panel()).not.toContain('with Google');
    } finally {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
    }
  });

  it('makes a new account behind a Google login with an Arise password, which then works with the email on a phone', async () => {
    const a = await device('laptop');
    a.S.importData({ sessions: [session('s1')] });
    popup.next = GMAIL;
    await a.SYNC.handleAction('sync-with', button('google'));
    expect(a.SYNC.status.with).toMatchObject({ p: 'google', fresh: true });
    expect(a.SYNC.panel()).toContain('Now make your Arise password');
    // Nothing goes up before the password.
    expect(cloud.docs.size).toBe(0);
    await a.SYNC.submit('with', { password: PW, password2: 'other' });
    expect(a.SYNC.status.error).toBe("The two passwords don't match.");
    expect(a.SYNC.status.with).not.toBeNull();
    await a.SYNC.submit('with', { password: PW, password2: PW });
    expect(a.SYNC.status.error).toBe('');
    expect(a.SYNC.status.with).toBeNull();
    expect(a.SYNC.status.pending?.recoveryCode).toBeTruthy();
    await a.SYNC.handleAction('sync-code-done');
    await a.SYNC.syncNow();
    expect(cloudText()).not.toContain('band_row'); // encrypted
    expect(login(GMAIL).ids).toEqual({ 'google.com': GMAIL });
    expect(login(GMAIL).password).toBeTruthy(); // the email login too

    const b = await device('phone');
    await b.SYNC.submit('in', { id: GMAIL, password: PW });
    expect(b.SYNC.status.error).toBe('');
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it("opens an existing account only with its Arise password, and puts back the email login Google's sign-in took", async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: GMAIL, password: PW, password2: PW });
    await a.SYNC.handleAction('sync-code-done');
    await a.SYNC.syncNow();

    const b = await device('laptop');
    popup.next = GMAIL;
    await b.SYNC.handleAction('sync-with', button('google'));
    expect(b.SYNC.status.with).toMatchObject({ fresh: false });
    expect(login(GMAIL).password).toBe(''); // Firebase took the email login away
    await b.SYNC.submit('with', { password: 'not the password' });
    expect(b.SYNC.status.error).toBe("That password isn't right.");
    expect(b.SYNC.status.with).not.toBeNull();
    expect(b.S.state.sessions).toEqual([]);
    await b.SYNC.submit('with', { password: PW });
    expect(b.SYNC.status.error).toBe('');
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(login(GMAIL).password).toBeTruthy();

    const c = await device('tablet');
    await c.SYNC.submit('in', { id: GMAIL, password: PW });
    expect(c.SYNC.status.error).toBe('');
  });

  it('cancelling signs out, and a closed pop-up says so plainly', async () => {
    const a = await device('laptop');
    await a.SYNC.handleAction('sync-with', button('google'));
    expect(a.SYNC.status.error).toBe('The sign-in window was closed before it finished.');
    popup.next = GMAIL;
    await a.SYNC.handleAction('sync-with', button('google'));
    await a.SYNC.handleAction('sync-with-cancel');
    expect(a.SYNC.status.with).toBeNull();
    expect(a.SYNC.status.user).toBeNull();

  });

  it('an account code account can let Google sign in too, and stop it again; the password still opens the data', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    a.SYNC.status.noEmail = true;
    await a.SYNC.submit('up', { password: PW, password2: PW });
    const code = a.SYNC.status.user!.id;
    await a.SYNC.handleAction('sync-code-done');
    await a.SYNC.syncNow();
    expect(a.SYNC.panel()).toContain('Also sign in with Google (less private)');
    popup.next = GMAIL;
    await a.SYNC.handleAction('sync-link', button('google'));
    expect(a.SYNC.status.error).toBe('');
    expect(a.SYNC.panel()).toContain('Stop signing in with Google');

    const b = await device('laptop');
    popup.next = GMAIL;
    await b.SYNC.handleAction('sync-with', button('google'));
    expect(b.SYNC.status.with).toMatchObject({ fresh: false });
    expect(b.SYNC.status.with!.user.id).toBe(code);
    await b.SYNC.submit('with', { password: PW });
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await b.SYNC.handleAction('sync-unlink', button('google'));
    expect([...cloud.users.values()].some((u) => u.ids?.['google.com'])).toBe(false);
    vi.restoreAllMocks();
  });
});
