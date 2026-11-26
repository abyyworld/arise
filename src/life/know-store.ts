// The flags on facts (know.ts) and the notes under the parts of life (area-notes.ts), kept on this
// device in the life log's database ('kv': 'flags' and 'areaNotes'). Each change marks the memory's
// pack, so it goes to the Player's other devices too (packs.ts, cloud.ts). The memory keeps a copy
// of both for the coach (memory.ts), read again when they change.

import type { LifeAreaNote, LifeFactFlag } from '../lib/validate';
import { done, open, req, tellOtherTabs } from './db';
import { markDirty, dirtied } from './journal';
import { MEM } from './packs';
import { cleanFlags, flagMap, MAX_FLAGS, patchFlag, type FlagPatch } from './know';
import { cleanNotes, MAX_NOTES } from './area-notes';

export const FLAGS = 'flags';
export const NOTES = 'areaNotes';

const valueOf = (row: unknown) => (row as { v?: unknown } | undefined)?.v;

async function readList<T>(k: string, clean: (v: unknown) => T[]): Promise<T[]> {
  try {
    const db = await open();
    return clean(valueOf(await req(db.transaction('kv').objectStore('kv').get(k))));
  } catch {
    return [];
  }
}

export const readFlags = () => readList(FLAGS, cleanFlags);
export const readNotes = () => readList(NOTES, cleanNotes);

// Changes the flags of some facts in one go, each on top of what's stored. Resolves with them as kept.
export async function saveFlags(changes: readonly { id: string; patch: FlagPatch }[], now = Date.now()): Promise<LifeFactFlag[]> {
  if (!changes.length) return [];
  const db = await open();
  const tx = db.transaction(['kv', 'sync'], 'readwrite');
  const kv = tx.objectStore('kv');
  const kept: LifeFactFlag[] = [];
  const g = kv.get(FLAGS);
  g.onsuccess = () => {
    const by = flagMap(cleanFlags(valueOf(g.result)));
    for (const c of changes) {
      const next = patchFlag(by.get(c.id), c.id, c.patch, now);
      by.set(c.id, next);
      kept.push(next);
    }
    kv.put({ k: FLAGS, v: [...by.values()].slice(-MAX_FLAGS) });
    markDirty(tx, [MEM]);
  };
  await done(tx);
  dirtied();
  tellOtherTabs('memory');
  return kept;
}

// Puts notes (new, changed or tombstones), each in place of the one with its id.
export async function putNotes(notes: readonly LifeAreaNote[]): Promise<void> {
  if (!notes.length) return;
  const db = await open();
  const tx = db.transaction(['kv', 'sync'], 'readwrite');
  const kv = tx.objectStore('kv');
  const g = kv.get(NOTES);
  g.onsuccess = () => {
    const by = new Map(cleanNotes(valueOf(g.result)).map((n) => [n.id, n]));
    for (const n of notes) by.set(n.id, n);
    kv.put({ k: NOTES, v: [...by.values()].slice(-MAX_NOTES) });
    markDirty(tx, [MEM]);
  };
  await done(tx);
  dirtied();
  tellOtherTabs('memory');
}
