// @vitest-environment jsdom
// What was sent to an AI (ai-log.ts), through ai.js: every engine's requests land in the log on
// this device, with what they were for, how much went and whether an answer came back; nothing is
// logged when nothing left the device.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const device = { state: 'unavailable' as string };
const deviceAsk = vi.fn(async () => 'Rest well.');
vi.mock('./lib/on-device', () => ({ lastKnown: () => device.state, availability: async () => device.state, ask: (...a: unknown[]) => (deviceAsk as (...x: unknown[]) => Promise<string>)(...a), download: vi.fn() }));
vi.mock('./ai-config', () => ({ PRIVATE_AI: { proxy: 'https://ai.example.workers.dev/v1/', model: 'llama3-3-70b', name: 'Private AI' } }));
vi.mock('tinfoil', () => ({
  SecureClient: class {
    async ready() {}
    getBaseURL() {
      return 'https://ai.example.workers.dev/v1';
    }
    fetch = (url: string, init: RequestInit) => fetch(url, init);
  },
}));

const OLLAMA = 'http://localhost:11434';
const okAnswer = (text = 'Do set 1 now.') => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
function ndjson(text: string) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`${JSON.stringify({ message: { content: text }, done: false })}\n`));
        c.enqueue(enc.encode(`${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' })}\n`));
        c.close();
      },
    }),
  );
}

let failing = false;
const hosts: string[] = [];
function stubFetch() {
  vi.stubGlobal('fetch', async (url: string, init: { body?: string } = {}) => {
    hosts.push(new URL(url).host);
    if (url.startsWith(OLLAMA)) {
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:14b', details: { parameter_size: '14.8B' } }] }));
      return ndjson('From your computer.');
    }
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'llama3-3-70b' }, { id: 'llama-3.3-70b-versatile' }] }));
    if (failing) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 500 });
    expect(init.body).toBeTruthy();
    return okAnswer();
  });
}

async function load({ signedIn = true } = {}) {
  vi.resetModules();
  const S = await import('./store');
  const AI = await import('./ai.js');
  const SENT = await import('./ai-log');
  const Local = await import('./lib/local-ai');
  AI.connectAccount({ signedIn: () => signedIn, idToken: async () => (signedIn ? 'token' : null) });
  return { S, AI, SENT, Local };
}

const fakeTab = () => ({
  ready: () => true,
  prompt: (p: { system: string; context: string; messages: { content: string }[]; note: string }) => ({ text: [p.system, p.context, ...p.messages.map((m) => m.content), p.note].join('\n\n'), fits: true }),
  ask: async () => 'Gemini answers.',
});

