// The plain rules behind the file manager: folders from two devices together, folders in folders
// (and loops two devices can make), copies, the trash's 30 days, sorting and search by name.

import { describe, expect, it } from 'vitest';
import { cleanFilesTree } from '../lib/validate';
import * as T from './files-tree';

const A = 'aaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccc';
const DAY = 864e5;

describe('folders from two devices', () => {
  it('keeps both sides, and the change made last wins', () => {
    const phone = { dirs: { [A]: { name: 'Trips', e: 10 }, [B]: { name: 'Old name', e: 5 } }, gone: {} };
    const laptop = { dirs: { [B]: { name: 'New name', e: 20 }, [C]: { name: 'Work', e: 7 } }, gone: {} };
    const both = T.mergeFolders(phone, laptop, 100);
    expect(both.dirs).toEqual({ [A]: { name: 'Trips', e: 10 }, [B]: { name: 'New name', e: 20 }, [C]: { name: 'Work', e: 7 } });
    // The same either way round.
    expect(T.sameFolders(both, T.mergeFolders(laptop, phone, 100))).toBe(true);
  });

  it('a folder deleted after its last change stays deleted; one changed after that comes back', () => {
    const here = { dirs: { [A]: { name: 'Trips', e: 10 }, [B]: { name: 'Work', e: 50 } }, gone: {} };
    const there = { dirs: {}, gone: { [A]: 20, [B]: 30 } };
    const both = T.mergeFolders(here, there, 100);
    expect(Object.keys(both.dirs)).toEqual([B]);
    expect(both.gone).toEqual({ [A]: 20 });
    // A deletion is forgotten after a long while.
    expect(T.mergeFolders(both, T.emptyFolders(), 20 + 401 * DAY).gone).toEqual({});
  });
});

describe('folders in folders', () => {
  const dirs = { [A]: { name: 'Trips', e: 1 }, [B]: { name: '2026', p: A, e: 1 }, [C]: { name: 'Rome', p: B, e: 1 } };

  it('knows the path, what is inside, and the choices for a list', () => {
    expect(T.pathOf(dirs, C)).toEqual([A, B, C]);
    expect(T.foldersIn(dirs)).toEqual([A]);
    expect(T.foldersIn(dirs, A)).toEqual([B]);
    expect(T.isWithin(dirs, C, A)).toBe(true);
    expect(T.isWithin(dirs, A, C)).toBe(false);
    expect(T.folderChoices(dirs).map((o) => o.label)).toEqual(['Trips', 'Trips / 2026', 'Trips / 2026 / Rome']);
  });

  it("puts a folder whose folder is gone at the top, and a file's too", () => {
    const left = { [C]: { name: 'Rome', p: B, e: 1 } };
    expect(T.parentOf(left, C)).toBeUndefined();
    expect(T.foldersIn(left)).toEqual([C]);
    expect(T.dirOf(left, { dir: B })).toBeUndefined();
    expect(T.dirOf(left, { dir: C })).toBe(C);
  });

  it('opens a loop two devices made at once, the same way on both', () => {
    const loop = { [A]: { name: 'One', p: B, e: 1 }, [B]: { name: 'Two', p: A, e: 1 } };
    expect(T.parentOf(loop, A)).toBeUndefined(); // the smallest id goes to the top
    expect(T.parentOf(loop, B)).toBe(A);
    expect(T.pathOf(loop, B)).toEqual([A, B]);
    expect(T.folderChoices(loop).map((o) => o.label)).toEqual(['One', 'One / Two']);
  });
});

describe('copies', () => {
  const f = (id: string, hash: string | undefined, at: number, size = 10, bin?: number) => ({ id, hash, at, size, bin });
  it('groups files with the same bytes, oldest first, leaving out the trash', () => {
    const h1 = '1'.repeat(64);
    const h2 = '2'.repeat(64);
    const groups = T.copyGroups([f('a', h1, 3), f('b', h1, 1), f('c', h2, 1, 500), f('d', h2, 2, 500), f('e', h2, 3, 500, 9), f('g', undefined, 1), f('h', '3'.repeat(64), 1)]);
    // The group that frees the most first.
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([
      ['c', 'd'],
      ['b', 'a'],
    ]);
  });
});

describe('the trash', () => {
  it('keeps a file 30 days', () => {
    const now = 1_000 * DAY;
    expect(T.expired({ bin: now - 29 * DAY }, now)).toBe(false);
    expect(T.expired({ bin: now - 30 * DAY }, now)).toBe(true);
    expect(T.expired({}, now)).toBe(false);
    expect(T.daysLeft({ bin: now - 10 * DAY }, now)).toBe(20);
  });
});

describe('showing them', () => {
  const list = [
    { id: '1', name: 'b report.pdf', at: 3, size: 50, type: 'application/pdf' },
    { id: '2', name: 'A photo.jpg', at: 1, size: 900, type: 'image/jpeg' },
    { id: '3', name: 'Song 10.mp3', at: 2, size: 10, type: 'audio/mpeg' },
    { id: '4', name: 'Song 9.mp3', at: 4, size: 20, type: 'audio/mpeg' },
  ];
  it('sorts by name, date, size and kind', () => {
    expect(T.sortFiles(list, 'name').map((f) => f.id)).toEqual(['2', '1', '4', '3']);
    expect(T.sortFiles(list, 'date').map((f) => f.id)).toEqual(['4', '1', '3', '2']);
    expect(T.sortFiles(list, 'size').map((f) => f.id)).toEqual(['2', '1', '4', '3']);
    expect(T.sortFiles(list, 'kind').map((f) => f.id)).toEqual(['2', '4', '3', '1']);
    expect(T.kindOf('video/mp4')).toBe('Videos');
    expect(T.kindOf('application/zip')).toBe('Other');
  });

  it('finds by name, every word, ignoring case and accents', () => {
    expect(T.nameMatches('Café menu.pdf', 'cafe')).toBe(true);
    expect(T.nameMatches('Café menu.pdf', 'MENU caf')).toBe(true);
    expect(T.nameMatches('Café menu.pdf', 'menu tea')).toBe(false);
  });
});

describe('what comes from the cloud (lib/validate.ts)', () => {
  it('keeps a good tree and drops what is wrong', () => {
    const t = cleanFilesTree({
      dirs: { [A]: { name: '  Trips/2026 ', p: A, g: 'goal1', e: 5 }, bad: { name: 'x', e: 1 }, [B]: { name: '', e: 1 }, [C]: { name: 'No time' } },
      gone: { [B]: 9, x: 1 },
      files: { [C]: { d: A, t: 3, m: 4, h: 'f'.repeat(64) }, [B]: { h: 'not a hash', d: 'nope' } },
    });
    expect(t).toEqual({ dirs: { [A]: { name: 'Trips 2026', g: 'goal1', e: 5 } }, gone: { [B]: 9 }, files: { [C]: { d: A, t: 3, m: 4, h: 'f'.repeat(64) } } });
    expect(cleanFilesTree(undefined)).toEqual({ dirs: {}, gone: {}, files: {} });
  });
});
