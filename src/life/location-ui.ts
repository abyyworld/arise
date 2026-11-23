// The Location setting in the phone apps (location-sense.ts): off, places only, or a point every
// so many minutes; exact or about 1 km; and places never to note. Drawn inside Settings, Your
// life · Android, and under Places in Your life on iPhone. The day's points and deleting a date
// range are on the Days screen (screens.js).

import { esc, toast } from '../ui.js';
import * as LS from './location-sense';
import * as LOC from './location';
import type { LocationMode } from './location';

const choice = (label: string, on: boolean, mode: LocationMode, every?: number) =>
  `<button class="${on ? 'on' : ''}" data-act="loc-mode" data-mode="${mode}"${every ? ` data-every="${every}"` : ''} aria-pressed="${on}">${esc(label)}</button>`;

function blockedLine(): string {
  const why = LS.blocked();
  if (!why) return '';
  if (LS.platform() === 'android') {
    const appInfo = '<div class="row"><button class="btn ghost small" data-act="android-open" data-screen="app">App info</button></div>';
    return why === 'denied'
      ? `<p class="error small">Android hasn't allowed Arise to use Location yet. Tap a choice above to ask again, or allow it in App info, under Permissions.</p>${appInfo}`
      : `<p class="error small">Location is allowed only while Arise is open. To note where you are while it's closed, choose <b>Allow all the time</b>: App info, Permissions, Location.</p>${appInfo}`;
  }
  const settings = '<div class="row"><button class="btn ghost small" data-act="life-settings">Open the Settings app</button></div>';
  return why === 'denied'
    ? `<p class="error small">Location is off for Arise. In the Settings app, open Arise, then Location, and choose Always.</p>${settings}`
    : `<p class="error small">Location is set to While Using, so points are noted only while Arise is open. Choose Always in the Settings app, under Arise, Location.</p>${settings}`;
}

function howLine(mode: LocationMode, every: number): string {
  const android = LS.platform() === 'android';
  if (mode === 'places') {
    return android
      ? 'Arise checks where you are every 15 minutes and keeps only the places you stayed at, and for how long. Easiest on the battery.'
      : 'The places you spend time at, when you arrive and when you leave. Easiest on the battery.';
  }
  if (mode !== 'interval') return 'Nothing about where you are is noted.';
  if (android) {
    return every < LOC.ANDROID_JOB_MIN
      ? `One point ${LOC.everyText(every)}. Under 15 minutes, Android needs Arise to keep a small notification showing while it notes where you are. It uses more battery.`
      : `One point ${LOC.everyText(every)}, even while Arise is closed. Android may run it a few minutes late to save battery.`;
  }
  return `One point ${LOC.everyText(every)}, as well as the places you spend time at. An iPhone can't wake Arise on a timer, so Arise keeps low-power location on. While you sit still, iOS pauses it, so the points are sparse until you move again.`;
}

const RADIUS_TEXT = (r: number) => (r >= 1000 ? `${r / 1000} km` : `${r} m`);

