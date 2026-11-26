// The page someone without Arise sees when they open a plan's link (main.ts sends them here; with
// Arise in this browser, the app answers it instead: plans-ui.js). It reads the plan's page from
// the cloud and opens it with the key in the link, which never leaves this browser. They can say
// Yes or No (sealed with the same key, lib/plans.ts) and save it as a calendar file.
//
// Like a shared goal's page (share-view.ts): no account, no intro, and nothing is kept on their
// device. Nothing here writes to the browser's storage, no service worker is set up, and the
// requests skip the browser's cache. The app itself isn't loaded.

import { FIREBASE } from './firebase-config.js';
import * as L from './lib/plans';
import { inviteIcs } from './lib/events-ics';
import type { CalEvent } from './lib/events';
import { icon } from './icons.js';
import './styles/plans.css';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const home = () => location.pathname || './';

const getArise = `<section class="panel share-cta">
    <p><b>Arise</b> is a private coach for your whole life, with a calendar that plans things with other people. It's free.</p>
    <a class="btn primary block" href="${esc(home())}">Get Arise</a>
    <p class="muted small">Have Arise on your phone? Copy this link, then in Arise open Calendar and tap Open a plan link.</p>
  </section>`;

function messageHTML(title: string, text: string, retry = false) {
  return `<section class="panel glow share-msg">
      <p class="kicker">Shared from Arise</p>
      <h1 class="display">${esc(title)}</h1>
      <p>${esc(text)}</p>
      ${retry ? '<button class="btn ghost" data-plan-retry>Try again</button>' : ''}
    </section>
    ${getArise}`;
}

// The plan as an event, for the calendar file: the same one each time, so saving it twice in a
// calendar app changes it instead of adding it again.
export function icsOf(ref: L.PlanRef, p: L.PlanPage): string {
  const e = { id: L.guestEventId(ref.id), ...L.eventFields(p), created: p.updated, at: p.updated } as CalEvent;
  return inviteIcs(e, { now: p.updated });
}

export function pageHTML(p: L.PlanPage) {
  const who = p.host ? `${p.host}'s plan` : 'A plan';
  const top = `<header class="page-head">
      <div><p class="kicker">Shared from Arise</p><h1 class="display">${esc(who)}</h1></div>
    </header>
    <section class="panel glow">
      ${p.cancelled ? '<p><span class="tag">Called off</span></p>' : ''}
      <h2 class="display goal-title">${esc(p.title)}</h2>
      <p>${esc(L.whenOf(p))}</p>
      ${p.location ? `<p>${icon('pin')} ${esc(p.location)}</p>` : ''}
    </section>`;
  if (p.cancelled) {
    return `${top}
    <p class="muted small share-foot">${esc(p.host || 'The person who sent it')} called this off.</p>
    ${getArise}`;
  }
  return `${top}
    <section class="panel plan-answer">
      <p class="label">Can you come?</p>
      <label class="field"><span class="k">Your name</span><input id="planName" type="text" maxlength="40" autocomplete="given-name"></label>
      <div class="row wrap">
        <button class="btn primary" data-plan-answer="yes">Yes</button>
        <button class="btn" data-plan-answer="no">No</button>
      </div>
      <p class="small" id="planSaid" role="status"></p>
      <p class="muted small">${esc(p.host || 'They')} will see your name and your answer. Answer again with the same name to change it.</p>
    </section>
    <section class="panel">
      <button class="btn ghost" data-plan-ics>${icon('calendar')} Add to your calendar</button>
      <p class="muted small">A calendar file for Apple, Google or Outlook. If the plan changes, this page shows it; the file doesn't.</p>
    </section>
    <p class="muted small share-foot">End-to-end encrypted: the key is in the link, so only people with the link can see this plan and answer it.</p>
    ${getArise}`;
}

const NOT_FOUND = 'This plan is no longer shared. Ask the person who sent it.';
const BROKEN = "This link isn't complete. Ask for it again, or copy all of it.";
const OFFLINE = "Couldn't load it. Check your internet connection and try again.";

let shownPlan: { ref: L.PlanRef; page: L.PlanPage } | null = null;
let busy = false;

// Shows the plan in `hash` (the page's # part). Returns what it showed.
export async function showPlan(hash = location.hash): Promise<'shown' | 'cancelled' | 'gone' | 'broken' | 'offline'> {
  const root = document.getElementById('app')!;
  document.body.dataset.view = 'share';
  document.getElementById('tabs')?.setAttribute('hidden', '');
  document.title = 'A plan | Arise';
  shownPlan = null;
  const ref = L.parsePlanLink(hash);
  if (!ref) {
    root.innerHTML = messageHTML('Link not complete', BROKEN);
    return 'broken';
  }
  if (!FIREBASE) {
    root.innerHTML = messageHTML('No longer shared', NOT_FOUND);
    return 'gone';
  }
  root.innerHTML = '<p class="muted">Loading…</p>';
  let sealed;
  try {
    sealed = await L.fetchPage(ref.id, FIREBASE);
  } catch {
    root.innerHTML = messageHTML("Couldn't load it", OFFLINE, true);
    return 'offline';
  }
  if (!sealed) {
    root.innerHTML = messageHTML('No longer shared', NOT_FOUND);
    return 'gone';
  }
  let page: L.PlanPage | null = null;
  try {
    page = await L.openPage(ref, sealed);
  } catch {}
  if (!page) {
    root.innerHTML = messageHTML('Link not complete', BROKEN);
    return 'broken';
  }
  shownPlan = { ref, page };
  root.innerHTML = pageHTML(page);
  return page.cancelled ? 'cancelled' : 'shown';
}

// Yes or No, sealed and sent. What it said.
export async function sendAnswer(says: 'yes' | 'no'): Promise<string> {
  const out = document.getElementById('planSaid');
  const name = (document.getElementById('planName') as HTMLInputElement | null)?.value.trim() || '';
  const say = (t: string) => {
    if (out) out.textContent = t;
    return t;
  };
  if (!shownPlan || !FIREBASE || busy) return '';
  if (!name) {
    document.getElementById('planName')?.focus();
    return say('Write your name first, so they know who answered.');
  }
  busy = true;
  const who = shownPlan.page.host || 'They';
  try {
    await L.answer(shownPlan.ref, name, says, FIREBASE);
    return say(says === 'yes' ? `Thanks, ${name}. ${who} will see you're coming.` : `Thanks, ${name}. ${who} will see you can't make it.`);
  } catch (err) {
    const code = String((err as { code?: string })?.code || '');
    return say(code === 'permission-denied' ? NOT_FOUND : OFFLINE);
  } finally {
    busy = false;
  }
}

function saveIcs() {
  if (!shownPlan) return;
  const name = `${shownPlan.page.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60).replace(/\s+/g, '-') || 'plan'}.ics`;
  const url = URL.createObjectURL(new File([icsOf(shownPlan.ref, shownPlan.page)], name, { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

document.addEventListener('click', (e) => {
  const t = e.target as Element;
  const answer = t.closest?.('[data-plan-answer]') as HTMLElement | null;
  if (answer) void sendAnswer(answer.dataset.planAnswer === 'yes' ? 'yes' : 'no');
  else if (t.closest?.('[data-plan-ics]')) saveIcs();
  else if (t.closest?.('[data-plan-retry]')) void showPlan();
});
// Another link opened in this tab, or the app's own address: start again with that.
window.addEventListener('hashchange', () => location.reload());

export const shown = showPlan();
