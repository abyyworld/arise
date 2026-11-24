import { describe, expect, it } from 'vitest';
import { importAll, zipAt } from './notes-fixtures';
import { notionName } from './notion';

// The tests run with TZ=UTC, so a time on this device's clock is UTC too.
const local = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const ZIPPED = new Date(2024, 5, 1, 8, 0, 0);
const HOME = '0123456789abcdef0123456789abcdef';
const TASKS = 'fedcba9876543210fedcba9876543210';
const ROW = '11111111111111111111111111111111';

describe('Notion', () => {
  it('takes the long ids off names', () => {
    expect(notionName(`Trip plans ${HOME}`)).toBe('Trip plans');
    expect(notionName('Plain')).toBe('Plain');
  });

  it('reads pages as notes and each database row as a note, once', async () => {
    const zip = zipAt(
      {
        [`Export/Home ${HOME}.md`]: `# Home\n\nCreated: January 2, 2024 3:04 PM\n\nWelcome. See [Tasks](Home%20${HOME}/Tasks%20${TASKS}.csv).\n`,
        [`Export/Home ${HOME}/Tasks ${TASKS}.csv`]: 'Name,Status,Created\nBuy milk,Done,"January 3, 2024 9:00 AM"\n',
        [`Export/Home ${HOME}/Tasks ${TASKS}_all.csv`]: '﻿Name,Status,Created\nBuy milk,Done,"January 3, 2024 9:00 AM"\nCall mum,,\nPay rent,Doing,\n',
        [`Export/Home ${HOME}/Tasks ${TASKS}/Call mum ${ROW}.md`]: '# Call mum\n\nStatus: To do\n\nAsk about Sunday.',
        [`Export/Home ${HOME}/photo.png`]: new Uint8Array([0x89, 0x50]),
      },
      ZIPPED,
      'Export-abc.zip',
    );
    const { detection, events, result } = await importAll(zip);
    expect(detection.found.map((f) => [f.kind, f.label, f.parts?.length])).toEqual([['notion', 'Notion pages', 3]]);
    expect(result.labels).toEqual(['Notion pages']);
    expect(events.map((e) => [e.title, e.at, e.meta?.folder ?? '', e.detail])).toEqual([
      ['Home', local(2024, 1, 2, 15, 4), '', 'Created: January 2, 2024 3:04 PM\n\nWelcome. See Tasks.'],
      ['Buy milk', local(2024, 1, 3, 9, 0), 'Home/Tasks', 'Status: Done\nCreated: January 3, 2024 9:00 AM'],
      ['Call mum', ZIPPED.getTime(), 'Home/Tasks', 'Status: To do\n\nAsk about Sunday.'],
      ['Pay rent', ZIPPED.getTime(), 'Home/Tasks', 'Status: Doing'],
    ]);
    expect(events.every((e) => e.meta?.app === 'Notion')).toBe(true);
  });
});
