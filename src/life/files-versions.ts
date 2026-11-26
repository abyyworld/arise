// Versions of a file: the plain rules (files.ts keeps them, files-sync.ts syncs them, files-ui.js
// shows them). Nothing here reads or writes storage.
//
// Each version is a file of its own, with its own sealed bytes, listed in the files index like any
// other, so apps from before versions still list (and never lose) every one of them. What makes
// them versions is in the index's tree (files-tree.ts placeOf): `v`, the file they're all versions
// of (the first one's id), and `c`, when each became the current one. The current one is the one
// that became current last; restoring an old one only gives it a newer `c`, so two devices'
// changes meet like any other change to where a file sits.

import type { FileMeta } from '../lib/validate';

export const MAX_VERSIONS = 20; // older versions kept for a file; the oldest past that go to the trash

type V = Pick<FileMeta, 'id' | 'at' | 'vg' | 'cur' | 'bin'>;

export const groupOf = (f: Pick<FileMeta, 'id' | 'vg'>) => f.vg || f.id;
// When it became the current one (or was added, for a file never restored).
export const rankOf = (f: Pick<FileMeta, 'at' | 'cur'>) => f.cur || f.at;
const newer = (a: V, b: V) => rankOf(b) - rankOf(a) || (a.id < b.id ? 1 : -1);

// Every group of versions among these files: the current one first, then the older ones, newest
// first. A file with no versions is a group of one.
export function groups<T extends V>(files: readonly T[]): Map<string, T[]> {
  const by = new Map<string, T[]>();
  for (const f of files) {
    const g = groupOf(f);
    by.set(g, [...(by.get(g) || []), f]);
  }
  for (const list of by.values()) list.sort(newer);
  return by;
}

// The files to show (out of the trash): each one's current version, never its older ones.
export function currentOnly<T extends V>(files: readonly T[]): T[] {
  const out: T[] = [];
  for (const list of groups(files.filter((f) => !f.bin)).values()) out.push(list[0]);
  const keep = new Set(out.map((f) => f.id));
  return files.filter((f) => keep.has(f.id));
}

// A file's older versions (out of the trash), newest first. Empty when it isn't the current one.
export function olderOf<T extends V>(files: readonly T[], id: string): T[] {
  const f = files.find((x) => x.id === id);
  if (!f || f.bin) return [];
  const list = groups(files.filter((x) => !x.bin)).get(groupOf(f)) || [];
  return list[0]?.id === id ? list.slice(1) : [];
}

// The current version of the file this one is a version of (itself, when it's the current one).
export function currentOf<T extends V>(files: readonly T[], id: string): T | null {
  const f = files.find((x) => x.id === id);
  if (!f) return null;
  if (f.bin) return f;
  return groups(files.filter((x) => !x.bin)).get(groupOf(f))?.[0] || null;
}

// Past the cap: the oldest versions beyond MAX_VERSIONS older ones.
export function overCap<T extends V>(files: readonly T[], id: string, max = MAX_VERSIONS): T[] {
  return olderOf(files, id).slice(max);
}

// The trash, one entry for what went there together: a file with the versions trashed with it.
// The newest of each goes first in its list.
export function trashBundles<T extends V>(files: readonly T[]): T[][] {
  const by = new Map<string, T[]>();
  for (const f of files) {
    if (!f.bin) continue;
    const k = `${groupOf(f)}@${f.bin}`;
    by.set(k, [...(by.get(k) || []), f]);
  }
  return [...by.values()].map((list) => list.sort(newer));
}
// The files that went to the trash with this one (the newest first).
export function bundleOf<T extends V>(files: readonly T[], id: string): T[] {
  const f = files.find((x) => x.id === id);
  if (!f?.bin) return f ? [f] : [];
  return trashBundles(files).find((b) => b.some((x) => x.id === id)) || [f];
}
