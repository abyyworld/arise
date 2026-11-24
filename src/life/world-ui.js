// Your world: the people, goals and places in the Player's life (world.ts), three ways. A
// constellation (You in the middle; each dot sized by time or contact, and lines between a person
// and the places and goals they share), a globe of places that turns slowly, and an outline, a
// plain nested list that is also the way in for a screen reader. All worked out and drawn on this
// device from what Arise already has; nothing is sent. With less motion (Settings, or the
// device's own reduce motion), nothing moves on its own.

import '../styles/places.css';
import * as S from '../store';
import * as L from './log';
import * as INS from './insight';
import * as MM from './map-math';
import * as PL from './places';
import * as W from './world';
import { loadState as locationState } from './location';
import { esc, icon } from '../ui.js';

export const VIEW = 'world';
const MODE_KEY = 'arise-world-view';
const MODES = [
  ['stars', 'Constellation'],
  ['globe', 'Globe'],
  ['list', 'Outline'],
];
const DAY = 86_400_000;
const PEOPLE_DAYS = 90;
const PLACE_DAYS = 365;

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
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
const modeNow = () => {
  const m = read(MODE_KEY);
  return MODES.some(([k]) => k === m) ? m : 'stars';
};

// Less motion in Settings, or the device asks for it.
export const still = () => document.documentElement.dataset.motion === 'less' || !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const ui = { world: null, laid: [], pick: null, token: 0, frame: 0, turn: null, tilt: null, drag: null, wired: false };

// ---------- the way in, on Me

export function entryCard() {
  return `<section class="panel world-entry">
    <h2 class="panel-title">${icon('globe')}<span>Your world</span></h2>
    <p class="muted small">The people, goals and places in your life, and how they meet. Made on this device from what Arise already has.</p>
    <div class="row">
      <button class="btn small" data-act="nav" data-v="${VIEW}">See your world</button>
      <button class="btn small ghost" data-act="nav" data-v="places">${icon('pin')} Your places on a map</button>
    </div>
  </section>`;
}

// ---------- the screen

