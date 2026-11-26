// A day's story on screen (story.ts): at the top of the day's journal, in place of the short
// paragraph when the journal is the one built from the log; under the AI's or the Player's own
// words as "What Arise saw" otherwise. "Write it better" asks the AI in use for warmer words, only
// when the Player taps it and only when that AI may read every part of the day. What it writes is
// kept only if they keep it, as their own edit of the journal (memory.ts, saveJournalEdit).

import * as AI from '../ai.js';
import { esc, fmt, icon, openSheet, closeSheet, toast } from '../ui.js';
import * as M from './memory';
import * as P from './policy';
import { dayKey } from './dates';
import { toText } from './diary';
import { mayWrite, writeBetter } from './story';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const shown = new Map(); // day -> { view, story }, what the journal on screen was drawn from
const better = { day: '', text: '' };
let token = 0;

// The journal's view with the day's story: for the built journal, the story (and what has no time
// to it) is its top paragraph, so Copy, Share and Edit have it too.
export function withStory(k, view, story) {
  if (!view) return view;
  const text = story?.text || '';
  const out = text && view.source === 'built' ? { ...view, doc: { ...view.doc, intro: [text, story.facts.aside].filter(Boolean).join(' ') } } : view;
  shown.set(k, { view: out, story: text ? story : null });
  return out;
}

// Under the AI's journal or the Player's own words: the plain story, folded away.
export function sawHTML(k) {
  const s = shown.get(k);
  if (!s?.story || s.view.source === 'built') return '';
  return `<details class="other day-story-saw"><summary>What Arise saw</summary><p class="day-story">${esc(s.story.text)}</p></details>`;
}

// "Write it better": a past day, its journal still the one built from the log, and an AI in use
// that may read all of its story.
export function canBetter(k) {
  const s = shown.get(k);
  return !!s?.story && s.view.source === 'built' && k < dayKey(Date.now()) && AI.ready() && mayWrite(s.story.facts, P.cap());
}
export const betterButton = (k) => (canBetter(k) ? `<button class="btn ghost small" data-act="story-better" data-day="${esc(k)}">${icon('system')} Write it better</button>` : '');

const dayTitle = (k) => fmt(k, { weekday: 'long', day: 'numeric', month: 'long' });

async function writeIt(k) {
  const s = shown.get(k);
  if (!s?.story) return;
  const me = ++token;
  better.day = k;
  better.text = '';
  openSheet(`<p class="kicker">${icon('system')} Write it better</p>
    <h2 class="display sheet-title">${esc(dayTitle(k))}</h2>
    <div id="storyBetter"><div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Writing…</div></div>
    <p class="muted small">Only this day's story goes to ${esc(AI.engineLabel())}, which may read all of it. Nothing is kept unless you keep it.</p>`);
  let html;
  try {
    const text = await writeBetter(s.story.facts, { voice: M.journalVoice(), cap: P.cap(), write: (prompt) => AI.writeDayStory(prompt) });
    if (me !== token) return;
    better.text = text;
    html = `<p class="journal-intro day-story-better">${esc(text)}</p>
      <div class="row"><button class="btn primary small" data-act="story-keep" data-day="${esc(k)}">Keep it</button><button class="btn ghost small" data-act="story-close">Not now</button></div>
      <p class="muted small">If you keep it, it's your own words for this day. Arise won't change them.</p>`;
  } catch (err) {
    if (me !== token) return;
    html = `<p class="error small">${esc(err?.message || "It couldn't be written just now. Try again later.")}</p>`;
  }
  const el = $('#storyBetter');
  if (el) el.innerHTML = html;
}

// Kept: the journal with these words at the top, as the Player's own edit.
async function keep(k) {
  const s = shown.get(k);
  if (!s || better.day !== k || !better.text) return false;
  const intro = [better.text, s.story?.facts.aside].filter(Boolean).join('\n');
  try {
    await M.saveJournalEdit(k, toText({ intro, parts: s.view.doc.parts }));
  } catch (err) {
    toast(err?.message || "Couldn't save it.");
    return false;
  }
  better.text = '';
  closeSheet();
  toast("Kept. They're your words now.");
  return true;
}

// `refresh`: draws the day again once it's kept.
export async function handleAction(act, el, { refresh = () => {} } = {}) {
  const d = el.dataset;
  switch (act) {
    case 'story-better':
      if (canBetter(d.day)) await writeIt(d.day);
      return true;
    case 'story-keep':
      if (await keep(d.day)) refresh();
      return true;
    case 'story-close':
      token++;
      better.text = '';
      closeSheet();
      return true;
    default:
      return false;
  }
}
