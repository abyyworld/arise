// Your places: where the Player's time goes, on a map. A heat map of the time spent and a dot for
// each place, drawn on this device from the life log with no network at all: a plain flat map with
// lines of latitude and longitude and a scale bar. The street map under it is a choice, remembered
// on this device only, since OpenStreetMap's tile server then sees which areas are looked at.
// Tapping a place shows its visits and time, and the Player can name it ("Home", "Lab"); names
// sync end-to-end encrypted (lib/place-names.ts). Places never to note (location.ts) stay off.

import '../styles/places.css';
import * as S from '../store';
import * as L from './log';
import * as MM from './map-math';
import * as PL from './places';
import { loadState as locationState } from './location';
import { esc, icon, openSheet, closeSheet, toast } from '../ui.js';

export const VIEW = 'places';
export const TILE_HOST = 'https://tile.openstreetmap.org';
const STREET_KEY = 'arise-street-map';
const RANGE_KEY = 'arise-map-range';
const HEIGHT = 380;
const CELL = 22; // the heat map's cells, in pixels

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const read = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
};

export const streetOn = () => read(STREET_KEY) === 'on';
const rangeNow = () => {
  const r = read(RANGE_KEY);
  return PL.isRange(r) ? r : 'month';
};

// What's on screen: the range, the places in it, the view of the map, the place open in the sheet.
const ui = { spots: [], places: [], view: null, loading: false, error: '', token: 0, open: null, hooked: false };

// ---------- the screen

