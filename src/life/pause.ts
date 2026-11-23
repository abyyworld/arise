// Pause everything: one switch that stops Arise noting anything from every source, for an hour, a
// day, or until it's turned back on. Kept in the settings, which sync end-to-end encrypted, so a
// pause started on the phone holds on the Mac and in the browser too. The rules are in
// lib/pause.ts.
//
// While it's on, the phones read nothing and their own recorders (notifications, location,
// connections) keep nothing; the Mac helper's and the extension's batches are taken but whatever
// happened during the pause is dropped. Anything read later that happened during a pause (a call
// log read from where it stopped) is dropped too.

import * as S from '../store';
import * as P from '../lib/pause';
import type { Pause } from '../lib/pause';

export { FOREVER } from '../lib/pause';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const pauses = (now = Date.now()): Pause[] => P.cleanPauses(S.state?.settings?.pauses, now);

export const isPaused = (now = Date.now()) => !!P.activePause(pauses(now), now);

// When it ends: 0 when it's off, FOREVER until turned back on.
export const pausedUntil = (now = Date.now()) => P.pausedUntil(pauses(now), now);

// Only what didn't happen during a pause.
export const unpaused = <T extends { at: number }>(items: readonly T[]): T[] => P.keepUnpaused(items, pauses());

const watchers = new Set<() => void>();
// Told when it starts or ends on this device (the phones pass it on to their recorders).
export function onPauseChange(cb: () => void): () => void {
  watchers.add(cb);
  return () => watchers.delete(cb);
}

function set(next: Pause[]) {
  const settings = S.state.settings;
  if (next.length) settings.pauses = next;
  else delete settings.pauses;
  S.save();
  for (const cb of [...watchers]) {
    try {
      cb();
    } catch {}
  }
}

// Pauses for `ms` (0: until turned back on).
export function pause(ms: number, now = Date.now()) {
  set(P.startPause(pauses(now), now, ms));
}

export function resume(now = Date.now()) {
  set(P.endPause(pauses(now), now));
}
