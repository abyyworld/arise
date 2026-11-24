// Names for places: the key, cleaning what comes from storage or sync, merging two devices (later
// change wins, removals stay removed), finding the name near a spot, and titles with the names.

import { describe, expect, it } from 'vitest';
import { cleanPlaceNames, keySpot, mergePlaceNames, namedTitle, nameNear, placeKey, setPlaceName, withPlaceNames, MAX_PLACE_NAMES, type PlaceNames } from './place-names';
import { merge, type CloudCopy } from './merge';
import { cleanState, type Settings } from './validate';

const NOW = Date.UTC(2026, 10, 20);
const DAY = 86_400_000;
const HOME = placeKey(41.3111, 69.2797);

describe('the key', () => {
  it('rounds to 3 decimals and reads back', () => {
    expect(HOME).toBe('41.311,69.280');
    expect(keySpot(HOME)).toEqual({ lat: 41.311, lon: 69.28 });
    expect(placeKey(-0.0001, -33.86789)).toBe('0.000,-33.868');
  });

  it("isn't anything else", () => {
    for (const k of ['', 'home', '41.31,69.28', '91.000,0.000', '0.000,181.000', '1.000,2.000,3.000', '<b>.000,1.000']) expect(keySpot(k)).toBeNull();
  });
});

describe('cleaning', () => {
  it('keeps good names, trims them, and drops bad keys and empty names', () => {
    const raw = {
      [HOME]: { name: '  Home\n sweet ', at: NOW },
      'not a key': { name: 'Lab', at: NOW },
      '1.000,2.000': { name: '   ', at: NOW },
      '3.000,4.000': { name: 'x'.repeat(80), at: NOW },
      '5.000,6.000': { name: 'Old', at: 'yesterday' },
    };
    const out = cleanPlaceNames(raw, NOW);
    expect(Object.keys(out)).toEqual(['3.000,4.000', HOME]); // in a fixed order
    expect(out[HOME]).toEqual({ name: 'Home sweet', at: NOW });
    expect(out['3.000,4.000'].name).toHaveLength(40);
  });

  it('keeps a removal for a while, then lets it go', () => {
    const out = cleanPlaceNames({ [HOME]: { gone: true, at: NOW - DAY }, '1.000,2.000': { gone: true, at: NOW - 200 * DAY } }, NOW);
    expect(out).toEqual({ [HOME]: { name: '', at: NOW - DAY, gone: true } });
  });

  it('keeps the newest names past the most it holds', () => {
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PLACE_NAMES + 10; i++) raw[placeKey(i / 10, 1)] = { name: `P${i}`, at: NOW - i };
    const out = cleanPlaceNames(raw, NOW);
    expect(Object.keys(out)).toHaveLength(MAX_PLACE_NAMES);
    expect(out[placeKey(0, 1)]).toBeTruthy();
    expect(out[placeKey((MAX_PLACE_NAMES + 9) / 10, 1)]).toBeUndefined();
  });

  it('is part of the state, and anything wrong in it goes', () => {
    const st = cleanState({ placeNames: { [HOME]: { name: 'Home', at: NOW }, bad: 1 } }, {} as Settings);
    expect(Object.keys(st.placeNames)).toEqual([HOME]);
    expect(cleanState({ placeNames: 'nope' }, {} as Settings).placeNames).toEqual({});
  });
});

