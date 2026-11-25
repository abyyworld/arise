// Your links (from Your days): the web addresses in your notes, journal and imported notes, and
// the pages you saved, each with where it came from and when. Search them, open them, save a new
// one, and keep a copy of a page to read later even if the site goes away. The work is in
// links.ts; the copy goes through Arise's fetch-only helper, which sees the page's address.

import '../styles/links.css';
import * as L from './log';
import * as LK from './links';
import { lifeStore } from './store-port';
import { CALENDAR } from '../calendar-config';
import { esc, icon, openSheet, closeSheet, toast } from '../ui.js';

export const VIEW = 'links';
const SHOWN = 200; // drawn at once; search finds the rest

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const ui = { items: null, query: '', error: '', busy: new Set(), token: 0, hooked: false, open: '' };

const helperOn = () => !!CALENDAR.server;
const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const onScreen = () => globalThis.document?.body?.dataset.view === VIEW && !!$('#lkList');

// ---------- the screen

export function renderLinks(root) {
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">Your days</p><h1 class="display">Your links</h1></div>
      <button class="btn small ghost" data-act="nav" data-v="days">${icon('back')} Your days</button>
    </header>
    <div class="cols">
      <div class="col">
        <section class="panel">
          <form class="lk-save" id="lkSave" autocomplete="off">
            <label class="label" for="lkUrl">Save a link</label>
            <input id="lkUrl" type="url" inputmode="url" maxlength="2000" placeholder="Paste an address, like https://…" required>
            <label class="sr-only" for="lkNote">A note, if you like</label>
            <input id="lkNote" type="text" maxlength="500" placeholder="A note, if you like">
            <button class="btn primary" type="submit">Save</button>
          </form>
        </section>
        <section class="panel">
          <form class="life-search" id="lkSearch" role="search" autocomplete="off">
            <label class="sr-only" for="lkQ">Search your links</label>
            <input id="lkQ" type="search" enterkeyhint="search" maxlength="200" placeholder="Search your links" value="${esc(ui.query)}">
            <button class="icon-btn send" type="submit" aria-label="Search">${icon('search')}</button>
          </form>
          <div id="lkList">${listHTML()}</div>
        </section>
      </div>
      <div class="col">
        <section class="panel small-print">
          <p class="small">The links in your notes, your journal and the notes you brought in, and the pages you saved here or with the Arise extension in your browser.</p>
          <p class="small">${
            helperOn()
              ? "Keep a copy fetches the page once through Arise's helper, so the helper sees that page's address (nothing else, and it keeps nothing). The copy is plain text, kept in your life log and synced sealed like the rest, so you can search it and read it even if the site goes away."
              : "Keep a copy needs Arise's helper, which isn't set up yet. Until then, nothing is fetched."
          }</p>
        </section>
      </div>
    </div>`;
  const save = $('#lkSave', root);
  save?.addEventListener('submit', (e) => {
    e.preventDefault();
    void saveLink();
  });
  const search = $('#lkSearch', root);
  search?.addEventListener('submit', (e) => e.preventDefault());
  $('#lkQ', root)?.addEventListener('input', (e) => {
    ui.query = e.target.value;
    paint();
  });
  hook();
  void fill();
}

function itemHTML(item) {
  const first = item.from[0];
  const more = item.from.length > 1 ? `, and ${plural(item.from.length - 1, 'more place')}` : '';
  const busy = ui.busy.has(item.url);
  return `<article class="lk-item">
    <a class="lk-title" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
    <p class="muted small lk-where">${esc(item.site)}. ${esc(first.where)}, ${esc(day(first.at))}${esc(more)}.</p>
    ${item.note ? `<p class="small lk-note">${esc(item.note.length > 300 ? `${item.note.slice(0, 299)}…` : item.note)}</p>` : ''}
    <div class="row">
      ${
        item.copy
          ? `<button class="btn small ghost" data-act="lk-read" data-u="${esc(item.url)}">${icon('note')} Read the copy</button><span class="muted small">Kept ${esc(day(item.copy.at))}</span>`
          : `<button class="btn small ghost" data-act="lk-copy" data-u="${esc(item.url)}" ${busy ? 'disabled' : ''}>${busy ? 'Keeping a copy…' : 'Keep a copy'}</button>`
      }
    </div>
  </article>`;
}

function listHTML() {
  if (ui.error) return `<p class="error small">${esc(ui.error)}</p>`;
  if (!ui.items) return '<div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Finding your links…</div>';
  if (!ui.items.length) return '<p class="muted small">No links yet. Paste one above, or write one in a note.</p>';
  const found = ui.items.filter((i) => LK.matches(i, ui.query));
  if (!found.length) return `<p class="muted small">No link has "${esc(ui.query.trim())}".</p>`;
  const head = `<p class="muted small">${ui.query.trim() ? `${plural(found.length, 'link')} found` : plural(found.length, 'link')}${found.length > SHOWN ? `. Showing the newest ${SHOWN}: search to find the rest` : ''}.</p>`;
  return head + found.slice(0, SHOWN).map(itemHTML).join('');
}

function paint() {
  const el = $('#lkList');
  if (el) el.innerHTML = listHTML();
}

async function fill() {
  const token = ++ui.token;
  try {
    const items = await LK.loadLinks();
    if (token !== ui.token) return;
    ui.items = items;
    ui.error = '';
  } catch (err) {
    if (token !== ui.token) return;
    ui.error = err?.message || "Your links couldn't be read.";
  }
  if (onScreen()) paint();
}

// The log changed (a note, a copy, something from another device): the list catches up.
function hook() {
  if (ui.hooked) return;
  ui.hooked = true;
  let t = null;
  L.onChange((c) => {
    if (c.type === 'clear') ui.items = null;
    clearTimeout(t);
    t = setTimeout(() => {
      if (onScreen()) void fill();
    }, 250);
  });
}

// ---------- saving a link

async function saveLink() {
  const url = $('#lkUrl');
  const note = $('#lkNote');
  const e = LK.savedLink({ url: url?.value || '', note: note?.value || '', at: Date.now() });
  if (!e) {
    toast("That doesn't look like a web address. It should start with https://");
    url?.focus();
    return;
  }
  try {
    const store = await lifeStore();
    await (store.upsertEvents ? store.upsertEvents([e]) : store.addEvents([e]));
  } catch {
    toast("Couldn't save it. Try again.");
    return;
  }
  if (url) url.value = '';
  if (note) note.value = '';
  toast('Saved to Your links.');
  await fill();
}

// ---------- a kept copy

async function keep(url, el) {
  if (!helperOn()) {
    toast(LK.NO_HELPER);
    return;
  }
  if (ui.busy.has(url)) return;
  ui.busy.add(url);
  if (el) {
    el.disabled = true;
    el.textContent = 'Keeping a copy…';
  }
  const r = await LK.keepCopy(url).catch(() => ({ ok: false, error: "Couldn't keep a copy. Try again." }));
  ui.busy.delete(url);
  toast(r.ok ? `Kept a copy of ${r.title}.${r.cut ? ' It was long: the first part is kept.' : ''}` : r.error);
  await fill();
  if (r.ok && ui.open === url) readSheet(url);
}

function readSheet(url) {
  const item = ui.items?.find((i) => i.url === url);
  if (!item?.copy) return;
  ui.open = url;
  const c = item.copy;
  const paras = c.text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  openSheet(`<p class="kicker">Your links: kept copy</p>
    <h2 class="display sheet-title">${esc(c.title)}</h2>
    <p class="muted small">Kept ${esc(day(c.at))} from ${esc(LK.siteOf(c.from || item.url))}.${c.cut ? ' The page was longer: the first part is kept.' : ''}</p>
    <div class="lk-copy">${paras}</div>
    <a class="btn ghost block" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open the page</a>
    <button class="btn ghost block" data-act="lk-copy" data-u="${esc(item.url)}">Keep a new copy</button>
    <button class="btn ghost block danger" data-act="lk-drop" data-u="${esc(item.url)}">Delete this copy</button>`);
}

async function drop(url, el) {
  const item = ui.items?.find((i) => i.url === url);
  if (!item?.copy) return;
  el.disabled = true;
  await LK.dropCopy(item).catch(() => {});
  ui.open = '';
  closeSheet();
  toast('The copy is deleted. The link stays.');
  await fill();
}

// Returns true when it handled the action (straight away: the work goes on after).
export function handleAction(act, el) {
  const url = el?.dataset?.u || '';
  switch (act) {
    case 'lk-copy':
      void keep(url, el);
      return true;
    case 'lk-read':
      readSheet(url);
      return true;
    case 'lk-drop':
      void drop(url, el);
      return true;
  }
  return false;
}
