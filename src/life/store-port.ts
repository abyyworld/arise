// Where life events go: the life log on this device (src/life/log.ts). Importers, linked devices
// and helpers only know this port, so they work with any store that can add events (tests use one
// in memory). A store set with setLifeStore wins; otherwise the life log is loaded when first
// needed.

import type { LifeEvent, LifeSource } from './types';

export interface LifeStore {
  // Adds what it doesn't have yet (same id: kept once) and says how many were new.
  addEvents(events: LifeEvent[]): Promise<number>;
  // Adds or replaces by id (a calendar event that moved), and says how many changed.
  upsertEvents?(events: LifeEvent[]): Promise<number>;
  // Takes events out by id (a cancelled event, "forget the last hour").
  removeIds?(ids: string[]): Promise<number>;
  // Everything from one source (the chats imported from an AI app, to list them).
  eventsFrom?(source: LifeSource): Promise<LifeEvent[]>;
  // Deletes everything from one source, on every device ("Delete everything from Claude").
  deleteSource?(source: LifeSource): Promise<number>;
}

const FAR = 8.64e15;
const MOST = 100_000;

type LogModule = {
  addEvents?: LifeStore['addEvents'];
  upsertEvents?: LifeStore['upsertEvents'];
  removeIds?: LifeStore['removeIds'];
  eventsBetween?(from: number, to: number, filter?: { sources?: readonly LifeSource[]; limit?: number }): Promise<LifeEvent[]>;
  deleteWhere?(opts: { source?: LifeSource }): Promise<number>;
};

let current: LifeStore | null = null;
let none = false; // set to null on purpose: no store until one is set (the life log isn't loaded)
const waiting: Array<(s: LifeStore) => void> = [];

export function setLifeStore(store: LifeStore | null): void {
  current = store;
  none = !store;
  if (store) waiting.splice(0).forEach((resolve) => resolve(store));
}

// The life log module, if this build has one.
const logs = import.meta.glob<LogModule>('./log.ts');

// The store: the one set, else the life log, loaded when first needed. null when there's none.
export async function loadLifeStore(): Promise<LifeStore | null> {
  if (current) return current;
  const load = logs['./log.ts'];
  if (!load || none) return null;
  try {
    const m = await load();
    if (!current && !none && typeof m.addEvents === 'function') {
      current = {
        addEvents: (events) => m.addEvents!(events),
        ...(m.upsertEvents ? { upsertEvents: (events: LifeEvent[]) => m.upsertEvents!(events) } : {}),
        ...(m.removeIds ? { removeIds: (ids: string[]) => m.removeIds!(ids) } : {}),
        ...(m.eventsBetween ? { eventsFrom: (source: LifeSource) => m.eventsBetween!(0, FAR, { sources: [source], limit: MOST }) } : {}),
        // A wipe by source: it deletes the same on every device, even what this one never had.
        ...(m.deleteWhere ? { deleteSource: (source: LifeSource) => m.deleteWhere!({ source }) } : {}),
      };
    }
  } catch {}
  return current;
}

// Whether there is, or will be, a store to hand events to. Without one, lifeStore() waits for
// good, so nothing should start reading for it.
export const hasLifeStore = () => !!current || (!none && !!logs['./log.ts']);

// The store, waiting for one if this build has none yet.
export async function lifeStore(): Promise<LifeStore> {
  const s = await loadLifeStore();
  // (A store may have been set while looking.)
  return s || current || new Promise<LifeStore>((resolve) => waiting.push(resolve));
}
