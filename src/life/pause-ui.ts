// Pause everything (pause.ts) on screen: the switch in Settings and on the Connect screen, and a
// card on Today while it's on.

import { esc, toast } from '../ui.js';
import * as PAUSE from './pause';

const WHAT = 'Stops Arise noting anything from your phones, location, the Mac helper and the browser extension, on all your devices. Nothing from while it was paused is kept.';

function untilText(until: number, now = Date.now()): string {
  if (until >= PAUSE.FOREVER) return 'until you turn it back on';
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? `until ${time}` : `until ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

export function pausePanel(): string {
  const until = PAUSE.pausedUntil();
  const body = until
    ? `<p><b>Paused ${esc(untilText(until))}.</b> Arise isn't noting anything.</p>
      <div class="row"><button class="btn primary small" data-act="pause-end">Turn back on</button></div>`
    : `<div class="row">
        <button class="btn ghost small" data-act="pause-for" data-ms="${PAUSE.HOUR}">For 1 hour</button>
        <button class="btn ghost small" data-act="pause-for" data-ms="${PAUSE.DAY}">For 1 day</button>
        <button class="btn ghost small" data-act="pause-for" data-ms="0">Until I turn it back on</button>
      </div>`;
  return `<section class="panel" id="pausePanel"><div class="panel-title"><span>Pause everything</span></div>
    <p class="small">${esc(WHAT)}</p>
    ${body}
  </section>`;
}

// On Today: only while it's on.
export function todayCard(): string {
  const until = PAUSE.pausedUntil();
  if (!until) return '<div id="pauseToday"></div>';
  return `<div id="pauseToday"><section class="panel banner pause-card" role="status">
    <span><b>Paused ${esc(untilText(until))}.</b> <small>Arise isn't noting anything from your phones, location, the Mac helper or the browser.</small></span>
    <button class="btn small primary" data-act="pause-end">Turn back on</button>
  </section></div>`;
}

function refresh() {
  if (typeof document === 'undefined') return;
  const panel = document.getElementById('pausePanel');
  if (panel) panel.outerHTML = pausePanel();
  const card = document.getElementById('pauseToday');
  if (card) card.outerHTML = todayCard();
}

export function handleAction(act: string, el: HTMLElement): boolean {
  switch (act) {
    case 'pause-for': {
      const ms = Math.max(0, Number(el.dataset.ms) || 0);
      PAUSE.pause(ms);
      toast(`Paused ${untilText(PAUSE.pausedUntil())}. Nothing is noted while it's on.`);
      refresh();
      return true;
    }
    case 'pause-end':
      PAUSE.resume();
      toast('On again. Arise notes your days again.');
      refresh();
      return true;
  }
  return false;
}

// A pause that ends while Arise is open: the card goes, the switch comes back.
let timer: ReturnType<typeof setTimeout> | null = null;
export function initPause() {
  const watch = () => {
    if (timer) clearTimeout(timer);
    const until = PAUSE.pausedUntil();
    if (until && until < PAUSE.FOREVER) timer = setTimeout(() => {
      refresh();
      watch();
    }, Math.min(until - Date.now() + 1000, 6 * 3_600_000));
  };
  PAUSE.onPauseChange(watch);
  watch();
}
