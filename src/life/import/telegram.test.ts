import { describe, expect, it } from 'vitest';
import { parseTelegram, textOf } from './telegram';
import { onePart } from './chat';
import { DETAIL_MAX } from './whatsapp';
import { classify, detect, importFile } from './index';
import { fileOf, input, run, titles, wellFormed, zipBlob } from '../../test/life-fixtures';
import type { LifeEvent } from '../types';

// Noon UTC, so the day is the same on any clock the tests run on.
const at = (d: number, h = 12, m = 0) => Date.UTC(2024, 0, d, h, m);
const unix = (ms: number) => String(ms / 1000);
const msg = (id: number, ms: number, from: string, fromId: string, text: unknown) => ({ id, type: 'message', date: new Date(ms).toISOString().slice(0, 19), date_unixtime: unix(ms), from, from_id: fromId, text });

const full = JSON.stringify(
  {
    about: 'Here is the data you requested.',
    personal_information: { user_id: 900, first_name: 'Sam', last_name: 'Tester', about: 'x' },
    contacts: { about: 'x', list: [{ first_name: 'Anna', last_name: '', date: '2020-01-01T00:00:00' }] },
    chats: {
      about: 'x',
      list: [
        {
          name: 'Anna Example',
          type: 'personal_chat',
          id: 111,
          messages: [
            msg(1, at(13), 'Anna Example', 'user111', 'Hey! Gym tomorrow?'),
            msg(2, at(13, 12, 5), 'Sam Tester', 'user900', ['Yes, at ', { type: 'bold', text: '7' }]),
            { id: 3, type: 'service', date: '2024-01-13T13:00:00', date_unixtime: unix(at(13, 13)), actor: 'Sam Tester', actor_id: 'user900', action: 'phone_call', duration_seconds: 300, discard_reason: 'hangup' },
            { id: 4, type: 'service', date: '2024-01-14T09:00:00', date_unixtime: unix(at(14, 9)), actor: 'Anna Example', actor_id: 'user111', action: 'phone_call', discard_reason: 'missed' },
            msg(5, at(14), 'Anna Example', 'user111', { weird: true }),
          ],
        },
        {
          name: 'Climbing club',
          type: 'private_supergroup',
          id: 222,
          messages: [msg(1, at(15), 'Ben Sample', 'user333', 'Who is in?'), { id: 2, type: 'service', date_unixtime: unix(at(15, 12, 1)), actor: 'Ben Sample', action: 'invite_members' }, msg(3, at(15, 12, 2), 'Sam Tester', 'user900', 'Me')],
        },
        { name: 'News', type: 'public_channel', id: 333, messages: [msg(1, at(15), 'News', 'channel333', 'Headline')] },
        { name: 'Saved Messages', type: 'saved_messages', id: 900, messages: [msg(1, at(15), 'Sam Tester', 'user900', 'note to self')] },
      ],
    },
  },
  null,
  1,
);

const single = JSON.stringify({ name: 'Anna Example', type: 'personal_chat', id: 111, messages: [msg(7, at(20), 'Anna Example', 'user111', 'Hi'), msg(8, at(20, 13), 'Sam Tester', 'user900', 'Hello')] });

describe('Telegram', () => {
  it('reads a full export: one event per chat per day, calls as calls, no channels', async () => {
    const { events } = await run(parseTelegram(onePart(input('result.json', full))));
    expect(events.every(wellFormed)).toBe(true);
    const messages = events.filter((e) => e.kind === 'message');
    expect(titles(messages)).toEqual(['Chatted with Anna Example on Telegram: 2 messages', 'Chatted with Anna Example on Telegram: 1 message', 'Chatted with Climbing club on Telegram: 2 messages']);
    expect(messages[0]).toMatchObject({ source: 'telegram', kind: 'message', tier: 3, value: 2, unit: 'messages', at: at(13), end: at(13, 12, 5), meta: { chat: 'Anna Example', sent: 1, received: 1 } });
    expect(messages[0].detail).toBe('Anna Example: Hey! Gym tomorrow? · You: Yes, at 7');
    expect(messages[2].detail).toBe('Ben Sample: Who is in? · You: Me');
    const calls = events.filter((e) => e.kind === 'call');
    expect(titles(calls)).toEqual(['Called Anna Example on Telegram (5 min)', 'Missed call from Anna Example on Telegram']);
    expect(calls[0]).toMatchObject({ tier: 3, at: at(13, 13), end: at(13, 13) + 300000, value: 300, unit: 's', meta: { direction: 'out', missed: false } });
    expect(calls[1].meta).toMatchObject({ direction: 'in', missed: true });
    expect(events.some((e) => /News|note to self/.test(`${e.title} ${e.detail}`))).toBe(false);
  });

  it('reads one chat exported on its own, and knows the Player from who the chat is with', async () => {
    const { events } = await run(parseTelegram(onePart(input('result.json', single, 5))));
    expect(titles(events)).toEqual(['Chatted with Anna Example on Telegram: 2 messages']);
    expect(events[0].meta).toMatchObject({ sent: 1, received: 1 });
    expect(events[0].detail).toBe('Anna Example: Hi · You: Hello');
  });

  it('gives the same ids every time and keeps the detail short', async () => {
    const a = await run(parseTelegram(onePart(input('result.json', full, 3))));
    const b = await run(parseTelegram(onePart(input('result.json', full))));
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
    expect(new Set(a.events.map((e) => e.id)).size).toBe(a.events.length);
    const long = JSON.stringify({ name: 'Anna', type: 'personal_chat', id: 1, messages: Array.from({ length: 50 }, (_, i) => msg(i, at(3, 10, i), 'Anna', 'user1', 'word '.repeat(60))) });
    const { events } = await run(parseTelegram(onePart(input('result.json', long))));
    expect(events[0].value).toBe(50);
    expect(events[0].detail!.length).toBeLessThanOrEqual(DETAIL_MAX);
    expect((await run(parseTelegram(onePart(input('result.json', '{}'))))).events).toEqual([]);
    expect((await run(parseTelegram(onePart(input('result.json', '{"chats": {"list": [ {"name": "x", "messages": [ {"broken'))))).events).toEqual([]);
  });

  it('reads Telegram text with links and formatting', () => {
    expect(textOf('plain')).toBe('plain');
    expect(textOf(['see ', { type: 'link', text: 'example.com' }, '!'])).toBe('see example.com!');
    expect(textOf(null)).toBe('');
  });

  it('is found on its own and in a zip, and brought in through importFile', async () => {
    expect(classify('result.json', full.slice(0, 8192), false)).toBe('telegram');
    expect(classify('result.json', single, false)).toBe('telegram');
    const d = await detect(fileOf([zipBlob({ 'Telegram Desktop/DataExport_2024-01-20/result.json': full })], 'telegram.zip'));
    expect(d.found.map((f) => [f.kind, f.label])).toEqual([['telegram', 'Telegram chats']]);
    const got: LifeEvent[] = [];
    const how: (boolean | undefined)[] = [];
    const r = await importFile(fileOf([full], 'result.json'), { onEvents: (b, h) => (got.push(...b), how.push(h?.replace)) });
    expect(r.labels).toEqual(['Telegram chats']);
    expect(r.found).toBe(5);
    expect(got.length).toBe(5);
    expect(how.every(Boolean)).toBe(true); // a day's count: a newer export replaces it
  });
});
