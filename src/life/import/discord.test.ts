import { describe, expect, it } from 'vitest';
import { indexName } from './discord';
import { detect, importFile } from './index';
import { fileOf, titles, wellFormed, zipBlob } from '../../test/life-fixtures';
import type { LifeEvent } from '../types';

const at = (d: number, h = 12, m = 0) => Date.UTC(2024, 0, d, h, m);

describe('Discord', () => {
  it('reads a newer package: every message is the Player’s own', async () => {
    const zip = zipBlob({
      'Messages/index.json': JSON.stringify({ '111': 'Direct Message with anna_example', '222': 'general in Climbing Club', '333': null }),
      'Messages/c111/channel.json': JSON.stringify({ id: '111', type: 'DM', recipients: ['900', '901'] }),
      'Messages/c111/messages.json': JSON.stringify([
        { ID: 2, Timestamp: '2024-01-13 12:10:00', Contents: 'see you there', Attachments: '' },
        { ID: 1, Timestamp: '2024-01-13 12:00:00', Contents: 'on my way', Attachments: '' },
      ]),
      'Messages/c222/channel.json': JSON.stringify({ id: '222', type: 'GUILD_TEXT', name: 'general', guild: { id: '5', name: 'Climbing Club' } }),
      'Messages/c222/messages.json': JSON.stringify([{ ID: 3, Timestamp: '2024-01-14 12:00:00', Contents: '', Attachments: 'https://cdn.example/a.png' }]),
      'Messages/c333/messages.json': JSON.stringify([{ ID: 4, Timestamp: '2024-01-15 12:00:00', Contents: 'hello?' }]),
      'Account/user.json': '{"id": "900"}',
    });
    const d = await detect(fileOf([zip], 'package.zip'));
    expect(d.found.map((f) => [f.kind, f.label, f.path])).toEqual([['discord', 'Discord messages', 'Messages']]);
    expect(d.found[0].parts![0]).toBe('Messages/index.json');
    const got: LifeEvent[] = [];
    await importFile(fileOf([zip], 'package.zip'), { detection: d, onEvents: (b) => void got.push(...b) });
    expect(got.every(wellFormed)).toBe(true);
    expect(titles(got)).toEqual(['Sent 2 messages to anna_example on Discord', 'Sent 1 message in #general in Climbing Club on Discord', 'Sent 1 message in a channel on Discord']);
    expect(got[0]).toMatchObject({ source: 'discord', kind: 'message', tier: 3, at: at(13), end: at(13, 12, 10), meta: { chat: 'anna_example', sent: 2, received: 0 } });
    expect(got[0].detail).toBe('You: on my way · You: see you there');
    expect(got[1].detail).toBeUndefined();
  });

  it('reads an older package with messages.csv and folders without the "c"', async () => {
    const csv = 'ID,Timestamp,Contents,Attachments\n1,2020-01-13 12:00:00.123000+00:00,"Hi, ""you""",\n2,2020-01-13 13:00:00.000000+00:00,"two\nlines",\n';
    const zip = zipBlob({ 'package/messages/index.json': JSON.stringify({ '777': 'Direct Message with ben#1234' }), 'package/messages/777/messages.csv': csv, 'package/messages/777/channel.json': '{"id":"777","type":1}' });
    const got: LifeEvent[] = [];
    const r = await importFile(fileOf([zip], 'package.zip'), { onEvents: (b) => void got.push(...b) });
    expect(r.labels).toEqual(['Discord messages']);
    expect(titles(got)).toEqual(['Sent 2 messages to ben#1234 on Discord']);
    expect(got[0].at).toBe(Date.UTC(2020, 0, 13, 12, 0, 0, 123));
    expect(got[0].detail).toBe('You: Hi, "you" · You: two lines');
  });

  it('reads the names in the index', () => {
    expect(indexName('Direct Message with anna#0')).toEqual({ name: 'anna', dm: true });
    expect(indexName('general in Our Server')).toEqual({ name: 'general in Our Server', dm: false });
    expect(indexName(null)).toBeNull();
    expect(indexName('None')).toBeNull();
  });
});
