// Signing in to Arise with Google (account.ts), with no Google script inside Arise: a plain
// pop-up to Google's sign-in page (connect/oauth.ts, the way linked accounts sign in), which
// sends an ID token back to Arise's own address (connect/return.ts). Firebase then checks that
// token and signs in with it. Where pop-ups don't work (an iPhone's Home Screen app), the whole
// page goes to Google and comes back, and sync.ts picks it up as the app starts.
//
// Only the token's email and name reach Arise, and only so Firebase can sign in: nothing else
// from the Google account is asked for.

import { begin, randomString, redirectUri, returnError, takeReturn } from './connect/oauth';
import { SIGNIN } from './connect/return';
import { SIGN_IN_WITH } from './firebase-config.js';

const NONCE = 'arise-signin-nonce';
export const clientId = () => (typeof SIGN_IN_WITH?.google === 'string' ? SIGN_IN_WITH.google : '');

export class SignInError extends Error {
  readonly code = 'signin-google';
}

export function authUrl({ state, nonce, redirect, client = clientId() }: { state: string; nonce: string; redirect: string; client?: string }): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', client);
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('response_type', 'id_token');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('prompt', 'select_account');
  return u.href;
}

const payload = (jwt: string): Record<string, unknown> | null => {
  try {
    const part = jwt.split('.')[1] || '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
};

// The ID token Google sent back, once it's checked against this sign-in (Firebase checks the
// signature and who it's for again).
export function tokenOf(params: URLSearchParams, nonce: string, client = clientId()): string {
  const err = returnError(params);
  if (err) throw new SignInError(err === "You didn't say yes, so nothing was linked." ? "You didn't say yes, so you weren't signed in." : err);
  const token = params.get('id_token') || '';
  const p = payload(token);
  if (!token || !p || !nonce || p.nonce !== nonce || p.aud !== client) throw new SignInError("Google's answer didn't fit this sign-in. Try again.");
  if (p.email_verified === false) throw new SignInError("Google hasn't checked that email address yet, so Arise can't sign in with it.");
  return token;
}

function takeNonce(): string {
  try {
    const n = localStorage.getItem(NONCE) || '';
    localStorage.removeItem(NONCE);
    return n;
  } catch {
    return '';
  }
}

// From a tap: the pop-up, and the ID token it brings back. In redirect mode the page leaves.
export async function askGoogle(): Promise<string> {
  if (!clientId()) throw new SignInError('Google sign-in is not set up yet.');
  const done = await begin(
    'signin',
    ['google'],
    ({ state }) => {
      const nonce = randomString(16);
      try {
        localStorage.setItem(NONCE, nonce);
      } catch {}
      return authUrl({ state, nonce, redirect: redirectUri() });
    },
    { keys: SIGNIN },
  );
  return tokenOf(done.params, takeNonce());
}

// A sign-in that came back to this page (the whole page went to Google): its ID token, once.
export function pickUpGoogle(): string | null {
  const done = takeReturn(undefined, SIGNIN);
  if (!done) return null;
  return tokenOf(done.params, takeNonce());
}