export function renderPlaces(root, { keep = false } = {}) {
  const range = rangeNow();
  const street = streetOn();
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">Your days</p><h1 class="display">Your places</h1></div>
      <button class="btn small ghost" data-act="nav" data-v="days">${icon('back')} Your days</button>
    </header>
    <section class="panel pm">
      <div class="seg" role="group" aria-label="How far back">${PL.RANGES.map(([r, label]) => `<button data-act="pm-range" data-v="${r}" class="${r === range ? 'on' : ''}" aria-pressed="${r === range}">${label}</button>`).join('')}</div>
      <div class="pm-map${street ? ' street' : ''}" id="pmMap" tabindex="0" role="group" aria-roledescription="map" aria-label="Map of your places. Drag to move, plus and minus to zoom. The list below has the same places." aria-describedby="pmSum">
        <div class="pm-tiles" id="pmTiles" aria-hidden="true"></div>
        <canvas id="pmCanvas" aria-hidden="true"></canvas>
        <div class="pm-zoom">
          <button class="icon-btn small" data-act="pm-zoom" data-d="1" aria-label="Zoom in">+</button>
          <button class="icon-btn small" data-act="pm-zoom" data-d="-1" aria-label="Zoom out">&minus;</button>
          <button class="icon-btn small" data-act="pm-fit" aria-label="Show all places">${icon('target')}</button>
        </div>
        <div class="pm-scale" id="pmScale" aria-hidden="true"><i></i><span></span></div>
        ${street ? `<p class="pm-credit">Map <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a></p>` : ''}
      </div>
      <p class="muted small" id="pmSum" aria-live="polite">Reading your places…</p>
      <button class="toggle-row" data-act="pm-street" aria-pressed="${street}"><span><b>Show the street map</b><small>Less private: OpenStreetMap's tile server sees which areas you look at. Off, the map is drawn on this device and nothing is sent.</small></span><span class="switch ${street ? 'on' : ''}"></span></button>
    </section>
    <section class="panel">
      <h2 class="panel-title">${icon('pin')}<span>Where your time goes</span></h2>
      <ol class="plain pm-list" id="pmList"></ol>
      <p class="muted small">Only on this device: the map is made from your life log here. Places you chose never to note stay off it. Names you give places sync to your other devices, end-to-end encrypted.</p>
    </section>`;
  hook();
  // A pinch on a trackpad (the browser sends it as a wheel with Ctrl) zooms; plain scrolling still
  // scrolls the page. On the map itself, so the rest of the page scrolls freely.
  $('#pmCanvas')?.addEventListener(
    'wheel',
    (e) => {
      if (!ui.view || !e.ctrlKey) return;
      e.preventDefault();
      const box = e.currentTarget.getBoundingClientRect();
      setView(MM.zoomAt(ui.view, e.deltaY < 0 ? 1 : -1, e.clientX - box.left, e.clientY - box.top));
    },
    { passive: false },
  );
  void fill({ keepView: keep });
}

// Once: redraw when the window changes size, and read again when the log changes.
function hook() {
  if (ui.hooked) return;
  ui.hooked = true;
  globalThis.addEventListener?.('resize', () => {
    if ($('#pmMap')?.isConnected) draw();
  });
  L.onChange(() => {
    if ($('#pmMap')?.isConnected) void fill({ keepView: true });
  });
  wire();
}

async function fill({ keepView = false } = {}) {
  const token = ++ui.token;
  const range = rangeNow();
  const { from, to } = PL.rangeTimes(range);
  let events = [];
  try {
    events = await L.eventsBetween(from, to, { kinds: ['place'], limit: 100000, newest: true });
  } catch {
    events = [];
    ui.error = "Couldn't read your places on this device.";
  }
  if (token !== ui.token || !$('#pmMap')?.isConnected) return;
  ui.spots = PL.spotsOf(events, { from, to, never: locationState().prefs.never });
  regroup();
  if (!keepView || !ui.view) ui.view = fit();
  draw();
}

// The places again from the spots (after a name changes, places with the same name are one).
function regroup() {
  ui.places = PL.groupPlaces(ui.spots, S.placeNames());
}

const size = () => {
  const box = $('#pmMap');
  return { w: Math.max(200, Math.round(box?.clientWidth || 600)), h: HEIGHT };
};

function fit() {
  const { w, h } = size();
  const all = ui.places.every((p) => p.rounded);
  return MM.fitView(ui.places, w, h, { pad: 40, maxZ: all ? 13 : 16 });
}

// ---------- drawing

const css = (name, fallback) => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
};

// Lines of latitude and longitude about every 120 pixels, at a round number of degrees.
const STEPS = [30, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
const gridStep = (z) => {
  const perPx = 360 / MM.worldSize(z);
  return [...STEPS].reverse().find((s) => s / perPx >= 120) ?? 30;
};

function draw() {
  const box = $('#pmMap');
  const canvas = $('#pmCanvas');
  if (!box || !canvas) return;
  const { w, h } = size();
  if (!ui.view) ui.view = fit();
  ui.view = { ...ui.view, w, h };
  const v = ui.view;
  summary();
  list();
  scale();
  tiles();
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {}
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const accent = css('--sys', '#5cc8ff');
  const text = css('--text', '#eef3f8');
  const muted = css('--muted', '#8591a0');
  const bg = css('--panel-solid', '#0a111b');

  // The lines, only without the street map (it has its own).
  if (!streetOn()) {
    const step = gridStep(v.z);
    const perPx = 360 / MM.worldSize(v.z);
    const nw = MM.fromScreen(v, 0, 0);
    const se = MM.fromScreen(v, w, h);
    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lon = Math.floor(nw.lon / step) * step; lon <= nw.lon + w * perPx; lon += step) {
      const x = (lon - nw.lon) / perPx;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let lat = Math.floor(se.lat / step) * step; lat <= nw.lat + step; lat += step) {
      const y = MM.toScreen(v, lat, nw.lon).y;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // The heat map: the time spent, cell by cell.
  const pts = ui.spots.map((s) => ({ ...MM.toScreen(v, s.lat, s.lon), w: Math.max(1, s.min) }));
  const bins = MM.heatBins(pts, CELL);
  const max = bins[0]?.w || 1;
  ctx.fillStyle = accent;
  for (const b of bins) {
    if (b.x < -CELL * 2 || b.y < -CELL * 2 || b.x > w + CELL * 2 || b.y > h + CELL * 2) continue;
    const level = MM.heatLevel(b.w, max);
    for (const [r, a] of [
      [CELL * 1.6, 0.1],
      [CELL * 1.0, 0.16],
      [CELL * 0.55, 0.22],
    ]) {
      ctx.globalAlpha = a * (0.35 + level);
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * (0.6 + 0.6 * level), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // A dot for each place, bigger for more time; a place kept to about 1 km gets a faint ring that
  // size, and named places and the ones with the most time get their name.
  const most = Math.max(1, ...ui.places.map((p) => p.min));
  const mpp = MM.metersPerPixel(MM.fromScreen(v, w / 2, h / 2).lat, v.z);
  ctx.font = '12px system-ui, sans-serif';
  ui.places.forEach((p, i) => {
    const s = MM.toScreen(v, p.lat, p.lon);
    if (s.x < -60 || s.y < -60 || s.x > w + 60 || s.y > h + 60) return;
    if (p.rounded) {
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(6, Math.min(90, 1000 / mpp)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const r = 3 + 5 * Math.sqrt(p.min / most);
    ctx.fillStyle = text;
    ctx.strokeStyle = bg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (ui.open === p.key) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (p.name || i < 5) {
      const label = PL.placeTitle(p).slice(0, 24);
      ctx.lineWidth = 3;
      ctx.strokeStyle = bg;
      ctx.strokeText(label, s.x + r + 4, s.y + 4);
      ctx.fillStyle = text;
      ctx.fillText(label, s.x + r + 4, s.y + 4);
    }
  });
}

function scale() {
  const el = $('#pmScale');
  if (!el || !ui.view) return;
  const mid = MM.fromScreen(ui.view, ui.view.w / 2, ui.view.h / 2);
  const s = MM.scaleBar(mid.lat, ui.view.z, 100);
  el.querySelector('i').style.width = `${s.px}px`;
  el.querySelector('span').textContent = s.label;
}

// The street map's tiles, only when it's on. Tiles already there are moved, not loaded again.
function tiles() {
  const layer = $('#pmTiles');
  if (!layer) return;
  if (!streetOn() || !ui.view) {
    layer.replaceChildren();
    return;
  }
  const want = MM.tilesFor(ui.view);
  const have = new Map([...layer.children].map((img) => [img.dataset.k, img]));
  const keep = new Set();
  for (const t of want) {
    const key = `${t.z}/${t.x}/${t.y}/${t.turn}`;
    let img = have.get(key);
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.dataset.k = key;
      img.src = `${TILE_HOST}/${t.z}/${t.x}/${t.y}.png`;
      layer.append(img);
    }
    keep.add(key);
    img.style.left = `${t.left}px`;
    img.style.top = `${t.top}px`;
  }
  for (const [key, img] of have) if (!keep.has(key)) img.remove();
}

function summary() {
  const el = $('#pmSum');
  if (!el) return;
  if (ui.error) {
    el.textContent = ui.error;
    return;
  }
  const total = ui.places.reduce((n, p) => n + p.min, 0);
  el.textContent = ui.places.length
    ? `${plural(ui.places.length, 'place')}, ${PL.timeText(total)} in all. Brighter means more time there.`
    : 'No places in your log for this time yet. Turn on Location in the phone app, or bring in your Google Maps Timeline in Connect.';
}

function list() {
  const el = $('#pmList');
  if (!el) return;
  el.innerHTML = ui.places
    .slice(0, 50)
    .map(
      (p) => `<li><button class="pm-row" data-act="pm-open" data-k="${esc(p.key)}"><b>${esc(PL.placeTitle(p))}</b><small>${esc(p.min ? PL.timeText(p.min) : 'A moment')} · ${esc(plural(p.visits.length, 'visit'))}${p.rounded ? ' · to about 1 km' : ''}</small></button></li>`,
    )
    .join('');
}

// ---------- a place

const RANGE_WORDS = { week: 'the last 7 days', month: 'the last 30 days', year: 'the last year', all: 'all your log' };
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function openPlace(key) {
  const p = ui.places.find((x) => x.key === key);
  if (!p) return;
  ui.open = p.key;
  draw();
  const shown = p.visits.slice(0, 30);
  openSheet(`<p class="kicker">A place</p>
    <h2 class="display sheet-title">${esc(PL.placeTitle(p))}</h2>
    <p>${esc(p.min ? PL.timeText(p.min) : 'No time counted')} here in ${RANGE_WORDS[rangeNow()]}, ${esc(plural(p.visits.length, 'visit'))}.</p>
    ${p.rounded ? '<p class="muted small">Kept only to about 1 km, so this is roughly where.</p>' : ''}
    <form class="pm-name" data-form="pm-name" data-k="${esc(p.key)}">
      <label class="field"><span class="k">Name this place</span><input id="pmName" type="text" maxlength="40" autocomplete="off" placeholder="Home, Lab, Mosque" value="${esc(p.name || '')}"></label>
      <button class="btn primary small" type="submit">Save the name</button>
    </form>
    ${p.name ? `<button class="link" data-act="pm-unname" data-k="${esc(p.key)}">Take the name away</button>` : ''}
    <p class="muted small">The name shows on your days and to your coach. It syncs to your other devices, end-to-end encrypted.</p>
    <h3 class="pm-h">Visits</h3>
    <ul class="plain pm-visits">${shown.map((s) => `<li><span>${esc(when(s.at))}</span><small class="muted">${esc(s.min ? PL.timeText(s.min) : 'a moment')}</small></li>`).join('')}</ul>
    ${p.visits.length > shown.length ? `<p class="muted small">And ${esc(plural(p.visits.length - shown.length, 'more visit'))}.</p>` : ''}`);
}

function saveName(key, name) {
  const p = ui.places.find((x) => x.key === key);
  if (!p) return;
  if (!S.namePlace(p.nameKey || p.key, name)) return;
  regroup();
  ui.open = null;
  closeSheet();
  draw();
  const n = String(name || '').trim();
  toast(n ? `Named it ${n}.` : 'Name taken away.');
}

// ---------- moving about

function setView(v) {
  ui.view = v;
  draw();
}

let drag = null;
function wire() {
  const doc = globalThis.document;
  if (!doc) return;
  doc.addEventListener('pointerdown', (e) => {
    if (e.target?.id !== 'pmCanvas' || !ui.view) return;
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
    e.target.setPointerCapture?.(e.pointerId);
  });
  doc.addEventListener('pointermove', (e) => {
    if (!drag || !ui.view) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) drag.moved = true;
    if (drag.moved) setView(MM.pan(ui.view, dx, dy));
  });
  doc.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (!d || d.moved || e.target?.id !== 'pmCanvas' || !ui.view) return;
    const box = e.target.getBoundingClientRect();
    const near = nearest(e.clientX - box.left, e.clientY - box.top);
    if (near) openPlace(near.key);
  });
  doc.addEventListener('dblclick', (e) => {
    if (e.target?.id !== 'pmCanvas' || !ui.view) return;
    const box = e.target.getBoundingClientRect();
    setView(MM.zoomAt(ui.view, 1, e.clientX - box.left, e.clientY - box.top));
  });
  doc.addEventListener('keydown', (e) => {
    if (e.target?.id !== 'pmMap' || !ui.view) return;
    const k = e.key;
    const by = 60;
    const moves = { ArrowLeft: [by, 0], ArrowRight: [-by, 0], ArrowUp: [0, by], ArrowDown: [0, -by] };
    if (moves[k]) setView(MM.pan(ui.view, ...moves[k]));
    else if (k === '+' || k === '=') setView(MM.zoomAt(ui.view, 1));
    else if (k === '-' || k === '_') setView(MM.zoomAt(ui.view, -1));
    else return;
    e.preventDefault();
  });
  doc.addEventListener('submit', (e) => {
    const f = e.target;
    if (f?.dataset?.form !== 'pm-name') return;
    e.preventDefault();
    saveName(f.dataset.k, $('#pmName')?.value || '');
  });
}

// The place nearest a point on the map, within a finger's reach.
function nearest(x, y) {
  let best = null;
  let bd = 22;
  for (const p of ui.places) {
    const s = MM.toScreen(ui.view, p.lat, p.lon);
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bd) {
      best = p;
      bd = d;
    }
  }
  return best;
}

// ---------- taps

// True when it was one of these.
export function handleAction(act, el) {
  const d = el?.dataset || {};
  switch (act) {
    case 'pm-range':
      if (!PL.isRange(d.v)) return true;
      write(RANGE_KEY, d.v === 'month' ? null : d.v);
      for (const b of document.querySelectorAll('[data-act="pm-range"]')) {
        b.classList.toggle('on', b.dataset.v === d.v);
        b.setAttribute('aria-pressed', String(b.dataset.v === d.v));
      }
      ui.view = null;
      void fill();
      return true;
    case 'pm-zoom':
      if (ui.view) setView(MM.zoomAt(ui.view, Number(d.d) > 0 ? 1 : -1));
      return true;
    case 'pm-fit':
      setView(fit());
      return true;
    case 'pm-street': {
      const on = !streetOn();
      write(STREET_KEY, on ? 'on' : null);
      const box = $('#pmMap');
      if (box) {
        const root = box.closest('main') || $('#app');
        if (root) renderPlaces(root, { keep: true });
      }
      toast(on ? 'Street map on. OpenStreetMap sees which areas you look at.' : 'Street map off. The map is drawn on this device only.');
      return true;
    }
    case 'pm-open':
      openPlace(d.k);
      return true;
    case 'pm-unname':
      saveName(d.k, '');
      return true;
    default:
      return false;
  }
}

// For tests: what's on screen.
export const _ui = ui;
