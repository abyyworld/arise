// Arise as "me" for other apps, on screen, in What Arise knows (me.ts does the work):
//   - About me: a short text from what Arise knows, which the Player picks, reads, changes and
//     copies into any AI app.
//   - Connected apps: one private me link per app, which keeps the app up to date with only what
//     the Player picked. What each gets, when it was updated, and turning it off.
// Nothing leaves the device until the Player copies, shares or makes a link.

import * as M from './memory';
import * as ME from '../me';
import * as SYNC from '../sync';
import * as N from '../native.js';
import { ABOUT_SECTIONS, SECTIONS, SECTION_LABELS, TIER_LABELS, TIER_TEXT, ABOUT_MAX, LINK_DEFAULT, HOUSE_MAX, HOUSE_PICKS, RULE_ADDS, RULE_TOPICS, aboutText, bodyOf, buildMe, choiceText, cleanRules, fitMe, meLink, ruleOf, rulesText } from '../lib/me';
import { SITE_URL } from '../lib/pages';
import { meHTML, exactHTML } from '../me-html';
import { esc, icon, openSheet, closeSheet, toast } from '../ui.js';
import { TOOL_WORDS, WANT_WORDS } from '../lib/feed';
import { FILE_MAX, SAVE_MAX } from '../lib/me-files';
import { hasLifeStore } from './store-port';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;

const KEEPS = "The app you give this link to can read what's in it and keep a copy.";
const SEALED = "It's end-to-end encrypted: the key is in the link, so nobody else can read it, not the people who run Arise and not Google, who host it.";
const DOCS = 'https://github.com/abyyworld/arise/blob/main/docs/ME-LINK.md';
const MCP = 'https://github.com/abyyworld/arise/blob/main/mcp/README.md';
const WEB_HOW = 'https://github.com/abyyworld/arise/blob/main/mcp/README.md#claude-chatgpt-and-gemini-on-the-web';

// Before the web connector can be turned on for an app: what it costs, in plain words.
export const WEB_WHY = [
  "Claude, ChatGPT and Gemini on the web can't open your link themselves. So this app gets an address of its own, and Arise's connector, a small server Arise runs on Cloudflare, opens it for a moment each time the app asks, and hands the app what it needs.",
  'While it does, that server and Cloudflare could read what this app gets. And the AI company (like Anthropic, OpenAI or Google) gets what its app reads, as with anything you tell it.',
  "The connector keeps none of it. It keeps only a log of what the app did, and any notes or files it adds, sealed so only your Arise can read them, until your Arise picks them up.",
  'Everything else in Arise stays end-to-end encrypted. You can turn this off any time, and the address stops working for good.',
];
const LESS = '<span class="tag less">Less private</span>';
const DAY_MS = 86_400_000;
const ENDS = [
  [7, 'A week'],
  [30, 'A month'],
  [0, 'No end'],
];
const whenDay = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

// Where an app's link points: this page's own address on the web; in the iPhone app, whose pages
// are only on the phone, the website.
const linkTo = (l) => meLink(N.isNative ? __APP_UPDATE_SITE__ || SITE_URL : `${location.origin}${location.pathname}`, l);
const canSend = () => N.canShareLink() || typeof navigator.share === 'function';
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function picksHTML(c, sections, act) {
  return `<p class="label">What goes in</p>
    <div class="chips" role="group" aria-label="What goes in">${sections
      .map((s) => {
        const on = c.sections.includes(s);
        return `<button class="chip ${on ? 'on' : ''}" data-act="${act}-sec" data-s="${s}" aria-pressed="${on}">${esc(SECTION_LABELS[s])}</button>`;
      })
      .join('')}</div>
    <p class="label">How private</p>
    <div class="seg" role="group" aria-label="How private">${[1, 2, 3]
      .map((t) => `<button class="${c.tier === t ? 'on' : ''}" data-act="${act}-tier" data-t="${t}" aria-pressed="${c.tier === t}">${TIER_LABELS[t]}</button>`)
      .join('')}</div>
    <p class="muted small">${esc(TIER_TEXT[c.tier])}</p>`;
}

const toggled = (c, s) => ({ ...c, sections: c.sections.includes(s) ? c.sections.filter((x) => x !== s) : [...c.sections, s] });

// =====================================================================
// About me
// =====================================================================

// The words as the Player changed them, kept until what goes in changes, and the words this put
// in the box last (anything else there was typed or pasted, and stays).
const about = { edited: false, text: '', shown: '' };

const aboutNow = () => (about.edited ? about.text : M.isLoaded() ? aboutText(ME.sourceNow(), ME.aboutChoice()) : '');
const countText = (n) => `${n.toLocaleString()} ${n === 1 ? 'character' : 'characters'}.${n > ABOUT_MAX ? ` ChatGPT takes up to ${ABOUT_MAX.toLocaleString()}.` : ''}`;

