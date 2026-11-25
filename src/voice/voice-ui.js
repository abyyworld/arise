// Voice notes: talk instead of typing. A Talk button next to a text box (the box on Today, and
// Add to your day): it records, shows the time and Stop, then the voice model on this device turns
// it into words and puts them in the box, where the person can fix them before saving. The box
// then works out what it is, as it does for typed words.
//
// Until the model is downloaded, Talk offers the download (its size, and that it stays on this
// device). On a device that can't record or run the model, it says so. The settings (language,
// keeping the recording, removing the model) are a panel on Your days.
//
// With "Keep the recording" on, the recording goes in the box's file picker, so it's saved with
// the note in Photos and files, locked on the device first, like any other file.
//
// The model and its download: voice/model.ts. Recording: voice/record.ts.

import { esc, toast } from '../ui.js';
import * as MODEL from './model';
import { MAX_SECONDS, startRecording, toSamples } from './record';
import { LANGUAGE_NAMES } from './tokens';
import '../styles/voice.css';

const doc = () => globalThis.document;
const mb = (n) => `${Math.max(1, Math.round(n / 1048576))} MB`;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const MIC = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

// What the flow uses, so tests can swap in a fake microphone and a fake model.
const real = {
  canRun: () => MODEL.canRun(),
  downloaded: () => MODEL.downloaded(),
  toDownload: () => MODEL.toDownload(),
  download: (o) => MODEL.download(o),
  remove: () => MODEL.removeAll(),
  start: () => startRecording(),
  samples: (blob) => toSamples(blob),
  transcriber: () => MODEL.transcriber(),
  attach: attachFile,
};
let deps = { ...real };

// One per text box: 'idle', 'offer' (download it?), 'dl', 'rec', 'work' or 'cant'.
const slots = new Map();
const state = { dl: null, abort: null, error: '', need: null, needing: false };

// For tests: swap what the flow uses (null for the real ones), starting afresh.
export function _setDeps(d) {
  deps = d ? { ...real, ...d } : { ...real };
  for (const s of slots.values()) clearInterval(s.timer);
  slots.clear();
  Object.assign(state, { dl: null, abort: null, error: '', need: null, needing: false });
}

function slot(box, file = '') {
  let s = slots.get(box);
  if (!s) slots.set(box, (s = { box, file, mode: 'idle', rec: null, timer: null }));
  if (file) s.file = file;
  return s;
}

// ---------- the button, and what's in its place while it works

export function micButton(box, file = '') {
  const s = slot(box, file);
  return `<span class="voice${['offer', 'dl', 'cant'].includes(s.mode) ? ' wide' : ''}" id="voice-${esc(box)}" data-box="${esc(box)}">${inner(s)}</span>`;
}

const at = (s) => `data-box="${esc(s.box)}"`;
function inner(s) {
  switch (s.mode) {
    case 'rec':
      return `<span class="voice-rec" role="status"><i class="voice-dot" aria-hidden="true"></i> Listening <span class="voice-time">${clock(s.rec?.seconds?.() || 0)}</span></span>
        <button type="button" class="btn primary small" data-act="voice-stop" ${at(s)}>Stop</button>
        <button type="button" class="link small" data-act="voice-cancel" ${at(s)}>Cancel</button>`;
    case 'work':
      return `<span class="voice-work muted small" role="status">Writing down what you said…</span>`;
    case 'dl':
    case 'offer': {
      if (state.dl) {
        const pct = Math.min(100, Math.round((state.dl.got / Math.max(1, state.dl.total)) * 100));
        return `<span class="small">Downloading the voice model: ${mb(state.dl.got)} of ${mb(state.dl.total)}.</span>
          <progress max="100" value="${pct}" aria-label="Downloaded">${pct}%</progress>
          <button type="button" class="link small" data-act="voice-dl-stop" ${at(s)}>Stop</button>`;
      }
      const size = mb(state.need ?? MODEL.DOWNLOAD_BYTES);
      return `<span class="small">Turn on voice notes: download about ${size} once, kept on this device. What you say is turned into words here and never leaves it.</span>
        ${state.error ? `<span class="error small">${esc(state.error)}</span>` : ''}
        <span class="row voice-btns"><button type="button" class="btn primary small" data-act="voice-get" ${at(s)}>Download (${size})</button><button type="button" class="link small" data-act="voice-close" ${at(s)}>Not now</button></span>`;
    }
    case 'cant':
      return `<span class="small">Voice notes can't work on this device: it can't record sound, or it can't run the voice model. You can still type.</span>
        <span class="row voice-btns"><button type="button" class="link small" data-act="voice-close" ${at(s)}>OK</button></span>`;
    default:
      return `<button type="button" class="btn ghost small voice-mic" data-act="voice-mic" ${at(s)} aria-label="Talk instead of typing">${MIC} <span>Talk</span></button>`;
  }
}