export function renderWorld(root) {
  const mode = modeNow();
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">You</p><h1 class="display">Your world</h1></div>
      <button class="btn small ghost" data-act="nav" data-v="progress">${icon('back')} Me</button>
    </header>
    <section class="panel world">
      <div class="seg" role="group" aria-label="Show it as">${MODES.map(([k, label]) => `<button data-act="world-mode" data-v="${k}" class="${k === mode ? 'on' : ''}" aria-pressed="${k === mode}">${label}</button>`).join('')}</div>
      <div id="worldBody">${bodyHTML(mode)}</div>
    </section>`;
  wire();
  void fill();
}

function bodyHTML(mode) {
  if (mode === 'list') return `<div id="worldList">${ui.world ? outlineHTML(ui.world) : '<p class="muted small">Reading…</p>'}</div>`;
  const globe = mode === 'globe';
  return `<div class="world-stage${globe ? ' globe' : ''}">
      <canvas id="worldCanvas" role="img" aria-label="${globe ? 'A globe with a dot for each of your places' : 'You in the middle, with your goals, people and places round you'}. The outline has the same, as a list."></canvas>
    </div>
    ${
      globe
        ? `<div class="row world-turn"><button class="btn small ghost" data-act="world-turn" data-d="-1" aria-label="Turn the globe west">${icon('back')} Turn</button><button class="btn small ghost" data-act="world-turn" data-d="1" aria-label="Turn the globe east">Turn ${icon('next')}</button></div>`
        : `<p class="muted small world-key"><span class="wk goal"></span>Goals <span class="wk person"></span>People <span class="wk place"></span>Places. Bigger means more time or more contact. Lines join a person to the places you were when you were in touch, and to goals that name them.</p>`
    }
    <p class="small" id="worldPick" aria-live="polite">${globe ? '' : 'Tap a dot to see what it is.'}</p>`;
}

async function fill() {
  const token = ++ui.token;
  const now = Date.now();
  let placeEvents = [];
  let talk = [];
  try {
    [placeEvents, talk] = await Promise.all([
      L.eventsBetween(now - PLACE_DAYS * DAY, now + 1, { kinds: ['place'], limit: 100000, newest: true }),
      L.eventsBetween(now - PEOPLE_DAYS * DAY, now + 1, { kinds: ['call', 'message'], limit: 100000, newest: true }),
    ]);
  } catch {}
  let areas = INS.peek()?.areas || null;
  if (!areas) areas = (await INS.get({ maxAge: 10 * 60_000 }).catch(() => null))?.areas || null;
  if (token !== ui.token || !$('#worldBody')?.isConnected) return;
  const spots = PL.spotsOf(placeEvents, { from: now - PLACE_DAYS * DAY, to: now + 1, never: locationState().prefs.never });
  ui.world = W.buildWorld({ goals: S.state.goals, people: W.peopleOf(talk), places: PL.groupPlaces(spots, S.placeNames()), areas });
  show();
}

function show() {
  stop();
  const mode = modeNow();
  if (mode === 'list') {
    const el = $('#worldList');
    if (el && ui.world) el.innerHTML = outlineHTML(ui.world);
    return;
  }
  if (mode === 'globe') startGlobe();
  else startStars();
}

// ---------- the outline

const PICK_LINE = { goal: 'Goal', person: 'Person', place: 'Place' };

function outlineHTML(world) {
  const by = (kind) => world.nodes.filter((n) => n.kind === kind);
  const label = new Map(world.nodes.map((n) => [n.id, n.label]));
  const linked = (id, kind) =>
    world.links
      .filter((l) => l.a === id || l.b === id)
      .map((l) => (l.a === id ? l.b : l.a))
      .filter((o) => o.startsWith(kind === 'place' ? 'l:' : kind === 'goal' ? 'g:' : 'p:'))
      .map((o) => label.get(o))
      .filter(Boolean);
  const sub = (items) => (items.length ? `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
  const group = (title, kind, extra) => {
    const list = by(kind);
    return `<li><b>${title}</b>${
      list.length ? `<ul>${list.map((n) => `<li>${esc(n.label)} <small class="muted">${esc(n.detail)}</small>${sub(extra(n))}</li>`).join('')}</ul>` : '<ul><li class="muted">None yet</li></ul>'
    }</li>`;
  };
  const areas = world.areas.length ? `<li><b>Parts of your life</b><ul>${world.areas.map((a) => `<li>${esc(a.label)}: ${esc(a.word)}</li>`).join('')}</ul></li>` : '';
  return `<ul class="world-outline">
    <li><b>You</b><ul>
      ${areas}
      ${group('Goals', 'goal', (n) => linked(n.id, 'person').map((p) => `With ${p}`))}
      ${group('People', 'person', (n) => [...linked(n.id, 'place').map((p) => `At ${p}`), ...linked(n.id, 'goal').map((g) => `Goal: ${g}`)])}
      ${group('Places', 'place', () => [])}
    </ul></li>
  </ul>`;
}

// ---------- drawing

const css = (name, fallback) => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
};
const COLOR = { you: ['--text', '#eef3f8'], goal: ['--gold', '#ffcf5a'], person: ['--violet', '#9d8cff'], place: ['--sys', '#5cc8ff'] };
const colorOf = (kind) => css(...COLOR[kind]);

// The canvas at its size on screen, sharp on a fine screen. Null when it can't draw (a test).
function surface(square = false) {
  const canvas = $('#worldCanvas');
  if (!canvas) return null;
  const w = Math.max(240, Math.round(canvas.parentElement?.clientWidth || 600));
  const h = square ? Math.min(w, 380) : Math.min(440, Math.max(300, Math.round(w * 0.7)));
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {}
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, w, h };
}

// Draws again and again while the screen is up and motion is fine; once otherwise.
function loop(paint) {
  stop();
  const step = (t) => {
    if (!$('#worldCanvas')?.isConnected) return stop();
    paint(t);
    if (still()) return stop();
    ui.frame = globalThis.requestAnimationFrame?.(step) || 0;
  };
  step(0);
}

function stop() {
  if (ui.frame) globalThis.cancelAnimationFrame?.(ui.frame);
  ui.frame = 0;
}

