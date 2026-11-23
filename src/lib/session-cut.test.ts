import { describe, expect, it } from 'vitest';
import { mustSignOut, parseCut, stampMs } from './session-cut';

const T = Date.UTC(2026, 10, 1, 12, 0, 20); // 12:00:20

describe('the time of "Sign out of all devices"', () => {
  it("reads Firestore's Timestamp and its plain shape", () => {
    expect(stampMs({ toMillis: () => T })).toBe(T);
    expect(stampMs({ seconds: T / 1000, nanoseconds: 500_000_000 })).toBe(T + 500);
    expect(stampMs({ seconds: T / 1000 })).toBe(T);
    expect(stampMs(T)).toBeNaN();
    expect(stampMs({ seconds: '1' })).toBeNaN();
    expect(stampMs(null)).toBeNaN();
  });

  it('takes only the shape the rules allow', () => {
    expect(parseCut({ v: 1, at: { seconds: T / 1000, nanoseconds: 0 }, wipe: true })).toEqual({ at: T, wipe: true });
    expect(parseCut({ v: 1, at: { seconds: T / 1000, nanoseconds: 0 }, wipe: 'yes' })).toEqual({ at: T, wipe: false });
    expect(parseCut({ v: 2, at: { seconds: T / 1000 }, wipe: false })).toBeNull();
    expect(parseCut({ v: 1, at: T, wipe: false })).toBeNull();
    expect(parseCut({ v: 1, at: { seconds: -5 }, wipe: false })).toBeNull();
    expect(parseCut(undefined)).toBeNull();
  });
});

describe('whether a device signs out', () => {
  const cut = { at: T + 300, wipe: false }; // 12:00:20.3

  it('signs out a device that signed in before it', () => {
    expect(mustSignOut(T - 1000, cut)).toBe(true);
    expect(mustSignOut(T - 86_400_000 * 30, cut)).toBe(true);
  });

  it('keeps a device that signed in after it, or in the same second (the one that chose it, signing in again)', () => {
    expect(mustSignOut(T + 1000, cut)).toBe(false);
    expect(mustSignOut(T, cut)).toBe(false); // its token says 12:00:20
  });

  it('keeps every device while there is none, or the sign-in time is unknown', () => {
    expect(mustSignOut(T - 1000, null)).toBe(false);
    expect(mustSignOut(null, cut)).toBe(false);
    expect(mustSignOut(NaN, cut)).toBe(false);
    expect(mustSignOut(0, cut)).toBe(false);
  });
});
