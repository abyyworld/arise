import { describe, expect, it } from 'vitest';
import { parseX } from './x';
import { onePart } from './chat';
import { classify, detect, importFile } from './index';
import { fileOf, input, run, titles, wellFormed, zipBlob } from '../../test/life-fixtures';
import type { LifeEvent } from '../types';

const iso = (d: number, h = 12, m = 0) => new Date(Date.UTC(2024, 0, d, h, m)).toISOString();
const ytd = (name: string, v: unknown) => `window.YTD.${name}.part0 = ${JSON.stringify(v, null, 2)}`;
const create = (from: string, to: string | null, d: number, h: number, text: string) => ({ messageCreate: { ...(to ? { recipientId: to } : {}), reactions: [], urls: [], text, mediaUrls: [], senderId: from, id: `${d}${h}${from}`, createdAt: iso(d, h) } });

const dms = ytd('direct_messages', [
  { dmConversation: { conversationId: '111-222', messages: [create('222', '111', 13, 13, 'Thanks!'), create('111', '222', 13, 12, 'Here is the link')] } },
  { dmConversation: { conversationId: '111-333', messages: [create('333', '111', 14, 12, 'Hi Sam')] } },
]);
const groups = ytd('direct_messages_group', [
  {
    dmConversation: {
      conversationId: '1500000000000000000',
      messages: [
        create('444', null, 15, 13, 'Saturday?'),
        { conversationNameUpdate: { initiatingUserId: '111', name: 'Weekend plans', createdAt: iso(15, 11) } },
        { joinConversation: { initiatingUserId: '111', participantsSnapshot: ['111', '444'], createdAt: iso(15, 10) } },
      ],
    },
  },
]);
const account = ytd('account', [{ account: { email: 'someone@example.com', username: 'samtester', accountId: '111', accountDisplayName: 'Sam' } }]);

describe('X (Twitter)', () => {
  it('reads one-to-one and group messages from the archive, with the account saying who the Player is', async () => {
    const zip = zipBlob({ 'data/direct-messages.js': dms, 'data/direct-messages-group.js': groups, 'data/account.js': account, 'data/tweets.js': ytd('tweets', []), 'data/direct-message-headers.js': ytd('direct_message_headers', []) });
    const d = await detect(fileOf([zip], 'twitter-2024-01-20.zip'));
    expect(d.found.map((f) => [f.kind, f.label])).toEqual([['x-messages', 'X messages']]);
    expect(d.found[0].parts).toEqual(['data/account.js', 'data/direct-messages-group.js', 'data/direct-messages.js']);
    const got: LifeEvent[] = [];
    await importFile(fileOf([zip], 'twitter-2024-01-20.zip'), { detection: d, onEvents: (b) => void got.push(...b) });
    expect(got.every(wellFormed)).toBe(true);
    expect(titles(got)).toEqual(['Chatted with X user 222 on X: 2 messages', 'Chatted with X user 333 on X: 1 message', 'Chatted with Weekend plans on X: 1 message']);
    expect(got[0]).toMatchObject({ source: 'x', kind: 'message', tier: 3, meta: { chat: 'X user 222', sent: 1, received: 1 } });
    expect(got[0].detail).toBe('You: Here is the link · X user 222: Thanks!');
    expect(JSON.stringify(got)).not.toContain('example.com');
  });

  it('works out the Player without the account file, and reads a messages file on its own', async () => {
    expect(classify('direct-messages.js', dms, false)).toBe('x-messages');
    const { events } = await run(parseX(onePart(input('direct-messages.js', dms))));
    expect(events.map((e) => e.meta?.chat)).toEqual(['X user 222', 'X user 333']);
    const one = await run(parseX(onePart(input('direct-messages.js', ytd('direct_messages', [{ dmConversation: { conversationId: '111-222', messages: [create('222', '111', 13, 13, 'Thanks!')] } }])))));
    expect(one.events[0].title).toBe('Chatted with someone on X: 1 message');
    expect(one.events[0].meta?.sent).toBeUndefined();
  });

  it('reads the older file names and split files', async () => {
    const zip = zipBlob({ 'data/direct-message.js': dms, 'data/direct-messages-part1.js': ytd('direct_messages', [{ dmConversation: { conversationId: '111-555', messages: [create('555', '111', 16, 12, 'Later')] } }]) });
    const d = await detect(fileOf([zip], 'archive.zip'));
    expect(d.found[0].parts).toEqual(['data/direct-message.js', 'data/direct-messages-part1.js']);
    const got: LifeEvent[] = [];
    await importFile(fileOf([zip], 'archive.zip'), { detection: d, onEvents: (b) => void got.push(...b) });
    expect(got.length).toBe(3);
  });
});
