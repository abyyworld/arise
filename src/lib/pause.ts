// Pause everything: the times when Arise noted nothing, from any source (the phones, location, the
// Mac helper, the browser extension). Plain functions, so validation and the tests can use them;
// src/life/pause.ts keeps the list in the synced settings.
//
// Each pause is [from, to): `to` is 0 while it lasts until the Player turns it back on. Pauses that
// ended are kept for a while, so something read later (a call log read from where it stopped, a
// batch that waited in the extension) is still left out when it happened during one.

export type Pause = [number, number];

const DAY = 86_400_000;
// How long an ended pause is remembered: longer than anything waits on a device.
export const KEEP_FOR = 60 * DAY;
const MAX = 50;
// For the phones: "until turned back on", as a time far in the future (year 275760).
export const FOREVER = 8.64e15;

const okTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < FOREVER;

export function cleanPauses(raw: unknown, now = Date.now()): Pause[] {
  const out: Pause[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!Array.isArray(x) || x.length !== 2) continue;
    const [from, to] = x as unknown[];
    if (!okTime(from) || !(to === 0 || (okTime(to) && to > from))) continue;
    if (to !== 0 && to < now - KEEP_FOR) continue;
    out.push([Math.floor(from), to === 0 ? 0 : Math.floor(to)]);
  }
  return out.sort((a, b) => a[0] - b[0]).slice(-MAX);
}

// The pause on now, if any.
export function activePause(pauses: readonly Pause[], now = Date.now()): Pause | null {
  return pauses.find(([from, to]) => from <= now && (to === 0 || to > now)) ?? null;
}

// Whether a moment falls in a pause (one that's on, or one that ended).
export const pausedAt = (pauses: readonly Pause[], t: number) => pauses.some(([from, to]) => t >= from && (to === 0 || t < to));

// Pauses from now, for `ms` (0: until turned back on). A pause already on ends where this starts.
export function startPause(pauses: readonly Pause[], now: number, ms: number): Pause[] {
  const ended = endPause(pauses, now);
  return cleanPauses([...ended, [now, ms > 0 ? now + ms : 0]], now);
}

// Turned back on now.
export function endPause(pauses: readonly Pause[], now: number): Pause[] {
  return cleanPauses(
    pauses
      .map(([from, to]): Pause => (from <= now && (to === 0 || to > now) ? [from, now] : [from, to]))
      .filter(([from, to]) => to === 0 || to > from),
    now,
  );
}

// When the pause on now ends: 0 when there's none, FOREVER when it lasts until turned back on.
export function pausedUntil(pauses: readonly Pause[], now = Date.now()): number {
  const p = activePause(pauses, now);
  if (!p) return 0;
  return p[1] === 0 ? FOREVER : p[1];
}

// What didn't happen during a pause.
export const keepUnpaused = <T extends { at: number }>(items: readonly T[], pauses: readonly Pause[]): T[] => (pauses.length ? items.filter((e) => !pausedAt(pauses, e.at)) : [...items]);
