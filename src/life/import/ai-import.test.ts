// Chats with AI apps (Claude, ChatGPT, Gemini), from their zips: which file is which, the list of
// conversations to pick from, and reading only the ones picked.

import { describe, expect, it } from 'vitest';
import { classify, detect, importFile } from './index';
import { fileOf, zipBlob } from '../../test/life-fixtures';
import type { LifeEvent } from '../types';

const iso = (d: number, h = 12) => new Date(Date.UTC(2024, 4, d, h)).toISOString();
const secs = (d: number, h = 12) => Date.UTC(2024, 4, d, h) / 1000;

const claude = JSON.stringify([
  { uuid: 'c1', name: 'Garden plans', created_at: iso(1), updated_at: iso(1), account: { uuid: 'a' }, chat_messages: [{ sender: 'human', text: 'What grows in shade?', created_at: iso(1) }, { sender: 'assistant', text: 'Ferns.', created_at: iso(1) }] },
  { uuid: 'c2', name: 'Cover letter', created_at: iso(2), updated_at: iso(2), account: { uuid: 'a' }, chat_messages: [{ sender: 'human', text: 'Make this shorter', created_at: iso(2) }] },
]);

const chatgpt = JSON.stringify([
  {
    title: 'Budget',
    create_time: secs(3),
    update_time: secs(3),
    id: 'g1',
    current_node: 'b',
    mapping: {
      a: { id: 'a', parent: null, children: ['b'], message: { author: { role: 'user' }, create_time: secs(3), content: { content_type: 'text', parts: ['How do I save more?'] } } },
      b: { id: 'b', parent: 'a', children: [], message: { author: { role: 'assistant' }, create_time: secs(3), content: { content_type: 'text', parts: ['Track spending.'] } } },
    },
  },
]);

const gemini = JSON.stringify([{ header: 'Gemini Apps', title: 'Prompted how do I fix a bike chain?', time: iso(4), products: ['Gemini Apps'] }]);
const search = JSON.stringify([{ header: 'Search', title: 'Searched for bike chain', titleUrl: 'https://www.google.com/search?q=bike+chain', time: iso(4), products: ['Search'] }]);
const geminiHtml =
  '<html><head><title>My Activity</title></head><body><div class="mdl-grid"><div class="outer-cell mdl-cell"><div class="mdl-grid"><div class="content-cell mdl-cell">Prompted&nbsp;hello?<br>May 5, 2024, 12:00:00 PM UTC<br></div></div></div></div></body></html>';

function memoryStore() {
  const kept = new Map<string, LifeEvent>();
  const replaced: boolean[] = [];
  return {
    kept,
    replaced,
    onEvents(batch: LifeEvent[], how?: { replace?: boolean }) {
      replaced.push(!!how?.replace);
      for (const e of batch) kept.set(e.id, e);
      return batch.length;
    },
  };
}

