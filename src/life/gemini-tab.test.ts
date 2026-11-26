// @vitest-environment jsdom
// Gemini in your browser, between Arise and the extension: Arise's side (gemini-tab.ts,
// browser-link.ts) with the real extension logic (extension/src/lib/gemini.ts, recorder.ts)
// behind a pretend content script, and a pretend Gemini tab. Off until turned on and allowed;
// the question and the answer are sealed on the way; plain messages when it fails or takes too
// long; turning it off gives the site back.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incoming, Transport } from './browser-link';
import * as R from '../../extension/src/lib/recorder';
import { parseRequest } from '../../extension/src/lib/pairing';

vi.mock('../ai.js', () => ({
  AIError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  useTab: () => {},
}));

const ARISE = 'https://abyyworld.github.io/arise/';
const ORIGIN = 'https://abyyworld.github.io';

function kv(): R.KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    remove: async (keys) => {
      for (const k of keys) data.delete(k);
    },
  };
}

let env: R.Env;
let local: ReturnType<typeof kv>;
let G: typeof import('../../extension/src/lib/gemini');
let BL: typeof import('./browser-link');
let GT: typeof import('./gemini-tab');
let wire: string[] = []; // every message on Arise's page, as sent
let origin = ORIGIN;
const listeners: ((p: Incoming) => void)[] = [];
const tab = {
  granted: false,
  allowOpened: 0,
  revoked: 0,
  asked: [] as { prompt: string; json: boolean }[],
  answer: (_p: string): Promise<{ ok: true; text: string } | { ok: false; error: import('../../extension/src/lib/gemini').AskError }> => Promise.resolve({ ok: true, text: 'Hello from Gemini.' }),
};

const transport: Transport = {
  async ask(msg, timeout = 4000) {
    wire.push(JSON.stringify(msg));
    const copy = structuredClone(msg);
    const g = G.parseGeminiRequest(copy);
    const run = async () => {
      if (g) return G.pageRequest(genv, g, origin);
      const req = parseRequest(copy);
      return req ? R.pageRequest(env, req, origin) : { ok: false, error: 'bad' };
    };
    // As the real page link does: no answer in time is null.
    const r = await Promise.race([run(), new Promise((resolve) => setTimeout(() => resolve(null), timeout))]);
    wire.push(JSON.stringify(r));
    return structuredClone(r);
  },
  onPush: (fn) => void listeners.push(fn),
};

let genv: import('../../extension/src/lib/gemini').GeminiEnv;

async function boot() {
  vi.resetModules();
  G = await import('../../extension/src/lib/gemini');
  BL = await import('./browser-link');
  GT = await import('./gemini-tab');
  (await import('./store-port')).setLifeStore({ addEvents: async (l) => l.length });
  genv = {
    local,
    now: () => Date.now(),
    link: () => R.getLink(env),
    granted: async () => tab.granted,
    revoke: async () => {
      tab.revoked++;
      tab.granted = false;
    },
    openAllow: async () => void tab.allowOpened++,
    run: async (prompt, o) => {
      tab.asked.push({ prompt, json: o.json });
      return tab.answer(prompt);
    },
  };
  await BL.initBrowserLink({ transport, accountKey: async () => null });
  await BL.startLink();
  const s = (await R.popupRequest(env, { t: 'state' })) as R.PopupState;
  await R.popupRequest(env, { t: 'confirm', link: s.pairing!.link });
  await vi.waitFor(() => expect(BL.here()).not.toBeNull());
}

// Turned on in Arise, then allowed in the extension's window.
async function turnOn() {
  expect(await GT.setOn(true)).toBe(true);
  tab.granted = true;
  await GT.check();
}

beforeEach(() => {
  wire = [];
  origin = ORIGIN;
  listeners.length = 0;
  Object.assign(tab, { granted: false, allowOpened: 0, revoked: 0, asked: [], answer: () => Promise.resolve({ ok: true, text: 'Hello from Gemini.' }) });
  local = kv();
  env = {
    now: () => Date.now(),
    local,
    session: kv(),
    history: { search: async () => [], getVisits: async () => [] },
    browser: 'Chrome on macOS',
    version: '1.2.0',
    arise: [ARISE],
    allowed: (o) => o === ORIGIN,
    push: async (p) => {
      for (const fn of listeners) fn(structuredClone(p));
    },
    openConfirm: async () => {},
  };
});

