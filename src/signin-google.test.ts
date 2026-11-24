// @vitest-environment jsdom
// Signing in to Arise with Google, the browser side: the address of Google's sign-in page, and
// checking the ID token that comes back (made for this sign-in and this app) before Firebase sees
// it. The answer comes back to Arise's own address and is kept apart from linked accounts'.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./firebase-config.js', async (orig) => ({ ...(await orig<typeof import('./firebase-config.js')>()), SIGN_IN_WITH: { google: 'client-1.apps.googleusercontent.com' } }));

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: object) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
const CLIENT = 'client-1.apps.googleusercontent.com';

describe('signing in with Google, in the browser', () => {
  it("asks Google for an ID token only (email and name), sent back to Arise's own address", async () => {
    const G = await import('./signin-google');
    const u = new URL(G.authUrl({ state: 's1', nonce: 'n1', redirect: 'https://abyyworld.github.io/arise/' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: CLIENT,
      redirect_uri: 'https://abyyworld.github.io/arise/',
      response_type: 'id_token',
      scope: 'openid email profile',
      state: 's1',
      nonce: 'n1',
      prompt: 'select_account',
    });
  });

  it('takes the token only when it was made for this sign-in and this app', async () => {
    const G = await import('./signin-google');
    const good = jwt({ aud: CLIENT, nonce: 'n1', email: 'me@gmail.com', email_verified: true });
    expect(G.tokenOf(new URLSearchParams({ id_token: good, state: 's' }), 'n1')).toBe(good);
    expect(() => G.tokenOf(new URLSearchParams({ id_token: good }), 'other')).toThrow("Google's answer didn't fit this sign-in. Try again.");
    expect(() => G.tokenOf(new URLSearchParams({ id_token: jwt({ aud: 'someone-else', nonce: 'n1' }) }), 'n1')).toThrow("didn't fit");
    expect(() => G.tokenOf(new URLSearchParams({ id_token: good }), '')).toThrow("didn't fit");
    expect(() => G.tokenOf(new URLSearchParams({ id_token: 'not a token' }), 'n1')).toThrow("didn't fit");
    expect(() => G.tokenOf(new URLSearchParams({ id_token: jwt({ aud: CLIENT, nonce: 'n1', email_verified: false }) }), 'n1')).toThrow("Google hasn't checked that email address yet");
    expect(() => G.tokenOf(new URLSearchParams({ error: 'access_denied' }), 'n1')).toThrow("You didn't say yes, so you weren't signed in.");
  });

  it("comes back to Arise's address as a sign-in, never as a linked account's answer", async () => {
    const R = await import('./connect/return');
    const O = await import('./connect/oauth');
    localStorage.setItem(R.SIGNIN.pending, JSON.stringify({ state: 'st', service: 'signin', mode: 'redirect', parts: ['google'], at: Date.now() }));
    history.replaceState(null, '', `/arise/#id_token=abc&state=st`);
    expect(R.isOAuthReturn(location.hash)).toBe(true);
    expect(R.handleOAuthReturn()).toBe(false); // redirect mode: the app starts and picks it up
    expect(location.hash).toBe('#settings');
    expect(O.takeReturn()).toBeNull(); // linked accounts don't see it
    expect(O.takeReturn(undefined, R.SIGNIN)?.params.get('id_token')).toBe('abc');
    expect(O.takeReturn(undefined, R.SIGNIN)).toBeNull(); // once
  });
});
