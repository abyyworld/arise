// Folders, the trash, copies, and the order files are shown in: the plain rules behind Photos and
// files (files.ts keeps them, files-sync.ts syncs them, files-ui.js shows them). Nothing here
// reads or writes storage.
//
// Folders sync in the files index's own `tree` (sealed with it: files-seal.ts), next to where each
// listed file sits and a SHA-256 of its bytes. Two devices' changes meet per folder and per file:
// the one changed last wins, and a folder deleted after its last change stays deleted.

import type { FilePlaceRec, FileMeta, FolderRec } from '../lib/validate';

export const TRASH_DAYS = 30;
export const TRASH_MS = TRASH_DAYS * 864e5;
const GONE_KEEP = 400 * 864e5; // like the files' own deletions (files-sync.ts)
const DEEPEST = 64; // folders in folders, at most this deep (and a guard against loops)

export interface Folders {
  dirs: Record<string, FolderRec>;
  gone: Record<string, number>; // deleted folders, and when
}
export const emptyFolders = (): Folders => ({ dirs: {}, gone: {} });

// ---------- two devices' folders together

const later = (x: FolderRec, y: FolderRec) => (y.e !== x.e ? y.e > x.e : JSON.stringify(y) > JSON.stringify(x));

export function mergeFolders(a: Folders, b: Folders, now = Date.now()): Folders {
  const gone: Record<string, number> = { ...a.gone };
  for (const [id, at] of Object.entries(b.gone)) gone[id] = Math.max(gone[id] || 0, at);
  const dirs: Record<string, FolderRec> = {};
  for (const id of new Set([...Object.keys(a.dirs), ...Object.keys(b.dirs)])) {
    const x = a.dirs[id];
    const y = b.dirs[id];
    const pick = !x ? y : !y ? x : later(x, y) ? y : x;
    if (gone[id] && gone[id] >= pick.e) continue;
    dirs[id] = pick;
    delete gone[id]; // changed after it was deleted elsewhere: it stays
  }
  for (const [id, at] of Object.entries(gone)) if (now - at > GONE_KEEP) delete gone[id];
  return { dirs, gone };
}

export const sameFolders = (a: Folders, b: Folders) => canon(a) === canon(b);

