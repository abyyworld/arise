// @vitest-environment jsdom
// Gemini in your browser as an engine (ai.js askTab, life/gemini-tab.ts): picked only by the
// Player, less private like the free AI and their own keys, so it reads tier 1 of the life log
// unless they allow more, never does work nobody asked for, and never writes the memory.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/on-device', () => ({ lastKnown: () => 'unavailable', availability: async () => 'unavailable', ask: vi.fn(), download: vi.fn() }));
vi.mock('../ai-config', () => ({ PRIVATE_AI: { proxy: 'https://ai.example.workers.dev/v1/', model: 'gpt-oss-120b', name: 'Private AI' } }));

const T = (k: string, h = 12) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h).getTime();
};

// A pretend tab: what it was asked, and what it answers.
function fakeTab() {
  const t = {
    on: true,
    asked: [] as { text: string; json: boolean }[],
    answer: 'Answer from Gemini.',
    ready: () => t.on,
    prompt: (p: import('./gemini-tab').PromptParts) => GT.buildPrompt(p),
    ask: async (text: string, o: { json?: boolean }) => {
      t.asked.push({ text, json: !!o.json });
      return t.answer;
    },
  };
  return t;
}

let GT: typeof import('./gemini-tab');

async function load() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  const S = await import('../store');
  const AI = await import('../ai.js');
  const L = await import('./log');
  const M = await import('./memory');
  const P = await import('./policy');
  GT = await import('./gemini-tab');
  AI.connectAccount({ signedIn: () => true, idToken: async () => 'token' });
  M.initMemory({ delay: -1 });
  const tab = fakeTab();
  AI.useTab(tab); // (in place of gemini-tab.ts's own, which needs the extension)
  await L.addEvents([
    { id: 'arise:quest:2026-10-16:q1', source: 'arise', kind: 'quest', at: T('2026-10-16', 8), title: 'Done: Study Spanish', tier: 1 },
    { id: 'google:s1', source: 'google', kind: 'search', at: T('2026-10-16', 10), title: 'Searched "knee pain after running"', tier: 3 },
  ]);
  return { S, AI, M, P, tab };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Gemini in your browser as the AI coach', () => {
  it('is only used once picked and ready, is less private, and never answers work nobody asked for', async () => {
    const { S, AI, P, tab } = await load();
    expect(AI.engine()).toBe('private'); // ready, but not picked: the app never picks it itself
    S.state.settings.aiEngine = 'tab';
    expect(AI.engine()).toBe('tab');
    expect(AI.isPrivate()).toBe(false);
    expect(AI.ENGINES.tab).toEqual({ name: 'Gemini in your browser', private: false });
    expect(AI.engineLabel()).toContain('your Google account');
    expect(AI.engine({ background: true })).toBeNull();
    expect(AI.ready({ background: true })).toBe(false);
    expect(AI.memoryStrength({ background: true })).toBe('none');
    expect(P.lessPrivate('tab')).toBe(true);
    expect(P.capFor('tab')).toBe(1);
    expect(P.cap()).toBe(1);
    P.setPrefs({ lessPrivate: true });
    expect(P.cap()).toBe(3);
    tab.on = false; // the extension went, or it was turned off there
    expect(AI.engine()).toBeNull();
    expect(P.cap()).toBe(0);
  });

  it('keeps the choice on this device, checked like every setting', async () => {
    const { S } = await load();
    const V = await import('../lib/validate');
    expect(V.cleanSettings({ ...S.DEFAULT_SETTINGS, aiEngine: 'tab' }, S.DEFAULT_SETTINGS).aiEngine).toBe('tab');
    expect(V.cleanSettings({ ...S.DEFAULT_SETTINGS, aiEngine: 'gemini' }, S.DEFAULT_SETTINGS).aiEngine).toBe('');
  });

  it("sends tier 1 of the life log only, and everything once the Player allows less private AIs", async () => {
    const { S, AI, M, P, tab } = await load();
    S.state.settings.aiEngine = 'tab';
    await M.addFact('I have asthma.'); // the Player's own: tier 2
    await AI.chat('Did I search for knee pain?');
    const first = tab.asked.at(-1)!.text;
    expect(first).toContain('Did I search for knee pain?');
    expect(first).toContain('Instructions from the Arise app');
    expect(first).toContain("## From the Player's life log");
    expect(first).not.toContain('Searched "knee pain after running"');
    expect(first).not.toContain('asthma');
    expect(S.state.ai.chat.at(-1)).toMatchObject({ role: 'assistant', text: 'Answer from Gemini.' });

    P.setPrefs({ lessPrivate: true });
    await AI.chat('And yesterday?');
    const second = tab.asked.at(-1)!.text;
    expect(second).toContain('Searched "knee pain after running"');
    expect(second).toContain('I have asthma.');
    expect(second).toContain('Our conversation so far:');
    expect(second).toContain('Me: Did I search for knee pain?');
  });

  it('never hands it a reply made from what it may not read', async () => {
    const { S, AI, tab } = await load();
    // A reply made from tier 3 (by an AI that may read it) stays out of what Gemini gets.
    const CH = await import('../lib/chats');
    const id = CH.newChatId();
    S.state.ai.chat.push(
      CH.inChat({ role: 'user', text: 'What did I search?', at: Date.now() }, id) as never,
      CH.inChat({ role: 'assistant', text: 'You searched "knee pain after running".', at: Date.now(), tier: 3 }, id) as never,
    );
    S.state.settings.aiEngine = 'tab';
    await AI.chat('What should I do about it?', { chat: id });
    const text = tab.asked.at(-1)!.text;
    expect(text).not.toContain('knee pain');
    expect(text).toContain(AI.HIDDEN_REPLY);
  });

  it('asks for JSON in the question and reads it as the other engines do', async () => {
    const { S, AI, tab } = await load();
    S.state.settings.aiEngine = 'tab';
    tab.answer = '```json\n{"options":[{"name":"Walk","costs":"20 minutes","gains":"Better sleep"},{"name":"Run","costs":"Sore knees","gains":"Fitness"}],"pick":"Walk","why":"Your knee hurts.","unknown":""}\n```';
    const out = await AI.adviseDecision('Walk or run tonight?');
    expect(tab.asked.at(-1)).toMatchObject({ json: true });
    expect(tab.asked.at(-1)!.text).toContain('Reply with only a JSON object');
    expect(out.options.map((o: { name: string }) => o.name)).toEqual(['Walk', 'Run']);
    expect(out.pick).toBe('Walk');

    tab.answer = 'Sure! Walking sounds lovely.';
    await expect(AI.adviseDecision('Walk or run tonight?')).rejects.toMatchObject({ code: 'format', message: "Gemini sent an answer the app couldn't read. Try again." });
  });

  it('never writes the memory or does work by itself', async () => {
    const { S, AI, tab } = await load();
    S.state.settings.aiEngine = 'tab';
    await expect(AI.askMemory({ instructions: 'Sum up the day.', prompt: 'Day', schema: { type: 'object' }, signal: undefined, engine: undefined })).rejects.toMatchObject({ code: 'no-ai', message: AI.TAB_WAITS });
    await expect(AI.dailyBriefing({ background: true })).rejects.toBeTruthy();
    expect(tab.asked).toEqual([]);
  });

  it('says plainly how much it gets, and fits it in one message', async () => {
    await load();
    const long = 'x'.repeat(40_000);
    const messages = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
    messages.push({ role: 'user', content: 'The question.' });
    const p = GT.buildPrompt({ system: 'Be kind.', context: long, messages });
    expect(p.fits).toBe(false);
    expect(p.text.length).toBeLessThanOrEqual(GT.TARGET);
    expect(p.text).toContain('My message:\nThe question.');
    const short = GT.buildPrompt({ system: 'Be kind.', context: 'Goal: run 5 km.', messages });
    expect(short.fits).toBe(true);
    expect(short.text).not.toContain('turn 0'); // only the latest turns
    expect(short.text).toContain('turn 13');
    expect(GT.buildPrompt({ messages: [{ role: 'user', content: 'Hi' }], note: ' (JSON)' })).toEqual({ text: 'Hi (JSON)', fits: true });
  });
});
