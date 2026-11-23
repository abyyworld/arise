// Pause everything (lib/pause.ts): the pauses kept safely, starting and ending one, what falls in
// one, and the setting in the synced settings (validate.ts).

import { describe, expect, it } from 'vitest';
import * as P from './pause';
import { cleanSettings, type Settings } from './validate';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 23, 12);

describe('the pauses', () => {
  it('keeps only sensible ones, oldest first, and forgets those long over', () => {
    expect(P.cleanPauses(null, NOW)).toEqual([]);
    expect(
      P.cleanPauses(
        [
          [NOW, 0],
          [NOW - 2 * HOUR, NOW - HOUR],
          [NOW, NOW - 1], // ends before it starts
          [NOW - 90 * DAY, NOW - 89 * DAY], // long over
          ['x', 0],
          [NOW, 0, 1],
          [NOW, 9e15],
        ],
        NOW,
      ),
    ).toEqual([
      [NOW - 2 * HOUR, NOW - HOUR],
      [NOW, 0],
    ]);
  });

  it('starts one for an hour, a day, or until turned back on', () => {
    expect(P.startPause([], NOW, HOUR)).toEqual([[NOW, NOW + HOUR]]);
    expect(P.pausedUntil(P.startPause([], NOW, DAY), NOW)).toBe(NOW + DAY);
    const forever = P.startPause([], NOW, 0);
    expect(forever).toEqual([[NOW, 0]]);
    expect(P.pausedUntil(forever, NOW + 400 * DAY)).toBe(P.FOREVER);
    expect(P.pausedUntil([], NOW)).toBe(0);
  });

  it('ends the one on when another starts, and when turned back on', () => {
    const one = P.startPause([], NOW, DAY);
    const two = P.startPause(one, NOW + HOUR, 0);
    expect(two).toEqual([
      [NOW, NOW + HOUR],
      [NOW + HOUR, 0],
    ]);
    expect(P.endPause(two, NOW + 2 * HOUR)).toEqual([
      [NOW, NOW + HOUR],
      [NOW + HOUR, NOW + 2 * HOUR],
    ]);
    // Turned back on the moment it started: nothing to remember.
    expect(P.endPause([[NOW, 0]], NOW)).toEqual([]);
  });

  it('knows what happened during one, even one that ended', () => {
    const pauses: P.Pause[] = [
      [NOW - 3 * HOUR, NOW - 2 * HOUR],
      [NOW, 0],
    ];
    expect(P.pausedAt(pauses, NOW - 150 * 60_000)).toBe(true);
    expect(P.pausedAt(pauses, NOW - 2 * HOUR)).toBe(false); // the moment it ended
    expect(P.pausedAt(pauses, NOW - HOUR)).toBe(false);
    expect(P.pausedAt(pauses, NOW + 5 * DAY)).toBe(true);
    expect(P.activePause(pauses, NOW - HOUR)).toBeNull();
    const items = [{ at: NOW - 150 * 60_000 }, { at: NOW - HOUR }, { at: NOW + 1 }];
    expect(P.keepUnpaused(items, pauses)).toEqual([{ at: NOW - HOUR }]);
    expect(P.keepUnpaused(items, [])).toEqual(items);
  });
});

describe('in the synced settings', () => {
  const d = cleanSettings({}, {} as Settings);
  it('is left out when there are none, and kept clean when there are', () => {
    expect('pauses' in cleanSettings({}, d)).toBe(false);
    expect('pauses' in cleanSettings({ pauses: 'yes' }, d)).toBe(false);
    const now = Date.now();
    expect(cleanSettings({ pauses: [[now - HOUR, 0], [5, 'x']] }, d).pauses).toEqual([[now - HOUR, 0]]);
  });
});
