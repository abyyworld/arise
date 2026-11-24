// The Player's corrections and the snapshots of what Arise knew, kept on this device in the life
// log's database ('kv': 'fixes' and 'knew'). Each change marks the memory's pack, so it goes to
// the Player's other devices too (packs.ts, cloud.ts). The rules are in fixes.ts.

import { cleanLifeFix, type LifeFix, type LifeKnew } from '../lib/validate';
import { done, open, req } from './db';
import { markDirty, dirtied } from './journal';
import { MEM } from './packs';
import { cleanFixes, cleanKnew, combine, MAX_FIXES, thinKnew } from './fixes';

export const FIXES = 'fixes';
export const KNEW = 'knew';

const valueOf = (row: unknown) => (row as { v?: unknown } | undefined)?.v;

// Every correction on this device ([] when the log can't be read).
export async function readFixes(): Promise<LifeFix[]> {
  try {
    const db = await open();
    return cleanFixes(valueOf(await req(db.transaction('kv').objectStore('kv').get(FIXES))));
  } catch {
    return [];
  }
}

// Keeps a correction (on top of any earlier one of the same thing), in the same go as noting that
// the memory's pack changed. Resolves with it as kept.
export async function saveFix(raw: LifeFix): Promise<LifeFix> {
  const fix = cleanLifeFix(raw);
  if (!fix) throw new Error("That correction couldn't be kept.");
  const db = await open();
  const tx = db.transaction(['kv', 'sync'], 'readwrite');
  const kv = tx.objectStore('kv');
  let kept = fix;
  const g = kv.get(FIXES);
  g.onsuccess = () => {
    const list = cleanFixes(valueOf(g.result));
    kept = combine(
      list.find((f) => f.id === fix.id),
      fix,
    );
    kv.put({ k: FIXES, v: [...list.filter((f) => f.id !== fix.id), kept].slice(-MAX_FIXES) });
    markDirty(tx, [MEM]);
  };
  await done(tx);
  dirtied();
  return kept;
}

// Every snapshot of what Arise knew, oldest first.
export async function readKnew(): Promise<LifeKnew[]> {
  try {
    const db = await open();
    return cleanKnew(valueOf(await req(db.transaction('kv').objectStore('kv').get(KNEW)))).sort((a, b) => (a.day < b.day ? -1 : 1));
  } catch {
    return [];
  }
}

// Keeps what Arise knows today, unless it's the same as the last one kept. Resolves with whether
// it was kept.
export async function saveKnew(snap: LifeKnew): Promise<boolean> {
  const db = await open();
  const tx = db.transaction(['kv', 'sync'], 'readwrite');
  const kv = tx.objectStore('kv');
  let kept = false;
  const g = kv.get(KNEW);
  g.onsuccess = () => {
    const list = cleanKnew(valueOf(g.result)).sort((a, b) => (a.day < b.day ? -1 : 1));
    const last = list.filter((k) => k.day <= snap.day).at(-1);
    if (last && JSON.stringify(last.facts) === JSON.stringify(snap.facts)) return;
    kv.put({ k: KNEW, v: thinKnew([...list.filter((k) => k.day !== snap.day), snap], snap.day) });
    markDirty(tx, [MEM]);
    kept = true;
  };
  await done(tx);
  if (kept) dirtied();
  return kept;
}
