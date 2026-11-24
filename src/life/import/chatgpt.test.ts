import { describe, expect, it } from 'vitest';
import { chatgptConversation, listChatGPT, parseChatGPT } from './chatgpt';
import { input, run, wellFormed } from '../../test/life-fixtures';

// Noon UTC, in seconds with a fraction, as ChatGPT writes them.
const t = (d: number, m = 0) => Date.UTC(2024, 2, d, 12, m) / 1000 + 0.25;
const ms = (d: number, m = 0) => Date.UTC(2024, 2, d, 12, m) + 250;

const node = (id: string, parent: string | null, children: string[], message: unknown) => ({ id, parent, children, message });
const msg = (role: string, text: unknown[] | null, time: number | null, extra: Record<string, unknown> = {}) => ({
  id: `m-${role}`,
  author: { role },
  create_time: time,
  content: text === null ? { content_type: 'code', text: 'print(1)' } : { content_type: 'text', parts: text },
  ...extra,
});

// A tree: the first answer was asked again (a branch), and the Player went on from the second one.
const chatgptExport = JSON.stringify([
  {
    title: 'Running plan',
    create_time: t(10),
    update_time: t(11),
    id: 'conv-run',
    current_node: 'f',
    mapping: {
      root: node('root', null, ['sys'], null),
      sys: node('sys', 'root', ['a'], msg('system', [''], null)),
      a: node('a', 'sys', ['b1', 'b2'], msg('user', ['How do I start running?'], t(10))),
      b1: node('b1', 'a', [], msg('assistant', ['First answer, not chosen.'], t(10, 1))),
      b2: node('b2', 'a', ['c'], msg('assistant', ['Start slow.'], t(10, 2))),
      c: node('c', 'b2', ['d'], msg('user', ['', 'How far in week one?'], t(11))),
      d: node('d', 'c', ['e'], msg('tool', ['search results'], t(11, 1))),
      e: node('e', 'd', ['f'], msg('assistant', null, t(11, 2))),
      f: node('f', 'e', [], msg('assistant', ['About 5 km.'], t(11, 3))),
      hidden: node('hidden', 'root', [], msg('user', ['custom instructions'], t(10), { metadata: { is_visually_hidden_from_conversation: true } })),
    },
  },
  // No current node: the thread ends at the latest leaf. The id is in conversation_id.
  {
    title: '',
    create_time: t(12),
    conversation_id: 'conv-two',
    mapping: {
      x: node('x', null, ['y'], msg('user', ['What is a tempo run?'], null)),
      y: node('y', 'x', [], msg('assistant', ['A steady hard run.'], t(12, 5))),
    },
  },
]);

describe('ChatGPT', () => {
  it('follows the thread from the current node back to the start, without system, tool or empty parts', () => {
    const c = chatgptConversation(JSON.parse(chatgptExport)[0])!;
    expect(c.id).toBe('conv-run');
    expect(c.messages.map((m) => [m.me, m.text, m.at])).toEqual([
      [true, 'How do I start running?', ms(10)],
      [false, 'Start slow.', ms(10, 2)],
      [true, 'How far in week one?', ms(11)],
      [false, 'About 5 km.', ms(11, 3)],
    ]);
    const two = chatgptConversation(JSON.parse(chatgptExport)[1])!;
    expect(two.id).toBe('conv-two');
    // A message with no time takes the conversation's.
    expect(two.messages.map((m) => [m.me, m.at])).toEqual([
      [true, ms(12)],
      [false, ms(12, 5)],
    ]);
    expect(chatgptConversation({ title: 'x' })).toBeNull();
    expect(chatgptConversation({ mapping: {} })).toBeNull();
  });

  it('makes one event per conversation per day, and lists them for the picker', async () => {
    const { events } = await run(parseChatGPT(input('conversations.json', chatgptExport)));
    expect(events.every(wellFormed)).toBe(true);
    expect(events.map((e) => [e.title, e.value, e.meta?.conv, e.detail])).toEqual([
      ['Chatted with ChatGPT: Running plan', 2, 'conv-run', '2 messages, 1 from you. You asked: How do I start running?'],
      ['Chatted with ChatGPT: Running plan', 2, 'conv-run', '2 messages, 1 from you. You asked: How far in week one?'],
      ['Chatted with ChatGPT: What is a tempo run?', 2, 'conv-two', '2 messages, 1 from you. You asked: What is a tempo run?'],
    ]);
    expect(events[0]).toMatchObject({ source: 'chatgpt', kind: 'message', tier: 3 });
    expect(events.map((e) => e.detail).join(' ')).not.toContain('Start slow');
    expect(await listChatGPT(input('conversations.json', chatgptExport))).toEqual([
      { id: 'conv-two', title: 'What is a tempo run?', at: ms(12, 5), n: 2 },
      { id: 'conv-run', title: 'Running plan', at: ms(11, 3), n: 4 },
    ]);
    const only = await run(parseChatGPT(input('conversations.json', chatgptExport), ['conv-run']));
    expect(new Set(only.events.map((e) => e.meta?.conv))).toEqual(new Set(['conv-run']));
  });
});
