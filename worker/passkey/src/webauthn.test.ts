// Checking passkeys: the WebAuthn spec's own test vectors (ES256 and RS256) are accepted, and
// anything changed in them is refused. Plus the small CBOR reader and the signature format.

import { describe, expect, it } from 'vitest';
import { CborError, decode } from './cbor';
import { cbor, FLAG, hex, softPasskey } from './test/helpers';
import { VECTORS } from './test/vectors';
import { derToRaw, parseAuthData, toB64url, verifyAssertion, verifyRegistration, WebAuthnError, type Expect } from './webauthn';

const SITE = { origin: 'https://example.org', rpId: 'example.org' };

async function register(name: 'es256' | 'rs256', over: Partial<Expect> = {}) {
  const v = VECTORS[name];
  return verifyRegistration({ clientDataJSON: hex(v.regClientData), attestationObject: hex(v.attestationObject) }, { challenge: toB64url(hex(v.regChallenge)), ...SITE, userVerified: false, ...over });
}
function signIn(name: 'es256' | 'rs256', key: Awaited<ReturnType<typeof register>>, over: Partial<Expect> = {}, change: { signature?: Uint8Array<ArrayBuffer>; authenticatorData?: Uint8Array<ArrayBuffer>; clientDataJSON?: Uint8Array<ArrayBuffer> } = {}) {
  const v = VECTORS[name];
  return verifyAssertion(
    { clientDataJSON: hex(v.authClientData), authenticatorData: hex(v.authenticatorData), signature: hex(v.signature), ...change },
    { alg: key.alg, jwk: key.jwk, count: key.count },
    { challenge: toB64url(hex(v.authChallenge)), ...SITE, userVerified: false, ...over },
  );
}