// The shape for each kind, so they differ by more than colour: goals diamonds, places squares.
function mark(ctx, kind, x, y, r) {
  ctx.beginPath();
  if (kind === 'goal') {
    ctx.moveTo(x, y - r * 1.2);
    ctx.lineTo(x + r * 1.2, y);
    ctx.lineTo(x, y + r * 1.2);
    ctx.lineTo(x - r * 1.2, y);
    ctx.closePath();
  } else if (kind === 'place') ctx.rect(x - r, y - r, r * 2, r * 2);
  else ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function startStars() {
  const s0 = surface();
  if (!s0 || !ui.world) return;
  ui.laid = W.layout(ui.world, s0.w, s0.h);
  loop((t) => {
    const s = surface();
    if (!s) return;
    const { ctx, w, h } = s;
    // A slow drift, a pixel or two, so it feels alive; none with less motion.
    const sway = (i) => (still() ? 0 : Math.sin(t / 2600 + i * 1.7) * 2);
    const at = new Map(ui.laid.map((n, i) => [n.id, { ...n, y: n.y + sway(i) }]));
    ctx.clearRect(0, 0, w, h);
    const muted = css('--muted', '#8591a0');
    const text = css('--text', '#eef3f8');
    const bg = css('--panel-solid', '#0a111b');
    const picked = ui.pick;
    const touches = (id) => !picked || id === picked || ui.world.links.some((l) => (l.a === picked && l.b === id) || (l.b === picked && l.a === id));
    // Faint lines from You to each, then the lines between them.
    const you = at.get('you');
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    for (const n of at.values()) {
      if (n.id === 'you') continue;
      ctx.globalAlpha = touches(n.id) ? 0.18 : 0.06;
      ctx.beginPath();
      ctx.moveTo(you.x, you.y);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
    }
    const most = Math.max(1, ...ui.world.links.map((l) => l.w));
    for (const l of ui.world.links) {
      const a = at.get(l.a);
      const b = at.get(l.b);
      if (!a || !b) continue;
      const on = !picked || l.a === picked || l.b === picked;
      ctx.globalAlpha = on ? 0.65 : 0.1;
      ctx.strokeStyle = colorOf(a.kind);
      ctx.lineWidth = 1 + 2 * Math.sqrt(l.w / most);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo((a.x + b.x) / 2 + (you.x - (a.x + b.x) / 2) * 0.35, (a.y + b.y) / 2 + (you.y - (a.y + b.y) / 2) * 0.35, b.x, b.y);
      ctx.stroke();
    }
    ctx.font = '12px system-ui, sans-serif';
    for (const n of at.values()) {
      ctx.globalAlpha = touches(n.id) ? 1 : 0.3;
      ctx.fillStyle = colorOf(n.kind);
      mark(ctx, n.kind, n.x, n.y, n.r);
      if (n.id === picked) {
        ctx.strokeStyle = text;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      const label = n.label.length > 20 ? `${n.label.slice(0, 19)}…` : n.label;
      const left = n.x < w / 2 && n.kind !== 'you';
      ctx.textAlign = n.kind === 'you' ? 'center' : left ? 'right' : 'left';
      const lx = n.kind === 'you' ? n.x : left ? n.x - n.r - 6 : n.x + n.r + 6;
      const ly = n.kind === 'you' ? n.y + n.r + 16 : n.y + 4;
      ctx.lineWidth = 3;
      ctx.strokeStyle = bg;
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = text;
      ctx.fillText(label, lx, ly);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    if (ui.world.nodes.length === 1) {
      ctx.fillStyle = muted;
      ctx.textAlign = 'center';
      ctx.fillText('Set a goal, connect your phone or bring in your history, and your world fills in.', w / 2, h / 2 + 52);
      ctx.textAlign = 'left';
    }
  });
}

function pickAt(x, y) {
  const n = W.hit(ui.laid, x, y);
  ui.pick = n && n.id !== 'you' ? (ui.pick === n.id ? null : n.id) : null;
  const el = $('#worldPick');
  if (el) {
    const node = ui.pick && ui.world.nodes.find((m) => m.id === ui.pick);
    if (!node) el.textContent = 'Tap a dot to see what it is.';
    else {
      const label = new Map(ui.world.nodes.map((m) => [m.id, m.label]));
      const with_ = ui.world.links
        .filter((l) => l.a === node.id || l.b === node.id)
        .map((l) => label.get(l.a === node.id ? l.b : l.a))
        .filter(Boolean);
      el.textContent = `${PICK_LINE[node.kind]}: ${node.label}. ${node.detail}.${with_.length ? ` Goes with ${with_.join(', ')}.` : ''}`;
    }
  }
  if (still()) startStars();
}

// ---------- the globe

function startGlobe() {
  if (!ui.world) return;
  const places = ui.world.nodes.filter((n) => n.kind === 'place');
  const mid = MM.centerOf(places.map((p) => ({ lat: p.lat, lon: p.lon })));
  if (ui.turn == null) ui.turn = mid.lon;
  if (ui.tilt == null) ui.tilt = Math.max(-50, Math.min(50, mid.lat));
  let last = 0;
  loop((t) => {
    if (!still() && last && !ui.drag) ui.turn = (ui.turn + ((t - last) / 1000) * 6) % 360; // 6 degrees a second
    last = t;
    paintGlobe(places);
  });
}

function paintGlobe(places) {
  const s = surface(true);
  if (!s) return;
  const { ctx, w, h } = s;
  const r = Math.min(w, h) / 2 - 24;
  const cx = w / 2;
  const cy = h / 2;
  const muted = css('--muted', '#8591a0');
  const text = css('--text', '#eef3f8');
  const bg = css('--panel-solid', '#0a111b');
  const accent = css('--sys', '#5cc8ff');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = bg;
  ctx.strokeStyle = muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Lines every 30 degrees, only on the side you see.
  ctx.globalAlpha = 0.25;
  const line = (pts) => {
    ctx.beginPath();
    let pen = false;
    for (const [lat, lon] of pts) {
      const p = MM.ortho(lat, lon, ui.tilt, ui.turn);
      if (!p.front) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(cx + p.x * r, cy + p.y * r);
      else ctx.moveTo(cx + p.x * r, cy + p.y * r);
      pen = true;
    }
    ctx.stroke();
  };
  for (let lat = -60; lat <= 60; lat += 30) line(Array.from({ length: 73 }, (_, i) => [lat, -180 + i * 5]));
  for (let lon = -180; lon < 180; lon += 30) line(Array.from({ length: 37 }, (_, i) => [-90 + i * 5, lon]));
  ctx.globalAlpha = 1;
  ctx.font = '12px system-ui, sans-serif';
  places.forEach((p, i) => {
    const q = MM.ortho(p.lat, p.lon, ui.tilt, ui.turn);
    if (!q.front) return;
    const x = cx + q.x * r;
    const y = cy + q.y * r;
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(x, y, 6 + 10 * p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
    if (i < 5) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = bg;
      ctx.strokeText(p.label.slice(0, 20), x + 8, y + 4);
      ctx.fillStyle = text;
      ctx.fillText(p.label.slice(0, 20), x + 8, y + 4);
    }
  });
  if (!places.length) {
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    ctx.fillText('No places in your log yet.', cx, cy);
    ctx.textAlign = 'left';
  }
}

// ---------- taps and drags

function wire() {
  if (ui.wired) return;
  ui.wired = true;
  const doc = globalThis.document;
  doc.addEventListener('pointerdown', (e) => {
    if (e.target?.id !== 'worldCanvas') return;
    ui.drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
  });
  doc.addEventListener('pointermove', (e) => {
    const d = ui.drag;
    if (!d || modeNow() !== 'globe') return;
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5) d.moved = true;
    ui.turn = (ui.turn ?? 0) - (e.clientX - d.x) * 0.5;
    ui.tilt = Math.max(-80, Math.min(80, (ui.tilt ?? 0) + (e.clientY - d.y) * 0.5));
    d.x = e.clientX;
    d.y = e.clientY;
    if (still() && ui.world) paintGlobe(ui.world.nodes.filter((n) => n.kind === 'place'));
  });
  doc.addEventListener('pointerup', (e) => {
    const d = ui.drag;
    ui.drag = null;
    if (!d || d.moved || e.target?.id !== 'worldCanvas' || modeNow() !== 'stars') return;
    const box = e.target.getBoundingClientRect();
    pickAt(e.clientX - box.left, e.clientY - box.top);
  });
  globalThis.addEventListener?.('resize', () => {
    if ($('#worldCanvas')?.isConnected) show();
  });
}

// True when it was one of these.
export function handleAction(act, el) {
  const d = el?.dataset || {};
  switch (act) {
    case 'world-mode': {
      if (!MODES.some(([k]) => k === d.v)) return true;
      write(MODE_KEY, d.v === 'stars' ? null : d.v);
      for (const b of document.querySelectorAll('[data-act="world-mode"]')) {
        b.classList.toggle('on', b.dataset.v === d.v);
        b.setAttribute('aria-pressed', String(b.dataset.v === d.v));
      }
      stop();
      ui.pick = null;
      const body = $('#worldBody');
      if (body) body.innerHTML = bodyHTML(d.v);
      if (ui.world) show();
      return true;
    }
    case 'world-turn':
      ui.turn = ((ui.turn ?? 0) + (Number(d.d) > 0 ? 30 : -30)) % 360;
      if (still() && ui.world) paintGlobe(ui.world.nodes.filter((n) => n.kind === 'place'));
      return true;
    default:
      return false;
  }
}

// For tests: what's on screen.
export const _ui = ui;
export { pickAt as _pickAt };
