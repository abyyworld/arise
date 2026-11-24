// Helpers for the note importers' tests: a store in memory, zips with a set time, and a whole
// import from a file to its events (each checked as the life log would).

import { expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { detect, importFile } from './index';
import type { LifeEvent } from '../types';
import { cleanLifeEvent } from '../../lib/validate';
import { wellFormed } from '../../test/life-fixtures';

export function memoryStore() {
  const kept = new Map<string, LifeEvent>();
  return {
    kept,
    async addEvents(events: LifeEvent[]) {
      let added = 0;
      for (const e of events) if (!kept.has(e.id)) (kept.set(e.id, e), added++);
      return added;
    },
    async upsertEvents(events: LifeEvent[]) {
      let changed = 0;
      for (const e of events) if (JSON.stringify(kept.get(e.id)) !== JSON.stringify(e)) (kept.set(e.id, e), changed++);
      return changed;
    },
  };
}

// A zip whose files were all last changed at `mtime`.
export function zipAt(files: Record<string, string | Uint8Array>, mtime: Date, name = 'notes.zip'): File {
  const data: Record<string, [Uint8Array, { level: 6; mtime: Date }]> = {};
  for (const [k, v] of Object.entries(files)) data[k] = [typeof v === 'string' ? strToU8(v) : v, { level: 6, mtime }];
  return new File([new Uint8Array(zipSync(data))], name, { lastModified: Date.UTC(2020, 0, 1) });
}

export async function importAll(file: File) {
  const store = memoryStore();
  const detection = await detect(file);
  const result = await importFile(file, { detection, onEvents: (b, how) => (how?.replace ? store.upsertEvents(b) : store.addEvents(b)) });
  const events = [...store.kept.values()].sort((a, b) => a.at - b.at || (a.title < b.title ? -1 : 1));
  for (const e of events) {
    expect(wellFormed(e)).toBe(true);
    expect(cleanLifeEvent(e)).toEqual(e);
  }
  return { detection, result, events, store };
}