describe('merging two devices', () => {
  const a: PlaceNames = { [HOME]: { name: 'Home', at: NOW - 100 }, '1.000,2.000': { name: 'Lab', at: NOW - 50 } };
  const b: PlaceNames = { [HOME]: { name: 'Flat', at: NOW - 10 }, '1.000,2.000': { name: '', gone: true, at: NOW - 80 }, '3.000,4.000': { name: 'Mosque', at: NOW - 5 } };

  it('takes each name from the later change, either way round', () => {
    const want = { '1.000,2.000': { name: 'Lab', at: NOW - 50 }, [HOME]: { name: 'Flat', at: NOW - 10 }, '3.000,4.000': { name: 'Mosque', at: NOW - 5 } };
    expect(mergePlaceNames(a, b, NOW)).toEqual(want);
    expect(mergePlaceNames(b, a, NOW)).toEqual(want);
  });

  it("doesn't bring back a name taken away later", () => {
    const gone = setPlaceName(a, HOME, '', NOW)!;
    expect(mergePlaceNames(gone, a, NOW)[HOME].gone).toBe(true);
    expect(mergePlaceNames(a, gone, NOW)[HOME].gone).toBe(true);
  });

  it('goes through the sync merge with the rest', () => {
    const copy = (raw: Record<string, unknown>): CloudCopy => {
      const { active: _a, updatedAt: _u, ...rest } = cleanState(raw, {} as Settings);
      return rest;
    };
    const m = merge(copy({ placeNames: a }), 1, copy({ placeNames: b }), 2, NOW);
    expect(m.placeNames[HOME].name).toBe('Flat');
    expect(m.placeNames['3.000,4.000'].name).toBe('Mosque');
  });
});

describe('naming', () => {
  it('sets, renames and takes away, each a later change', () => {
    const one = setPlaceName({}, HOME, ' Home ', NOW)!;
    expect(one[HOME]).toEqual({ name: 'Home', at: NOW });
    const two = setPlaceName(one, HOME, 'Flat', NOW)!; // the same millisecond still counts as later
    expect(two[HOME]).toEqual({ name: 'Flat', at: NOW + 1 });
    expect(setPlaceName(two, HOME, '', NOW + 5)![HOME]).toEqual({ name: '', at: NOW + 5, gone: true });
    expect(setPlaceName({}, 'nowhere', 'Home', NOW)).toBeNull();
    const none = {};
    expect(setPlaceName(none, HOME, '', NOW)).toBe(none);
  });

  it('finds the closest name within 200 m', () => {
    const names = { [HOME]: { name: 'Home', at: NOW }, [placeKey(41.313, 69.28)]: { name: 'Shop', at: NOW } };
    expect(nameNear(names, 41.3112, 69.2799)?.name).toBe('Home');
    expect(nameNear(names, 41.3128, 69.28)?.name).toBe('Shop');
    expect(nameNear(names, 41.32, 69.28)).toBeNull();
    expect(nameNear({ [HOME]: { name: '', at: NOW, gone: true } }, 41.311, 69.28)).toBeNull();
  });

  it('puts the name in place titles', () => {
    const names = { [HOME]: { name: 'Home', at: NOW } };
    const at = (title: string, meta: Record<string, number | string | boolean> = { lat: 41.3111, lon: 69.2797 }) => namedTitle({ kind: 'place', title, meta }, names);
    expect(at('At a place for 2 h')).toBe('At Home for 2 h');
    expect(at('Where you were')).toBe('At Home');
    expect(at('Left a place')).toBe('Left Home');
    expect(at('At Starbucks')).toBe('At Starbucks (Home)');
    expect(at('At home')).toBe('At home');
    expect(at('At a place', { lat: 41.3111, lng: 69.2797 })).toBe('At Home'); // Google's import says lng
    expect(at('At a place', { lat: 10, lon: 10 })).toBe('At a place');
    expect(namedTitle({ kind: 'call', title: 'Call with Sam', meta: { lat: 41.3111, lon: 69.2797 } }, names)).toBe('Call with Sam');
    const evs = [{ kind: 'place' as const, title: 'Where you were', meta: { lat: 41.3111, lon: 69.2797 } }, { kind: 'note' as const, title: 'Hi' }];
    const out = withPlaceNames(evs, names);
    expect(out.map((e) => e.title)).toEqual(['At Home', 'Hi']);
    expect(out[1]).toBe(evs[1]);
    expect(evs[0].title).toBe('Where you were');
  });
});
