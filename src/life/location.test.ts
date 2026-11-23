// @vitest-environment jsdom
// Location on a timer (location.ts): the setting kept safely, the minutes typed, rounding to about
// 1 km, places never to note, one point per interval, stays made from points, and the events.

import { describe, expect, it } from 'vitest';
import * as LOC from './location';

const MIN = 60_000;
const T0 = new Date(2026, 10, 20, 9, 0).getTime();
const HOME = { lat: 41.3111, lon: 69.2797 };

describe('the setting', () => {
  it('starts off, every 30 minutes, exact, with no places never to note', () => {
    expect(LOC.cleanLocationPrefs({})).toEqual({ mode: 'off', every: 30, exact: true, never: [] });
    expect(LOC.cleanLocationPrefs(null)).toEqual(LOC.defaultPrefs());
  });

  it('keeps only what makes sense', () => {
    const p = LOC.cleanLocationPrefs({ mode: 'always', every: 0, exact: 'no', never: [{ lat: 95, lon: 0 }, { lat: 41.3, lon: 69.2, radius: 9e9, name: '  Home   base ' }, 'x'] });
    expect(p).toEqual({ mode: 'off', every: 30, exact: true, never: [{ lat: 41.3, lon: 69.2, radius: 250, name: 'Home base' }] });
    expect(LOC.cleanLocationPrefs({ mode: 'interval', every: 5, exact: false }).every).toBe(5);
    expect(LOC.cleanLocationPrefs({ mode: 'places' }).mode).toBe('places');
    expect(LOC.cleanLocationPrefs({ exact: false }).exact).toBe(false);
  });

  it('takes a typed number of minutes from 1 to 720', () => {
    expect(LOC.parseEvery('45')).toBe(45);
    expect(LOC.parseEvery(' 7 ')).toBe(7);
    expect(LOC.parseEvery('0')).toBeNull();
    expect(LOC.parseEvery('721')).toBeNull();
    expect(LOC.parseEvery('2.5')).toBeNull();
    expect(LOC.parseEvery('ten')).toBeNull();
    expect(LOC.parseEvery('')).toBeNull();
    expect(LOC.cleanEvery(12.4)).toBe(12);
    expect(LOC.cleanEvery('90')).toBe(90);
    expect(LOC.cleanEvery(-3)).toBe(LOC.SUGGESTED_EVERY);
  });

  it('says the interval in words', () => {
    expect(LOC.everyText(1)).toBe('every minute');
    expect(LOC.everyText(30)).toBe('every 30 minutes');
    expect(LOC.everyText(60)).toBe('every hour');
    expect(LOC.everyText(120)).toBe('every 2 hours');
  });

  it('keeps at most 50 places never to note', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ lat: 1 + i / 100, lon: 2, radius: 100 }));
    expect(LOC.cleanNever(many)).toHaveLength(50);
  });

  it('is kept in this browser only, and comes back clean', () => {
    localStorage.clear();
    expect(LOC.loadState().prefs.mode).toBe('off');
    LOC.saveState({ prefs: { ...LOC.defaultPrefs(), mode: 'interval', every: 15 }, held: [{ at: T0, lat: 1, lon: 2 }], last: { at: T0, added: 3 } });
    expect(LOC.loadState()).toEqual({ prefs: { mode: 'interval', every: 15, exact: true, never: [] }, held: [{ at: T0, lat: 1, lon: 2 }], last: { at: T0, added: 3 } });
    localStorage.setItem('arise-location', '{broken');
    expect(LOC.loadState().prefs.mode).toBe('off');
    LOC.forgetState();
    expect(localStorage.getItem('arise-location')).toBeNull();
  });
});

describe('where', () => {
  it('rounds to a grid of about 1 km', () => {
    const r = LOC.roundSpot(41.3111, 69.2797);
    expect(r.lat).toBeCloseTo(41.31, 5);
    expect(LOC.distance(HOME, r)).toBeLessThan(1000);
    // Two spots a few hundred meters apart in the same cell land on the same point.
    expect(LOC.roundSpot(r.lat + 0.002, r.lon - 0.002)).toEqual(r);
    expect(LOC.roundSpot(r.lat - 0.002, r.lon + 0.003)).toEqual(r);
    // The cells are as wide as they are tall, even far north.
    const north = LOC.roundSpot(64.1466, -21.9426);
    expect(LOC.distance({ lat: 64.1466, lon: -21.9426 }, north)).toBeLessThan(1200);
  });

  it('measures meters between two spots', () => {
    expect(LOC.distance(HOME, HOME)).toBe(0);
    // 0.01 degrees of latitude is about 1.1 km.
    expect(LOC.distance({ lat: 0, lon: 0 }, { lat: 0.01, lon: 0 })).toBeGreaterThan(1100);
    expect(LOC.distance({ lat: 0, lon: 0 }, { lat: 0.01, lon: 0 })).toBeLessThan(1120);
  });

  it('knows a spot inside a place never to note', () => {
    const never = [{ ...HOME, radius: 250, name: 'Home' }];
    expect(LOC.inNever({ lat: 41.3121, lon: 69.2797 }, never)).toBe(true); // about 110 m away
    expect(LOC.inNever({ lat: 41.3161, lon: 69.2797 }, never)).toBe(false); // about 550 m away
    expect(LOC.inNever(HOME, [])).toBe(false);
  });
});

