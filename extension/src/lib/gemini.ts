// Gemini in your browser: Arise asks a question, the extension types it into Gemini in a tab of
// this browser, signed in with the person's own Google account, and hands back the answer.
//
// Off until the person turns it on in Arise (Settings, AI coach) and allows gemini.google.com in
// the extension's own window (allow.html): that one site is an optional permission, never asked
// for at install. Turning it off (in Arise or in that window) gives the permission back and
// deletes the key. It's tied to the Arise it was turned on for: a new link starts with it off.
//
// The question and the answer are sealed on the way, as the rest of the link is (seal.ts): Arise
// seals the question for this extension's own key (given only to the linked Arise, while this is
// on), and the extension seals the answer for that Arise's key. Other extensions that can see
// messages on Arise's page read neither. Google reads both, in the Gemini tab: that's what makes
// this less private, and Arise says so wherever it can be picked.
//
// Protocol (Arise's page, through content.ts):
//   geminiStatus {link}      → {ok, on, granted, gkey?}
//   geminiOn {link, on}      → the same; on, and not allowed yet: the window that asks opens
//   gemini {link, box}       → {ok, box} with the answer, or {ok: false, error}
// On the Gemini tab (gemini-page.ts, through a port named PORT): {t: 'ask', prompt, json,
// timeout} → {t: 'wait'} every few seconds (it keeps the background awake), then {t: 'done',
// text} or {t: 'fail', error}.

import { fromB64url, toB64url } from './bytes';
import { type SealedBatch, isSealedBatch, openBatch, sealBatch } from './seal';
import type { PageError } from './gemini-page';

export const ORIGIN = 'https://gemini.google.com/*';
export const NEW_CHAT = 'https://gemini.google.com/app';
export const PORT = 'arise-gemini';
export const MAX_PROMPT = 60_000;
export const MAX_ANSWER = 100_000;
export const LOAD_FOR = 30_000; // the Gemini tab loading
export const ANSWER_FOR = 150_000; // the answer, once sent (the page's own wait)
// Everything together, with room for the page to find its box first: Arise waits a little longer.
export const TOTAL_FOR = LOAD_FOR + ANSWER_FOR + 30_000;

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const K = { on: 'gemini:on', key: 'gemini:key' };
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const isId = (s: unknown): s is string => typeof s === 'string' && ID.test(s);

export type GeminiRequest = { t: 'geminiStatus'; link: string } | { t: 'geminiOn'; link: string; on: boolean } | { t: 'gemini'; link: string; box: SealedBatch };

export type AskError = PageError | 'off' | 'no-permission' | 'busy' | 'bad' | 'tab' | 'not-linked' | 'no-key';

export interface Question {
  v: 1;
  prompt: string;
  json: boolean;
}
export interface Answer {
  v: 1;
  re: string; // the question's id
  text: string;
}

export function parseGeminiRequest(x: unknown): GeminiRequest | null {
  const m = x as Record<string, unknown>;
  if (!m || typeof m !== 'object' || !isId(m.link)) return null;
  if (m.t === 'geminiStatus') return { t: 'geminiStatus', link: m.link };
  if (m.t === 'geminiOn') return typeof m.on === 'boolean' ? { t: 'geminiOn', link: m.link, on: m.on } : null;
  if (m.t === 'gemini') return isSealedBatch(m.box) && m.box.ct.length <= 400_000 ? { t: 'gemini', link: m.link, box: m.box } : null;
  return null;
}

export function parseQuestion(x: unknown): Question | null {
  const q = x as Record<string, unknown>;
  if (!q || q.v !== 1 || typeof q.prompt !== 'string' || typeof q.json !== 'boolean') return null;
  const prompt = q.prompt.trim();
  return prompt && prompt.length <= MAX_PROMPT ? { v: 1, prompt, json: q.json } : null;
}

export function parseAnswer(x: unknown, re: string): Answer | null {
  const a = x as Record<string, unknown>;
  if (!a || a.v !== 1 || a.re !== re || typeof a.text !== 'string') return null;
  return { v: 1, re, text: a.text.slice(0, MAX_ANSWER) };
}

// ---------- what's kept (extension storage)

