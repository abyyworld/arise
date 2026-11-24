// The passkey helper from the outside: add a passkey while signed in, sign in with it (and get a
// Firebase custom token), list and remove. Only Arise's address, each challenge once, and only
// the account's own passkeys.

import { beforeEach, describe, expect, it } from 'vitest';
import { handle, type Env } from './api';
import { verifyIdToken } from './jwt';
import { cleanName, Passkeys } from './store';
import { fakeStorage, idToken, rsaKeys, serviceAccountJson, softPasskey, type SoftPasskey } from './test/helpers';
import { fromB64url, toB64url } from './webauthn';

const ORIGIN = 'https://abyyworld.github.io';
const RP = 'abyyworld.github.io';
const PROJECT = 'arise-test';
const te = new TextEncoder();

let now = 1_800_000_000_000;
let google: CryptoKeyPair; // signs the test ID tokens
let saKeys: CryptoKeyPair; // the service account's
let env: Env;
let object: Passkeys;
let limited = false;

beforeEach(async () => {
  now = 1_800_000_000_000;
  limited = false;
  google ||= await rsaKeys();
  saKeys ||= await rsaKeys();
  object = new Passkeys(fakeStorage(), {}, () => now);
  env = {
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
    FIREBASE_PROJECT_ID: PROJECT,
    FIREBASE_SERVICE_ACCOUNT: await serviceAccountJson(saKeys, PROJECT),
    PER_IP: { limit: async () => ({ success: !limited }) },
    PASSKEYS: { idFromName: () => 'all', get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }) },
  };
});

const deps = { keyFor: async () => google.publicKey, now: () => now };
const tokenFor = (uid: string, signedInAgo = 60) =>
  idToken(google, { iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, iat: now / 1000 - 10, exp: now / 1000 + 3000, auth_time: now / 1000 - signedInAgo });
async function call(path: string, body: unknown = {}, { uid = '', origin = ORIGIN, signedInAgo = 60, method = 'POST' } = {}) {
  const headers: Record<string, string> = { origin, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.5' };
  if (uid) headers.authorization = `Bearer ${await tokenFor(uid, signedInAgo)}`;
  const res = await handle(new Request(`https://arise-passkey.example.workers.dev${path}`, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }), env, deps);
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any>, headers: res.headers };
}

async function add(uid: string, name = 'My iPhone', site = { origin: ORIGIN, rpId: RP }): Promise<SoftPasskey> {
  const start = await call('/v1/add/start', {}, { uid, origin: site.origin });
  expect(start.status).toBe(200);
  expect(start.body.rpId).toBe(site.rpId);
  expect(fromB64url(start.body.userId)).toEqual(te.encode(uid));
  const p = await softPasskey(fromB64url(start.body.userId));
  const made = await p.create({ challenge: start.body.challenge, ...site });
  const done = await call('/v1/add/finish', { name, clientDataJSON: made.clientDataJSON, attestationObject: made.attestationObject }, { uid, origin: site.origin });
  expect(done.status).toBe(200);
  expect(done.body).toEqual({ id: toB64url(p.id), name: cleanName(name), added: now });
  return p;
}
async function signIn(p: SoftPasskey, over: Partial<Parameters<SoftPasskey['get']>[0]> = {}, origin = ORIGIN) {
  const start = await call('/v1/signin/start', {}, { origin });
  const got = await p.get({ challenge: start.body?.challenge, origin, rpId: new URL(origin).hostname, ...over });
  return call('/v1/signin/finish', got, { origin });
}

