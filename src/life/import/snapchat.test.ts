import { describe, expect, it } from 'vitest';
import { parseSnapchat } from './snapchat';
import { onePart } from './chat';
import { detect, importFile } from './index';
import { fileOf, input, run, titles, wellFormed, zipBlob } from '../../test/life-fixtures';
import type { LifeEvent } from '../types';

const t = (d: number, h = 12, m = 0) => `2024-01-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00 UTC`;
const at = (d: number, h = 12, m = 0) => Date.UTC(2024, 0, d, h, m);

const newer = JSON.stringify(
  {
    'anna.example': [
      { From: 'anna.example', 'Media Type': 'TEXT', Created: t(13, 12, 5), Content: 'lol', 'Conversation Title': null, IsSender: false, 'Created(microseconds)': at(13, 12, 5) },
      { From: 'sam.tester', 'Media Type': 'MEDIA', Created: t(13), Content: '', 'Conversation Title': null, IsSender: true, 'Created(microseconds)': at(13) },
    ],
    '6a1b7c2d-0000-4000-8000-000000000000': [{ From: 'ben.sample', 'Media Type': 'TEXT', Created: t(14), Content: 'Who is in?', 'Conversation Title': 'Climbing', IsSender: false }],
  },
  null,
  1,
);

const older = JSON.stringify({
  'Received Saved Chat History': [{ From: 'anna.example', 'Media Type': 'TEXT', Created: t(3, 10), Text: 'hello' }],
  'Sent Saved Chat History': [{ To: 'anna.example', 'Media Type': 'TEXT', Created: t(3, 11), Text: 'hi back' }],
  'Received Unsaved Chat History': [{ From: 'ben.sample', 'Media Type': 'SNAP', Created: t(4), Text: '' }],
});

describe('Snapchat', () => {
  it('reads the newer chat history in a zip, snaps counted, groups by their title', async () => {
    const zip = zipBlob({ 'mydata~1705000000/json/chat_history.json': newer, 'mydata~1705000000/json/account.json': '{}' });
    const d = await detect(fileOf([zip], 'mydata.zip'));
    expect(d.found.map((f) => [f.kind, f.label])).toEqual([['snapchat', 'Snapchat chats']]);
    const got: LifeEvent[] = [];
    await importFile(fileOf([zip], 'mydata.zip'), { detection: d, onEvents: (b) => void got.push(...b) });
    expect(got.every(wellFormed)).toBe(true);
    expect(titles(got)).toEqual(['Chatted with anna.example on Snapchat: 2 messages', 'Chatted with Climbing on Snapchat: 1 message']);
    expect(got[0]).toMatchObject({ source: 'snapchat', tier: 3, at: at(13), end: at(13, 12, 5), meta: { sent: 1, received: 1 } });
    expect(got[0].detail).toBe('anna.example: lol');
  });

  it('reads the older layout, sent and received, and a file on its own', async () => {
    expect((await detect(fileOf([older], 'chat_history.json'))).found.map((f) => f.kind)).toEqual(['snapchat']);
    const { events } = await run(parseSnapchat(onePart(input('chat_history.json', older, 3))));
    expect(titles(events)).toEqual(['Chatted with anna.example on Snapchat: 2 messages', 'Chatted with ben.sample on Snapchat: 1 message']);
    expect(events[0].detail).toBe('anna.example: hello · You: hi back');
    expect(events[1].meta).toMatchObject({ sent: 0, received: 1 });
  });
});
