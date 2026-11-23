// "Search by meaning" on Your days: download the small search model on the Player's choice (with
// its size, and that it stays on this device), how far it has read the log, and removing it.
// The model is life/embed/model.ts; what it does with the log, life/embed/index.ts.

import { esc, toast } from '../ui.js';
import * as MODEL from './embed/model';
import * as IDX from './embed/index';

const $ = (sel) => globalThis.document?.querySelector(sel) ?? null;
const mb = (n) => `${Math.round(n / 1048576)} MB`;

const state = { dl: null, abort: null, error: '' };

export function panel() {
  const on = MODEL.prefs().on;
  let body;
  if (state.dl) {
    const pct = Math.min(100, Math.round((state.dl.got / state.dl.total) * 100));
    body = `<p class="small">Downloading the search model: ${mb(state.dl.got)} of ${mb(state.dl.total)}.</p>
      <progress max="100" value="${pct}" aria-label="Downloaded">${pct}%</progress>
      <div class="row"><button class="btn ghost small" data-act="meaning-stop">Stop</button></div>`;
  } else if (on) {
    const reading = IDX.status.busy ? ` Reading your log${IDX.status.done ? `: ${IDX.status.done.toLocaleString()} done` : ''}. Search uses it as it goes.` : '';
    body = `<p class="small">On. Search finds what's close in meaning, with a small model on this device.${esc(reading)}</p>
      ${IDX.status.error ? `<p class="error small">${esc(IDX.status.error)}</p>` : ''}
      <div class="row"><button class="link danger-link" data-act="meaning-remove">Remove the model</button></div>`;
  } else {
    body = `<p class="small">Search finds related words now ("exercise" finds runs and the gym). For search that understands what you mean, download a small model once: about ${mb(MODEL.DOWNLOAD_BYTES)}. It runs on this device, and your log never leaves it.</p>
      ${state.error ? `<p class="error small">${esc(state.error)}</p>` : ''}
      <div class="row"><button class="btn small primary" data-act="meaning-get">Download (${mb(MODEL.DOWNLOAD_BYTES)})</button></div>`;
  }
  return `<section class="panel small-print" id="meaningPanel"><p class="label">Search by meaning</p>${body}</section>`;
}

function repaint() {
  const el = $('#meaningPanel');
  if (el) el.outerHTML = panel();
}
IDX.onStatus(repaint);

async function get() {
  if (state.dl) return;
  state.error = '';
  state.abort = new AbortController();
  state.dl = { got: 0, total: MODEL.DOWNLOAD_BYTES };
  repaint();
  let last = 0;
  try {
    await MODEL.download({
      signal: state.abort.signal,
      onProgress: (p) => {
        state.dl = p;
        // (Not on every chunk: a few times a second is plenty.)
        const now = Date.now();
        if (now - last > 250) {
          last = now;
          repaint();
        }
      },
    });
    toast('Search by meaning is on. Arise reads your log with it in the background.');
    void IDX.start();
  } catch (err) {
    state.error = err?.code === 'stopped' ? '' : err?.message || "The search model couldn't be downloaded.";
  } finally {
    state.dl = null;
    state.abort = null;
    repaint();
  }
}

export async function handleAction(act) {
  if (!act.startsWith('meaning-')) return false;
  if (act === 'meaning-get') await get();
  else if (act === 'meaning-stop') state.abort?.abort();
  else if (act === 'meaning-remove') {
    if (!globalThis.confirm?.('Remove the search model from this device? Search goes back to related words. You can download it again any time.')) return true;
    IDX.stop();
    await MODEL.removeAll();
    await IDX.forgetVectors();
    toast('Removed.');
    repaint();
  }
  return true;
}

// On: read what's new in the log a little after Arise opens.
if (MODEL.prefs().on && typeof window !== 'undefined') setTimeout(() => void IDX.start(), 8000);
