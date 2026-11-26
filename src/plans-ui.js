// Plans between people on the Calendar (plans.ts does the work): the part of an event's sheet that
// plans it with someone, sends the link and shows who's in; "Tell them?" when a shared event
// changes or goes; a plan link opened in Arise (I'm in, Can't make it); and Open a plan link, for
// a link that came to a phone.

import * as S from './store';
import * as P from './plans';
import * as L from './lib/plans';
import * as EV from './lib/events';
import * as N from './native.js';
import { firstName } from './share';
import { SITE_URL } from './lib/pages';
import { status as syncStatus } from './sync';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';
import './styles/plans.css';

const $ = (sel) => globalThis.document?.querySelector(sel) ?? null;

// Where the other person opens the link: this page's address on the web; the website in the phone apps.
export const linkTo = (plan) => L.planLink(N.isNative ? __APP_UPDATE_SITE__ || SITE_URL : `${location.origin}${location.pathname}`, plan);
const canSend = () => N.canShareLink() || typeof navigator.share === 'function';
const names = (list) => (list.length < 3 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const pageOfEvent = (e) => L.pageOf(e, { now: e.at });
const yourName = (e) => e?.plan?.name || firstName();

// ---------- in an event's sheet

export const WHAT_THEY_SEE = 'They see the title, the time, the place and your first name, and can say if they can come. Not your notes or who else you invited.';

function answersHTML(e) {
  const { yes, no, left } = P.answersOf(e);
  if (!yes.length && !no.length && !left.length) return '<p class="muted small">No answers yet.</p>';
  const line = (label, list, cls) => (list.length ? `<p class="plan-says ${cls}"><b>${label}</b> ${esc(names(list.map((a) => a.name)))}</p>` : '');
  return `${line("In:", yes, 'yes')}${line("Can't make it:", no, 'no')}${line('Stopped sharing:', left, 'left')}`;
}

export function planSection(e) {
  if (!e || e.gone) return '';
  const plan = e.plan;
  if (!plan) {
    return `<section class="ev-plan" id="evPlan">
      <p class="label">${icon('share')} Plan it with someone</p>
      <p class="muted small">Arise makes a private link and you send it yourself. ${esc(WHAT_THEY_SEE)}</p>
      <button class="btn small" type="button" data-act="plan-start" data-id="${esc(e.id)}">Plan it with someone</button>
    </section>`;
  }
  if (plan.guest) {
    const who = plan.host || 'They';
    const status =
      plan.ended === 'cancelled'
        ? `<p><span class="tag">Called off</span> ${esc(who)} called this off.</p>`
        : plan.ended === 'off'
          ? `<p class="muted small">${esc(who)} stopped sharing this. It stays in your calendar as yours.</p>`
          : `<p class="muted small">${plan.host ? `Shared with you by ${esc(plan.host)}.` : 'Shared with you.'} When they change it, your copy changes too.</p>
             <p class="plan-says ${plan.says === 'no' ? 'no' : 'yes'}">${plan.says === 'no' ? "You said you can't make it." : "You said you're in."}</p>
             <div class="row wrap">
               ${plan.says === 'no' ? `<button class="btn small" type="button" data-act="plan-mine" data-v="yes" data-id="${esc(e.id)}">I'm in after all</button>` : `<button class="btn small" type="button" data-act="plan-mine" data-v="no" data-id="${esc(e.id)}">Can't make it</button>`}
               <button class="btn ghost small" type="button" data-act="plan-leave" data-id="${esc(e.id)}">Stop sharing</button>
             </div>`;
    return `<section class="ev-plan" id="evPlan"><p class="label">${icon('share')} Shared plan</p>${status}</section>`;
  }
  const untold = P.untold(e);
  return `<section class="ev-plan" id="evPlan">
    <p class="label">${icon('share')} Planned with others</p>
    ${answersHTML(e)}
    ${untold ? `<p class="small">Their copy still has the old details. <button class="link small" type="button" data-act="plan-tell" data-id="${esc(e.id)}">Tell them now</button></p>` : ''}
    <label class="field"><span class="k">Link</span><input id="planLinkIn" type="text" readonly value="${esc(linkTo(plan))}"></label>
    <div class="row wrap">
      ${canSend() ? `<button class="btn small" type="button" data-act="plan-send" data-id="${esc(e.id)}">Send</button>` : ''}
      <button class="btn small" type="button" data-act="plan-copy">Copy link</button>
      <button class="btn small" type="button" data-act="plan-email" data-id="${esc(e.id)}">Email</button>
      <button class="btn ghost small danger" type="button" data-act="plan-stop" data-id="${esc(e.id)}">Stop sharing</button>
    </div>
    <p class="muted small">${esc(WHAT_THEY_SEE)} Anyone with the link can see it and answer, so send it only to the people you mean.</p>
  </section>`;
}

// The section again, in the sheet that's open (if it's this event's).
function redraw(id) {
  const box = $('#evPlan');
  if (!box || box.closest('.ev-sheet')?.dataset.id !== id) return;
  box.outerHTML = planSection(S.state.events[id]);
}

// The event's sheet opened: its answers, or their changes, right away.
export function opened(id) {
  const e = S.state.events[id];
  if (!e?.plan || e.plan.ended) return;
  const run = e.plan.guest ? P.follow(id) : P.pullAnswers(id);
  void run.then(() => redraw(id)).catch(() => {});
}

// "Called off" on your copy of a plan its maker called off; '' otherwise.
export const tagOf = (e) => (e?.plan?.guest && e.plan.ended === 'cancelled' ? 'Called off' : '');
export const isShared = (e) => !!e?.plan && !e.plan.ended;

// ---------- "Tell them?"

// After a change was saved: if the page doesn't say it yet, ask.
export function afterChange(id) {
  const e = S.state.events[id];
  if (!e || !P.untold(e)) return;
  if (!confirm('Tell the people you planned this with? Their copy changes to match.')) return;
  void tellNow(id);
}

async function tellNow(id) {
  try {
    if (await P.tell(id)) toast('Told them. Their copy changes next time they open Arise or the link.');
    else toast('This plan is no longer shared.');
  } catch (err) {
    toast(`${P.problem(err)} They still have the old details.`);
  }
  redraw(id);
}

// Before an event of yours is deleted (`e` as it is now). Your plan: tell them it's called off, or
// turn the link off without a word. Someone else's: tell them you can't make it.
export function beforeRemove(e) {
  if (!e?.plan) return;
  const plan = e.plan;
  if (!plan.guest) {
    const told = confirm("Tell them it's called off? Their copy is marked as called off. If not, the link stops working and their copy stays as theirs.");
    const job = told ? P.cancel(e).then((ok) => toast(ok ? 'Told them it is called off.' : 'This plan is no longer shared.')) : P.stopLink(plan);
    void job.catch((err) => toast(`${P.problem(err)} ${told ? "They weren't told." : 'The link still works.'}`));
    return;
  }
  if (plan.ended) return;
  const name = yourName(e);
  if (!name || !confirm(`Tell ${plan.host || 'them'} you can't make it?`)) return;
  void P.tellNo(e, name).catch((err) => toast(`${P.problem(err)} They weren't told.`));
}

// ---------- a plan link opened in Arise

let link = null; // { ref, page?, state: 'loading' | 'shown' | 'gone' | 'broken' | 'offline', busy }
let openEvent = () => {};
// The calendar's way to open one of your events (calendar-ui.js).
export const setOpenEvent = (fn) => (openEvent = fn);

function linkHTML() {
  const { page, state } = link;
  if (state === 'loading') return '<div class="plan-sheet"><p class="kicker">A plan shared with you</p><p class="muted">Loading…</p></div>';
  if (state !== 'shown') {
    const say = {
      gone: ['No longer shared', 'This plan was turned off. Ask the person who sent it.'],
      broken: ["Link isn't complete", 'Ask for it again, or copy all of it.'],
      offline: ["Couldn't load it", 'Check your internet connection and try again.'],
    }[state];
    return `<div class="plan-sheet"><p class="kicker">A plan shared with you</p><h2 class="display sheet-title">${esc(say[0])}</h2><p>${esc(say[1])}</p>${state === 'offline' ? '<button class="btn ghost small" data-act="plan-retry">Try again</button>' : ''}</div>`;
  }
  const who = page.host ? `A plan from ${page.host}` : 'A plan shared with you';
  if (page.cancelled) {
    return `<div class="plan-sheet"><p class="kicker">${esc(who)}</p><h2 class="display sheet-title">${esc(page.title)}</h2><p><span class="tag">Called off</span> ${esc(L.whenOf(page))}</p></div>`;
  }
  return `<div class="plan-sheet">
    <p class="kicker">${esc(who)}</p>
    <h2 class="display sheet-title">${esc(page.title)}</h2>
    <p>${esc(L.whenOf(page))}</p>
    ${page.location ? `<p>${icon('pin')} ${esc(page.location)}</p>` : ''}
    <label class="field"><span class="k">Your name</span><input id="planName" type="text" maxlength="40" autocomplete="given-name" value="${esc(firstName())}"></label>
    <p class="muted small">${esc(page.host || 'They')} will see your name and your answer. With I'm in, it goes in your calendar and follows their changes.</p>
    <div class="row wrap">
      <button class="btn primary small" data-act="plan-answer" data-v="yes" ${link.busy ? 'disabled' : ''}>I'm in</button>
      <button class="btn small" data-act="plan-answer" data-v="no" ${link.busy ? 'disabled' : ''}>Can't make it</button>
    </div>
  </div>`;
}
const drawLink = () => {
  if ($('.plan-sheet') || link?.state === 'loading') openSheet(linkHTML());
};

// A plan link (the # part, or a whole link pasted in). True when it was one.
export function takeLink(text) {
  const ref = L.parsePlanLink(text);
  if (!ref) {
    if (L.isPlanHash(String(text || '').trim()) || /#plan=/.test(String(text || ''))) toast("This plan link isn't complete. Ask for it again.");
    return false;
  }
  // Your own plan, or one already in your calendar: its event.
  const mine = EV.liveEvents(S.state.events).find((e) => e.plan?.id === ref.id);
  if (mine) {
    openEvent(mine.id);
    return true;
  }
  link = { ref, state: 'loading', busy: false };
  openSheet(linkHTML());
  void load();
  return true;
}

async function load() {
  const mine = link;
  let got;
  try {
    got = await P.look(mine.ref);
  } catch {
    if (link === mine) {
      link.state = 'offline';
      drawLink();
    }
    return;
  }
  if (link !== mine) return;
  if ('page' in got) {
    link.page = got.page;
    link.state = 'shown';
  } else link.state = 'gone' in got ? 'gone' : 'broken';
  drawLink();
}

async function answerLink(says) {
  if (!link?.page || link.busy) return;
  const name = ($('#planName')?.value || '').trim();
  if (!name) {
    toast('Write your name first, so they know who answered.');
    $('#planName')?.focus();
    return;
  }
  link.busy = true;
  const mine = link;
  try {
    await P.reply(mine.ref, mine.page, says, name);
    link = null;
    closeSheet();
    after();
    toast(says === 'yes' ? "You're in. It's in your calendar, marked as shared with you." : `Told ${mine.page.host || 'them'} you can't make it.`);
  } catch (err) {
    mine.busy = false;
    toast(P.problem(err));
    drawLink();
  }
}

// ---------- Open a plan link

function pasteHTML() {
  return `<div class="plan-paste">
    <p class="kicker">Your calendar</p><h2 class="display sheet-title">Open a plan link</h2>
    <p class="muted small">Someone sent you a plan from Arise? Paste the link here to answer it.</p>
    <form data-form="plan-paste"><label class="field"><span class="k">Link</span><input id="planPaste" type="url" autocomplete="off" placeholder="https://…#plan=…"></label>
    <button class="btn primary small" type="submit">Open</button></form>
  </div>`;
}

// ---------- taps

let after = () => {}; // the calendar's repaint
export const setAfter = (fn) => (after = fn);

async function guarded(job, done) {
  try {
    await job();
    if (done) toast(done);
  } catch (err) {
    toast(P.problem(err));
  }
}

async function copyLink() {
  const input = $('#planLinkIn');
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
    toast('Link copied.');
  } catch {
    input.focus();
    input.select();
    toast('Copy the link from the box.');
  }
}

function message(e) {
  return `${e.title}, ${L.whenOf(pageOfEvent(e))}${e.location ? `, ${e.location}` : ''}.`;
}

async function sendLink(e) {
  const url = linkTo(e.plan);
  const text = `${message(e)} Say if you can come:`;
  try {
    if (N.canShareLink()) await N.shareLink({ title: e.title, text, url });
    else await navigator.share({ title: e.title, text, url });
  } catch (err) {
    if (err?.name !== 'AbortError') void copyLink();
  }
}

function emailLink(e) {
  const to = (e.guests || []).filter(EV.isEmail);
  const body = `${message(e)}\n\nSay if you can come: ${linkTo(e.plan)}`;
  try {
    globalThis.location.href = `mailto:${to.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(e.title)}&body=${encodeURIComponent(body)}`;
  } catch {}
}

// True when it was one of these.
export function handleAction(act, el) {
  const d = el?.dataset || {};
  const e = d.id ? S.state.events[d.id] : null;
  switch (act) {
    case 'plan-start':
      if (!syncStatus.user) {
        toast('Planning with someone needs an account. Make one, or sign in, under Settings, Account.');
        return true;
      }
      el.disabled = true;
      void guarded(async () => {
        await P.start(d.id);
        redraw(d.id);
        after();
      }, 'Link made. Send it to the people you mean.');
      return true;
    case 'plan-send':
      if (e?.plan) void sendLink(e);
      return true;
    case 'plan-copy':
      void copyLink();
      return true;
    case 'plan-email':
      if (e?.plan) emailLink(e);
      return true;
    case 'plan-tell':
      void tellNow(d.id);
      return true;
    case 'plan-stop':
      if (!confirm('Stop sharing? The link stops working for good. Their copy stays in their calendar as theirs.')) return true;
      void guarded(async () => {
        await P.stop(d.id);
        redraw(d.id);
        after();
      }, 'Sharing stopped. The link no longer works.');
      return true;
    case 'plan-mine': {
      const name = yourName(e) || prompt('Your name, so they know who answered:') || '';
      if (!name.trim()) return true;
      void guarded(async () => {
        await P.changeAnswer(d.id, d.v === 'yes' ? 'yes' : 'no', name);
        redraw(d.id);
        after();
      }, d.v === 'yes' ? "Told them you're in." : "Told them you can't make it.");
      return true;
    }
    case 'plan-leave':
      if (!confirm('Stop sharing? Their changes stop coming in, and the event stays in your calendar as yours.')) return true;
      void guarded(async () => {
        await P.leave(d.id, yourName(e));
        redraw(d.id);
        after();
      }, 'Stopped. It stays in your calendar as yours.');
      return true;
    case 'plan-answer':
      void answerLink(d.v === 'yes' ? 'yes' : 'no');
      return true;
    case 'plan-retry':
      if (link) {
        link.state = 'loading';
        drawLink();
        void load();
      }
      return true;
    case 'plan-paste':
      openSheet(pasteHTML());
      $('#planPaste')?.focus();
      return true;
    default:
      return false;
  }
}

globalThis.document?.addEventListener('submit', (ev) => {
  if (ev.target?.dataset?.form !== 'plan-paste') return;
  ev.preventDefault();
  const text = $('#planPaste')?.value || '';
  if (!L.parsePlanLink(text)) {
    toast("That isn't a plan link. It has #plan= in it.");
    return;
  }
  takeLink(text);
});

// Answers and changes come in while the calendar is open, and when Arise comes back to the front.
export function refresh(force = false) {
  void P.refresh({ force })
    .then((changed) => {
      if (changed) after();
    })
    .catch(() => {});
}
globalThis.document?.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && document.body?.dataset.view === 'calendar') refresh();
});

export function _reset() {
  link = null;
  P._reset();
}
