import { describe, expect, it } from 'vitest';
import { classify, detect } from './index';
import { importAll, zipAt } from './notes-fixtures';

// The tests run with TZ=UTC, so a time on this device's clock is UTC too.
const local = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const ZIPPED = new Date(2024, 5, 1, 8, 0, 0);

describe('Obsidian', () => {
  const vault = {
    'MyVault/.obsidian/app.json': '{"theme":"dark"}',
    'MyVault/.trash/Old.md': '# Old\nGone.',
    'MyVault/Daily/2024-01-05.md': 'Went for a run.\n\nFelt good.',
    'MyVault/Projects/Trip.md': '---\ncreated: 2024-01-02 09:30\ntags: [travel, ideas]\n---\n# Trip ideas\nSomewhere warm in June. See [[Daily/2024-01-05]].\n',
    'MyVault/Inbox.md': 'Call the dentist',
    'MyVault/attachments/pic.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };

  it('finds a vault by its .obsidian folder and reads one note a file, leaving its bin out', async () => {
    const d = await detect(zipAt(vault, ZIPPED, 'MyVault.zip'));
    expect(d.found.map((f) => [f.kind, f.label, f.parts?.length])).toEqual([['obsidian', 'Obsidian notes', 3]]);
    const { result, events } = await importAll(zipAt(vault, ZIPPED, 'MyVault.zip'));
    expect(result).toMatchObject({ found: 3, added: 3, labels: ['Obsidian notes'] });
    expect(events.map((e) => [e.title, e.at, e.meta?.folder ?? '', e.meta?.tags ?? ''])).toEqual([
      ['Trip ideas', local(2024, 1, 2, 9, 30), 'Projects', 'travel, ideas'],
      ['2024-01-05', local(2024, 1, 5), 'Daily', ''],
      ['Inbox', ZIPPED.getTime(), '', ''],
    ]);
    expect(events[0].detail).toBe('Somewhere warm in June. See [[Daily/2024-01-05]].');
    expect(events[1].detail).toBe('Went for a run.\n\nFelt good.');
    expect(events.every((e) => e.meta?.app === 'Obsidian' && e.source === 'other' && e.kind === 'note' && e.tier === 3)).toBe(true);
  });

  it('a second import of the vault adds nothing, and an edited note gets its new words', async () => {
    const first = await importAll(zipAt(vault, ZIPPED, 'MyVault.zip'));
    const store = first.store;
    const { importFile } = await import('./index');
    const edited = zipAt({ ...vault, 'MyVault/Inbox.md': 'Call the dentist on Monday' }, ZIPPED, 'MyVault.zip');
    const r = await importFile(edited, { onEvents: (b, how) => (how?.replace ? store.upsertEvents(b) : store.addEvents(b)) });
    expect(r).toMatchObject({ found: 3, added: 1 });
    expect([...store.kept.values()].find((e) => e.title === 'Inbox')?.detail).toBe('Call the dentist on Monday');
    expect(store.kept.size).toBe(3);
  });

  it('reads Markdown notes in a zip without a vault, but not a stray read-me in another app’s export', async () => {
    const plain = await importAll(zipAt({ 'Notes/a.md': '# A\nOne', 'Notes/sub/b.markdown': 'Two' }, ZIPPED));
    expect(plain.detection.found.map((f) => f.kind)).toEqual(['notes']);
    expect(plain.events.map((e) => [e.title, e.meta?.folder ?? '', e.meta?.app])).toEqual([
      ['A', '', 'Notes'],
      ['b', 'sub', 'Notes'],
    ]);
    const spotify = await detect(zipAt({ 'MyData/README.md': '# Read me', 'MyData/StreamingHistory_music_0.json': '[{"endTime":"2024-01-01 10:00","artistName":"A","trackName":"B","msPlayed":1}]' }, ZIPPED));
    expect(spotify.found.map((f) => f.kind)).toEqual(['spotify-account']);
  });
});

describe('a note on its own', () => {
  it('takes a .md, a .txt that is no statement or chat, and a saved web page', async () => {
    const md = new File(['---\ndate: 2023-12-24\n---\nPresents to wrap'], 'Christmas.md', { lastModified: Date.UTC(2024, 0, 1) });
    const a = await importAll(md);
    expect(a.detection.found.map((f) => f.kind)).toEqual(['note-file']);
    expect(a.events.map((e) => [e.title, e.at, e.detail])).toEqual([['Christmas', local(2023, 12, 24), 'Presents to wrap']]);

    const txt = new File(['Ideas for the garden.\nMore roses, fewer weeds.'], 'garden.txt', { lastModified: Date.UTC(2024, 2, 3, 4, 5) });
    const b = await importAll(txt);
    expect(b.detection.found.map((f) => f.kind)).toEqual(['note-file']);
    expect(b.events.map((e) => [e.title, e.at])).toEqual([['garden', Date.UTC(2024, 2, 3, 4, 5)]]);

    const html = new File(['<html><head><title>Recipe</title></head><body><p>Flour &amp; eggs</p></body></html>'], 'recipe.html', { lastModified: Date.UTC(2024, 1, 1) });
    const c = await importAll(html);
    expect(c.events.map((e) => [e.title, e.detail])).toEqual([['Recipe', 'Flour & eggs']]);

    // A WhatsApp chat and a statement are still what they were.
    expect(classify('chat.txt', '13/01/2024, 21:15 - Anna: Hi\n13/01/2024, 21:16 - Ben: Hey\n', false)).toBe('whatsapp');
    expect(classify('notes.md', '# Hi', true)).toBeNull();
  });
});

describe('Apple Notes', () => {
  it('reads the iCloud Notes folder of Apple’s data download, with dates from its list', async () => {
    const zip = zipAt(
      {
        'iCloud Notes/Notes_Details.csv': 'Title,Created On,Modified On\nShopping,2023-04-05 10:11:12,2023-05-01 08:00:00\n',
        'iCloud Notes/Notes/Shopping/Shopping.txt': 'Milk\nBread',
        'iCloud Notes/Notes/Work/Plan/Plan.html': '<html><body><h1>Plan</h1><div>Ship it</div></body></html>',
        'iCloud Notes/Recently Deleted/Gone/Gone.txt': 'Old',
        'iCloud Notes/Notes/Shopping/photo.jpeg': new Uint8Array([0xff, 0xd8]),
      },
      ZIPPED,
      'iCloud Notes.zip',
    );
    const { detection, events, result } = await importAll(zip);
    expect(detection.found.map((f) => [f.kind, f.label])).toEqual([['apple-notes', 'Apple Notes']]);
    expect(result.labels).toEqual(['Apple Notes']);
    expect(events.map((e) => [e.title, e.at, e.detail, e.meta?.folder ?? ''])).toEqual([
      ['Shopping', new Date(2023, 3, 5, 10, 11, 12).getTime(), 'Milk\nBread', ''],
      ['Plan', ZIPPED.getTime(), 'Plan\n\nShip it', 'Work'],
    ]);
    expect(events.every((e) => e.meta?.app === 'Apple Notes')).toBe(true);
  });
});