describe('the passkey helper', () => {
  it('adds a passkey, then signs in with it: a custom token for that account, signed by the service account', async () => {
    const p = await add('alice-uid');
    const res = await signIn(p);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(toB64url(p.id));
    const [h, c, s] = res.body.token.split('.');
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
    expect(claims).toMatchObject({ uid: 'alice-uid', aud: expect.stringContaining('identitytoolkit'), iss: expect.stringContaining(`@${PROJECT}.iam.gserviceaccount.com`) });
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', saKeys.publicKey, fromB64url(s), te.encode(`${h}.${c}`))).toBe(true);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // The list shows when it was last used.
    const list = await call('/v1/list', {}, { uid: 'alice-uid' });
    expect(list.body.passkeys).toEqual([{ id: toB64url(p.id), name: 'My iPhone', added: now, used: now, synced: true }]);
  });

  it('uses each challenge once, and only for five minutes', async () => {
    const p = await add('alice-uid');
    const start = await call('/v1/signin/start');
    const got = await p.get({ challenge: start.body.challenge, origin: ORIGIN, rpId: RP });
    expect((await call('/v1/signin/finish', got)).status).toBe(200);
    expect((await call('/v1/signin/finish', got)).status).toBe(400); // the same answer again
    const late = await call('/v1/signin/start');
    now += 5 * 60_000 + 1;
    const old = await p.get({ challenge: late.body.challenge, origin: ORIGIN, rpId: RP });
    expect((await call('/v1/signin/finish', old)).body.error.message).toMatch(/took too long/);
    // A challenge Arise never gave.
    expect((await call('/v1/signin/finish', await p.get({ challenge: 'made-up', origin: ORIGIN, rpId: RP }))).status).toBe(400);
  });

  it("refuses a passkey it doesn't know, another site's, a forged one, or a mismatched account", async () => {
    const p = await add('alice-uid');
    const stranger = await softPasskey(te.encode('alice-uid'));
    expect((await signIn(stranger)).status).toBe(404);
    expect((await signIn(p, { rpId: 'evil.example' })).body.error.message).toMatch(/another site/);
    // Answers for one address can't be used from the other.
    const start = await call('/v1/signin/start', {}, { origin: 'http://localhost:5173' });
    const got = await p.get({ challenge: start.body.challenge, origin: 'http://localhost:5173', rpId: 'localhost' });
    expect((await call('/v1/signin/finish', got)).status).toBe(400);
    // Signed by another key under this passkey's id.
    const s2 = await call('/v1/signin/start');
    const forged = await stranger.get({ challenge: s2.body.challenge, origin: ORIGIN, rpId: RP });
    expect((await call('/v1/signin/finish', { ...forged, id: toB64url(p.id) })).body.error.message).toMatch(/signature/);
    // The passkey says it's for another account.
    const s3 = await call('/v1/signin/start');
    const other = await p.get({ challenge: s3.body.challenge, origin: ORIGIN, rpId: RP });
    expect((await call('/v1/signin/finish', { ...other, userHandle: toB64url(te.encode('bob-uid')) })).status).toBe(400);
  });

  it("needs the device to check who it is (face, fingerprint or screen lock)", async () => {
    const p = await add('alice-uid');
    expect((await signIn(p, { flags: 0x01 })).body.error.message).toMatch(/face, fingerprint or screen lock/);
  });

  it('adds only for the signed-in account, after a fresh sign-in, and with its own challenge', async () => {
    expect((await call('/v1/add/start', {}, {})).status).toBe(401);
    expect((await call('/v1/add/start', {}, { uid: 'alice-uid', signedInAgo: 3600 })).body.error.message).toMatch(/password again/);
    // Bob can't finish with a challenge given to Alice.
    const start = await call('/v1/add/start', {}, { uid: 'alice-uid' });
    const p = await softPasskey(te.encode('bob-uid'));
    const made = await p.create({ challenge: start.body.challenge, origin: ORIGIN, rpId: RP });
    expect((await call('/v1/add/finish', { name: 'x', ...made }, { uid: 'bob-uid' })).status).toBe(400);
    // Adding the same passkey twice: the second time, Arise already has it.
    const again = await call('/v1/add/start', {}, { uid: 'alice-uid' });
    const mine = await add('alice-uid');
    expect(again.body.ids).toEqual([]);
    const ids = (await call('/v1/add/start', {}, { uid: 'alice-uid' })).body.ids;
    expect(ids).toEqual([toB64url(mine.id)]);
  });

  it('keeps names plain and short, and at most ten passkeys an account', async () => {
    const p = await add('alice-uid', 'My <b>Mac</b>\n\twith a very long name that goes on and on and on and on and on');
    void p;
    const list = (await call('/v1/list', {}, { uid: 'alice-uid' })).body.passkeys;
    expect(list[0].name).toBe('My b Mac /b with a very long name that goes on and on and on');
    for (let i = 1; i < 10; i++) await add('alice-uid', `Key ${i}`);
    const full = await call('/v1/add/start', {}, { uid: 'alice-uid' });
    expect(full.status).toBe(409);
    expect(full.body.error.message).toMatch(/Remove one first/);
  });

  it("lists and removes only the account's own passkeys", async () => {
    const a1 = await add('alice-uid', 'Phone');
    const a2 = await add('alice-uid', 'Laptop');
    const b = await add('bob-uid', 'Bob');
    expect((await call('/v1/list', {}, { uid: 'bob-uid' })).body.passkeys.map((x: { name: string }) => x.name)).toEqual(['Bob']);
    expect((await call('/v1/remove', { id: toB64url(a1.id) }, { uid: 'bob-uid' })).body).toEqual({ removed: 0 });
    expect((await call('/v1/remove', { id: toB64url(a1.id) }, { uid: 'alice-uid' })).body).toEqual({ removed: 1 });
    expect((await signIn(a1)).status).toBe(404);
    expect((await signIn(a2)).status).toBe(200);
    expect((await call('/v1/remove', {}, { uid: 'alice-uid' })).status).toBe(400);
    expect((await call('/v1/remove', { all: true }, { uid: 'alice-uid' })).body).toEqual({ removed: 1 });
    expect((await signIn(a2)).status).toBe(404);
    expect((await signIn(b)).status).toBe(200);
  });

  it('answers only Arise, only POST, and not too often', async () => {
    expect((await call('/v1/signin/start', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/v1/signin/start', {}, { method: 'GET' })).status).toBe(405);
    expect((await call('/v1/other')).status).toBe(404);
    const pre = await handle(new Request('https://x.workers.dev/v1/signin/start', { method: 'OPTIONS', headers: { origin: ORIGIN } }), env, deps);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    const health = await call('/health', {}, { method: 'GET' });
    expect(health.body).toEqual({ ok: true, name: 'arise-passkey', ready: true });
    limited = true;
    expect((await call('/v1/signin/start')).status).toBe(429);
  });

  it("says plainly when the owner hasn't set the key yet, or set another project's", async () => {
    const p = await add('alice-uid');
    const { FIREBASE_SERVICE_ACCOUNT: _k, ...rest } = env;
    const before = env;
    env = rest as Env;
    expect((await call('/v1/signin/start')).body.error.message).toMatch(/aren't set up/);
    expect((await call('/health', {}, { method: 'GET' })).body.ready).toBe(false);
    env = { ...before, FIREBASE_SERVICE_ACCOUNT: await serviceAccountJson(saKeys, 'another-project') };
    expect((await signIn(p)).body.error.message).toMatch(/another project/);
  });

  it("the token's account is the passkey's, and checks out as one Firebase would sign in with", async () => {
    const p = await add('alice-uid');
    const res = await signIn(p);
    const [, c] = res.body.token.split('.');
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
    expect(claims.exp - claims.iat).toBe(3600);
    // (An ID token isn't a custom token: the helper never takes one for the other.)
    await expect(verifyIdToken(res.body.token, PROJECT, now / 1000, async () => saKeys.publicKey)).rejects.toThrow();
  });
});