// JSON with its keys in order, so two equal trees compare equal.
export function canon(v: unknown): string {
  if (!v || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(',')}}`;
}

// ---------- where a folder is

// The folder a folder is in: its own, when that's there and doesn't lead back to it (two devices
// can each put one folder in the other at once; then the loop opens at its smallest id). None: the top.
export function parentOf(dirs: Record<string, FolderRec>, id: string): string | undefined {
  const p = dirs[id]?.p;
  if (!p || !dirs[p]) return undefined;
  const seen = [id];
  let cur: string | undefined = p;
  while (cur && dirs[cur] && seen.length <= DEEPEST * 4) {
    const at = seen.indexOf(cur);
    if (at >= 0) {
      const loop = seen.slice(at);
      return at === 0 && id === [...loop].sort()[0] ? undefined : p;
    }
    seen.push(cur);
    cur = dirs[cur].p;
  }
  return p;
}

// The folders from the top down to this one (this one last).
export function pathOf(dirs: Record<string, FolderRec>, id: string | undefined): string[] {
  const out: string[] = [];
  let cur = id && dirs[id] ? id : undefined;
  while (cur && out.length < DEEPEST * 4 && !out.includes(cur)) {
    out.unshift(cur);
    cur = parentOf(dirs, cur);
  }
  return out;
}

// Whether `id` is `outer` or somewhere inside it.
export const isWithin = (dirs: Record<string, FolderRec>, id: string | undefined, outer: string) => !!id && pathOf(dirs, id).includes(outer);

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// The folders right inside one (none: at the top), by name.
export function foldersIn(dirs: Record<string, FolderRec>, parent?: string): string[] {
  return Object.keys(dirs)
    .filter((id) => parentOf(dirs, id) === (parent || undefined))
    .sort((a, b) => byName(dirs[a].name, dirs[b].name) || (a < b ? -1 : 1));
}

// Every folder with its path in words ("Trips / 2026"), in the order a list shows them.
export function folderChoices(dirs: Record<string, FolderRec>): { id: string; label: string; depth: number }[] {
  const out: { id: string; label: string; depth: number }[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    if (depth > DEEPEST) return;
    for (const id of foldersIn(dirs, parent)) {
      out.push({ id, label: pathOf(dirs, id).map((x) => dirs[x].name).join(' / '), depth });
      walk(id, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}

// The folder a file is in: its own when that folder is still there, else the top.
export const dirOf = (dirs: Record<string, FolderRec>, f: Pick<FileMeta, 'dir'>) => (f.dir && dirs[f.dir] ? f.dir : undefined);

// ---------- where a file is, as the tree keeps it

export function placeOf(f: Pick<FileMeta, 'dir' | 'bin' | 'moved' | 'hash'>): FilePlaceRec {
  const out: FilePlaceRec = {};
  if (f.dir) out.d = f.dir;
  if (f.bin) out.t = f.bin;
  if (f.moved) out.m = f.moved;
  if (f.hash) out.h = f.hash;
  return out;
}
// The same, as a file's own fields (undefined: none).
export const fieldsOf = (p: FilePlaceRec) => ({ dir: p.d, bin: p.t, moved: p.m });

// ---------- the trash

export const expired = (f: Pick<FileMeta, 'bin'>, now = Date.now()) => !!f.bin && now - f.bin >= TRASH_MS;
export const daysLeft = (f: Pick<FileMeta, 'bin'>, now = Date.now()) => (f.bin ? Math.max(0, Math.ceil((f.bin + TRASH_MS - now) / 864e5)) : TRASH_DAYS);

// ---------- copies: files with exactly the same bytes

// Groups of two or more files (not in the trash) with the same SHA-256, oldest first in each, the
// groups that free the most space first.
export function copyGroups<T extends Pick<FileMeta, 'id' | 'at' | 'size' | 'hash' | 'bin'>>(files: readonly T[]): T[][] {
  const by = new Map<string, T[]>();
  for (const f of files) if (f.hash && !f.bin) by.set(f.hash, [...(by.get(f.hash) || []), f]);
  return [...by.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)))
    .sort((a, b) => b[0].size * (b.length - 1) - a[0].size * (a.length - 1) || (a[0].id < b[0].id ? -1 : 1));
}

// ---------- showing them

export type SortBy = 'name' | 'date' | 'size' | 'kind';
export const SORTS: { by: SortBy; label: string }[] = [
  { by: 'date', label: 'Newest first' },
  { by: 'name', label: 'Name' },
  { by: 'size', label: 'Biggest first' },
  { by: 'kind', label: 'Kind' },
];
export const isSort = (v: unknown): v is SortBy => SORTS.some((s) => s.by === v);

const KINDS = ['Photos', 'Videos', 'Sound', 'Documents', 'Other'] as const;
export type Kind = (typeof KINDS)[number];
export function kindOf(type: string): Kind {
  if (type.startsWith('image/')) return 'Photos';
  if (type.startsWith('video/')) return 'Videos';
  if (type.startsWith('audio/')) return 'Sound';
  if (/^text\/|pdf|word|document|sheet|excel|presentation|powerpoint|rtf|markdown|json|csv/.test(type)) return 'Documents';
  return 'Other';
}

export function sortFiles<T extends Pick<FileMeta, 'id' | 'name' | 'at' | 'size' | 'type'>>(list: readonly T[], by: SortBy): T[] {
  const tie = (a: T, b: T) => b.at - a.at || (a.id < b.id ? -1 : 1);
  const out = [...list];
  if (by === 'name') return out.sort((a, b) => byName(a.name, b.name) || tie(a, b));
  if (by === 'size') return out.sort((a, b) => b.size - a.size || tie(a, b));
  if (by === 'kind') return out.sort((a, b) => KINDS.indexOf(kindOf(a.type)) - KINDS.indexOf(kindOf(b.type)) || byName(a.name, b.name) || tie(a, b));
  return out.sort(tie);
}

// Search by name: every word typed is somewhere in the name, ignoring case and accents.
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function nameMatches(name: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const n = fold(name);
  return words.every((w) => n.includes(w));
}