export function aboutPanel() {
  const text = aboutNow();
  about.shown = text;
  return `<section class="panel" id="aboutMe">
    <div class="panel-title">${icon('note')}<span>About me, for any app</span></div>
    <p class="small">Tell an AI app about yourself. Pick what goes in, read it, change any words, then copy it.</p>
    ${picksHTML(ME.aboutChoice(), ABOUT_SECTIONS, 'me-about')}
    <label class="field"><span class="k">Your About me</span><textarea id="aboutMeText" class="log-text" rows="10" maxlength="4000" placeholder="${M.isLoaded() ? 'Nothing to say yet. Pick more above, or add facts about you.' : 'Reading…'}">${esc(text)}</textarea></label>
    <p class="muted small" id="aboutMeCount">${countText(text.length)}</p>
    <div class="row">
      <button class="btn primary small" data-act="me-about-copy">Copy</button>
      ${canSend() ? '<button class="btn ghost small" data-act="me-about-share">Share…</button>' : ''}
    </div>
    <p class="label">Where to paste it</p>
    <ul class="changes small">
      <li><b>ChatGPT:</b> Settings, Personalization, Custom instructions.</li>
      <li><b>Claude:</b> Settings, Profile.</li>
      <li><b>Any AI app:</b> its "about you" field.</li>
    </ul>
    <p class="muted small life-note">Nothing leaves Arise until you copy or share it.</p>
  </section>`;
}

// After the memory is read, or changes: the text catches up, unless the Player is changing it.
function fillAbout({ force = false } = {}) {
  if (force) about.edited = false;
  const box = $('#aboutMeText');
  if (!box || (!force && (about.edited || box.value !== about.shown || globalThis.document.activeElement === box))) return;
  box.value = about.shown = aboutNow();
  const count = $('#aboutMeCount');
  if (count) count.textContent = countText(box.value.length);
}

// What goes in changed: the words start again from it.
function repaintAbout() {
  about.edited = false;
  if (typeof document === 'undefined') return; // (it can come after the page is gone)
  const el = $('#aboutMe');
  if (el) el.outerHTML = aboutPanel();
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
    return true;
  } catch {
    return false;
  }
}

async function send({ title, text, url }) {
  try {
    if (N.canShareLink()) await N.shareLink({ title, text, url });
    else await navigator.share(url ? { title, text, url } : { title, text });
    return true;
  } catch (err) {
    return err?.name === 'AbortError';
  }
}

// =====================================================================
// Connected apps
// =====================================================================

export function appsPanel() {
  return `<section class="panel" id="meApps">
    <div class="panel-title">${icon('share')}<span>Connected apps</span></div>
    <p class="small">Give an app its own private link to you, like a buddy app or an AI assistant. It always has your latest, and only what you pick. You can turn it off any time.</p>
    ${(() => {
      const idle = ME.lastIdleOff();
      return idle ? `<p class="small notice">Turned off on the web after ${ME.IDLE_DAYS} days without use: ${esc(idle.apps.join(', '))}. Turn it on again any time.</p>` : '';
    })()}
    <div id="meAppList">${appListHTML()}</div>
    <button class="btn primary block" data-act="me-connect">${icon('share')} Connect an app</button>
    <p class="muted small life-note">${esc(KEEPS)}</p>
  </section>`;
}

function statusLine(l) {
  const err = ME.note(l.id);
  if (err) return `<p class="error small">Couldn't update it: ${esc(err)}</p>`;
  return l.sent ? `<p class="muted small">Updated ${esc(when(l.sent))}</p>` : '';
}

// On the web or not, and when the app last did something there.
function webLine(l) {
  if (!l.web) return '';
  const last = ME.feedOf(l.id).at(-1);
  const ended = !ME.webNow(l);
  const w = l.web;
  const may = [w.read === false ? "doesn't read about you" : '', w.notes ? 'may add notes and to-dos' : '', w.fread ? 'may read your shared files' : '', w.fwrite ? 'may save files' : ''].filter(Boolean);
  return `<p class="muted small">${ended ? `On the web${w.until ? ` until ${esc(whenDay(w.until))}` : ''}, now ended.` : `On the web${w.until ? ` until ${esc(whenDay(w.until))}` : ''}${may.length ? `, ${may.join(', ')}` : ''}.`}${last ? ` Last used ${esc(when(last.at))}.` : ''}</p>`;
}

// What an app on the web may do, in a sentence.
function mayText(w) {
  const can = [w.read !== false ? 'read what you picked' : '', w.notes ? 'add notes and to-dos' : '', w.fread ? 'read the files in your shared folder' : '', w.fwrite ? (w.fread ? 'save files there' : 'save files in your shared folder') : ''].filter(Boolean);
  if (!can.length) return 'It may do nothing yet. Turn on what it may do below.';
  if (can.length === 1 && w.read !== false) return 'It only reads.';
  return `It may ${can.length > 1 ? `${can.slice(0, -1).join(', ')} and ${can.at(-1)}` : can[0]}.`;
}

// One line of the access log, in plain words: "Claude read your goals", "ChatGPT saved a file: “list.md”".
function logLine(e, app) {
  const what = e.tool === 'ask' ? `asked to ${WANT_WORDS[e.want] || 'add something'}` : TOOL_WORDS[e.tool];
  const words = e.file?.name || e.note || '';
  return `<span class="muted">${esc(when(e.at))}</span> ${esc(e.client || app)} ${esc(what)}${e.ok ? '' : ' (refused)'}${words ? `: “${esc(words.length > 120 ? `${words.slice(0, 119)}…` : words)}”` : ''}`;
}

// =====================================================================
// Rules for one app, and what it asked to add
// =====================================================================

const RULE_LABELS = {
  note: 'Add a note to your day',
  todo: 'Add a to-do',
  file: 'Save a file in your shared folder',
  health: 'Read anything about your health',
  money: 'Read anything about your money',
};
const RULE_CHOICES = [
  ['yes', 'May just do'],
  ['ask', 'Ask me first'],
  ['never', 'Never'],
];
const NEEDS_UPDATE = "Needs the connector update. Until then, AI apps on the web don't get your house rules, but Arise still keeps back what they may never read, and checks what they add against your rules.";
const short = (t, n = 120) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const dayWords = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

