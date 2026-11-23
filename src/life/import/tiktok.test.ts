import { describe, expect, it } from 'vitest';
import { parseTikTok, tiktokChat } from './tiktok';
import { onePart } from './chat';
import { detect, importFile } from './index';
import { fileOf, input, run, titles, wellFormed, zipBlob } from '../../test/life-fixtures';
import type { LifeEvent } from '../types';

const t = (d: number, h = 12, m = 0) => `2024-01-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
const at = (d: number, h = 12, m = 0) => Date.UTC(2024, 0, d, h, m);

const data = JSON.stringify(
  {
    Activity: { 'Video Browsing History': { VideoList: [{ Date: t(1), Link: 'https://www.tiktokv.com/share/video/1/' }] } },
    'Direct Message': {
      'Direct Messages': {
        ChatHistory: {
          'Chat History with anna.example:': [
            { Date: t(13, 12), From: 'anna.example', Content: 'look at this' },
            { Date: t(13, 12, 3), From: 'sam.tester', Content: 'haha' },
          ],
          'Chat History with ben.sample:': [{ Date: t(14), From: 'ben.sample', Content: 'https://www.tiktokv.com/share/video/2/' }],
        },
      },
    },
    Profile: { 'Profile Information': { ProfileMap: { bioDescription: '', userName: 'sam.tester' } } },
  },
  null,
  2,
);

describe('TikTok', () => {
  it('reads the direct messages, in UTC, with the profile saying who the Player is', async () => {
    const zip = zipBlob({ 'TikTok_Data_1705000000/user_data_tiktok.json': data });
    const d = await detect(fileOf([zip], 'TikTok_Data.zip'));
    expect(d.found.map((f) => [f.kind, f.label])).toEqual([['tiktok', 'TikTok messages']]);
    const got: LifeEvent[] = [];
    await importFile(fileOf([zip], 'TikTok_Data.zip'), { detection: d, onEvents: (b) => void got.push(...b) });
    expect(got.every(wellFormed)).toBe(true);
    expect(titles(got)).toEqual(['Chatted with anna.example on TikTok: 2 messages', 'Chatted with ben.sample on TikTok: 1 message']);
    expect(got[0]).toMatchObject({ source: 'tiktok', kind: 'message', tier: 3, at: at(13), end: at(13, 12, 3), meta: { sent: 1, received: 1 } });
    expect(got[0].detail).toBe('anna.example: look at this · You: haha');
  });

  it('reads the older layout and a file on its own, and finds the Player from the chats', async () => {
    const old = JSON.stringify({ 'Direct Messages': { ChatHistory: { 'Chat History with anna.example:': [{ Date: t(13), From: 'sam.tester', Content: 'hi' }, { Date: t(13, 13), From: 'anna.example', Content: 'hey' }] } } });
    expect((await detect(fileOf([old], 'user_data.json'))).found.map((f) => f.kind)).toEqual(['tiktok']);
    const { events } = await run(parseTikTok(onePart(input('user_data.json', old, 4))));
    expect(events[0].detail).toBe('You: hi · anna.example: hey');
    expect(tiktokChat('Chat History with anna.example:')).toBe('anna.example');
  });
});