export interface KV {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
type Kept = { link: string; pub: string; priv: string };

// On for this link only.
export const isOn = async (kv: KV, link: string) => (await kv.get([K.on]))[K.on] === link;

export async function forget(kv: KV) {
  await kv.remove([K.on, K.key]);
}

async function keyFor(kv: KV, link: string): Promise<Kept> {
  const got = (await kv.get([K.key]))[K.key] as Kept | undefined;
  if (got?.link === link && got.pub && got.priv) return got;
  const pair = (await crypto.subtle.generateKey(CURVE, true, ['deriveBits'])) as CryptoKeyPair;
  const kept = { link, pub: toB64url(await crypto.subtle.exportKey('raw', pair.publicKey)), priv: toB64url(await crypto.subtle.exportKey('pkcs8', pair.privateKey)) };
  await kv.set({ [K.key]: kept });
  return kept;
}

async function privateKey(kv: KV, link: string): Promise<CryptoKey | null> {
  const got = (await kv.get([K.key]))[K.key] as Kept | undefined;
  if (got?.link !== link || !got.priv) return null;
  try {
    return await crypto.subtle.importKey('pkcs8', fromB64url(got.priv), CURVE, false, ['deriveBits']);
  } catch {
    return null;
  }
}

// ---------- Arise's requests

export interface GeminiEnv {
  local: KV;
  now(): number;
  link(): Promise<{ id: string; pub: string; origin: string } | null>;
  granted(): Promise<boolean>; // gemini.google.com is allowed
  revoke(): Promise<void>; // gives that permission back
  openAllow(): Promise<void>; // the extension's window that asks for it
  run(prompt: string, o: { json: boolean }): Promise<{ ok: true; text: string } | { ok: false; error: AskError }>;
}

async function status(env: GeminiEnv, link: string) {
  const on = await isOn(env.local, link);
  const granted = on && (await env.granted().catch(() => false));
  return { ok: true, on, granted, ...(on && granted ? { gkey: (await keyFor(env.local, link)).pub } : {}) };
}

let busy = false; // one question at a time: there's one Gemini tab

export async function pageRequest(env: GeminiEnv, req: GeminiRequest, origin: string): Promise<unknown> {
  const link = await env.link();
  if (!link || link.origin !== origin || link.id !== req.link) return { ok: false, error: 'not-linked' };
  if (req.t === 'geminiStatus') return status(env, link.id);
  if (req.t === 'geminiOn') {
    if (!req.on) {
      await forget(env.local);
      await env.revoke().catch(() => {});
      return status(env, link.id);
    }
    await env.local.set({ [K.on]: link.id });
    await keyFor(env.local, link.id);
    if (!(await env.granted().catch(() => false))) await env.openAllow().catch(() => {});
    return status(env, link.id);
  }
  if (!(await isOn(env.local, link.id))) return { ok: false, error: 'off' };
  if (!(await env.granted().catch(() => false))) return { ok: false, error: 'no-permission' };
  if (req.box.link !== link.id) return { ok: false, error: 'bad' };
  const key = await privateKey(env.local, link.id);
  if (!key) return { ok: false, error: 'no-key' };
  let q: Question | null;
  try {
    q = parseQuestion(await openBatch(key, req.box));
  } catch {
    q = null;
  }
  if (!q) return { ok: false, error: 'bad' };
  if (busy) return { ok: false, error: 'busy' };
  busy = true;
  try {
    const r = await env.run(q.prompt, { json: q.json }).catch(() => ({ ok: false as const, error: 'tab' as const }));
    if (!r.ok) return r;
    const text = r.text.slice(0, MAX_ANSWER);
    if (!text.trim()) return { ok: false, error: 'empty' };
    const now = env.now();
    const answer: Answer = { v: 1, re: req.box.id, text };
    return { ok: true, box: await sealBatch(link.pub, link.id, { id: req.box.id, from: now, to: now, n: 1 }, answer) };
  } finally {
    busy = false;
  }
}

// ---------- the Gemini tab

export interface PortLike {
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: { addListener(f: (msg: unknown) => void): void };
  onDisconnect: { addListener(f: () => void): void };
}

// Asks the page's script over its port, and waits for its answer: never longer than `timeout`,
// and a page that goes away (closed, or moved to another site) ends it at once.
export function askOverPort(port: PortLike, prompt: string, { json = false, timeout = ANSWER_FOR + LOAD_FOR } = {}): Promise<{ ok: true; text: string } | { ok: false; error: AskError }> {
  return new Promise((resolve) => {
    let done = false;
    const end = (r: { ok: true; text: string } | { ok: false; error: AskError }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => end({ ok: false, error: 'timeout' }), timeout);
    port.onMessage.addListener((m) => {
      const r = m as { t?: string; text?: unknown; error?: unknown };
      if (r?.t === 'done' && typeof r.text === 'string') end({ ok: true, text: r.text.slice(0, MAX_ANSWER) });
      else if (r?.t === 'fail') end({ ok: false, error: (['no-box', 'no-send', 'timeout', 'empty', 'busy'].includes(r.error as string) ? r.error : 'tab') as AskError });
    });
    port.onDisconnect.addListener(() => end({ ok: false, error: 'tab' }));
    port.postMessage({ t: 'ask', prompt, json, timeout: ANSWER_FOR });
  });
}
