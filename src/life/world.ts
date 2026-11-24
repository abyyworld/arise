// "Your world": the people, goals and places in the Player's life, and how they meet, from what
// Arise already has (goals, calls and messages, places, the parts of life in areas.ts). The
// constellation, the globe and the outline in world-ui.js all draw this. Pure: no store, no log,
// no network.

import { AREA_IDS, AREAS, GROW_CATEGORY, SCALE, type AreaId } from '../lib/life-check';
import type { Goal } from '../lib/goals';
import type { LifeArea } from './areas';
import { personName, personOf } from './signals';
import { placeTitle, timeText, type Place } from './places';
import type { LifeEvent } from './types';

const MIN = 60_000;
export const MAX_EACH = 12; // people, places and goals each

export type NodeKind = 'you' | 'goal' | 'person' | 'place';

export interface WorldNode {
  id: string; // 'you', 'g:<goal id>', 'p:<person>', 'l:<place key>'
  kind: NodeKind;
  label: string;
  size: number; // 0 to 1, against the others of its kind
  detail: string; // "14 calls and messages", "32 h"
  area?: AreaId; // a goal's part of life
  lat?: number; // a place's spot
  lon?: number;
}

export interface WorldLink {
  a: string;
  b: string;
  w: number; // how many times
}

export interface World {
  nodes: WorldNode[];
  links: WorldLink[];
  areas: { id: AreaId; label: string; word: string }[];
}

export interface Person {
  key: string;
  name: string;
  n: number; // calls and messages
  times: number[];
}

// The people they were in touch with (calls and messages with someone), most first.
export function peopleOf(events: readonly LifeEvent[]): Person[] {
  const by = new Map<string, Person>();
  for (const e of events) {
    const key = personOf(e);
    if (!key) continue;
    const p = by.get(key) || { key, name: personName(e) || key, n: 0, times: [] };
    p.n++;
    p.times.push(e.at);
    by.set(key, p);
  }
  return [...by.values()].sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1));
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
const mentions = (text: string, name: string) => {
  const first = words(name).split(/[\s@.]+/)[0] || '';
  if (first.length < 3 || /^\+?\d/.test(first)) return false;
  return new RegExp(`(^|[^\\p{L}])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u').test(words(text));
};

// While at a place: a visit's time, or 30 minutes either side of a moment there.
const near = (t: number, p: Place) => p.visits.some((v) => (v.end ? t >= v.at && t <= v.end : Math.abs(t - v.at) <= 30 * MIN));

const goalText = (g: Goal) => [g.title, g.why, ...g.quests.map((q) => q.title)].join(' ');
const areaOf = (g: Goal): AreaId | undefined => AREA_IDS.find((a) => GROW_CATEGORY[a] === g.category);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buildWorld({ goals = [], people = [], places = [], areas = null }: { goals?: readonly Goal[]; people?: readonly Person[]; places?: readonly Place[]; areas?: readonly LifeArea[] | null }): World {
  const gs = goals.filter((g) => g.status !== 'done').slice(0, MAX_EACH);
  const ps = people.slice(0, MAX_EACH);
  const ls = places.filter((p) => p.min > 0 || p.name).slice(0, MAX_EACH);
  const most = (xs: number[]) => Math.max(1, ...xs);
  const topN = most(ps.map((p) => p.n));
  const topMin = most(ls.map((p) => p.min));
  const topQ = most(gs.map((g) => g.quests.filter((q) => !q.archived).length));
  const nodes: WorldNode[] = [
    { id: 'you', kind: 'you', label: 'You', size: 1, detail: '' },
    ...gs.map((g): WorldNode => {
      const q = g.quests.filter((x) => !x.archived).length;
      return { id: `g:${g.id}`, kind: 'goal', label: g.title, size: Math.sqrt((q || 0.5) / topQ), detail: `${g.status === 'paused' ? 'Paused. ' : ''}${q ? plural(q, 'quest') : 'No quests yet'}`, area: areaOf(g) };
    }),
    ...ps.map((p): WorldNode => ({ id: `p:${p.key}`, kind: 'person', label: p.name, size: Math.sqrt(p.n / topN), detail: plural(p.n, 'call or message', 'calls and messages') })),
    ...ls.map((p): WorldNode => ({ id: `l:${p.key}`, kind: 'place', label: placeTitle(p), size: Math.sqrt(Math.max(1, p.min) / topMin), detail: p.min ? timeText(p.min) : plural(p.visits.length, 'visit'), lat: p.lat, lon: p.lon })),
  ];
  const links: WorldLink[] = [];
  for (const person of ps) {
    // The places they were when in touch, the three most.
    const at = ls
      .map((pl) => ({ pl, w: person.times.filter((t) => near(t, pl)).length }))
      .filter((x) => x.w > 0)
      .sort((a, b) => b.w - a.w)
      .slice(0, 3);
    for (const { pl, w } of at) links.push({ a: `p:${person.key}`, b: `l:${pl.key}`, w });
    // Goals that name them.
    for (const g of gs) if (mentions(goalText(g), person.name)) links.push({ a: `p:${person.key}`, b: `g:${g.id}`, w: 1 });
  }
  // The parts of life worked out so far (with nothing to go on, they'd only say so eight times).
  const areaList = (areas || []).filter((a) => a.score).map((a) => ({ id: a.id, label: AREAS[a.id]?.label || a.label, word: a.score ? SCALE[Math.max(1, Math.min(5, Math.round(a.score))) - 1] : 'Not enough to go on yet' }));
  return { nodes, links, areas: areaList };
}

// ---------- the constellation's layout

export interface Laid extends WorldNode {
  x: number;
  y: number;
  r: number; // its dot's radius
}

// Where each kind sits round You: goals above, people to the lower left, places to the lower right.
const SECTOR: Record<Exclude<NodeKind, 'you'>, number> = { goal: -90, person: 150, place: 30 };
const SPREAD = 100; // degrees each kind spreads over

// Fixed places on a canvas of w by h: You in the middle, each kind in its own part of the ring,
// spread evenly, every other one a little further out so the labels don't meet.
export function layout(world: World, w: number, h: number): Laid[] {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.max(40, Math.min(w, h) / 2 - 36);
  const out: Laid[] = [];
  for (const n of world.nodes) if (n.kind === 'you') out.push({ ...n, x: cx, y: cy, r: 10 });
  for (const kind of ['goal', 'person', 'place'] as const) {
    const list = world.nodes.filter((n) => n.kind === kind);
    list.forEach((n, i) => {
      const t = list.length === 1 ? 0.5 : i / (list.length - 1);
      const deg = SECTOR[kind] - SPREAD / 2 + SPREAD * t;
      const rad = (deg * Math.PI) / 180;
      const ring = R * (i % 2 ? 0.95 : 0.66);
      out.push({ ...n, x: cx + Math.cos(rad) * ring, y: cy + Math.sin(rad) * ring, r: 4 + 8 * Math.max(0, Math.min(1, n.size)) });
    });
  }
  return out;
}

// The dot under a point, if any (a little extra round small ones, for a finger).
export function hit(laid: readonly Laid[], x: number, y: number, slack = 10): Laid | null {
  let best: Laid | null = null;
  let bd = Infinity;
  for (const n of laid) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= n.r + slack && d < bd) {
      best = n;
      bd = d;
    }
  }
  return best;
}
