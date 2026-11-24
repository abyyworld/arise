// The sums behind the map of places (map-ui.js) and the globe (world-ui.js): the same flat map
// projection the street map uses (Web Mercator, so the dots and the street map line up), fitting
// a view around the places, the heat map in cells, the scale bar, which street map tiles a view
// needs, and a globe seen from one side (orthographic). Pure: no screen, no network.

export const TILE = 256;
export const MIN_Z = 2;
export const MAX_Z = 18;
const MAX_LAT = 85.05112878;
const R = 6_378_137; // the Earth's radius the street map uses, in meters

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const worldSize = (z: number) => TILE * 2 ** z;

// A spot in pixels on the whole world at zoom z: x from the 180th meridian east, y from the top.
export function project(lat: number, lon: number, z: number): { x: number; y: number } {
  const size = worldSize(z);
  const s = Math.sin((clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
}

export function unproject(x: number, y: number, z: number): { lat: number; lon: number } {
  const size = worldSize(z);
  const n = Math.PI - (2 * Math.PI * y) / size;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lon: (x / size) * 360 - 180 };
}

// What's on screen: the zoom, the world pixel at the middle, and the size in CSS pixels.
export interface View {
  z: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

// Up and down, the middle stays inside the world; left and right, it goes round.
function settle(v: View): View {
  const size = worldSize(v.z);
  const cy = size <= v.h ? size / 2 : clamp(v.cy, v.h / 2, size - v.h / 2);
  return { ...v, cx: ((v.cx % size) + size) % size, cy };
}

// The closest view that shows every spot, with `pad` pixels to spare round the edge.
export function fitView(spots: readonly { lat: number; lon: number }[], w: number, h: number, { pad = 32, maxZ = 16 } = {}): View {
  if (!spots.length) return settle({ z: MIN_Z, cx: worldSize(MIN_Z) / 2, cy: worldSize(MIN_Z) / 2, w, h });
  let z = Math.min(maxZ, MAX_Z);
  for (; z > MIN_Z; z--) {
    const ps = spots.map((s) => project(s.lat, s.lon, z));
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    if (Math.max(...xs) - Math.min(...xs) <= w - 2 * pad && Math.max(...ys) - Math.min(...ys) <= h - 2 * pad) break;
  }
  const ps = spots.map((s) => project(s.lat, s.lon, z));
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  return settle({ z, cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, w, h });
}

// Where a spot is on screen, in CSS pixels from the top left (the nearer way round the world).
export function toScreen(v: View, lat: number, lon: number): { x: number; y: number } {
  const p = project(lat, lon, v.z);
  const size = worldSize(v.z);
  let dx = p.x - v.cx;
  if (dx > size / 2) dx -= size;
  if (dx < -size / 2) dx += size;
  return { x: v.w / 2 + dx, y: v.h / 2 + (p.y - v.cy) };
}

// The spot under a point on screen.
export const fromScreen = (v: View, x: number, y: number) => unproject(v.cx + x - v.w / 2, v.cy + y - v.h / 2, v.z);

export const pan = (v: View, dx: number, dy: number): View => settle({ ...v, cx: v.cx - dx, cy: v.cy - dy });

// One step in or out (dz: +1 or -1), keeping the spot under (x, y) where it is.
export function zoomAt(v: View, dz: number, x = v.w / 2, y = v.h / 2): View {
  const z = clamp(v.z + dz, MIN_Z, MAX_Z);
  if (z === v.z) return v;
  const k = 2 ** (z - v.z);
  const wx = v.cx + x - v.w / 2;
  const wy = v.cy + y - v.h / 2;
  return settle({ ...v, z, cx: wx * k - (x - v.w / 2), cy: wy * k - (y - v.h / 2) });
}

// ---------- the heat map

export interface Bin {
  x: number; // the middle of the cell, on screen
  y: number;
  w: number; // the weight in it (minutes)
}

// Weights on screen added up in square cells of `cell` pixels. Only cells with something in them,
// heaviest first.
export function heatBins(points: readonly { x: number; y: number; w: number }[], cell: number): Bin[] {
  const size = Math.max(1, cell);
  const bins = new Map<string, Bin>();
  for (const p of points) {
    if (!(p.w > 0) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const i = Math.floor(p.x / size);
    const j = Math.floor(p.y / size);
    const k = `${i},${j}`;
    const b = bins.get(k);
    if (b) b.w += p.w;
    else bins.set(k, { x: (i + 0.5) * size, y: (j + 0.5) * size, w: p.w });
  }
  return [...bins.values()].sort((a, b) => b.w - a.w);
}

// How strong a cell looks, from 0 to 1: by the square root, so a few long stays don't hide the rest.
export const heatLevel = (w: number, max: number) => (max > 0 && w > 0 ? Math.min(1, Math.sqrt(w / max)) : 0);

// ---------- the scale bar

// Meters for one CSS pixel at a latitude and zoom.
export const metersPerPixel = (lat: number, z: number) => (2 * Math.PI * R * Math.cos((clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180)) / worldSize(z);

// A round distance (1, 2 or 5 times a power of ten) no longer than `maxPx` on screen.
export function scaleBar(lat: number, z: number, maxPx = 100): { px: number; meters: number; label: string } {
  const mpp = metersPerPixel(lat, z);
  const most = mpp * maxPx;
  const pow = 10 ** Math.floor(Math.log10(Math.max(most, 1e-9)));
  const meters = [5, 2, 1].map((n) => n * pow).find((m) => m <= most) ?? pow;
  const label = meters >= 1000 ? `${meters / 1000} km` : `${Math.round(meters)} m`;
  return { px: Math.max(1, Math.round(meters / mpp)), meters, label };
}

// ---------- street map tiles

export interface Tile {
  z: number;
  x: number; // the tile's number, round the world
  y: number;
  left: number; // where it goes on screen
  top: number;
  turn: number; // which time round the world (the same tile can show twice when zoomed out)
}

// The tiles that cover a view, by the usual numbering (z/x/y).
export function tilesFor(v: View): Tile[] {
  const n = 2 ** v.z;
  const x0 = v.cx - v.w / 2;
  const y0 = v.cy - v.h / 2;
  const out: Tile[] = [];
  for (let ty = Math.floor(y0 / TILE); ty * TILE < y0 + v.h; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(x0 / TILE); tx * TILE < x0 + v.w; tx++) {
      out.push({ z: v.z, x: ((tx % n) + n) % n, y: ty, left: Math.round(tx * TILE - x0), top: Math.round(ty * TILE - y0), turn: Math.floor(tx / n) });
    }
  }
  return out;
}

// ---------- a globe seen from one side

// A spot on a globe of radius 1 turned so (lat0, lon0) faces you: x to the right, y down, and
// whether it's on the side you see.
export function ortho(lat: number, lon: number, lat0: number, lon0: number): { x: number; y: number; front: boolean } {
  const r = Math.PI / 180;
  const p = lat * r;
  const l = (lon - lon0) * r;
  const p0 = lat0 * r;
  const x = Math.cos(p) * Math.sin(l);
  const y = Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l);
  const front = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l) >= 0;
  return { x, y: -y, front };
}

// The middle of some spots for the globe to face: the average latitude, and the longitude of the
// average direction (so spots either side of the 180th meridian don't average to the far side).
export function centerOf(spots: readonly { lat: number; lon: number }[]): { lat: number; lon: number } {
  if (!spots.length) return { lat: 20, lon: 0 };
  const r = Math.PI / 180;
  const sx = spots.reduce((s, p) => s + Math.cos(p.lon * r), 0);
  const sy = spots.reduce((s, p) => s + Math.sin(p.lon * r), 0);
  return { lat: spots.reduce((s, p) => s + p.lat, 0) / spots.length, lon: Math.atan2(sy, sx) / r };
}
