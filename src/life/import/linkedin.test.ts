import { describe, expect, it } from 'vitest';
import { isLinkedInMessages, parseLinkedIn } from './linkedin';
import { onePart } from './chat';
import { classify, detect, importFile } from './index';
import { fileOf, input, run, titles, wellFormed, zipBlob } from '../../test/life-fixtures';
import type { LifeEvent } from '../types';

const at = (d: number, h = 12, m = 0) => Date.UTC(2024, 0, d, h, m);
const head = 'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER';
const row = (id: string, title: string, from: string, to: string, date: string, content: string, folder = 'INBOX') => [id, title, from, `https://www.linkedin.com/in/${from.toLowerCase().replace(/ /g, '-')}`, to, '', date, '', content, folder].map((c) => `"${c.replace(/"/g, '""')}"`).join(',');

const csv = [
  head,
  row('2-abc', '', 'Anna Example', 'Sam Tester', '2024-01-13 12:05:00 UTC', '<p>Thanks for connecting, Sam!</p>'),
  row('2-abc', '', 'Sam Tester', 'Anna Example', '2024-01-13 12:00:00 UTC', 'Hi Anna, good to meet you.'),
  row('2-def', 'Project chat', 'Ben Sample', 'Sam Tester, Cleo Demo', '2024-01-14 12:00:00 UTC', 'Kickoff on Monday'),
  row('2-zzz', '', 'Spam Sender', 'Sam Tester', '2024-01-15 12:00:00 UTC', 'Buy now', 'SPAM'),
].join('\r\n');

describe('LinkedIn', () => {
  it('reads messages.csv in a zip: one event per conversation per day, spam left out', async () => {
    const zip = zipBlob({ 'messages.csv': csv, 'Connections.csv': 'Notes:\n"x"\n\nFirst Name,Last Name\nAnna,Example\n' });
    const d = await detect(fileOf([zip], 'Basic_LinkedInDataExport_01-20-2024.zip'));
    expect(d.found.map((f) => [f.kind, f.label])).toEqual([['linkedin', 'LinkedIn messages']]);
    const got: LifeEvent[] = [];
    await importFile(fileOf([zip], 'Basic_LinkedInDataExport_01-20-2024.zip'), { detection: d, onEvents: (b) => void got.push(...b) });
    expect(got.every(wellFormed)).toBe(true);
    expect(titles(got)).toEqual(['Chatted with Anna Example on LinkedIn: 2 messages', 'Chatted with Project chat on LinkedIn: 1 message']);
    expect(got[0]).toMatchObject({ source: 'linkedin', kind: 'message', tier: 3, at: at(13), end: at(13, 12, 5), meta: { sent: 1, received: 1 } });
    expect(got[0].detail).toBe('You: Hi Anna, good to meet you. · Anna Example: Thanks for connecting, Sam!');
  });

  it('is known by its columns on its own, before a bank statement', async () => {
    expect(isLinkedInMessages(head)).toBe(true);
    expect(isLinkedInMessages('Date,Description,Amount')).toBe(false);
    expect(classify('messages.csv', csv, false)).toBe('linkedin');
    expect((await detect(fileOf([csv], 'messages.csv'))).found.map((f) => f.kind)).toEqual(['linkedin']);
    // One conversation: nobody to tell who the Player is, so both names.
    const { events } = await run(parseLinkedIn(onePart(input('messages.csv', [head, row('2-abc', '', 'Anna Example', 'Sam Tester', '2024-01-13 12:05:00 UTC', 'Hi')].join('\n'), 7))));
    expect(events[0].title).toBe('Chatted with Anna Example and Sam Tester on LinkedIn: 1 message');
  });
});
