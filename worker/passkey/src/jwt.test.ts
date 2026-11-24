// Firebase tokens: the custom token has the shape Firebase asks for and the service account's
// signature (a throwaway key here), and the app's ID token is only taken when it's valid.

import { describe, expect, it } from 'vitest';
import { AUDIENCE, customToken, serviceAccount, verifyIdToken } from './jwt';
import { idToken, rsaKeys, serviceAccountJson } from './test/helpers';
import { fromB64url } from './webauthn';

const te = new TextEncoder();
const parts = (jwt: string) => jwt.split('.').map((p, i) => (i < 2 ? JSON.parse(new TextDecoder().decode(fromB64url(p))) : p));

describe('the custom token', () => {
  it("is a JWT Firebase takes: RS256, the service account as issuer and subject, Firebase's audience, an hour, the uid", async () => {
    const keys = await rsaKeys();
    const sa = await serviceAccount(await serviceAccountJson(keys, 'arise-test'));
    expect(sa.projectId).toBe('arise-test');
    const token = await customToken(sa, 'uid-123', 1_800_000_000);
    const [header, claims, sig] = parts(token);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claims).toEqual({ iss: sa.email, sub: sa.email, aud: AUDIENCE, iat: 1_800_000_000, exp: 1_800_003_600, uid: 'uid-123' });
    expect(sa.email).toBe('firebase-adminsdk-x@arise-test.iam.gserviceaccount.com');
    const [h, p] = token.split('.');
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, fromB64url(sig), te.encode(`${h}.${p}`))).toBe(true);
    // Another key's signature doesn't fit.
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', (await rsaKeys()).publicKey, fromB64url(sig), te.encode(`${h}.${p}`))).toBe(false);
  });

  it('refuses a uid Firebase would refuse, and a key file that is not one', async () => {
    const sa = await serviceAccount(await serviceAccountJson(await rsaKeys()));
    await expect(customToken(sa, '')).rejects.toThrow();
    await expect(customToken(sa, 'x'.repeat(129))).rejects.toThrow();
    await expect(serviceAccount('{oops')).rejects.toThrow(/isn't JSON/);
    await expect(serviceAccount(JSON.stringify({ type: 'authorized_user' }))).rejects.toThrow(/isn't a service account/);
    const broken = JSON.parse(await serviceAccountJson(await rsaKeys()));
    broken.private_key = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n';
    await expect(serviceAccount(JSON.stringify(broken))).rejects.toThrow(/can't be read/);
  });
});

describe("the app's ID token", () => {
  const NOW = 1_800_000_000;
  const good = (over: Record<string, unknown> = {}) => ({ iss: 'https://securetoken.google.com/arise-test', aud: 'arise-test', sub: 'uid-1', iat: NOW - 10, exp: NOW + 3000, auth_time: NOW - 100, ...over });

  it('gives the uid and when the account signed in', async () => {
    const keys = await rsaKeys();
    const token = await idToken(keys, good());
    expect(await verifyIdToken(token, 'arise-test', NOW, async () => keys.publicKey)).toEqual({ uid: 'uid-1', authTime: NOW - 100 });
  });

  it("refuses another project's, an old one, a forged one, or one with no key", async () => {
    const keys = await rsaKeys();
    const key = async () => keys.publicKey;
    await expect(verifyIdToken(await idToken(keys, good({ aud: 'other' })), 'arise-test', NOW, key)).rejects.toThrow('audience');
    await expect(verifyIdToken(await idToken(keys, good({ iss: 'https://securetoken.google.com/other' })), 'arise-test', NOW, key)).rejects.toThrow('audience');
    await expect(verifyIdToken(await idToken(keys, good({ exp: NOW - 1 })), 'arise-test', NOW, key)).rejects.toThrow('expired');
    await expect(verifyIdToken(await idToken(keys, good({ sub: '' })), 'arise-test', NOW, key)).rejects.toThrow('sub');
    await expect(verifyIdToken(await idToken(await rsaKeys(), good()), 'arise-test', NOW, key)).rejects.toThrow('signature');
    await expect(verifyIdToken(await idToken(keys, good()), 'arise-test', NOW, async () => undefined)).rejects.toThrow('kid');
    await expect(verifyIdToken('not.a', 'arise-test', NOW, key)).rejects.toThrow('shape');
  });
});
