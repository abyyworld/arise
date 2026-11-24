// The passkey helper's front door: who may call it (Arise's own web address only), how often,
// and which account asks (the app's Firebase ID token). The passkeys themselves are kept and
// checked in the Durable Object (store.ts). After a passkey signs in, this makes the Firebase
// custom token the app signs in with.
//
//   POST /v1/add/start      (signed in)  →  {challenge, rpId, userId, ids}
//   POST /v1/add/finish     (signed in)  {name, clientDataJSON, attestationObject}  →  {id, name, added}
//   POST /v1/signin/start                →  {challenge, rpId}
//   POST /v1/signin/finish               {id, clientDataJSON, authenticatorData, signature, userHandle}  →  {token, id}
//   POST /v1/list           (signed in)  →  {passkeys: [{id, name, added, used, synced}]}
//   POST /v1/remove         (signed in)  {id} or {all: true}  →  {removed}
//   GET  /health                         →  {ok, name, ready}

import { customToken, serviceAccount, verifyIdToken, googleKey, type ServiceAccount } from './jwt';
import type { Op } from './store';
import { toB64url } from './webauthn';

export interface Env {
  ALLOWED_ORIGINS: string; // comma-separated
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT?: string; // the service account key file (JSON), a secret
  PER_IP?: RateLimiter;
  PASSKEYS: DurableObjectNamespaceLike;
}
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export interface Deps {
  keyFor?: typeof googleKey; // Google's public keys for ID tokens
  now?: () => number; // ms
}

const MAX_BODY = 16_384;
// Adding a passkey needs a fresh sign-in (the app checks the password just before).
const RECENT_SIGN_IN = 10 * 60;
const te = new TextEncoder();

const ROUTES = new Map<string, boolean>([
  // path → needs the account's ID token
  ['/v1/add/start', true],
  ['/v1/add/finish', true],
  ['/v1/signin/start', false],
  ['/v1/signin/finish', false],
  ['/v1/list', true],
  ['/v1/remove', true],
]);

function corsHeaders(origin: string): Record<string, string> {
  return origin
    ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400' }
    : { vary: 'origin' };
}
const json = (status: number, body: unknown, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

let sa: { text: string; account: Promise<ServiceAccount> } | null = null;
function account(env: Env): Promise<ServiceAccount> | null {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return null;
  if (sa?.text !== env.FIREBASE_SERVICE_ACCOUNT) sa = { text: env.FIREBASE_SERVICE_ACCOUNT, account: serviceAccount(env.FIREBASE_SERVICE_ACCOUNT) };
  return sa.account;
}

async function readBody(req: Request): Promise<string | null> {
  if (Number(req.headers.get('content-length')) > MAX_BODY) return null;
  const text = await req.text();
  return text.length > MAX_BODY ? null : text;
}

export async function handle(req: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const origin = req.headers.get('origin') || '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  const cors = corsHeaders(ok ? origin : '');
  const fail = (status: number, message: string) => json(status, { error: { message } }, cors);
  const path = new URL(req.url).pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers: cors });
  if (path === '/health' && req.method === 'GET') return json(200, { ok: true, name: 'arise-passkey', ready: !!env.FIREBASE_SERVICE_ACCOUNT }, cors);
  if (!ROUTES.has(path)) return fail(404, 'Not found.');
  if (req.method !== 'POST') return fail(405, 'Use POST.');
  if (!ok) return fail(403, 'Only the Arise app may use this.');
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  if (env.PER_IP && !(await env.PER_IP.limit({ key: ip })).success) return fail(429, 'Too many tries. Wait a minute and try again.');
  const sign = account(env);
  if (!sign) return fail(503, "Passkeys aren't set up on the server yet.");

  const text = await readBody(req);
  if (text === null) return fail(413, 'Too much data.');
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) || {};
    } catch {
      return fail(400, 'Bad request.');
    }
  }
  const now = deps.now?.() ?? Date.now();

  let uid = '';
  if (ROUTES.get(path)) {
    const token = /^Bearer (\S+)$/.exec(req.headers.get('authorization') || '')?.[1] || '';
    try {
      const id = await verifyIdToken(token, env.FIREBASE_PROJECT_ID, now / 1000, deps.keyFor);
      uid = id.uid;
      if (path === '/v1/add/start' && now / 1000 - id.authTime > RECENT_SIGN_IN) return fail(401, 'For safety, type your password again, then add the passkey.');
    } catch {
      return fail(401, 'Sign in again, then try again.');
    }
    if (te.encode(uid).length > 64) return fail(400, "This account can't have passkeys.");
  }

  const rpId = new URL(origin).hostname;
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  let op: Op;
  switch (path) {
    case '/v1/add/start':
      op = { op: 'start', kind: 'add', origin, uid };
      break;
    case '/v1/add/finish':
      op = { op: 'add', uid, origin, name: str('name'), clientDataJSON: str('clientDataJSON'), attestationObject: str('attestationObject') };
      break;
    case '/v1/signin/start':
      op = { op: 'start', kind: 'signin', origin };
      break;
    case '/v1/signin/finish':
      op = { op: 'signin', origin, id: str('id'), clientDataJSON: str('clientDataJSON'), authenticatorData: str('authenticatorData'), signature: str('signature'), userHandle: str('userHandle') || null };
      break;
    case '/v1/list':
      op = { op: 'list', uid };
      break;
    default:
      if (body.all !== true && !str('id')) return fail(400, 'Say which passkey.');
      op = body.all === true ? { op: 'remove', uid } : { op: 'remove', uid, id: str('id') };
  }

  const store = env.PASSKEYS.get(env.PASSKEYS.idFromName('all'));
  const res = await store.fetch('https://passkeys/', { method: 'POST', body: JSON.stringify(op) });
  const out = (await res.json()) as Record<string, unknown>;
  if (!res.ok) return json(res.status, out, cors);
  if (path === '/v1/add/start') return json(200, { ...out, rpId, userId: toB64url(te.encode(uid)) }, cors);
  if (path === '/v1/signin/start') return json(200, { ...out, rpId }, cors);
  if (path === '/v1/signin/finish') {
    let s: ServiceAccount;
    try {
      s = await sign;
    } catch {
      return fail(503, "The server's Firebase key doesn't work. The owner needs to set it again.");
    }
    if (s.projectId !== env.FIREBASE_PROJECT_ID) return fail(503, "The server's Firebase key is for another project. The owner needs to set it again.");
    return json(200, { token: await customToken(s, String(out.uid), Math.floor(now / 1000)), id: out.id }, cors);
  }
  return json(200, out, cors);
}