// What apps asked to add, each with Allow and Don't.
function asksHTML(l) {
  const list = ME.asksFor(l.id);
  if (!list.length) return '';
  return `<ul class="me-asks">${list
    .map(
      (a) => `<li class="me-ask">
      <p class="small"><b>${esc(a.client || l.app)} wants to:</b> ${WANT_WORDS[a.want]} “${esc(short(a.text))}”${a.day ? ` for ${esc(dayWords(a.day))}` : ''}</p>
      <div class="fact-acts">
        <button class="link" data-act="me-ask-allow" data-k="${esc(ME.askKey(a))}">Allow</button>
        <button class="link danger-link" data-act="me-ask-no" data-k="${esc(ME.askKey(a))}">Don't</button>
      </div>
    </li>`,
    )
    .join('')}</ul>`;
}

const updateLine = (l) => (ME.needsConnectorUpdate(l) ? `<p class="error small">${esc(NEEDS_UPDATE)}</p>` : '');

// The rules part of one app's sheet.
function rulesHTML(l, user, busy) {
  return `<div class="me-rules">
    <p class="label">Rules for this app</p>
    <p class="small">${esc(rulesText(l.rules))}</p>
    ${updateLine(l)}
    ${asksHTML(l)}
    ${user ? `<button class="btn ghost small" data-act="me-rules-edit" ${busy}>Change the rules</button>` : ''}
  </div>`;
}

// Changing them: a choice for each thing, and the house rules in their own words.
function rulesEditHTML(l, r) {
  const seg = (a, choices) =>
    `<p class="small">${esc(RULE_LABELS[a])}</p><div class="seg" role="group" aria-label="${esc(RULE_LABELS[a])}">${choices
      .map(([v, t]) => {
        const on = ruleOf(r, a) === v;
        return `<button class="${on ? 'on' : ''}" data-act="me-rule" data-a="${a}" data-v="${v}" aria-pressed="${on}">${t}</button>`;
      })
      .join('')}</div>`;
  const adds = !!l.web && !l.web.off && (l.web.notes || l.web.fwrite);
  return `<p class="label">Rules for this app</p>
    <p class="small">Pick what ${esc(l.app)} may just do, must ask you about first, or may never do. Arise and its connector keep to these.</p>
    <p class="label">Adding things</p>
    ${RULE_ADDS.map((a) => seg(a, RULE_CHOICES)).join('')}
    <p class="muted small">${adds ? '<b>Ask me first:</b> Arise shows you what it wants to add, and adds it only when you tap Allow.' : 'It can only add things on the web, once you let it add notes and to-dos, or save files, there.'}</p>
    <p class="label">Reading</p>
    ${RULE_TOPICS.map((a) => seg(a, [RULE_CHOICES[0], RULE_CHOICES[2]])).join('')}
    <p class="muted small"><b>Never</b> leaves out facts, goals, quests and days about it.</p>
    <label class="field"><span class="k">House rules</span><textarea id="meHouse" class="log-text" rows="4" maxlength="${HOUSE_MAX}" placeholder="Don't mention my exams unless I ask.">${esc(r?.house || '')}</textarea></label>
    <p class="muted small">In your words. The app gets them with every answer.</p>
    <div class="chips" role="group" aria-label="Add a house rule">${HOUSE_PICKS.map((t, i) => `<button class="chip" data-act="me-rule-pick" data-i="${i}">${esc(t)}</button>`).join('')}</div>`;
}

const RULES_NONE = () => ({ ask: [], never: [], house: '' });

function appListHTML() {
  const list = ME.links();
  if (!list.length) return '<p class="muted small">No apps connected yet.</p>';
  return `<ul class="fact-list me-apps">${list
    .map(
      (l) => `<li class="fact">
      <p class="fact-text">${esc(l.app)}</p>
      <p class="muted small">Gets: ${esc(choiceText(l.choice))}</p>
      ${l.rules ? `<p class="muted small">Rules: ${esc(rulesText(l.rules))}</p>` : ''}
      ${webLine(l)}
      ${updateLine(l)}
      ${asksHTML(l)}
      ${statusLine(l)}
      <div class="fact-acts">
        <button class="link" data-act="me-app" data-id="${esc(l.id)}">See what it gets</button>
        <button class="link" data-act="me-app-new" data-id="${esc(l.id)}">New link</button>
        <button class="link danger-link" data-act="me-app-off" data-id="${esc(l.id)}">Turn off</button>
      </div>
    </li>`,
    )
    .join('')}</ul>`;
}

function repaintApps() {
  if (typeof document === 'undefined') return;
  const el = $('#meAppList');
  if (el) el.innerHTML = appListHTML();
}

// Called with the rest of What Arise knows, once the memory is read and after it changes. The
// sheet's preview catches up too, unless the Player is typing in it.
export function fillMe() {
  fillAbout();
  repaintApps();
  if (!sheet?.el?.contains(globalThis.document.activeElement)) repaintSheet();
}

// ---------- the sheet: connecting an app, and one app's link

// mode: 'new' (picking for a new app), 'view' (one app's link), 'edit' (changing what it gets).
let sheet = null;

