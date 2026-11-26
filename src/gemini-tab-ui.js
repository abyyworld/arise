// Settings, AI coach: "Gemini in your browser" (life/gemini-tab.ts). system.js shows its card
// with the others while this browser's Arise extension is linked (or once it's picked), and this
// panel under them while it's picked: what Google sees, Try, and turning it off.

import * as S from './store';
import * as AI from './ai.js';
import * as GT from './life/gemini-tab';
import * as BL from './life/browser-link';
import { esc, toast } from './ui.js';

let app = { render: () => {}, view: () => '' };
const redraw = () => {
  if (app.view() === 'settings' || app.view() === 'connect') app.render();
};
export function initGeminiTabUI(hooks) {
  app = hooks;
  GT.initGeminiTab({ render: redraw });
}

let tryState = { busy: false, ok: false, text: '' };

// Only with the extension linked in this browser, or once it's picked (so it can be turned off).
export const offered = () => !!BL.here() || S.state.settings.aiEngine === 'tab';

export const CARD_TEXT = 'Gemini in a tab of this browser, with your own Google account, through the Arise extension. Free within your Gemini limits. Google sees what the coach sends.';

export const SEES =
  "Google sees each question and what Arise sends with it (your goal, plan, check-ins and anything you typed in Arise), and keeps it in your Gemini activity like any chat you have there. Your life log goes too only if you allow less private AIs to read it. Arise doesn't use it for work it does by itself, like the daily message or learning from your days.";

export function cardStatus() {
  if (!BL.here()) return { ok: false, text: 'Needs the Arise extension, linked to this browser.' };
  if (GT.status.error) return { ok: false, text: GT.status.error };
  if (!GT.status.known) return { ok: false, text: 'Asking the Arise extension…' };
  if (!GT.status.on) return { ok: false, text: 'Pick it to turn it on. The app asks you first.' };
  if (!GT.status.granted) return { ok: false, text: "Waiting for you to allow gemini.google.com in the Arise extension's window." };
  return { ok: true, text: 'Ready. Answers can take a minute.' };
}

export function panel() {
  const ready = GT.ready();
  return `<div class="stack own-key" id="geminiTab">
      <p class="small">${esc(SEES)}</p>
      <p class="muted small">Be signed in at gemini.google.com in this browser. Arise opens its own Gemini tab in the background and starts a new chat for each question. Keep Arise open while it answers.</p>
      ${tryState.text ? `<p class="small ${tryState.ok ? 'ok' : 'error'}">${esc(tryState.text)}</p>` : ''}
      <div class="row">
        <button class="btn ghost small" data-act="gtab-try" ${!ready || tryState.busy ? 'disabled' : ''}>${tryState.busy ? 'Waiting for Gemini…' : 'Try'}</button>
        ${GT.status.on && !GT.status.granted ? '<button class="btn ghost small" data-act="gtab-allow">Ask again</button>' : ''}
        <button class="btn ghost small" data-act="gtab-off">Stop using it</button>
      </div>
    </div>`;
}

const AGREE =
  "Use Gemini in your browser? It's less private: Google sees what the coach sends (your goal, plan, check-ins and what you typed in Arise) and keeps it in your Gemini activity. The Arise extension then asks you to allow gemini.google.com.";

// Picking its card. False when the Player says no, or there's no extension to ask.
export async function turnOn() {
  if (GT.ready()) return true;
  if (!BL.here()) {
    toast('Link this browser to Arise first, with the Arise extension.');
    return false;
  }
  if (!GT.status.on && !confirm(AGREE)) return false;
  tryState = { busy: false, ok: false, text: '' };
  return GT.setOn(true);
}

export async function handleAction(act) {
  switch (act) {
    case 'gtab-try':
      tryState = { busy: true, ok: false, text: '' };
      redraw();
      try {
        const text = await AI.testTab();
        tryState = { busy: false, ok: true, text: `✓ Gemini answered: ${text.slice(0, 80)}` };
      } catch (err) {
        tryState = { busy: false, ok: false, text: err.message };
      }
      redraw();
      return true;
    case 'gtab-allow':
      await GT.setOn(true);
      return true;
    case 'gtab-off':
      if (S.state.settings.aiEngine === 'tab') {
        S.state.settings.aiEngine = '';
        S.save();
      }
      await GT.setOn(false);
      tryState = { busy: false, ok: false, text: '' };
      toast("Arise won't use Gemini in this browser any more.");
      redraw();
      return true;
  }
  return false;
}
