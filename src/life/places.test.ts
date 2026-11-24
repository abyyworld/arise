// The sums behind the map of places: the projection, fitting a view, the heat map's cells, the
// scale bar, the street map's tiles, the globe; and the places themselves (time counted, spots put
// together, names, places never to note), and Your world made from them.

import { describe, expect, it } from 'vitest';
import * as MM from './map-math';
import * as PL from './places';
import * as W from './world';
import { placeKey } from '../lib/place-names';
import type { LifeEvent } from './types';
import type { Goal } from '../lib/goals';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 20, 8);
const near = (a: number, b: number, d = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(d);

describe('the flat map', () => {
  it('projects and comes back', () => {
    const p = MM.project(0, 0, 0);
    expect(p).toEqual({ x: 128, y: 128 });
    for (const [lat, lon] of [
      [41.3111, 69.2797],
      [-33.8688, 151.2093],
      [51.5, -0.12],
    ]) {
      const q = MM.project(lat, lon, 12);
      const back = MM.unproject(q.x, q.y, 12);
      near(back.lat, lat);
      near(back.lon, lon);
    }
  });

  it('fits every spot in view, as close as it can', () => {
    const spots = [
      { lat: 41.31, lon: 69.27 },
      { lat: 41.33, lon: 69.3 },
    ];
    const v = MM.fitView(spots, 400, 300, { pad: 20 });
    for (const s of spots) {
      const p = MM.toScreen(v, s.lat, s.lon);
      expect(p.x).toBeGreaterThanOrEqual(20);
      expect(p.x).toBeLessThanOrEqual(380);
      expect(p.y).toBeGreaterThanOrEqual(20);
      expect(p.y).toBeLessThanOrEqual(280);
    }
    const closer = { ...v, z: v.z + 1, cx: v.cx * 2, cy: v.cy * 2 };
    const out = spots.map((s) => MM.toScreen(closer, s.lat, s.lon));
    expect(out.some((p) => p.x < 20 || p.x > 380 || p.y < 20 || p.y > 280)).toBe(true);
    expect(MM.fitView([], 400, 300).z).toBe(MM.MIN_Z);
  });

  it('zooms round the point under the finger, and pans', () => {
    const v = MM.fitView([{ lat: 41.31, lon: 69.27 }], 400, 300, { maxZ: 12 });
    const before = MM.fromScreen(v, 100, 50);
    const z = MM.zoomAt(v, 1, 100, 50);
    expect(z.z).toBe(v.z + 1);
    const after = MM.fromScreen(z, 100, 50);
    near(after.lat, before.lat, 1e-9);
    near(after.lon, before.lon, 1e-9);
    const p = MM.pan(v, 10, 0);
    expect(p.cx).toBe(v.cx - 10);
    expect(MM.zoomAt({ ...v, z: MM.MAX_Z }, 1)).toEqual({ ...v, z: MM.MAX_Z });
  });

  it('shows a round distance on the scale bar', () => {
    const s = MM.scaleBar(0, 10, 100);
    expect(s.meters).toBe(10000); // about 153 m a pixel at the equator
    expect(s.label).toBe('10 km');
    expect(s.px).toBeLessThanOrEqual(100);
    const t = MM.scaleBar(60, 16, 100);
    expect(t.label).toBe('100 m');
    expect(t.px).toBeGreaterThan(50);
  });

  it('lists the tiles that cover a view, round the world', () => {
    const v: MM.View = { z: 2, cx: 50, cy: 512, w: 300, h: 256 };
    const tiles = MM.tilesFor(v);
    expect(tiles.every((t) => t.x >= 0 && t.x < 4 && t.y >= 0 && t.y < 4)).toBe(true);
    expect(tiles.find((t) => t.left < 0 && t.x === 3)).toBeTruthy(); // west of 180 is the last column
    const keys = tiles.map((t) => `${t.x}/${t.y}/${t.turn}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the heat map', () => {
  it('adds up the weights in each cell, heaviest first', () => {
    const bins = MM.heatBins(
      [
        { x: 1, y: 1, w: 10 },
        { x: 9, y: 9, w: 5 },
        { x: 25, y: 3, w: 40 },
        { x: 50, y: 50, w: 0 },
        { x: NaN, y: 1, w: 3 },
      ],
      20,
    );
    expect(bins).toEqual([
      { x: 30, y: 10, w: 40 },
      { x: 10, y: 10, w: 15 },
    ]);
    expect(MM.heatLevel(40, 40)).toBe(1);
    expect(MM.heatLevel(10, 40)).toBe(0.5);
    expect(MM.heatLevel(0, 40)).toBe(0);
  });
});

describe('the globe', () => {
  it('faces the spot it turns to, and hides the far side', () => {
    const f = MM.ortho(41, 69, 41, 69);
    near(f.x, 0);
    near(f.y, 0);
    expect(f.front).toBe(true);
    expect(MM.ortho(-41, -111, 41, 69).front).toBe(false);
    const east = MM.ortho(0, 90, 0, 0);
    near(east.x, 1);
    expect(MM.ortho(60, 0, 0, 0).y).toBeLessThan(0); // north is up
  });

  it('finds the middle across the 180th meridian', () => {
    const c = MM.centerOf([
      { lat: 0, lon: 179 },
      { lat: 10, lon: -179 },
    ]);
    near(Math.abs(c.lon), 180, 1e-6);
    expect(c.lat).toBe(5);
  });
});

const ev = (id: string, at: number, meta: Record<string, string | number | boolean>, more: Partial<LifeEvent> = {}): LifeEvent => ({ id: `maps:${id}`, source: 'maps', kind: 'place', at, title: 'At a place', tier: 3, meta, ...more });

describe('places', () => {
  const home = { lat: 41.3111, lon: 69.2797 };
  const lab = { lat: 41.35, lon: 69.2 };
  const events: LifeEvent[] = [
    ev('s1', T0, { ...home, via: 'stay' }, { end: T0 + 120 * MIN }),
    ev('s2', T0 + 200 * MIN, { lat: 41.3113, lon: 69.2799, via: 'stay' }, { end: T0 + 260 * MIN }), // the same place, a little off
    ev('p1', T0 + 300 * MIN, { ...lab, via: 'point' }),
    ev('p2', T0 + 330 * MIN, { ...lab, via: 'point' }),
    ev('p3', T0 + 600 * MIN, { ...lab, via: 'point' }),
    ev('g1', T0 + 700 * MIN, { lat: 51.5, lng: -0.12 }, { end: T0 + 730 * MIN, title: 'At British Museum' }), // Google's import
    ev('x', T0, {}, { title: 'Wi-Fi: Home' }), // no spot
    { ...ev('c', T0, home), kind: 'call' },
  ];

  it('counts the time at each spot inside the range', () => {
    const spots = PL.spotsOf(events);
    expect(spots.map((s) => [s.id, s.min])).toEqual([
      ['maps:s1', 120],
      ['maps:s2', 60],
      ['maps:p1', 30], // until the next point
      ['maps:p2', 60], // an hour at most
      ['maps:p3', 15], // the last one
      ['maps:g1', 30],
    ]);
    // Cut to the range: half the first stay.
    expect(PL.spotsOf(events, { from: T0 + 60 * MIN, to: T0 + 100 * MIN }).map((s) => [s.id, s.min])).toEqual([['maps:s1', 40]]);
  });

  it('leaves out places never to note', () => {
    const spots = PL.spotsOf(events, { never: [{ ...home, radius: 250, name: 'Home' }] });
    expect(spots.some((s) => s.id === 'maps:s1' || s.id === 'maps:s2')).toBe(false);
    expect(spots).toHaveLength(4);
  });

  it('puts spots close together into one place, most time first', () => {
    const places = PL.groupPlaces(PL.spotsOf(events));
    expect(places.map((p) => [p.min, p.visits.length])).toEqual([
      [180, 2],
      [105, 3],
      [30, 1],
    ]);
    expect(places[0].visits[0].id).toBe('maps:s2'); // newest first
    expect(places[0].key).toBe(placeKey(places[0].lat, places[0].lon));
    expect(PL.placeTitle(places[2])).toBe('British Museum');
    expect(PL.placeTitle(places[1])).toBe('Near 41.350, 69.200');
  });

  it('uses the names, and puts places with the same name together', () => {
    const names = { [placeKey(home.lat, home.lon)]: { name: 'Home', at: T0 } };
    const places = PL.groupPlaces(PL.spotsOf(events), names);
    expect(places[0].name).toBe('Home');
    expect(places[0].key).toBe(placeKey(home.lat, home.lon));
    expect(PL.placeTitle(places[0])).toBe('Home');
    // Two spots 300 m apart are two places, until they share a name.
    const apart = [ev('a', T0, { lat: 41.311, lon: 69.2797 }, { end: T0 + MIN * 10 }), ev('b', T0 + MIN * 20, { lat: 41.3136, lon: 69.2797 }, { end: T0 + MIN * 30 })];
    expect(PL.groupPlaces(PL.spotsOf(apart))).toHaveLength(2);
    const one = PL.groupPlaces(PL.spotsOf(apart), { [placeKey(41.312, 69.2797)]: { name: 'Campus', at: T0 } });
    expect(one.map((p) => [p.name, p.visits.length])).toEqual([['Campus', 2]]);
  });

  it('says how long in plain words', () => {
    expect(PL.timeText(0.2)).toBe('under a minute');
    expect(PL.timeText(45)).toBe('45 min');
    expect(PL.timeText(125)).toBe('2 h 5 min');
    expect(PL.timeText(120)).toBe('2 h');
    expect(PL.timeText(3 * 24 * 60 + 240)).toBe('3 days 4 h');
  });

  it('covers the ranges', () => {
    expect(PL.rangeTimes('week', T0).from).toBe(T0 - 7 * 24 * 60 * MIN);
    expect(PL.rangeTimes('all', T0).from).toBe(1);
    expect(PL.isRange('month')).toBe(true);
    expect(PL.isRange('decade')).toBe(false);
  });
});

describe('your world', () => {
  const msg = (who: string, at: number): LifeEvent => ({ id: `whatsapp:${who}${at}`, source: 'whatsapp', kind: 'message', at, title: `Chatted with ${who}`, tier: 3, meta: { chat: who } });
  const goal = (id: string, title: string, more: Partial<Goal> = {}): Goal => ({ id, title, category: 'relationships', why: '', by: '', created: '2026-10-01', updated: 1, status: 'active', quests: [], measures: [], milestones: [], ...more });

  it('finds people, links them to places and goals, and lays it out', () => {
    const home = { lat: 41.3111, lon: 69.2797 };
    const places = PL.groupPlaces(PL.spotsOf([ev('s1', T0, home, { end: T0 + 120 * MIN })]), { [placeKey(home.lat, home.lon)]: { name: 'Home', at: T0 } });
    const people = W.peopleOf([msg('Sam Lee', T0 + 10 * MIN), msg('Sam Lee', T0 + 500 * MIN), msg('Ana', T0 + 600 * MIN)]);
    expect(people.map((p) => [p.name, p.n])).toEqual([
      ['Sam Lee', 2],
      ['Ana', 1],
    ]);
    const world = W.buildWorld({ goals: [goal('g1', 'Visit Sam every month'), goal('g2', 'Run 5k', { category: 'fitness' }), goal('g3', 'Old', { status: 'done' })], people, places, areas: null });
    expect(world.nodes.map((n) => n.id)).toEqual(['you', 'g:g1', 'g:g2', `p:${people[0].key}`, `p:${people[1].key}`, `l:${places[0].key}`]);
    expect(world.nodes.find((n) => n.id === 'g:g2')?.area).toBe('body');
    expect(world.links).toEqual([
      { a: `p:${people[0].key}`, b: `l:${places[0].key}`, w: 1 }, // in touch while at Home
      { a: `p:${people[0].key}`, b: 'g:g1', w: 1 }, // the goal names Sam
    ]);
    const laid = W.layout(world, 600, 400);
    expect(laid[0]).toMatchObject({ id: 'you', x: 300, y: 200 });
    for (const n of laid) {
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(600);
      expect(n.y).toBeGreaterThan(0);
      expect(n.y).toBeLessThan(400);
    }
    const g = laid.find((n) => n.id === 'g:g1')!;
    expect(g.y).toBeLessThan(200); // goals above
    expect(W.hit(laid, g.x + 2, g.y)?.id).toBe('g:g1');
    expect(W.hit(laid, 5, 5)).toBeNull();
  });
});