function needsAccount() {
  if (!SYNC.configured) return '<p>Connecting an app needs the cloud, and this copy of Arise has none set up.</p>';
  if (SYNC.status.user) return '';
  if (SYNC.status.loading) return '<p>Your account is still loading. Try again in a moment.</p>';
  return `<p><b>Connecting an app needs an account</b>, since the link's page is kept in the cloud. Make one, or sign in, under Settings, Account.</p>
    <button class="btn primary block" data-act="nav" data-v="settings">Go to Account</button>`;
}

// What the app gets is what's left once it's trimmed to fit in a page (lib/me.ts sealMe). That's
// measured in the background (it seals it); until then, and nearly always, it's all of it.
const TRIMMED = "That's too much for one link, so the app gets less: the oldest days are left out first, then the facts Arise is least sure of. Pick less to send it all.";
const fits = new Map(); // what a payload says (bodyOf) -> { payload, trimmed }
const measuring = new Set();

function measure(body, p) {
  if (measuring.has(body)) return;
  measuring.add(body);
  fitMe(p)
    .then((fit) => {
      if (fits.size > 20) fits.clear();
      fits.set(body, fit);
      if (fit.trimmed) repaintPreview();
    })
    .catch(() => {})
    .finally(() => measuring.delete(body));
}

function previewHTML(choice, rules) {
  if (!M.isLoaded()) return '<p class="muted small">Reading…</p>';
  const p = buildMe(ME.sourceNow(), choice, Date.now(), null, rules);
  const body = bodyOf(p);
  const fit = fits.get(body);
  if (!fit) measure(body, p);
  const shown = fit ? { ...fit.payload, updated: p.updated } : p;
  return `<div class="me-preview">${fit?.trimmed ? `<p class="error small">${esc(TRIMMED)}</p>` : ''}${meHTML(shown)}${exactHTML(shown)}</div>`;
}

// Only the preview, so what's being typed in the sheet stays as it is.
function repaintPreview() {
  const el = sheet?.el?.isConnected ? $('.me-preview', sheet.el) : null;
  if (!el) return;
  const l = sheet.mode === 'new' ? null : ME.links().find((x) => x.id === sheet.id);
  el.outerHTML = previewHTML(l && sheet.mode === 'view' ? l.choice : sheet.choice, l?.rules);
}

function sheetHTML() {
  const head = (title) => `<div class="me-sheet"><p class="kicker">Connected apps</p><h2 class="display sheet-title">${esc(title)}</h2>`;
  const error = sheet.error ? `<p class="error small">${esc(sheet.error)}</p>` : '';
  const busy = sheet.busy ? 'disabled' : '';
  if (sheet.mode === 'new') {
    const blocked = needsAccount();
    return `${head('Connect an app')}
      <p>Make a private link for one app. It reads only what you pick here, and gets your changes by itself. Make one link for each app, so you can turn each off on its own.</p>
      <label class="field"><span class="k">Which app</span><input id="meAppName" type="text" maxlength="40" autocomplete="off" placeholder="My buddy app" value="${esc(sheet.app)}"></label>
      ${picksHTML(sheet.choice, SECTIONS, 'me')}
      <p class="label">What it gets now</p>
      ${previewHTML(sheet.choice)}
      <p class="muted small">${esc(KEEPS)} ${esc(SEALED)}</p>
      ${blocked || `<button class="btn primary block" data-act="me-make" ${busy}>${sheet.busy ? 'Making the link…' : 'Make the link'}</button>`}
      ${error}</div>`;
  }
  const l = ME.links().find((x) => x.id === sheet.id);
  // Gone from the list: turned off, or (New link said why) another account's, waiting for it.
  if (!l) return sheet.error ? `${head(sheet.app)}${error}</div>` : `${head('Turned off')}<p>This link was turned off.</p></div>`;
  const user = SYNC.status.user;
  if (sheet.mode === 'web') {
    const w = sheet.web;
    return `${head(l.app)}
      <p class="label">Use it on the web ${LESS}</p>
      ${WEB_WHY.map((t) => `<p class="small">${esc(t)}</p>`).join('')}
      ${webPicksHTML(w)}
      <div class="row">
        <button class="btn primary small" data-act="me-web-on" ${busy}>${sheet.busy ? 'Turning it on…' : 'Turn it on'}</button>
        <button class="btn ghost small" data-act="me-app" data-id="${esc(l.id)}">Cancel</button>
      </div>
      ${error}</div>`;
  }
  if (sheet.mode === 'rules') {
    return `${head(l.app)}
      ${rulesEditHTML(l, sheet.rules)}
      <div class="row">
        <button class="btn primary small" data-act="me-rules-save" ${busy}>${sheet.busy ? 'Saving…' : 'Save'}</button>
        <button class="btn ghost small" data-act="me-app" data-id="${esc(l.id)}">Cancel</button>
      </div>
      ${error}</div>`;
  }
  if (sheet.mode === 'edit') {
    return `${head(l.app)}
      ${picksHTML(sheet.choice, SECTIONS, 'me')}
      <p class="label">What it gets now</p>
      ${previewHTML(sheet.choice, l.rules)}
      <div class="row">
        <button class="btn primary small" data-act="me-app-save" ${busy}>${sheet.busy ? 'Saving…' : 'Save'}</button>
        <button class="btn ghost small" data-act="me-app" data-id="${esc(l.id)}">Cancel</button>
      </div>
      ${error}</div>`;
  }
  return `${head(l.app)}
    <p>Give this link to ${esc(l.app)}. It updates by itself after your changes${user ? '' : ', whenever you are signed in'}.</p>
    <label class="field"><span class="k">Link</span><input id="meLinkIn" type="text" readonly value="${esc(linkTo(l))}"></label>
    <div class="row">
      <button class="btn primary small" data-act="me-link-copy">Copy link</button>
      ${canSend() ? '<button class="btn ghost small" data-act="me-link-send">Share…</button>' : ''}
    </div>
    <p class="muted small">${esc(KEEPS)} Keep the link private, like a password.</p>
    <p class="small">Making an app? <a href="${DOCS}" target="_blank" rel="noopener">How to read the link ${icon('ext')}</a>. For Claude Desktop and other AI apps: <a href="${MCP}" target="_blank" rel="noopener">the Arise MCP server ${icon('ext')}</a>.</p>
    <p class="label">What it gets now</p>
    <p class="muted small">${esc(choiceText(l.choice))}</p>
    ${previewHTML(l.choice, l.rules)}
    ${statusLine(l)}
    ${rulesHTML(l, user, busy)}
    ${webHTML(l, user, busy)}
    ${error}
    ${
      user
        ? `<div class="row">
      <button class="btn ghost small" data-act="me-app-edit" ${busy}>Change what it gets</button>
      <button class="btn ghost small" data-act="me-app-new" data-id="${esc(l.id)}" ${busy}>New link</button>
      <button class="btn ghost small danger" data-act="me-app-off" data-id="${esc(l.id)}" ${busy}>Turn off</button>
    </div>
    <p class="muted small"><b>New link</b> gives the app a new link, and the old one stops working for good. <b>Turn off</b> stops the link for good. The app keeps what it already read.</p>`
        : '<p class="small">Sign in, under Settings, Account, to change it or turn it off.</p>'
    }
    </div>`;
}