// The whole setting. `withOff`: Android, where this is its own switch (on iPhone, Places is).
export function locationBlock({ withOff = true } = {}): string {
  if (!LS.platform()) return '';
  const st = LS.read();
  const mode = LS.mode();
  const every = st.prefs.every;
  const custom = mode === 'interval' && !LOC.EVERY_CHOICES.includes(every);
  const choices = [
    withOff ? choice('Off', mode === 'off', 'off') : '',
    choice(withOff ? 'Places only' : 'Arriving and leaving only', mode === 'places', 'places'),
    ...LOC.EVERY_CHOICES.map((m) => choice(m === 60 ? 'Every hour' : `Every ${m} min${m === LOC.SUGGESTED_EVERY ? ' (suggested)' : ''}`, mode === 'interval' && every === m, 'interval', m)),
  ].join('');
  const never = st.prefs.never
    .map(
      (n, i) => `<li class="row"><span>${esc(n.name || 'A place')} <small class="muted">(${esc(RADIUS_TEXT(n.radius))} around it)</small></span>
        <button class="btn ghost small" data-act="loc-never-del" data-i="${i}" aria-label="${esc(`Remove ${n.name || 'this place'}`)}">Remove</button></li>`,
    )
    .join('');
  const last = st.last;
  return `<div class="loc-block" id="locBlock">
    <p class="label">Location</p>
    <p class="small">Where you are, noted on this phone. Off until you pick something. ${esc('Stays on this phone and in your encrypted sync.')}</p>
    <div class="seg wrap" role="group" aria-label="Note where you are">${choices}</div>
    <div class="row">
      <label class="field"><span class="k">Or every this many minutes</span><input id="locEvery" type="number" inputmode="numeric" min="${LOC.MIN_EVERY}" max="${LOC.MAX_EVERY}" step="1" value="${custom ? every : ''}" placeholder="${LOC.SUGGESTED_EVERY}"></label>
      <button class="btn ghost small" data-act="loc-every">Use it</button>
    </div>
    <p class="muted small">${esc(howLine(mode, every))}</p>
    ${blockedLine()}
    ${mode !== 'off' && LS.platform() === 'android' && last ? (last.error ? `<p class="error small">The last read didn't work: ${esc(last.error)}</p>` : `<p class="muted small">Read ${last.added ? `${last.added} new` : 'nothing new'} last time.</p>`) : ''}
    <button class="toggle-row" data-act="loc-exact" aria-pressed="${!st.prefs.exact}"><span><b>Only to about 1 km</b><small>Rounded on this phone before it's kept, so no one can tell the street. Off: exact.</small></span><span class="switch ${st.prefs.exact ? '' : 'on'}"></span></button>
    <p class="label">Places never to note</p>
    <p class="small">Nothing inside these is kept, like home, a clinic or a friend's house. This phone checks before it keeps anything.</p>
    ${never ? `<ul class="plain">${never}</ul>` : '<p class="muted small">None yet.</p>'}
    <div class="row">
      <label class="field"><span class="k">Name (only you see it)</span><input id="locNeverName" type="text" maxlength="60" placeholder="Home"></label>
      <label class="field"><span class="k">How far around</span><select id="locNeverRadius">${LOC.RADII.map((r) => `<option value="${r}"${r === LOC.DEFAULT_RADIUS ? ' selected' : ''}>${RADIUS_TEXT(r)}</option>`).join('')}</select></label>
    </div>
    <div class="row"><button class="btn ghost small" data-act="loc-never-add">Add where I am now</button><button class="btn ghost small" data-act="loc-range">Delete places in a date range</button></div>
  </div>`;
}

// Android: a panel of its own, next to Your life · Android. (On iPhone the block is under Places.)
export function locationPanel(name = ''): string {
  if (LS.platform() !== 'android') return '';
  return `<section class="panel" id="locationPanel"${name ? ` data-title="${esc(name)}"` : ''}><div class="panel-title"><span>${esc(name || 'Your life · Location')}</span></div>${locationBlock()}</section>`;
}

export function refresh() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('locationPanel');
  if (el) el.outerHTML = locationPanel(el.dataset.title);
}

const value = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';

// The block's buttons. True when it was one of them; `redraw` draws the panel again.
export async function handleAction(act: string, el: HTMLElement, redraw: () => void): Promise<boolean> {
  if (!act.startsWith('loc-') || act === 'loc-range' || act === 'loc-range-del' || act === 'loc-day-del') return false;
  switch (act) {
    case 'loc-mode': {
      const mode = el.dataset.mode as LocationMode;
      if (!LOC.MODES.includes(mode)) return true;
      (el as HTMLButtonElement).disabled = true;
      const note = await LS.setMode(mode, el.dataset.every ? Number(el.dataset.every) : undefined);
      toast(note || (mode === 'off' ? 'Location off. What Arise already noted stays in your life log.' : 'Location on.'));
      break;
    }
    case 'loc-every': {
      const n = LOC.parseEvery(value('locEvery'));
      if (n === null) {
        toast(`Type a number of minutes from ${LOC.MIN_EVERY} to ${LOC.MAX_EVERY}.`);
        return true;
      }
      const note = await LS.setMode('interval', n);
      toast(note || `Location on, ${LOC.everyText(n)}.`);
      break;
    }
    case 'loc-exact':
      await LS.setExact(!LS.read().prefs.exact);
      break;
    case 'loc-never-add': {
      (el as HTMLButtonElement).disabled = true;
      const added = await LS.addNeverHere(Number(value('locNeverRadius')) || LOC.DEFAULT_RADIUS, value('locNeverName'));
      toast(added ? 'Added. Nothing there is noted from now on. To delete what was noted there before, use Delete places in a date range.' : "Couldn't find where this phone is. Check that Location is allowed for Arise and try again.");
      break;
    }
    case 'loc-never-del':
      await LS.removeNever(Number(el.dataset.i));
      toast('Removed.');
      break;
    default:
      return false;
  }
  redraw();
  return true;
}
