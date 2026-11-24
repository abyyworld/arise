import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { dayOfEvent, obsidianFiles, obsidianZip, safeName, zipName } from './export-obsidian';
import type { LifeEvent } from './types';

// The tests run with TZ=UTC, so a day on this device's clock is a UTC day.
const at = (d: number, h: number, m = 0) => Date.UTC(2024, 0, d, h, m);
const MADE = new Date(Date.UTC(2024, 5, 1, 12));

const events: LifeEvent[] = [
  { id: 'health:steps:2024-01-02', source: 'health', kind: 'steps', at: at(2, 0), end: at(3, 0), title: '8,000 steps', value: 8000, unit: 'steps', tier: 2, meta: { day: '2024-01-02' } },
  { id: 'spotify:a', source: 'spotify', kind: 'listen', at: at(2, 9, 5), title: 'Listened to Song', detail: 'Artist', tier: 2 },
  { id: 'other:note:1', source: 'other', kind: 'note', at: at(2, 10), title: 'Trip ideas', detail: 'Somewhere warm.\n\n- Beach', tier: 3, meta: { app: 'Obsidian', folder: 'Projects', tags: 'travel, big ideas' } },
  { id: 'other:note:2', source: 'other', kind: 'note', at: at(2, 11), title: 'Trip ideas', detail: 'A second note with the same name.', tier: 3, meta: { app: 'Notes' } },
  { id: 'manual:x', source: 'manual', kind: 'note', at: at(3, 8), title: 'Felt [[great]] | rested', tier: 2 },
  { id: 'other:note:3', source: 'other', kind: 'note', at: at(3, 9), title: 'What/is: this?', detail: 'Odd name.', tier: 3, meta: { app: 'PDF' } },
];

describe('Export to Obsidian', () => {
  it('makes a file for each day, with its journal, and links its notes in their own files', () => {
    const files = obsidianFiles(events, { journals: new Map([['2024-01-02', 'A good day.'], ['2024-01-05', 'Quiet.']]), summaries: new Map([['2024-01-02', 'Walked and planned a trip.']]), made: MADE });
    expect(Object.keys(files).sort()).toEqual([
      'Arise/Days/2024-01-02.md',
      'Arise/Days/2024-01-03.md',
      'Arise/Days/2024-01-05.md',
      'Arise/Notes/2024-01-02 Trip ideas 2.md',
      'Arise/Notes/2024-01-02 Trip ideas.md',
      'Arise/Notes/2024-01-03 What is this.md',
      'Arise/Read me.md',
    ]);
    expect(files['Arise/Days/2024-01-02.md']).toBe(
      [
        '---',
        'date: 2024-01-02',
        'type: day',
        'events: 4',
        '---',
        '',
        '# Tuesday, 2 January 2024',
        '',
        '## Journal',
        '',
        'A good day.',
        '',
        '## Summary',
        '',
        'Walked and planned a trip.',
        '',
        '## Your day',
        '',
        '- 8,000 steps (Health)',
        '- 09:05 Listened to Song: Artist (Spotify)',
        '- 10:00 [[2024-01-02 Trip ideas|Trip ideas]] (Obsidian)',
        '- 11:00 [[2024-01-02 Trip ideas 2|Trip ideas]] (Notes)',
        '',
      ].join('\n'),
    );
    expect(files['Arise/Notes/2024-01-02 Trip ideas.md']).toBe(
      ['---', 'date: 2024-01-02', 'time: "10:00"', 'type: note', 'source: Obsidian', 'folder: Projects', 'tags:', '  - travel', '  - big-ideas', '---', '', '# Trip ideas', '', 'Somewhere warm.', '', '- Beach', '', 'From [[2024-01-02]]', ''].join('\n'),
    );
    // A note with no words stays a line of its day, with nothing read as a link.
    expect(files['Arise/Days/2024-01-03.md']).toContain('- 08:00 Felt great | rested (Your notes)\n- 09:00 [[2024-01-03 What is this|What/is: this?]] (PDF)');
    expect(files['Arise/Days/2024-01-05.md']).toContain('type: day\nevents: 0\n');
    expect(files['Arise/Days/2024-01-05.md']).toContain('## Journal\n\nQuiet.');
    expect(files['Arise/Read me.md']).toContain('3 days and 6 things');
    // The same events, the same files.
    expect(obsidianFiles(events, { made: MADE })).toEqual(obsidianFiles([...events].reverse(), { made: MADE }));
  });

  it('zips them, and names the zip by the day it was made', () => {
    const zip = unzipSync(obsidianZip(events, { made: MADE }));
    expect(Object.keys(zip)).toContain('Arise/Days/2024-01-02.md');
    expect(strFromU8(zip['Arise/Notes/2024-01-03 What is this.md'])).toContain('Odd name.');
    expect(zipName(MADE)).toBe('Arise life log 2024-06-01.zip');
  });

  it('keeps names safe and days right', () => {
    expect(safeName('a/b\\c:d*e?"f<g>h|i#j^k[l]m')).toBe('a b c d e f g h i j k l m');
    expect(safeName('...')).toBe('Note');
    expect(safeName('x'.repeat(200)).length).toBe(80);
    expect(dayOfEvent(events[0])).toBe('2024-01-02');
    expect(dayOfEvent({ ...events[1], at: at(4, 23, 59) })).toBe('2024-01-04');
  });
});