beforeEach(() => {
  localStorage.clear();
  device.state = 'unavailable';
  failing = false;
  hosts.length = 0;
  deviceAsk.mockClear();
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('every engine is logged', () => {
  it('the private AI: a chat, with its parts and sizes', async () => {
    const { AI, SENT } = await load();
    expect(SENT.sentList()).toEqual([]);
    await AI.chat('How was my week?');
    const [e] = SENT.sentList();
    expect(e).toMatchObject({ ai: 'private', for: 'chat', answer: 'yes' });
    const names = e.parts.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Arise's instructions (the same each time)", 'Profile', 'Goals', 'Check-ins', 'Your message']));
    expect(e.parts.find((p) => p.name === 'Your message')?.chars).toBe('How was my week?'.length);
    expect(e.chars).toBe(e.parts.reduce((a, p) => a + p.chars, 0));
    expect(e.text).toBeUndefined(); // the full text is off by default
  });

  it('the free AI', async () => {
    const { S, AI, SENT } = await load();
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    await AI.chat('Hi');
    expect(SENT.sentList()[0]).toMatchObject({ ai: 'free', for: 'chat', answer: 'yes' });
  });

  it('your own key, with the service that answered', async () => {
    const { S, AI, SENT } = await load({ signedIn: false });
    AI.addKey({ key: 'gsk_first', model: 'llama-3.3-70b-versatile' });
    S.state.settings.aiEngine = 'own';
    AI.consent('groq');
    await AI.writeMyWay('meet friday 3pm, bring the slides', 'message');
    const [e] = SENT.sentList();
    expect(e).toMatchObject({ ai: 'own', for: 'write', answer: 'yes' });
    expect(e.who).toContain('Groq');
    // Write it my way sends only the notes: no instructions or data from the rest of the app.
    expect(e.parts.map((p) => p.name)).toEqual(['Your notes and writing sample']);
    expect(e.tier).toBeUndefined();
  });

  it('the AI on this device, with only the turns it reads', async () => {
    device.state = 'available';
    const { AI, SENT } = await load({ signedIn: false });
    expect(AI.engine()).toBe('device');
    await AI.chat('Hi there');
    const [e] = SENT.sentList();
    expect(e).toMatchObject({ ai: 'device', for: 'chat', answer: 'yes' });
    expect(deviceAsk).toHaveBeenCalledTimes(1);
    expect(hosts).toEqual([]); // nothing left this device
  });

  it("your computer's AI, with its model", async () => {
    const { AI, SENT, Local } = await load();
    Local.setPrefs({ on: true });
    await AI.initAI();
    expect(AI.engine()).toBe('local');
    await AI.chat('Hi');
    const [e] = SENT.sentList();
    expect(e).toMatchObject({ ai: 'local', for: 'chat', answer: 'yes' });
    expect(e.who).toContain('qwen2.5:14b');
  });

  it('Gemini in your browser, and its Try button', async () => {
    const { S, AI, SENT } = await load();
    AI.useTab(fakeTab());
    S.state.settings.aiEngine = 'tab';
    await AI.chat('Hi');
    expect(await AI.testTab()).toBe('Gemini answers.');
    const list = SENT.sentList();
    expect(list.map((e) => [e.ai, e.for])).toEqual([
      ['tab', 'test'],
      ['tab', 'chat'],
    ]);
    expect(list[0].parts.map((p) => p.name)).toEqual(['A test line']);
  });

  it("a key's Test button", async () => {
    const { S, AI, SENT } = await load({ signedIn: false });
    const k = AI.addKey({ key: 'gsk_first', model: 'llama-3.3-70b-versatile' });
    S.state.settings.aiEngine = 'own';
    AI.consent('groq');
    await AI.testKeyEntry(k!.id);
    expect(SENT.sentList()[0]).toMatchObject({ ai: 'own', for: 'test', answer: 'yes' });
  });

  it('work nobody asked for, with the most private part of the life log that AI may read', async () => {
    device.state = 'available';
    const { AI, SENT } = await load({ signedIn: false });
    AI.useMemory({ cap: () => 3, profile: () => '', profileTier: () => 1, recall: async () => ({ text: '', tier: 1 }) });
    await AI.askRead({ prompt: 'Describe this note: dentist on Tuesday', schema: { type: 'object' }, engine: 'device' }).catch(() => {});
    const [e] = SENT.sentList();
    expect(e).toMatchObject({ ai: 'device', for: 'reads', bg: true, tier: 3 });
    expect(e.parts).toEqual([{ name: 'The note or file to describe', chars: 'Describe this note: dentist on Tuesday'.length }]);
  });

  it('an answer that never came back, and a request that never left', async () => {
    const { S, AI, SENT } = await load();
    failing = true;
    await expect(AI.chat('Hi')).rejects.toBeTruthy();
    const [e] = SENT.sentList();
    expect(e).toMatchObject({ ai: 'private', answer: 'no' });
    expect(e.why).toBeTruthy();

    // No AI at all: nothing is sent, so nothing is logged.
    S.state.settings.aiEngine = 'device';
    await expect(AI.chat('Hi')).rejects.toMatchObject({ code: 'no-ai' });
    expect(SENT.sentList()).toHaveLength(1);
  });
});

describe('the full text', () => {
  it('is kept only once switched on, and only for 7 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 20, 9));
    const { AI, SENT } = await load();
    await AI.chat('First');
    expect(SENT.sentList()[0].text).toBeUndefined();
    SENT.setFullText(true);
    expect(SENT.fullText()).toBe(true);
    await AI.chat('Second, with my words');
    const kept = SENT.sentList()[0];
    expect(kept.text).toContain('Second, with my words');
    expect(kept.text).toContain('## Profile');

    vi.setSystemTime(new Date(2026, 10, 27, 10)); // 7 days and an hour on
    const later = SENT.sentList();
    expect(later).toHaveLength(2); // the list stays
    expect(later.every((e) => e.text === undefined)).toBe(true); // the words go
  });
});