describe('Gemini in your browser, Arise and the extension', () => {
  it('is off until turned on in Arise and allowed in the extension', async () => {
    await boot();
    await GT.check();
    expect(GT.status).toMatchObject({ known: true, on: false, granted: false, gkey: '' });
    expect(GT.ready()).toBe(false);
    await expect(GT.ask('Hi')).rejects.toMatchObject({ code: 'no-ai' });
    expect(tab.asked).toEqual([]);

    expect(await GT.setOn(true)).toBe(true);
    expect(tab.allowOpened).toBe(1); // the extension's own window asks for gemini.google.com
    expect(GT.status).toMatchObject({ on: true, granted: false, gkey: '' });
    expect(GT.ready()).toBe(false);
    tab.granted = true;
    await GT.check();
    expect(GT.status.on && GT.status.granted).toBe(true);
    expect(GT.status.gkey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(GT.ready()).toBe(true);
  });

  it('seals the question and the answer on the way', async () => {
    await boot();
    await turnOn();
    wire = [];
    const question = 'My goal is a 5 km run. Should I rest my knee today?';
    tab.answer = async () => ({ ok: true, text: 'Rest it today, and walk instead.' });
    expect(await GT.ask(question, { json: false })).toBe('Rest it today, and walk instead.');
    expect(tab.asked).toEqual([{ prompt: question, json: false }]); // the extension opened it for the tab
    const all = wire.join('\n');
    expect(all).toContain('"t":"gemini"');
    expect(all).not.toContain('5 km');
    expect(all).not.toContain('knee');
    expect(all).not.toContain('walk instead');
  });

  it('asks for JSON when the answer must be JSON', async () => {
    await boot();
    await turnOn();
    tab.answer = async () => ({ ok: true, text: '{"ok":true}' });
    expect(await GT.ask('Reply with only a JSON object', { json: true })).toBe('{"ok":true}');
    expect(tab.asked.at(-1)!.json).toBe(true);
  });

  it('says plainly what went wrong on the Gemini page', async () => {
    await boot();
    await turnOn();
    const cases: [string, string, RegExp][] = [
      ['no-box', 'tab', /couldn't find where to type on the Gemini page.*signed in/],
      ['no-send', 'tab', /couldn't press send/],
      ['timeout', 'timeout', /didn't answer in time/],
      ['busy', 'busy', /still answering/],
      ['tab', 'tab', /couldn't open Gemini in a tab/],
    ];
    for (const [error, code, msg] of cases) {
      tab.answer = async () => ({ ok: false, error: error as never });
      const err = (await GT.ask('Hi').catch((e) => e)) as { code: string; message: string };
      expect(err.code).toBe(code);
      expect(err.message).toMatch(msg);
      expect(err.message).not.toMatch(/[\u2014\u2013]/);
    }
    tab.answer = async () => ({ ok: true, text: '   ' });
    await expect(GT.ask('Hi')).rejects.toMatchObject({ code: 'format', message: "Gemini's answer was empty. Try again." });
  });

  it('gives up after a while when nothing comes back, and can be stopped', async () => {
    await boot();
    await turnOn();
    // Stopped by the Player while Gemini writes.
    let finish = () => {};
    tab.answer = () => new Promise((resolve) => (finish = () => resolve({ ok: true, text: 'Late.' })));
    const c = new AbortController();
    const p = GT.ask('Hi', { signal: c.signal, timeout: 5000 });
    await vi.waitFor(() => expect(tab.asked).toHaveLength(1));
    c.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted', message: 'Stopped.' });
    finish();
    await new Promise((r) => setTimeout(r, 10));

    tab.answer = () => new Promise(() => {}); // Gemini never finishes
    await expect(GT.ask('Hi', { timeout: 50 })).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining("didn't answer in time") });
    // The extension still waits on that one: the next question is told so.
    await expect(GT.ask('Again')).rejects.toMatchObject({ code: 'busy' });
    expect(GT.WAIT_FOR).toBeGreaterThan(G.TOTAL_FOR); // Arise waits longer than the extension does
  });

  it('only answers the Arise it is linked with', async () => {
    await boot();
    await turnOn();
    origin = 'https://evil.example';
    await expect(GT.ask('Hi')).rejects.toMatchObject({ code: 'no-ai' });
    origin = ORIGIN;
    const h = BL.here()!;
    expect(await h.ask({ t: 'geminiStatus', link: 'x'.repeat(16) })).toEqual({ ok: false, error: 'not-linked' });
    // A question not sealed for the extension's key is refused unopened.
    const { sealBatch } = await import('../../extension/src/lib/seal');
    const { newKeyPair } = await import('../../extension/src/lib/seal');
    const other = await newKeyPair(false);
    const box = await sealBatch(other.pub, h.id, { id: 'q'.repeat(16), from: 1, to: 1, n: 1 }, { v: 1, prompt: 'Hi', json: false });
    expect(await h.ask({ t: 'gemini', link: h.id, box })).toEqual({ ok: false, error: 'bad' });
    expect(tab.asked).toEqual([]);
  });

  it('turns off from Arise: the site permission and the key go', async () => {
    await boot();
    await turnOn();
    expect([...local.data.keys()]).toEqual(expect.arrayContaining(['gemini:on', 'gemini:key']));
    expect(await GT.setOn(false)).toBe(true);
    expect(tab.revoked).toBe(1);
    expect(local.data.has('gemini:on')).toBe(false);
    expect(local.data.has('gemini:key')).toBe(false);
    expect(GT.ready()).toBe(false);
    await expect(GT.ask('Hi')).rejects.toMatchObject({ code: 'no-ai' });
  });

  it('is off again for a new link', async () => {
    await boot();
    await turnOn();
    await boot(); // linked again (the old link goes)
    await GT.check();
    expect(GT.status).toMatchObject({ on: false, gkey: '' });
  });
});

describe("the extension's wait on the Gemini tab", () => {
  function fakePort() {
    const msg: ((m: unknown) => void)[] = [];
    const gone: (() => void)[] = [];
    const p = {
      sent: [] as unknown[],
      disconnected: 0,
      postMessage: (m: unknown) => void p.sent.push(m),
      disconnect: () => void p.disconnected++,
      onMessage: { addListener: (f: (m: unknown) => void) => void msg.push(f) },
      onDisconnect: { addListener: (f: () => void) => void gone.push(f) },
      reply: (m: unknown) => msg.forEach((f) => f(m)),
      close: () => gone.forEach((f) => f()),
    };
    return p;
  }

  beforeEach(async () => {
    G = await import('../../extension/src/lib/gemini');
  });

  it('asks the page, keeps waiting while it says so, and takes its answer', async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const r = G.askOverPort(port, 'Hi', { json: true, timeout: 60_000 });
    expect(port.sent).toEqual([{ t: 'ask', prompt: 'Hi', json: true, timeout: G.ANSWER_FOR }]);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000);
      port.reply({ t: 'wait' });
    }
    port.reply({ t: 'done', text: 'Hello.' });
    await expect(r).resolves.toEqual({ ok: true, text: 'Hello.' });
    expect(port.disconnected).toBe(1);
    vi.useRealTimers();
  });

  it('stops waiting after its time, or when the tab goes', async () => {
    vi.useFakeTimers();
    const a = fakePort();
    const slow = G.askOverPort(a, 'Hi', { timeout: 60_000 });
    a.reply({ t: 'wait' }); // still at it is no answer
    vi.advanceTimersByTime(60_000);
    await expect(slow).resolves.toEqual({ ok: false, error: 'timeout' });
    const b = fakePort();
    const closed = G.askOverPort(b, 'Hi');
    b.close();
    await expect(closed).resolves.toEqual({ ok: false, error: 'tab' });
    const c = fakePort();
    const failed = G.askOverPort(c, 'Hi');
    c.reply({ t: 'fail', error: 'no-box' });
    await expect(failed).resolves.toEqual({ ok: false, error: 'no-box' });
    const d = fakePort();
    const odd = G.askOverPort(d, 'Hi');
    d.reply({ t: 'fail', error: 'something new' });
    await expect(odd).resolves.toEqual({ ok: false, error: 'tab' });
    vi.useRealTimers();
  });

  it('checks every request from the page before anything else', () => {
    const link = 'L'.repeat(16);
    expect(G.parseGeminiRequest({ t: 'geminiStatus', link })).toEqual({ t: 'geminiStatus', link });
    expect(G.parseGeminiRequest({ t: 'geminiOn', link, on: 'yes' })).toBeNull();
    expect(G.parseGeminiRequest({ t: 'gemini', link, box: { v: 1 } })).toBeNull();
    expect(G.parseGeminiRequest({ t: 'gemini', link: 'short' })).toBeNull();
    expect(G.parseGeminiRequest({ t: 'hello' })).toBeNull();
    expect(G.parseQuestion({ v: 1, prompt: 'x'.repeat(G.MAX_PROMPT + 1), json: false })).toBeNull();
    expect(G.parseQuestion({ v: 1, prompt: '  Hi ', json: true })).toEqual({ v: 1, prompt: 'Hi', json: true });
    expect(G.parseAnswer({ v: 1, re: 'a', text: 'Hi' }, 'b')).toBeNull(); // an answer to another question
  });
});
