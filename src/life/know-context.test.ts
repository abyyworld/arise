// @vitest-environment jsdom
// "Never send to an AI" with the real coach (ai.js) and me links (me.ts): a fact held back is in
// no request any AI gets, whatever the settings, and in no app's page. The notes in the parts of
// life reach the coach, key ones first.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));
vi.mock('../ai-config', () => ({ PRIVATE_AI: { proxy: 'https://ai.example.workers.dev/v1/', model: 'gpt-oss-120b', name: 'Private AI' } }));
vi.setConfig({ testTimeout: 20_000 });

const T = (k: string, h = 12) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h).getTime();
};

async function load() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  const S = await import('../store');
  const AI = await import('../ai.js');
  const L = await import('./log');
  const M = await import('./memory');
  const P = await import('./policy');
  const AN = await import('./area-notes');
  AI.connectAccount({ signedIn: () => true, idToken: async () => 'token' });
  M.initMemory({ delay: -1 });
  S.state.settings.aiEngine = 'free';
  AI.agreeFree();
  P.setPrefs({ lessPrivate: true }); // the free AI may read everything
  await L.addEvents([{ id: 'manual:n1', source: 'manual', kind: 'note', at: T('2026-10-16', 9), title: 'Walked Rex', detail: 'Walked Rex in the park', tier: 2 }]);
  return { S, AI, L, M, P, AN };
}

// Every request the free AI gets, as sent; memory requests get a JSON answer.
function stub() {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    const body = JSON.parse(init.body);
    const memory = body.messages.some((m: { content: string }) => String(m.content).includes('You keep the memory of Arise'));
    const content = memory ? JSON.stringify({ summary: 'You walked Rex.', facts: [], confirm: [] }) : 'Answer.';
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
  return bodies;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('never send to an AI', () => {
  it('keeps the fact out of the coach, the memory and every app, and the area notes go to the coach', async () => {
    const { AI, M, AN } = await load();
    const bodies = stub();
    const held = (await M.addFact('You have asthma.'))!;
    await M.addFact('You walk Rex every morning.');
    await M.flagFact(held.id, { noAI: true });
    await M.putAreaNotes([AN.makeNote({ areas: ['work'], title: 'Drone EduTrain launch', key: true }, '2026-10-10', Date.now())!, AN.makeNote({ areas: ['fun'], title: 'Guitar lessons' }, '2026-10-12', Date.now())!]);

    await AI.chat('What do you know about my health?');
    await M.learn({ days: ['2026-10-16'] });
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const b of bodies) expect(b).not.toContain('asthma');
    const chat = bodies.find((b) => b.includes('## What Arise knows about the Player'))!;
    expect(chat).toContain('You walk Rex every morning.');
    expect(chat).toContain('## Their life areas');
    expect(chat.indexOf('Drone EduTrain launch')).toBeLessThan(chat.indexOf('Guitar lessons'));

    // About me and me links (apps, AI apps on the web among them).
    const ME = await import('../me');
    const facts = (await ME.source()).facts.map((f) => f.text);
    expect(facts).toContain('You walk Rex every morning.');
    expect(facts.join(' ')).not.toContain('asthma');
  });
});
