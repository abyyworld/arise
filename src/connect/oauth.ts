// Signing in to Google or Microsoft from the web app, with no Arise server in between and no
// client secret: the service sends its answer back to Arise's own address (return.ts).
//
// A pop-up where possible, so the app stays as it is. Where pop-ups don't work (blocked, or the
// app added to an iPhone's Home Screen, whose pop-ups can't talk back to it), the whole page goes
// to the sign-in and comes back.
//
// No third-party script: Google's own sign-in library would have to run inside Arise (with
// everything Arise keeps), which Arise's rules don't allow (index.html). This is the same
// standard flow it runs, written out.

import { CONNECT, type Back, type Keys } from './return';
import type { ServiceId } from './state';

export interface Pending {
  state: string;
  service: ServiceId | 'signin';
  mode: 'popup' | 'redirect';
  verifier?: string; // PKCE (Microsoft)
  parts: string[];
  at: number;
}

export interface Done {
  pending: Pending;
  params: URLSearchParams;
}

const MAX_AGE = 15 * 60_000;

// Arise's address, where the answer comes back: https://…/arise/
export function redirectUri(href = location.href): string {
  const u = new URL('./', href);
  return u.origin + u.pathname;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// PKCE (RFC 7636): the S256 challenge for a verifier.
export async function challenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

const iosHomeScreen = () => (navigator as { standalone?: boolean }).standalone === true;

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') as T | null;
  } catch {
    return null;
  }
}
const clear = (k: Keys = CONNECT) => {
  try {
    localStorage.removeItem(k.pending);
    localStorage.removeItem(k.ret);
  } catch {}
};

// The answer for the sign-in this device started, once, if it's there and fresh.
export function takeReturn(state?: string, k: Keys = CONNECT): Done | null {
  const p = read<Pending>(k.pending);
  const back = read<Back>(k.ret);
  if (!p || !back || typeof back.params !== 'string' || back.state !== p.state || (state && p.state !== state)) return null;
  clear(k);
  if (Date.now() - (p.at || 0) > MAX_AGE) return null;
  return { pending: p, params: new URLSearchParams(back.params) };
}

let cancelWait: (() => void) | null = null;

export function cancel(k: Keys = CONNECT) {
  cancelWait?.();
  clear(k);
}

// Starts a sign-in. Must run straight from the tap (browsers only allow a pop-up then), so the
// pop-up opens before anything else. `build` makes the sign-in address. Resolves with the answer
// in pop-up mode; in redirect mode the page leaves, and the app picks it up when it comes back.
export async function begin(service: ServiceId | 'signin', parts: string[], build: (o: { state: string; challenge?: string }) => string, { pkce = false, keys: k = CONNECT }: { pkce?: boolean; keys?: Keys } = {}): Promise<Done> {
  cancelWait?.(); // a sign-in started earlier and never finished
  const popup = iosHomeScreen() ? null : window.open('', k.channel, 'popup=yes,width=520,height=700');
  const p: Pending = { state: randomString(16), service, mode: popup ? 'popup' : 'redirect', parts, at: Date.now() };
  if (pkce) p.verifier = randomString(32);
  try {
    localStorage.setItem(k.pending, JSON.stringify(p));
    localStorage.removeItem(k.ret);
  } catch {}
  const url = build({ state: p.state, challenge: p.verifier ? await challenge(p.verifier) : undefined });
  if (!popup) {
    location.assign(url);
    return new Promise<Done>(() => {}); // the page goes to the sign-in
  }
  popup.location.href = url;
  return wait(p.state, k);
}

// Waits for the pop-up's answer: a message on this device's channel, a change in storage, or
// (as a backstop) a look every second.
function wait(state: string, k: Keys = CONNECT, timeout = 10 * 60_000): Promise<Done> {
  return new Promise<Done>((resolve, reject) => {
    let ch: BroadcastChannel | null = null;
    const stop = () => {
      clearInterval(poll);
      clearTimeout(timer);
      window.removeEventListener('storage', check);
      ch?.close();
      cancelWait = null;
    };
    const check = () => {
      const done = takeReturn(state, k);
      if (done) {
        stop();
        resolve(done);
      }
    };
    try {
      ch = new BroadcastChannel(k.channel);
      ch.onmessage = (e) => {
        const back = e.data as Back;
        if (back?.state !== state) return;
        try {
          localStorage.setItem(k.ret, JSON.stringify(back));
        } catch {}
        check();
      };
    } catch {}
    window.addEventListener('storage', check);
    const poll = setInterval(check, 1000);
    const timer = setTimeout(() => {
      stop();
      reject(new Error('timeout'));
    }, timeout);
    cancelWait = () => {
      stop();
      reject(new Error('cancelled'));
    };
  });
}

// What came back as an error, in plain words ('' when it wasn't one).
export function returnError(params: URLSearchParams): string {
  const e = params.get('error');
  if (!e) return '';
  if (e === 'access_denied' || e === 'consent_required') return "You didn't say yes, so nothing was linked.";
  if (e === 'interaction_required' || e === 'login_required') return 'Sign in again to keep going.';
  return "The sign-in didn't work. Try again.";
}
