// Sign out of all devices (account.ts, sync.ts).
//
// Firebase can't end another device's sign-in from the app. So the account keeps one small
// document, users/{uid}/arise/signout: when the Player last chose "Sign out of all devices" (the
// database's own clock, so no device's clock can move it) and whether those devices also remove
// Arise's data. Every device looks at it when Arise starts, at each sync and when Arise comes back
// to the screen, and signs itself out if it signed in before that time. A device that's off or
// offline does it the next time it's online. The document holds nothing of the Player's data:
// only a time and a yes or no.

export interface Cut {
  at: number; // ms
  wipe: boolean; // the devices that sign out also remove Arise's data
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// A Firestore Timestamp (or the same as a plain object) in ms. NaN when it isn't one.
export function stampMs(v: unknown): number {
  const o = obj(v);
  if (typeof o.toMillis === 'function') {
    const ms = Number((o.toMillis as () => unknown)());
    return Number.isFinite(ms) ? ms : NaN;
  }
  const s = o.seconds;
  const n = o.nanoseconds ?? 0;
  if (typeof s !== 'number' || !Number.isFinite(s) || typeof n !== 'number' || !Number.isFinite(n)) return NaN;
  return s * 1000 + Math.floor(n / 1e6);
}

// The document as read from the cloud, checked field by field. Null when there's none, or it
// doesn't look right (then nobody is signed out by it).
export function parseCut(d: unknown): Cut | null {
  const o = obj(d);
  if (o.v !== 1) return null;
  const at = stampMs(o.at);
  if (!(at > 0) || at > 8.64e15) return null;
  return { at, wipe: o.wipe === true };
}

// Whether a device that signed in at `signedInAt` (ms, from its sign-in token) signs out now.
// Its token counts whole seconds, so the two are compared in whole seconds: the device that chose
// it signs in again right after (to stay signed in), maybe within the same second. Not when the
// sign-in time isn't known: it's checked again next time.
export function mustSignOut(signedInAt: number | null, cut: Cut | null): boolean {
  if (!cut || signedInAt === null || !Number.isFinite(signedInAt) || signedInAt <= 0) return false;
  return Math.floor(signedInAt / 1000) < Math.floor(cut.at / 1000);
}