// What the app may do, a switch for each, and for how long it's on.
const NEEDS_FILES_UPDATE = "Needs the connector update. Until it's there, apps on the web can't read or save files.";
const kb = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.round(n / 1024)} KB`);
function switchRow(p, on, title, small, disabled = false) {
  return `<button class="toggle-row" data-act="me-web-perm" data-p="${p}" aria-pressed="${on}" ${disabled ? 'disabled' : ''}><span><b>${esc(title)}</b><small>${esc(small)}</small></span><span class="switch ${on ? 'on' : ''}"></span></button>`;
}
function webPicksHTML(w) {
  // Notes and files go into the life log and Photos and files: a build without them only reads.
  const life = hasLifeStore();
  const files = ME.connectorDoesFiles() === true;
  const folders = sheet?.folders || [];
  const dir = folders.find((f) => f.id === w.dir);
  const folderPick = !life
    ? ''
    : folders.length
      ? `<label class="field"><span class="k">Shared folder</span><select id="meWebDir" ${files ? '' : 'disabled'}>
          <option value="" ${dir ? '' : 'selected'}>Pick a folder</option>
          ${folders.map((f) => `<option value="${esc(f.id)}" ${f.id === w.dir ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
        </select></label>`
      : `<p class="muted small">${sheet?.folders ? 'You have no folders yet.' : 'Reading your folders…'}</p>`;
  return `<p class="label">What it may do</p>
    ${switchRow('read', w.read !== false, 'Read', 'What you picked above: your name, goals, facts and days.')}
    ${life ? switchRow('notes', !!w.notes, 'Add', 'A note to your day or a to-do on your list, when you ask it to. Marked with its name. It never changes or deletes anything.') : ''}
    ${
      life
        ? `${switchRow('fread', !!w.fread && !!dir, 'Read files', `Only the files in the one folder you pick below, up to ${kb(FILE_MAX)} each, sealed for this app. Nothing else of Photos and files.`, !files || !dir)}
    ${switchRow('fwrite', !!w.fwrite && !!dir, 'Save files', `A file into that folder, up to ${kb(SAVE_MAX)}, when you ask it to. Your rules apply.`, !files || !dir)}
    ${files ? '' : `<p class="error small">${esc(NEEDS_FILES_UPDATE)}</p>`}
    ${folderPick}
    ${folders.length || !files ? '' : '<button class="btn ghost small" data-act="me-web-mkdir">Make a folder for it</button>'}`
        : ''
    }
    <p class="label">For how long</p>
    <div class="seg" role="group" aria-label="For how long">${ENDS.map(([d, t]) => `<button class="${w.days === d ? 'on' : ''}" data-act="me-web-days" data-d="${d}" aria-pressed="${w.days === d}">${t}</button>`).join('')}</div>`;
}

// The web part of one app's sheet: off, with a way to turn it on, or on, with the address to give
// the app, its settings and what it did.
function webHTML(l, user, busy) {
  const ready = ME.connectorReady();
  if (!l.web) {
    if (!ready || !user) return '';
    return `<div class="me-web">
      <p class="label">Use it on the web ${LESS}</p>
      <p class="small">Let Claude, ChatGPT or Gemini on the web read what this app gets, through Arise's connector. Off until you turn it on, and off again by itself after 60 days without use.</p>
      <button class="btn ghost small" data-act="me-web-explain" ${busy}>Use it on the web…</button>
    </div>`;
  }
  const live = ME.webNow(l);
  const reach = ME.connectorReachable();
  const log = ME.feedOf(l.id).slice(-10).reverse();
  const days = l.web.until ? null : 0;
  return `<div class="me-web">
    <p class="label">On the web ${LESS}</p>
    <p class="small">${live ? `On${l.web.until ? ` until ${esc(whenDay(l.web.until))}` : ', with no end date'}. ${mayText(l.web)}` : `Ended${l.web.until ? ` on ${esc(whenDay(l.web.until))}` : ''}, and its address no longer works. Pick for how long below to turn it on again, with a new address.`}</p>
    ${reach === false ? '<p class="error small">The connector isn\'t answering right now, so AI apps on the web can\'t reach this yet. It works as soon as it does.</p>' : ''}
    <label class="field"><span class="k">Connector address</span><input id="meWebIn" type="text" readonly value="${esc(ME.connectorAddress(l))}"></label>
    <div class="row"><button class="btn primary small" data-act="me-web-copy">Copy address</button></div>
    <ul class="small me-web-how">
      <li><b>Claude</b> (claude.ai): Settings, Connectors, Add custom connector. Paste the address.</li>
      <li><b>ChatGPT</b>: Settings, Apps and connectors, Advanced settings, turn on Developer mode. Then Create, paste the address, and pick No authentication.</li>
      <li><b>Gemini and other apps</b>: anywhere that takes an MCP server address.</li>
    </ul>
    <p class="muted small">Keep the address private, like a password. <a href="${WEB_HOW}" target="_blank" rel="noopener">More help ${icon('ext')}</a></p>
    ${user ? webPicksHTML({ ...l.web, days: sheet.webDays ?? days }) : ''}
    <p class="label">What it did</p>
    ${log.length ? `<ul class="fact-list me-web-log">${log.map((e) => `<li class="small">${logLine(e, l.app)}</li>`).join('')}</ul>` : '<p class="muted small">Nothing yet.</p>'}
    <div class="row">
      <button class="link" data-act="me-web-check">Check now</button>
      ${user ? `<button class="link danger-link" data-act="me-web-off" ${busy}>Turn off on the web</button>` : ''}
    </div>
  </div>`;
}

function showSheet(next) {
  sheet = next;
  openSheet(sheetHTML());
  sheet.el = $('#sheet .sheet-body .me-sheet');
}

// Only while this sheet is the one showing. What's typed in the app's name stays.
function repaintSheet() {
  if (!sheet?.el?.isConnected) return;
  const name = $('#meAppName', sheet.el);
  if (name) sheet.app = name.value;
  const house = $('#meHouse', sheet.el);
  if (house && sheet.rules) sheet.rules.house = house.value;
  const body = sheet.el.parentElement;
  body.innerHTML = sheetHTML();
  sheet.el = $('.me-sheet', body);
}

function openApp(id, mode = 'view') {
  const l = ME.links().find((x) => x.id === id);
  if (!l) return;
  showSheet({ mode, id, app: l.app, choice: l.choice, busy: false, error: '', web: { notes: false, days: 30 } });
  if (l.web) {
    void ME.checkConnector().then(repaintSheet);
    void ME.pullFeeds({ force: true });
    loadFolders();
  }
}

// The folders in Photos and files, for picking the one an app on the web shares.
function loadFolders() {
  if (!hasLifeStore()) return;
  const mine = sheet;
  Promise.all([import('./files'), import('./files-tree')])
    .then(async ([F, T]) => {
      const tree = await F.listFolders();
      if (sheet !== mine) return;
      mine.folders = T.folderChoices(tree.dirs).map(({ id, label }) => ({ id, label }));
      if (!mine.busy) repaintSheet();
    })
    .catch(() => {});
}

// A switch changed: on the sheet before the web is on, or straight away once it is.
async function setPerm(p, on) {
  const l = sheet && ME.links().find((x) => x.id === sheet.id);
  if (!l) return;
  const key = p === 'notes' ? 'notes' : p;
  if (sheet.mode === 'web') {
    sheet.web = { ...sheet.web, [key]: on };
    repaintSheet();
    return;
  }
  if (!l.web) return;
  await busy(async (s) => {
    await ME.setWeb(s.id, { notes: l.web.notes && hasLifeStore(), ...(l.web.until ? { until: l.web.until } : {}), [key]: on });
    toast(PERM_SAID[p][on ? 1 : 0](l.app));
  });
}
const PERM_SAID = {
  read: [(a) => `${a} can't read about you now.`, (a) => `${a} may read what you picked.`],
  notes: [(a) => `${a} can't add notes or to-dos now.`, (a) => `${a} may add notes and to-dos now.`],
  fread: [(a) => `${a} can't read your files now.`, (a) => `${a} may read the files in that folder now.`],
  fwrite: [(a) => `${a} can't save files now.`, (a) => `${a} may save files in that folder now.`],
};

ME.onFeed(() => {
  repaintApps();
  if (sheet?.mode === 'view' && !sheet.busy) repaintSheet();
});

const untilFor = (days) => (days ? Date.now() + days * DAY_MS : 0);

async function busy(fn) {
  if (!sheet || sheet.busy) return;
  const mine = sheet;
  mine.busy = true;
  mine.error = '';
  repaintSheet();
  try {
    await fn(mine);
  } catch (err) {
    mine.error = ME.problem(err);
  }
  mine.busy = false;
  if (sheet === mine) repaintSheet();
  repaintApps();
}

// =====================================================================
// Taps
// =====================================================================

export async function handleAction(act, el) {
  const d = el.dataset;
  switch (act) {
    case 'me-about-sec':
      ME.setAboutChoice(toggled(ME.aboutChoice(), d.s));
      repaintAbout();
      return true;
    case 'me-about-tier':
      ME.setAboutChoice({ ...ME.aboutChoice(), tier: Number(d.t) });
      repaintAbout();
      return true;
    case 'me-about-copy': {
      const box = $('#aboutMeText');
      if (!box?.value.trim()) {
        toast('Nothing to copy yet.');
        return true;
      }
      if (!(await copyText(box.value, 'Copied. Paste it into the app.'))) {
        box.focus();
        box.select();
        toast('Copy the text from the box.');
      }
      return true;
    }
    case 'me-about-share': {
      const text = $('#aboutMeText')?.value || '';
      if (text.trim() && !(await send({ title: 'About me', text }))) await copyText(text, 'Copied. Paste it into the app.');
      return true;
    }
    case 'me-connect':
      showSheet({ mode: 'new', app: '', choice: { ...LINK_DEFAULT, sections: [...LINK_DEFAULT.sections] }, busy: false, error: '' });
      M.load()
        .then(repaintSheet)
        .catch(() => {});
      return true;
    case 'me-sec':
      if (!sheet) return true;
      sheet.choice = toggled(sheet.choice, d.s);
      repaintSheet();
      return true;
    case 'me-tier':
      if (!sheet) return true;
      sheet.choice = { ...sheet.choice, tier: Number(d.t) };
      repaintSheet();
      return true;
    case 'me-make': {
      const name = ($('#meAppName')?.value || '').trim();
      if (!name) {
        toast('Give the app a name first, so you know which link is which.');
        $('#meAppName')?.focus();
        return true;
      }
      await busy(async (s) => {
        s.app = name;
        const l = await ME.connect(name, s.choice);
        Object.assign(s, { mode: 'view', id: l.id, choice: l.choice });
        toast('Link made. Copy it into the app.');
      });
      return true;
    }
    case 'me-app':
      openApp(d.id);
      return true;
    case 'me-app-edit':
      if (!sheet) return true;
      sheet.mode = 'edit';
      repaintSheet();
      return true;
    case 'me-app-save':
      await busy(async (s) => {
        await ME.setChoice(s.id, s.choice);
        s.mode = 'view';
        toast('Saved. The app gets this from now on.');
      });
      return true;
    case 'me-app-new': {
      const l = ME.links().find((x) => x.id === d.id);
      if (!l || !confirm(`Make a new link for ${l.app}? The old one stops working for good, so give the app the new one.`)) return true;
      if (!sheet?.el?.isConnected || sheet.id !== l.id) openApp(l.id);
      await busy(async (s) => {
        const next = await ME.newLink(l.id);
        if (next) s.id = next.id;
        toast('New link made. The old one no longer works.');
      });
      return true;
    }
    case 'me-app-off': {
      const l = ME.links().find((x) => x.id === d.id);
      if (!l || !confirm(`Turn off the link for ${l.app}? It stops working for good. The app keeps what it already read.`)) return true;
      try {
        await ME.turnOff(l.id);
        toast(`Turned off. ${l.app} can't read anything new.`);
      } catch (err) {
        toast(ME.problem(err)); // (another account's link waits for it, and this says so)
      }
      if (!ME.links().some((x) => x.id === l.id)) {
        if (sheet?.id === l.id && sheet.el?.isConnected) closeSheet();
        sheet = null;
      }
      repaintApps();
      return true;
    }
    case 'me-rules-edit': {
      const l = sheet && ME.links().find((x) => x.id === sheet.id);
      if (!l) return true;
      const r = l.rules || RULES_NONE();
      sheet.mode = 'rules';
      sheet.rules = { ask: [...r.ask], never: [...r.never], house: r.house };
      repaintSheet();
      return true;
    }
    case 'me-rule': {
      if (!sheet?.rules) return true;
      const a = d.a;
      const r = sheet.rules;
      r.ask = r.ask.filter((x) => x !== a);
      r.never = r.never.filter((x) => x !== a);
      if (d.v === 'ask' && RULE_ADDS.includes(a)) r.ask.push(a);
      if (d.v === 'never') r.never.push(a);
      repaintSheet();
      return true;
    }
    case 'me-rule-pick': {
      if (!sheet?.rules) return true;
      const box = $('#meHouse');
      if (box) sheet.rules.house = box.value;
      const pick = HOUSE_PICKS[Number(d.i)];
      const now = sheet.rules.house.trim();
      if (pick && !now.includes(pick)) sheet.rules.house = (now ? `${now}\n${pick}` : pick).slice(0, HOUSE_MAX);
      if (box) box.value = sheet.rules.house; // (the repaint keeps what's in the box)
      repaintSheet();
      return true;
    }
    case 'me-rules-save': {
      if (!sheet?.rules) return true;
      const box = $('#meHouse');
      if (box) sheet.rules.house = box.value;
      await busy(async (s) => {
        await ME.setRules(s.id, cleanRules(s.rules) || null);
        s.mode = 'view';
        toast('Saved. The app keeps to these rules from now on.');
      });
      return true;
    }
    case 'me-ask-allow':
      try {
        if (await ME.allowAsk(d.k)) toast('Allowed. Added.');
      } catch (err) {
        toast(ME.problem(err));
      }
      repaintApps();
      if (sheet?.mode === 'view') repaintSheet();
      return true;
    case 'me-ask-no':
      ME.dismissAsk(d.k);
      toast('Not added.');
      repaintApps();
      if (sheet?.mode === 'view') repaintSheet();
      return true;
    case 'me-web-explain':
      if (!sheet) return true;
      sheet.mode = 'web';
      sheet.web = { notes: false, days: 30 };
      repaintSheet();
      loadFolders();
      void ME.checkConnector().then(repaintSheet);
      return true;
    case 'me-web-perm': {
      if (!sheet || !['read', 'notes', 'fread', 'fwrite'].includes(d.p)) return true;
      const l = ME.links().find((x) => x.id === sheet.id);
      const w = sheet.mode === 'web' ? sheet.web : l?.web;
      if (!w) return true;
      const on = d.p === 'read' ? w.read === false : !w[d.p];
      await setPerm(d.p, on);
      return true;
    }
    case 'me-web-mkdir': {
      const l = sheet && ME.links().find((x) => x.id === sheet.id);
      if (!l) return true;
      try {
        const F = await import('./files');
        const id = await F.makeFolder(`For ${l.app}`);
        await setDir(id);
        loadFolders();
        toast(`Made the folder "For ${l.app}". Put the files ${l.app} may read in it.`);
      } catch (err) {
        toast(ME.problem(err));
      }
      return true;
    }
    case 'me-web-days': {
      if (!sheet) return true;
      const days = Number(d.d) || 0;
      if (sheet.mode === 'web') {
        sheet.web = { ...sheet.web, days };
        repaintSheet();
        return true;
      }
      const l = ME.links().find((x) => x.id === sheet.id);
      if (!l?.web) return true;
      await busy(async (s) => {
        const until = untilFor(days);
        await ME.setWeb(s.id, { notes: l.web.notes && hasLifeStore(), ...(until ? { until } : {}) });
        s.webDays = days;
        toast(until ? `On until ${whenDay(until)}.` : 'On with no end date.');
      });
      return true;
    }
    case 'me-web-on':
      await busy(async (s) => {
        const until = untilFor(s.web.days);
        const files = ME.connectorDoesFiles() === true && hasLifeStore() && s.web.dir;
        await ME.setWeb(s.id, {
          notes: s.web.notes && hasLifeStore(),
          ...(until ? { until } : {}),
          read: s.web.read !== false,
          ...(files ? { dir: s.web.dir, fread: !!s.web.fread, fwrite: !!s.web.fwrite } : {}),
        });
        s.mode = 'view';
        s.webDays = s.web.days;
        toast('On for the web. Copy the address into the app.');
        void ME.checkConnector().then(repaintSheet);
      });
      return true;
    case 'me-web-off': {
      const l = sheet && ME.links().find((x) => x.id === sheet.id);
      if (!l || !confirm(`Turn off ${l.app} on the web? Its address stops working for good, and the app keeps what it already read. The link itself keeps working where you gave it.`)) return true;
      await busy(async (s) => {
        await ME.setWeb(s.id, null);
        s.webDays = undefined;
        toast('Off on the web.');
      });
      return true;
    }
    case 'me-web-copy': {
      const input = $('#meWebIn');
      if (input && !(await copyText(input.value, 'Address copied. Paste it into the app.'))) {
        input.focus();
        input.select();
        toast('Copy the address from the box.');
      }
      return true;
    }
    case 'me-web-check':
      await ME.checkConnector();
      await ME.pullFeeds({ force: true });
      repaintSheet();
      return true;
    case 'me-link-copy': {
      const input = $('#meLinkIn');
      if (input && !(await copyText(input.value, 'Link copied.'))) {
        input.focus();
        input.select();
        toast('Copy the link from the box.');
      }
      return true;
    }
    case 'me-link-send': {
      const l = sheet && ME.links().find((x) => x.id === sheet.id);
      if (l && !(await send({ title: 'Arise', text: `My Arise link for ${l.app}`, url: linkTo(l) }))) await copyText(linkTo(l), 'Link copied.');
      return true;
    }
    default:
      return false;
  }
}

// The shared folder: on the sheet before the web is on, or straight away once it is. A new folder
// starts with nothing shared from it until the Player turns the file switches on.
async function setDir(dir) {
  const l = sheet && ME.links().find((x) => x.id === sheet.id);
  if (!l) return;
  if (sheet.mode === 'web') {
    sheet.web = { ...sheet.web, dir };
    repaintSheet();
    return;
  }
  if (!l.web) return;
  await busy(async (s) => {
    await ME.setWeb(s.id, { notes: l.web.notes && hasLifeStore(), ...(l.web.until ? { until: l.web.until } : {}), dir, ...(dir ? {} : { fread: false, fwrite: false }) });
    toast(dir ? `Shared folder set for ${l.app}.` : `${l.app} has no shared folder now.`);
  });
}

globalThis.document?.addEventListener('change', (e) => {
  if (e.target?.id === 'meWebDir') void setDir(e.target.value || '');
});

// Typing in the About me text keeps it as typed, until what goes in changes.
globalThis.document?.addEventListener('input', (e) => {
  if (e.target?.id !== 'aboutMeText') return;
  about.edited = true;
  about.text = e.target.value;
  const count = $('#aboutMeCount');
  if (count) count.textContent = countText(e.target.value.length);
});

// The memory or the log was wiped: nothing of it stays on screen.
export function forgetMeScreens() {
  about.text = '';
  sheet = null;
  fillAbout({ force: true });
}
