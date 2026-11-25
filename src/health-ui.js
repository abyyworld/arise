// System health on screen (health.ts), in Setup and connections: one button checks sync, the AI,
// reminders, the AI apps connector, calendars by link and your own storage, and says what works.

import * as H from './health';
import * as SYNC from './sync';
import * as S from './store';
import * as ME from './me';
import { PRIVATE_AI } from './ai-config';
import { REMINDERS } from './reminders-config';
import { CALENDAR } from './calendar-config';
import { isNative } from './native.js';
import { checkOwnStorage } from './life/files-sync';
import { status as readsStatus, statusText as readsText } from './life/reads-core';
import { esc, icon } from './ui.js';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const origin = (u) => {
  try {
    return u ? new URL(u).origin : '';
  } catch {
    return '';
  }
};

const DAY = 86_400_000;

export function probes() {
  return [
    {
      id: 'sync',
      name: 'Sync',
      run: async () => {
        if (!SYNC.hasAccount()) return { state: 'off', text: 'No account on this device, so your data is only here.' };
        const at = SYNC.lastSyncedAt();
        if (SYNC.status.error) return { state: 'bad', text: SYNC.status.error };
        if (!at || Date.now() - at > 2 * DAY) return { state: 'bad', text: `Last synced ${H.ago(at)}. Open Settings, Account and tap Sync now.` };
        return { state: 'ok', text: `Last synced ${H.ago(at)}.` };
      },
    },
    H.serverProbe('ai', 'Private AI', origin(PRIVATE_AI.proxy), 'Your coach can still use the AI on this device, if it has one.'),
    isNative
      ? { id: 'reminders', name: 'Reminders', run: async () => ({ state: 'ok', text: 'This phone plans its own reminders, with no server.' }) }
      : H.serverProbe('reminders', 'Reminders', origin(REMINDERS.server), 'Reminders while Arise is closed come from this server.'),
    {
      id: 'connector',
      name: 'AI apps on the web',
      run: async () => {
        if (!ME.connectorReady()) return { state: 'off', text: 'Not set up in this version.' };
        if (!ME.links().some((l) => l.web)) return { state: 'off', text: 'No AI app is connected on the web.' };
        return (await ME.checkConnector()) ? { state: 'ok', text: 'Answers.' } : { state: 'bad', text: "Doesn't answer, so Claude, ChatGPT or Gemini on the web can't reach Arise." };
      },
    },
    H.serverProbe('calendar', 'Calendars by link', origin(CALENDAR.server), 'On the web, calendars by link are read through this helper.'),
    {
      id: 'storage',
      name: 'Your own storage',
      run: async () => {
        const cfg = S.ownStorage();
        if (!cfg) return { state: 'off', text: 'Not set up: photos and files are kept in Arise, up to 250 MB.' };
        await checkOwnStorage(cfg);
        return { state: 'ok', text: 'Your bucket answers, and Arise can write to it.' };
      },
    },
    {
      id: 'reads',
      name: 'Arise reads it for you',
      run: async () => {
        const s = readsStatus;
        if (s.state === 'off') return { state: 'off', text: 'Off. Turn it on in Settings, Your life log.' };
        return { state: s.state === 'no-ai' || s.failed ? 'bad' : 'ok', text: readsText(s) };
      },
    },
    {
      id: 'notify',
      name: 'Notifications here',
      run: async () => {
        if (isNative) return S.state.settings.notify ? { state: 'ok', text: 'On.' } : { state: 'off', text: 'Off. Turn them on in Settings, Reminders.' };
        const p = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
        if (p === 'granted') return { state: 'ok', text: 'Allowed in this browser.' };
        if (p === 'denied') return { state: 'bad', text: 'Blocked in this browser. Allow them in the site settings (the icon left of the address).' };
        return { state: 'off', text: p === 'unsupported' ? "This browser can't show them." : 'Not asked yet. Turn them on in Settings, Reminders.' };
      },
    },
  ];
}

let results = null; // the last check's
let running = false;

const MARK = { ok: 'Working', bad: 'Needs a look', off: 'Not set up' };

function rows() {
  if (!results) return '<p class="muted small">Checks sync, the AI, reminders, AI apps, calendars and your storage. Nothing of yours is sent: each server is only asked whether it is there.</p>';
  return `<p class="small"><b>${esc(H.summary(results) || 'Checking...')}</b></p>
    <ul class="health-list">${results
      .map((r) => `<li class="health-row ${r.state}"><span class="health-dot" aria-hidden="true"></span><span><b>${esc(r.name)}</b> <span class="tag">${MARK[r.state]}</span><br><small>${esc(r.text)}</small></span></li>`)
      .join('')}</ul>`;
}

export function panel() {
  return `<section class="panel health" id="healthPanel">
    <div class="panel-title">${icon('bolt')}<span>System health</span></div>
    <div id="healthBody">${rows()}</div>
    <div class="row"><button class="btn small primary" data-act="health-run"${running ? ' disabled' : ''}>${running ? 'Checking...' : results ? 'Check again' : 'Check everything'}</button></div>
  </section>`;
}

function repaint() {
  const el = $('#healthPanel');
  if (el) el.outerHTML = panel();
}

export async function run(list = probes()) {
  if (running) return results;
  running = true;
  results = [];
  repaint();
  try {
    results = await H.runAll(list, (_r, all) => {
      results = [...all];
      const body = $('#healthBody');
      if (body) body.innerHTML = rows();
    });
  } finally {
    running = false;
    repaint();
  }
  return results;
}

// True when it was one of these.
export function handleAction(act) {
  if (act !== 'health-run') return false;
  void run();
  return true;
}

// For tests.
export function _reset() {
  results = null;
  running = false;
}