describe('AI chats: what a file is', () => {
  it('tells the two conversations.json apart by shape, and Gemini from the rest of My Activity', () => {
    expect(classify('conversations.json', claude.slice(0, 8192), true)).toBe('claude');
    expect(classify('conversations.json', chatgpt.slice(0, 8192), true)).toBe('chatgpt');
    expect(classify('Takeout/My Activity/Gemini Apps/MyActivity.json', gemini, true)).toBe('gemini');
    expect(classify('MyActivity.json', gemini, false)).toBe('gemini');
    expect(classify('Takeout/My Activity/Search/MyActivity.json', search, true)).toBe('google-activity');
    expect(classify('Takeout/My Activity/Gemini Apps/MyActivity.html', geminiHtml, true)).toBe('gemini');
    // Other HTML from Takeout is still the HTML that needs exporting again.
    expect(classify('Takeout/My Activity/Search/MyActivity.html', geminiHtml.replace('Prompted', 'Searched'), true)).toBe('html');
    // A Claude list of projects, or ChatGPT's feedback, aren't conversations.
    expect(classify('projects.json', '[{"uuid":"p","name":"x","docs":[]}]', true)).toBeNull();
    expect(classify('message_feedback.json', '[{"id":"f","conversation_id":"c","rating":"thumbsUp"}]', true)).toBeNull();
  });

  it('finds the conversations in each app’s zip and lists them, newest first', async () => {
    const c = await detect(fileOf([zipBlob({ 'conversations.json': claude, 'users.json': '[{"uuid":"a","full_name":"Sam"}]', 'projects.json': '[]' })], 'data-2024-05-10.zip'));
    expect(c.found).toEqual([
      expect.objectContaining({
        kind: 'claude',
        path: 'conversations.json',
        label: 'Claude chats',
        chats: [
          { id: 'c2', title: 'Cover letter', at: Date.UTC(2024, 4, 2, 12), n: 1 },
          { id: 'c1', title: 'Garden plans', at: Date.UTC(2024, 4, 1, 12), n: 2 },
        ],
      }),
    ]);
    const g = await detect(fileOf([zipBlob({ 'conversations.json': chatgpt, 'chat.html': '<html><body>chat</body></html>', 'user.json': '{"id":"u"}', 'message_feedback.json': '[]' })], 'export.zip'));
    expect(g.found.map((f) => [f.kind, f.label, f.chats?.map((x) => x.id)])).toEqual([['chatgpt', 'ChatGPT chats', ['g1']]]);
  });

  it('reads Gemini and the rest of a full Takeout, each as its own part; the JSON is enough when both are there', async () => {
    const d = await detect(
      fileOf(
        [
          zipBlob({
            'Takeout/My Activity/Gemini Apps/MyActivity.json': gemini,
            'Takeout/My Activity/Gemini Apps/MyActivity.html': geminiHtml,
            'Takeout/My Activity/Search/MyActivity.json': search,
          }),
        ],
        'takeout-001.zip',
      ),
    );
    expect(d.found.map((f) => [f.kind, f.path])).toEqual([
      ['gemini', 'Takeout/My Activity/Gemini Apps/MyActivity.json'],
      ['google-activity', 'Takeout/My Activity/Search/MyActivity.json'],
    ]);
    expect(d.html).toBeUndefined();
    const store = memoryStore();
    const r = await importFile(fileOf([zipBlob({ 'Takeout/My Activity/Gemini Apps/MyActivity.json': gemini, 'Takeout/My Activity/Search/MyActivity.json': search })], 'takeout-001.zip'), { onEvents: store.onEvents });
    expect(r.labels).toEqual(['Gemini chats', 'Google activity: Search']);
    expect([...store.kept.values()].map((e) => [e.source, e.title]).sort()).toEqual([
      ['gemini', 'Chatted with Gemini: how do I fix a bike chain?'],
      ['google', 'Searched "bike chain"'],
    ]);

    // HTML only: Gemini is read from it, not turned away.
    const h = await detect(fileOf([zipBlob({ 'Takeout/My Activity/Gemini Apps/MyActivity.html': geminiHtml })], 'takeout.zip'));
    expect(h.problem).toBeUndefined();
    expect(h.found.map((f) => [f.kind, f.chats?.length])).toEqual([['gemini', 1]]);
  });

  it('reads only the conversations picked, as totals a newer export can complete', async () => {
    const file = fileOf([zipBlob({ 'conversations.json': claude })], 'data.zip');
    const detection = await detect(file);
    const store = memoryStore();
    const r = await importFile(file, { detection, chats: ['c1'], onEvents: store.onEvents });
    expect(r.found).toBe(1);
    expect([...store.kept.values()].map((e) => [e.meta?.conv, e.title])).toEqual([['c1', 'Chatted with Claude: Garden plans']]);
    expect(store.replaced).toEqual([true]);
    // All of them when nothing is picked.
    const all = memoryStore();
    await importFile(file, { detection, onEvents: all.onEvents });
    expect([...all.kept.values()].map((e) => e.meta?.conv).sort()).toEqual(['c1', 'c2']);
  });
});