describe("the WebAuthn spec's test vectors", () => {
  it('ES256 (16.2): adds the passkey, then signs in with it', async () => {
    const key = await register('es256');
    expect(key.id).toBe(toB64url(hex(VECTORS.es256.credentialId)));
    expect(key.alg).toBe(-7);
    expect(key.jwk).toEqual({ kty: 'EC', crv: 'P-256', x: expect.any(String), y: expect.any(String) });
    expect(key.backedUp).toBe(true);
    expect(await signIn('es256', key)).toEqual({ count: 0, backedUp: true });
  });

  it('RS256 (16.10): adds the passkey, then signs in with it', async () => {
    const key = await register('rs256');
    expect(key.id).toBe(toB64url(hex(VECTORS.rs256.credentialId)));
    expect(key.alg).toBe(-257);
    expect(key.jwk).toEqual({ kty: 'RSA', n: expect.any(String), e: 'AQAB' });
    expect((await signIn('rs256', key)).count).toBe(0);
  });

  it("refuses when the device didn't check who it is, as Arise asks for by default", async () => {
    // The ES256 vector's flags have UV off (0x59, then 0x19); the RS256 one's have it on.
    await expect(register('es256', { userVerified: true })).rejects.toThrow(/face, fingerprint or screen lock/);
    const rs = await register('rs256', { userVerified: true });
    await expect(signIn('rs256', rs, { userVerified: true })).rejects.toThrow(WebAuthnError);
  });

  it('refuses another challenge, another address or another site', async () => {
    await expect(register('es256', { challenge: toB64url(hex(VECTORS.es256.authChallenge)) })).rejects.toThrow(/doesn't fit/);
    await expect(register('es256', { origin: 'https://evil.example' })).rejects.toThrow(/another site/);
    await expect(register('es256', { rpId: 'example.com' })).rejects.toThrow(/another site/);
    const key = await register('es256');
    await expect(signIn('es256', key, { challenge: toB64url(hex(VECTORS.es256.regChallenge)) })).rejects.toThrow(/doesn't fit/);
    await expect(signIn('es256', key, { origin: 'https://example.org:8443' })).rejects.toThrow(/another site/);
    await expect(signIn('es256', key, { rpId: 'evil.example' })).rejects.toThrow(/another site/);
  });

  it('refuses a changed signature, changed data, or the other passkey', async () => {
    for (const name of ['es256', 'rs256'] as const) {
      const key = await register(name);
      const sig = hex(VECTORS[name].signature);
      sig[sig.length - 3] ^= 1;
      await expect(signIn(name, key, {}, { signature: sig })).rejects.toThrow(WebAuthnError);
      const data = hex(VECTORS[name].authenticatorData);
      data[36] = 1; // the count
      await expect(signIn(name, key, {}, { authenticatorData: data })).rejects.toThrow(/signature doesn't match/);
    }
    const es = await register('es256');
    const rs = await register('rs256');
    await expect(signIn('es256', rs)).rejects.toThrow(WebAuthnError);
    await expect(signIn('rs256', es)).rejects.toThrow(WebAuthnError);
  });

  it('refuses a sign-in answer where an add was asked for, and the other way round', async () => {
    const v = VECTORS.es256;
    await expect(
      verifyRegistration({ clientDataJSON: hex(v.authClientData), attestationObject: hex(v.attestationObject) }, { challenge: toB64url(hex(v.authChallenge)), ...SITE, userVerified: false }),
    ).rejects.toThrow(/something else/);
    const key = await register('es256');
    await expect(signIn('es256', key, { challenge: toB64url(hex(v.regChallenge)) }, { clientDataJSON: hex(v.regClientData) })).rejects.toThrow(/something else/);
  });
});

describe('a passkey that counts', () => {
  it('refuses a count that does not go up (a copied passkey)', async () => {
    const p = await softPasskey(new Uint8Array([1, 2, 3]));
    const site = { origin: 'https://arise.example', rpId: 'arise.example' };
    p.count = 5;
    const made = await p.create({ challenge: 'c1', ...site });
    const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const key = await verifyRegistration({ clientDataJSON: fromB64(made.clientDataJSON), attestationObject: fromB64(made.attestationObject) }, { challenge: 'c1', ...site });
    expect(key.count).toBe(5);
    const at = async (count: number) => {
      const s = await p.get({ challenge: 'c2', ...site, count });
      return verifyAssertion({ clientDataJSON: fromB64(s.clientDataJSON), authenticatorData: fromB64(s.authenticatorData), signature: fromB64(s.signature) }, key, { challenge: 'c2', ...site });
    };
    expect((await at(6)).count).toBe(6);
    await expect(at(5)).rejects.toThrow(/copied/);
    await expect(at(0)).rejects.toThrow(/copied/);
  });

  it("refuses an answer where nobody was there, or that says it's synced but can't be", async () => {
    const p = await softPasskey(new Uint8Array([1]));
    const site = { origin: 'https://arise.example', rpId: 'arise.example' };
    const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const add = async (flags: number) => {
      const m = await p.create({ challenge: 'c', ...site, flags });
      return verifyRegistration({ clientDataJSON: fromB64(m.clientDataJSON), attestationObject: fromB64(m.attestationObject) }, { challenge: 'c', ...site });
    };
    await expect(add(FLAG.UV | FLAG.AT)).rejects.toThrow(/someone was there/);
    await expect(add(FLAG.UP | FLAG.UV | FLAG.BS | FLAG.AT)).rejects.toThrow(/doesn't add up/);
    await expect(add(FLAG.UP | FLAG.UV)).rejects.toThrow(WebAuthnError); // no key at all
    expect((await add(FLAG.UP | FLAG.UV | FLAG.AT)).backedUp).toBe(false);
  });
});

describe('reading what passkeys send', () => {
  it('reads CBOR the way WebAuthn writes it, and refuses the rest', () => {
    const v = decode(cbor(new Map<string | number, never>([['a', 1 as never], [-1, new Uint8Array([9]) as never]]))) as Map<unknown, unknown>;
    expect(v.get('a')).toBe(1);
    expect(v.get(-1)).toEqual(new Uint8Array([9]));
    expect(decode(new Uint8Array([0xf5]))).toBe(true);
    expect(decode(new Uint8Array([0x19, 0x01, 0x00]))).toBe(256);
    expect(decode(new Uint8Array([0x38, 0x63]))).toBe(-100);
    for (const bad of [[0x5f], [0x9f], [0xc2, 0x40], [0xfb, 0, 0, 0, 0, 0, 0, 0, 0], [0x42, 1], [0xa1, 0x40, 0x01], [0xa2, 0x01, 0x01, 0x01, 0x02], [0x01, 0x02], []]) {
      expect(() => decode(new Uint8Array(bad))).toThrow(CborError);
    }
    // Nested very deep: refused, not a crash.
    expect(() => decode(new Uint8Array([...new Array(40).fill(0x81), 0]))).toThrow(CborError);
  });

  it('turns DER signatures into the form Web Crypto takes', () => {
    const raw = derToRaw(hex(VECTORS.es256.signature));
    expect(raw.length).toBe(64);
    expect(Buffer.from(raw.subarray(0, 32)).toString('hex')).toBe('f50a4e2e4409249c4a853ba361282f09841df4dd4547a13a87780218deffcd38');
    // Short numbers are padded on the left.
    expect([...derToRaw(new Uint8Array([0x30, 6, 2, 1, 5, 2, 1, 7]))].filter(Boolean)).toEqual([5, 7]);
    expect(() => derToRaw(new Uint8Array([0x30, 6, 2, 1, 5, 2, 1]))).toThrow(WebAuthnError);
    expect(() => derToRaw(new Uint8Array([0x31, 6, 2, 1, 5, 2, 1, 7]))).toThrow(WebAuthnError);
  });

  it('refuses authenticator data with extra bytes, or too short', () => {
    expect(() => parseAuthData(new Uint8Array(36))).toThrow(WebAuthnError);
    expect(() => parseAuthData(new Uint8Array(38))).toThrow(/more in it/);
    expect(parseAuthData(new Uint8Array(37)).count).toBe(0);
  });
});