describe('points', () => {
  const pts = (mins: number[]) => mins.map((m, i) => ({ at: T0 + m * MIN, lat: 41.2 + i / 100, lon: 69.1, acc: 20 }));

  it('keeps one point per interval, with a little room for a late phone', () => {
    const kept = LOC.thin(pts([0, 5, 14, 25, 29, 50]), 30);
    expect(kept.map((p) => (p.at - T0) / MIN)).toEqual([0, 25, 50]);
    expect(LOC.thin(pts([0, 5, 14]), 5).map((p) => (p.at - T0) / MIN)).toEqual([0, 5, 14]);
    // Continues from the last one kept before.
    expect(LOC.thin(pts([10, 40]), 30, T0).map((p) => (p.at - T0) / MIN)).toEqual([40]);
  });

  it('drops what is inside a place never to note, and rounds unless exact', () => {
    const prefs = { ...LOC.defaultPrefs(), never: [{ ...HOME, radius: 300, name: 'Home' }] };
    const raw = [
      { at: T0 + MIN, lat: 41.3112, lon: 69.2798, acc: 10 }, // home
      { at: T0, lat: 41.35, lon: 69.3, acc: 12 },
      { at: 'soon', lat: 1, lon: 2 },
      { at: T0 + 2 * MIN, lat: 200, lon: 2 },
    ];
    expect(LOC.prepare(raw, prefs)).toEqual([{ at: T0, lat: 41.35, lon: 69.3, acc: 12 }]);
    const rough = LOC.prepare(raw, { ...prefs, exact: false });
    expect(rough).toEqual([{ at: T0, ...LOC.roundSpot(41.35, 69.3), acc: 1000 }]);
  });

  it('makes a sensitive Maps event with a stable id per phone', () => {
    const e = LOC.pointEvent({ at: T0, lat: 41.35123456, lon: 69.3, acc: 12 }, 'android', true);
    expect(e).toMatchObject({ id: `maps:point:android:${T0 / 1000}`, source: 'maps', kind: 'place', at: T0, tier: 3, title: 'Where you were' });
    expect(e.meta).toEqual({ lat: 41.35123, lon: 69.3, via: 'point', device: 'android', acc: 12 });
    expect(e.detail).toBe('41.3512, 69.3000, within about 12 m');
    expect(LOC.pointEvent({ at: T0, lat: 41.35, lon: 69.3 }, 'iphone', false)).toMatchObject({ id: `maps:point:iphone:${T0 / 1000}`, detail: '41.35, 69.30, to about 1 km', meta: { rounded: true } });
    expect(LOC.hasSpot(e)).toBe(true);
    expect(LOC.hasSpot({ source: 'maps', meta: {} })).toBe(false);
    expect(LOC.hasSpot({ source: 'android', meta: { lat: 1, lon: 2 } })).toBe(false);
  });
});

describe('stays, for places only on Android', () => {
  const at = (mins: number, lat: number, lon = 69.28) => ({ at: T0 + mins * MIN, lat, lon });

  it('turns points close together for a while into a stay, and holds the one still going', () => {
    const points = [at(0, 41.311), at(15, 41.3111), at(30, 41.3112), at(45, 41.4), at(60, 41.5), at(75, 41.5001)];
    const { stays, held } = LOC.stays(points, T0 + 80 * MIN);
    expect(stays).toHaveLength(1);
    expect(stays[0]).toMatchObject({ arrive: T0, depart: T0 + 30 * MIN });
    expect(held.map((p) => p.at)).toEqual([T0 + 60 * MIN, T0 + 75 * MIN]);
  });

  it('notes a stay still going after 3 days as it is', () => {
    const points = [at(0, 41.311), at(15, 41.3111)];
    expect(LOC.stays(points, T0 + 4 * 24 * 60 * MIN)).toMatchObject({ stays: [{ arrive: T0, depart: T0 + 15 * MIN }], held: [] });
  });

  it('leaves out a moment somewhere on the way', () => {
    const points = [at(0, 41.311), at(15, 41.4), at(30, 41.5)];
    expect(LOC.stays(points, T0 + 31 * MIN).stays).toEqual([]);
  });

  it('makes an event that says how long', () => {
    const e = LOC.stayEvent({ arrive: T0, depart: T0 + 130 * MIN, lat: 41.3111, lon: 69.2797 }, 'android', true);
    expect(e).toMatchObject({ id: `maps:stay:android:${T0 / 1000}`, title: 'At a place for 2 h 10 min', end: T0 + 130 * MIN, value: 130, unit: 'min', tier: 3 });
    const rough = LOC.stayEvent({ arrive: T0, depart: T0 + 20 * MIN, lat: 41.3111, lon: 69.2797 }, 'android', false);
    expect(rough.meta).toMatchObject({ lat: 41.31, rounded: true });
  });
});