function paint(s) {
  const el = doc()?.getElementById(`voice-${s.box}`);
  if (!el) return;
  el.innerHTML = inner(s);
  el.classList.toggle('wide', ['offer', 'dl', 'cant'].includes(s.mode));
}
function paintAll() {
  for (const s of slots.values()) paint(s);
  repaintPanel();
}

// ---------- talking

// The words go into the box (after what's there), and the box is told, so it works out what it is.
export function putWords(box, text) {
  const el = doc()?.getElementById(box);
  if (!el) return false;
  const was = el.value.trim();
  let v = was ? `${was} ${text}` : text;
  if (el.maxLength > 0) v = v.slice(0, el.maxLength);
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus?.();
  try {
    el.setSelectionRange?.(v.length, v.length);
  } catch {}
  return true;
}

// The recording into the box's file picker, as if it had been picked. False where the browser can't.
function attachFile(fileId, file) {
  const input = doc()?.getElementById(fileId);
  if (!input || typeof DataTransfer !== 'function') return false;
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

export function recordingName(type, when = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ext = /mp4|m4a|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
  return `Voice note ${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}.${p(when.getMinutes())}.${ext}`;
}

async function mic(box, file) {
  const s = slot(box, file);
  if (s.mode !== 'idle') return;
  if (!deps.canRun()) {
    s.mode = 'cant';
    return paint(s);
  }
  if (!(await deps.downloaded())) {
    s.mode = state.dl ? 'dl' : 'offer';
    if (state.need == null) state.need = await deps.toDownload().catch(() => null);
    return paint(s);
  }
  try {
    s.rec = await deps.start();
  } catch (err) {
    toast(err?.message || "The microphone couldn't start.");
    return;
  }
  s.mode = 'rec';
  paint(s);
  // The model starts while the person talks, so the words come sooner after Stop.
  void Promise.resolve()
    .then(() => deps.transcriber())
    .catch(() => {});
  s.timer = setInterval(() => tick(s), 500);
}

function tick(s) {
  if (s.mode !== 'rec' || !s.rec) return;
  // The box is gone (its sheet was closed): the microphone stops.
  const here = doc()?.getElementById(`voice-${s.box}`);
  if (!here) return cancel(s);
  const t = s.rec.seconds();
  const el = here.querySelector('.voice-time');
  if (el) el.textContent = clock(t);
  if (t >= MAX_SECONDS) void stop(s);
}

function cancel(s) {
  clearInterval(s.timer);
  s.timer = null;
  s.rec?.cancel();
  s.rec = null;
  s.mode = 'idle';
  paint(s);
}

export async function stop(s) {
  if (typeof s === 'string') s = slot(s);
  if (s.mode !== 'rec' || !s.rec) return;
  clearInterval(s.timer);
  s.timer = null;
  const rec = s.rec;
  s.rec = null;
  s.mode = 'work';
  paint(s);
  try {
    const blob = await rec.stop();
    const audio = await deps.samples(blob);
    const t = await deps.transcriber();
    const { text } = await t.transcribe(audio, { language: MODEL.prefs().lang });
    if (text) putWords(s.box, text);
    else toast("Arise didn't hear any words. Try again, a little closer to the microphone.");
    if (MODEL.prefs().keep && blob.size && s.file) {
      const kept = deps.attach(s.file, new File([blob], recordingName(blob.type), { type: blob.type || 'audio/webm' }));
      if (!kept) toast("This browser can't keep the recording with the note. The words are in the box.");
    }
  } catch (err) {
    toast(err?.message || "That couldn't be turned into words.");
  } finally {
    s.mode = 'idle';
    paint(s);
  }
}

// ---------- the download

async function get() {
  if (state.dl) return;
  state.error = '';
  state.abort = new AbortController();
  state.dl = { got: 0, total: state.need ?? MODEL.DOWNLOAD_BYTES };
  for (const s of slots.values()) if (s.mode === 'offer') s.mode = 'dl';
  paintAll();
  let last = 0;
  let ok = false;
  try {
    await deps.download({
      signal: state.abort.signal,
      onProgress: (p) => {
        state.dl = p;
        // (Not on every chunk: a few times a second is plenty.)
        const now = Date.now();
        if (now - last > 250) {
          last = now;
          paintAll();
        }
      },
    });
    ok = true;
    toast('Voice notes are on. Tap Talk and speak.');
  } catch (err) {
    state.error = err?.code === 'stopped' ? '' : err?.message || "The voice model couldn't be downloaded.";
  } finally {
    state.dl = null;
    state.abort = null;
    state.need = null;
    for (const s of slots.values()) if (s.mode === 'dl' || (ok && s.mode === 'offer')) s.mode = ok ? 'idle' : 'offer';
    paintAll();
  }
}

// ---------- the settings, on Your days

export function panel() {
  const p = MODEL.prefs();
  let body;
  if (!deps.canRun()) {
    body = `<p class="small">Voice notes can't work on this device: it can't record sound, or it can't run the voice model.</p>`;
  } else if (state.dl) {
    const pct = Math.min(100, Math.round((state.dl.got / Math.max(1, state.dl.total)) * 100));
    body = `<p class="small">Downloading the voice model: ${mb(state.dl.got)} of ${mb(state.dl.total)}.</p>
      <progress max="100" value="${pct}" aria-label="Downloaded">${pct}%</progress>
      <div class="row"><button class="btn ghost small" data-act="voice-dl-stop">Stop</button></div>`;
  } else if (p.on) {
    body = `<p class="small">On. Tap Talk in the box on Today or in Add to your day, and speak. ${esc(MODEL.MODEL_NAME)} turns it into words on this device. The sound never leaves it.</p>
      <label class="field inline"><span class="k">Language</span><select id="voiceLang">${[['auto', 'Auto (it works it out)'], ...LANGUAGE_NAMES].map(([v, name]) => `<option value="${v}" ${p.lang === v ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>
      <button class="toggle-row" data-act="voice-keep" aria-pressed="${p.keep}"><span><b>Keep the recording</b><small>${p.keep ? 'The recording is saved with the note in Photos and files, locked on this device first.' : 'Off: only the words are kept.'}</small></span><span class="switch ${p.keep ? 'on' : ''}"></span></button>
      <div class="row"><button class="link danger-link" data-act="voice-remove">Remove the voice model</button></div>`;
  } else {
    if (state.need == null && !state.needing) {
      state.needing = true;
      void deps
        .toDownload()
        .then((n) => (state.need = n))
        .catch(() => {})
        .finally(() => {
          state.needing = false;
          repaintPanel();
        });
    }
    const size = mb(state.need ?? MODEL.DOWNLOAD_BYTES);
    body = `<p class="small">Talk instead of typing. Turn on voice notes: download about ${size} once, kept on this device. What you say is turned into words here and never leaves it.</p>
      ${state.error ? `<p class="error small">${esc(state.error)}</p>` : ''}
      <div class="row"><button class="btn small primary" data-act="voice-get">Download (${size})</button></div>`;
  }
  return `<section class="panel small-print" id="voicePanel"><p class="label">Voice notes</p>${body}</section>`;
}

function repaintPanel() {
  const el = doc()?.getElementById('voicePanel');
  if (el) el.outerHTML = panel();
}

// ---------- taps

// Taps on anything with data-act="voice-...". True when it was one of these.
export function handleAction(act, el) {
  if (!act?.startsWith('voice-')) return false;
  const box = el?.dataset?.box || '';
  const s = box ? slot(box) : null;
  switch (act) {
    case 'voice-mic':
      void mic(box);
      break;
    case 'voice-stop':
      if (s) void stop(s);
      break;
    case 'voice-cancel':
      if (s?.mode === 'rec') cancel(s);
      break;
    case 'voice-close':
      if (s) {
        s.mode = 'idle';
        state.error = '';
        paint(s);
      }
      break;
    case 'voice-get':
      void get();
      break;
    case 'voice-dl-stop':
      state.abort?.abort();
      break;
    case 'voice-keep':
      MODEL.setPrefs({ keep: !MODEL.prefs().keep });
      repaintPanel();
      break;
    case 'voice-remove':
      if (!globalThis.confirm?.('Remove the voice model from this device? You can download it again any time.')) break;
      void deps.remove().then(() => {
        state.need = null;
        toast('Removed.');
        paintAll();
      });
      break;
    default:
      return false;
  }
  return true;
}

doc()?.addEventListener('change', (e) => {
  if (e.target?.id === 'voiceLang') MODEL.setPrefs({ lang: e.target.value });
});
