import { describe, expect, it } from 'vitest';
import { claudeConversation, listClaude, parseClaude } from './claude';
import { conversationEvents, detailOf } from './ai-chat';
import { DETAIL_MAX } from './whatsapp';
import { input, run, wellFormed } from '../../test/life-fixtures';
import { cleanLifeEvent } from '../../lib/validate';

// Noon UTC, so the day is the same on any clock the tests run on.
const iso = (d: number, h = 12, m = 0) => new Date(Date.UTC(2024, 4, d, h, m)).toISOString().replace('Z', '000Z');

const claudeExport = JSON.stringify([
  {
    uuid: 'conv-trip',
    name: 'Trip ideas',
    created_at: iso(1),
    updated_at: iso(2),
    account: { uuid: 'acc' },
    chat_messages: [
      { uuid: 'm1', sender: 'human', text: 'Where should I go in June?', content: [{ type: 'text', text: 'Where should I go in June?' }], created_at: iso(1) },
      { uuid: 'm2', sender: 'assistant', text: 'Some ideas.', content: [{ type: 'text', text: 'Some ideas.' }], created_at: iso(1, 12, 1) },
      // Older exports: text only, no content.
      { uuid: 'm3', sender: 'human', text: 'And somewhere warm?', created_at: iso(1, 12, 5) },
      { uuid: 'm4', sender: 'assistant', text: 'Here are some.', created_at: iso(1, 12, 6) },
      // An attachment with no words: left out.
      { uuid: 'm5', sender: 'human', text: '', content: [{ type: 'image' }], created_at: iso(1, 12, 7) },
      { uuid: 'm6', sender: 'human', text: '', content: [{ type: 'text', text: 'Back again: what about July?' }, { type: 'tool_use', name: 'x' }], created_at: iso(2) },
      { uuid: 'm7', sender: 'assistant', content: [{ type: 'text', text: 'July works.' }], created_at: iso(2, 12, 1) },
    ],
  },
  { uuid: 'conv-empty', name: '', created_at: iso(3), updated_at: iso(3), chat_messages: [] },
  { uuid: 'conv-untitled', name: '', created_at: iso(4), updated_at: iso(4), chat_messages: [{ sender: 'human', text: 'Help me plan a birthday party for my sister', created_at: iso(4) }] },
  { name: 'No id', chat_messages: [{ sender: 'human', text: 'x', created_at: iso(5) }] },
]);

describe('Claude', () => {
  it('reads a conversation: the Player’s words and the AI’s, with pieces of text or text alone', () => {
    const c = claudeConversation(JSON.parse(claudeExport)[0])!;
    expect(c.id).toBe('conv-trip');
    expect(c.title).toBe('Trip ideas');
    expect(c.messages.map((m) => [m.me, m.text])).toEqual([
      [true, 'Where should I go in June?'],
      [false, 'Some ideas.'],
      [true, 'And somewhere warm?'],
      [false, 'Here are some.'],
      [true, 'Back again: what about July?'],
      [false, 'July works.'],
    ]);
    expect(claudeConversation({ name: 'x' })).toBeNull();
    expect(claudeConversation({ chat_messages: [] })).toBeNull();
  });

  it('makes one event per conversation per day, with the title, the questions and the id', async () => {
    const { events } = await run(parseClaude(input('conversations.json', claudeExport)));
    expect(events.every(wellFormed)).toBe(true);
    expect(events.map((e) => [e.title, e.value, e.meta?.conv, e.meta?.day])).toEqual([
      ['Chatted with Claude: Trip ideas', 4, 'conv-trip', '2024-05-01'],
      ['Chatted with Claude: Trip ideas', 2, 'conv-trip', '2024-05-02'],
      ['Chatted with Claude: Help me plan a birthday party for my sister', 1, 'conv-untitled', '2024-05-04'],
    ]);
    const first = events[0];
    expect(first).toMatchObject({ source: 'claude', kind: 'message', tier: 3, unit: 'messages', at: Date.UTC(2024, 4, 1, 12), end: Date.UTC(2024, 4, 1, 12, 6) });
    expect(first.meta).toMatchObject({ chat: 'Trip ideas', sent: 2, received: 2 });
    expect(first.detail).toBe('4 messages, 2 from you. You asked: Where should I go in June? · And somewhere warm?');
    // The AI's answers never go in.
    expect(events.map((e) => e.detail).join(' ')).not.toContain('Some ideas');
    // Every event passes the life log's own check as it is.
    for (const e of events) expect(cleanLifeEvent(e)).toEqual(e);
    // The same file again gives the same ids.
    const again = await run(parseClaude(input('conversations.json', claudeExport, 7)));
    expect(again.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it('lists every conversation for the picker, newest first, and reads only the ones picked', async () => {
    expect(await listClaude(input('conversations.json', claudeExport))).toEqual([
      { id: 'conv-untitled', title: 'Help me plan a birthday party for my sister', at: Date.UTC(2024, 4, 4, 12), n: 1 },
      { id: 'conv-trip', title: 'Trip ideas', at: Date.UTC(2024, 4, 2, 12, 1), n: 6 },
    ]);
    const { events } = await run(parseClaude(input('conversations.json', claudeExport), ['conv-untitled']));
    expect(events.map((e) => e.meta?.conv)).toEqual(['conv-untitled']);
  });

  it('keeps the questions within the limits the other chats use', () => {
    const long = 'word '.repeat(100);
    const msgs = Array.from({ length: 30 }, (_, i) => ({ at: Date.UTC(2024, 0, 1, 12, i), me: i % 2 === 0, text: `${i} ${long}` }));
    const [e] = conversationEvents('claude', 'Claude', { id: 'x', title: 't'.repeat(400), messages: msgs });
    expect(e.detail!.length).toBeLessThanOrEqual(DETAIL_MAX);
    expect(e.detail!.startsWith('30 messages, 15 from you. You asked: 0 word')).toBe(true);
    expect(e.title.length).toBeLessThanOrEqual(300);
    expect(detailOf(2, 0, [])).toBe('2 messages, 0 from you.');
    expect(detailOf(1, 1, ['Hi'])).toBe('1 message, 1 from you. You asked: Hi');
  });
});
