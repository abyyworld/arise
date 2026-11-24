import { describe, expect, it } from 'vitest';
import { importAll, zipAt } from './notes-fixtures';
import { keepNote } from './keep';
import { classify, detect } from './index';

const ZIPPED = new Date(2024, 5, 1, 8, 0, 0);
const usec = (ms: number) => ms * 1000;

const shopping = {
  color: 'DEFAULT',
  isTrashed: false,
  isPinned: true,
  isArchived: false,
  title: 'Shopping',
  listContent: [
    { textHtml: 'Milk', text: 'Milk', isChecked: false },
    { textHtml: 'Bread', text: 'Bread', isChecked: true },
    { text: '  ', isChecked: false },
  ],
  labels: [{ name: 'Home' }],
  createdTimestampUsec: usec(Date.UTC(2024, 0, 2, 10)),
  userEditedTimestampUsec: usec(Date.UTC(2024, 0, 3, 10)),
};
const idea = { isTrashed: false, title: '', textContent: 'Paint the fence blue\nNext spring', userEditedTimestampUsec: usec(Date.UTC(2023, 4, 6, 7)) };
const binned = { isTrashed: true, title: 'Old', textContent: 'Gone', userEditedTimestampUsec: usec(Date.UTC(2023, 1, 1)) };

describe('Google Keep', () => {
  it('reads a note: checklists as ticks, labels as tags, and leaves the bin out', () => {
    expect(keepNote(shopping, 'Keep/Shopping.json')).toMatchObject({ app: 'Google Keep', title: 'Shopping', text: '[ ] Milk\n[x] Bread', at: Date.UTC(2024, 0, 2, 10), tags: ['Home'], extra: { pinned: true } });
    expect(keepNote(binned, 'Keep/Old.json')).toBeNull();
    expect(keepNote({ isTrashed: false, title: '', textContent: '' }, 'Keep/Empty.json')).toBeNull();
    expect(keepNote([1, 2], 'Keep/x.json')).toBeNull();
  });

  it('finds Keep in a Takeout next to the rest, and its notes come in', async () => {
    const zip = zipAt(
      {
        'Takeout/Keep/Shopping.json': JSON.stringify(shopping),
        'Takeout/Keep/Shopping.html': '<html><body><div class="note">Shopping</div></body></html>',
        'Takeout/Keep/Idea.json': JSON.stringify(idea),
        'Takeout/Keep/Old.json': JSON.stringify(binned),
        'Takeout/Keep/Labels.txt': 'Home\n',
        'Takeout/My Activity/Search/MyActivity.json': JSON.stringify([{ header: 'Search', title: 'Searched for x', titleUrl: 'https://www.google.com/search?q=x', time: '2024-01-01T10:00:00Z', products: ['Search'] }]),
      },
      ZIPPED,
      'takeout.zip',
    );
    const { detection, events, result } = await importAll(zip);
    expect(detection.found.map((f) => [f.kind, f.label])).toEqual([
      ['google-activity', 'Google activity: Search'],
      ['keep', 'Google Keep notes'],
    ]);
    expect(result.labels).toEqual(['Google activity: Search', 'Google Keep notes']);
    const notes = events.filter((e) => e.kind === 'note');
    expect(notes.map((e) => [e.title, e.detail, e.meta?.tags ?? ''])).toEqual([
      ['Paint the fence blue', 'Paint the fence blue\nNext spring', ''],
      ['Shopping', '[ ] Milk\n[x] Bread', 'Home'],
    ]);
  });

  it('knows a Keep note chosen on its own', async () => {
    expect(classify('Idea.json', JSON.stringify(idea), false)).toBe('keep');
    const d = await detect(new File([JSON.stringify(idea)], 'Idea.json'));
    expect(d.found.map((f) => f.kind)).toEqual(['keep']);
  });
});
