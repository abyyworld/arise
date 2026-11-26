// Your website on screen (from Me): its pages and posts, the editor with a live preview, the look,
// Ideas to write about, Publish to GitHub Pages and, if turned on, the visit counter's chart.
// The pages live in the synced state (lib/site.ts); the GitHub key (site-publish.ts) and the
// counter's read key (site-visits.ts) stay on this device.

import './styles/site.css';
import * as S from './store';
import * as SITE from './lib/site';
import * as SP from './site-publish';
import * as SV from './site-visits';
import * as AI from './ai.js';
import { esc, icon, toast } from './ui.js';

export const VIEW = 'website';
const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;

const ui = { editing: '', ideas: null, ideasBusy: false, ideasError: '', hint: '', busy: false, error: '', visits: null, visitsError: '', countBusy: false };

const PLACEHOLDER = {
  home: 'A few lines to say hello: who you are and what you do.',
  about: 'About you: what you do, what you care about, how to reach you.',
  projects: '## A project\nWhat it is, what you did, a link to it.',
  writing: 'A line or two above the list of your posts. Can be left empty.',
  page: 'Write this page.',
  post: 'Write your post.',
};
const HELP = '# Heading, **bold**, *italic*, [a link](https://…), - a list, > a quote, ``` code ```, ![what it shows](https://…) for a picture.';

// ---------- the way in, on Me

export function entryCard() {
  const site = S.site();
  const has = SITE.hasSite(site);
  return `<section class="panel site-entry">
    <h2 class="panel-title">${icon('globe')}<span>Your website</span></h2>
    <p class="muted small">${has && site.address.url ? `Live at <a href="${esc(site.address.url)}" target="_blank" rel="noopener">${esc(site.address.url.replace(/^https:\/\//, '').replace(/\/$/, ''))}</a>.` : 'A simple website of your own, written here and published to your GitHub account.'}</p>
    <div class="row"><button class="btn small" data-act="nav" data-v="${VIEW}">${has ? 'Open your website' : 'Make a website'}</button></div>
  </section>`;
}

// ---------- the screen

export function renderSite(root) {
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">You</p><h1 class="display">Your website</h1></div>
      <button class="btn small ghost" data-act="nav" data-v="progress">${icon('back')} Me</button>
    </header>
    <div id="siteBody">${bodyHTML()}</div>`;
  void loadVisits();
}

function redraw() {
  const el = $('#siteBody');
  if (el) el.innerHTML = bodyHTML();
}

function bodyHTML() {
  const site = S.site();
  if (!SITE.hasSite(site)) {
    return `<section class="panel site-start">
      <div class="panel-title"><span>A website of your own</span></div>
      <p>A home page, a page about you, your projects and your writing. You write it here, pick a look, and publish it to GitHub Pages in your own GitHub account.</p>
      <p class="muted small">Only what you write here goes on it. Nothing else Arise knows about you does.</p>
      <div class="row"><button class="btn small primary" data-act="site-start">Start my website</button></div>
    </section>`;
  }
  return [pagesPanel(site), ui.editing ? editorPanel(site) : '', lookPanel(site), ideasPanel(), publishPanel(site), visitsPanel(site)].join('');
}

const status = (site, p) => (p.draft ? 'Draft' : SITE.published(site, p) ? 'Published' : 'Empty, not published');

function pagesPanel(site) {
  const pages = SITE.menuPages(site, true);
  const posts = SITE.posts(site, true);
  const movable = pages.filter((p) => p.kind !== 'home');
  const row = (p, move) => `<li class="site-row${ui.editing === p.id ? ' on' : ''}">
      <span><b>${esc(p.title)}</b> <span class="muted small">${esc(p.kind === 'post' ? `${p.date} · ${status(site, p)}` : status(site, p))}</span></span>
      <span class="row">
        ${move ? `<button class="btn small ghost" data-act="site-up" data-id="${esc(p.id)}" aria-label="Move ${esc(p.title)} up" ${movable[0]?.id === p.id ? 'disabled' : ''}>↑</button><button class="btn small ghost" data-act="site-down" data-id="${esc(p.id)}" aria-label="Move ${esc(p.title)} down" ${movable.at(-1)?.id === p.id ? 'disabled' : ''}>↓</button>` : ''}
        <button class="btn small" data-act="site-edit" data-id="${esc(p.id)}">Edit</button>
      </span>
    </li>`;
  return `<section class="panel site-pages">
    <div class="panel-title"><span>Pages</span></div>
    <ul class="site-list">${pages.map((p) => row(p, p.kind !== 'home')).join('')}</ul>
    <div class="row"><button class="btn small" data-act="site-add-page">Add a page</button></div>
    <div class="panel-title site-sub"><span>Posts</span></div>
    ${posts.length ? `<ul class="site-list">${posts.map((p) => row(p, false)).join('')}</ul>` : '<p class="muted small">No posts yet. They show on the Writing page, newest first.</p>'}
    <div class="row"><button class="btn small" data-act="site-add-post">Add a post</button></div>
  </section>`;
}

function editorPanel(site) {
  const p = site.pages[ui.editing];
  if (!p || p.gone) return '';
  const own = p.kind === 'page' || p.kind === 'post';
  const placeholder = ui.hint || PLACEHOLDER[p.kind];
  return `<section class="panel site-editor" id="siteEditor" data-id="${esc(p.id)}">
    <div class="panel-title"><span>Edit: ${esc(p.title)}</span></div>
    <div class="site-edit">
      <div class="stack">
        <label class="field"><span class="k">Title</span><input data-site-field="title" value="${esc(p.title)}" maxlength="${SITE.TITLE_MAX}" ${p.kind === 'home' ? 'disabled' : ''}></label>
        ${p.kind === 'post' ? `<label class="field"><span class="k">Date</span><input type="date" data-site-field="date" value="${esc(p.date)}"></label>` : ''}
        <label class="field"><span class="k">Text</span><textarea data-site-field="body" rows="14" maxlength="${SITE.BODY_MAX}" placeholder="${esc(placeholder)}">${esc(p.body)}</textarea></label>
        <p class="muted small">${esc(HELP)}</p>
        <label class="check"><input type="checkbox" data-site-field="draft" ${p.draft ? 'checked' : ''}> Draft: keep it here, don't publish it yet</label>
      </div>
      <div class="site-preview theme-${esc(site.look.theme)}" aria-label="Preview" aria-live="polite">${previewHTML(p.kind === 'home' ? site.look.name || 'My website' : p.title, p.body)}</div>
    </div>
    <div class="row">
      <button class="btn small primary" data-act="site-done">Done</button>
      ${own ? `<button class="link danger-link" data-act="site-delete" data-id="${esc(p.id)}">Delete ${p.kind === 'post' ? 'post' : 'page'}</button>` : ''}
    </div>
  </section>`;
}

const previewHTML = (title, body) => `<h1>${esc(title)}</h1>${SITE.toHTML(body) || '<p class="muted">Nothing written yet.</p>'}`;

function lookPanel(site) {
  return `<section class="panel site-look">
    <div class="panel-title"><span>Name and look</span></div>
    <label class="field"><span class="k">Site name</span><input data-site-look="name" value="${esc(site.look.name)}" maxlength="${SITE.NAME_MAX}" placeholder="Your name"></label>
    <label class="field"><span class="k">One line about you</span><input data-site-look="line" value="${esc(site.look.line)}" maxlength="${SITE.LINE_MAX}" placeholder="What you do, in a few words"></label>
    <div class="site-themes" role="radiogroup" aria-label="Look">
      ${Object.entries(SITE.THEMES)
        .map(
          ([id, t]) => `<label class="site-theme theme-${id}${site.look.theme === id ? ' on' : ''}"><input type="radio" name="siteTheme" value="${id}" data-site-look="theme" ${site.look.theme === id ? 'checked' : ''}>
          <span class="site-swatch" aria-hidden="true"><b>Aa</b></span><span><b>${esc(t.name)}</b><span class="muted small"> ${esc(t.about)}</span></span></label>`,
        )
        .join('')}
    </div>
  </section>`;
}

function ideasPanel() {
  let out = '';
  if (ui.ideasError) out = `<p class="error small" role="alert">${esc(ui.ideasError)}</p>`;
  else if (ui.ideas) {
    out = `<ul class="site-ideas">${ui.ideas.ideas
      .map((x, i) => `<li><b>${esc(x.title)}</b>${x.why ? `<span class="muted small">${esc(x.why)}</span>` : ''}<button class="btn small" data-act="site-idea" data-i="${i}">Start a post</button></li>`)
      .join('')}</ul>`;
  }
  return `<section class="panel site-ideas-panel">
    <div class="panel-title"><span>Ideas to write about</span></div>
    <p class="muted small">Your coach's AI suggests a few posts from your goals, projects and notes, only as far as it may read them. Nothing is written or published until you start one.</p>
    ${out}
    <div class="row"><button class="btn small" data-act="site-ideas" ${ui.ideasBusy ? 'disabled' : ''}>${ui.ideasBusy ? 'Thinking…' : ui.ideas ? 'Other ideas' : 'Ideas to write about'}</button></div>
  </section>`;
}

const field = (name, label, type, extra = '') => `<label class="field"><span class="k">${label}</span><input name="${name}" type="${type}" ${extra} spellcheck="false" autocapitalize="off"></label>`;

function publishPanel(site) {
  const c = SP.conn();
  const err = ui.error ? `<p class="error small" role="alert">${esc(ui.error)}</p>` : '';
  if (!c.token) {
    return `<section class="panel site-publish" id="sitePublish">
      <div class="panel-title"><span>Publish</span></div>
      <p class="small">Your website goes on GitHub Pages, free, in a repository on your own GitHub account. Everything on its pages is public.</p>
      <details class="other"><summary>How to make the key</summary>
        <ol class="small">
          <li>On GitHub, make a new <b>public</b> repository. Name it <b>yourname.github.io</b> and the site is at https://yourname.github.io. Any other name puts it at https://yourname.github.io/that-name.</li>
          <li>Go to Settings, Developer settings, Personal access tokens, <b>Fine-grained tokens</b>, Generate new token.</li>
          <li>Repository access: <b>Only select repositories</b>, and pick that one. Permissions: <b>Contents</b> and <b>Pages</b>, Read and write. Nothing else.</li>
          <li>Copy the key and paste it below. It stays on this device and only ever goes to GitHub.</li>
        </ol>
      </details>
      <form class="stack" data-site-form="connect">
        ${field('token', 'GitHub key', 'password', 'required autocomplete="off" placeholder="github_pat_…"')}
        ${field('repo', 'Repository', 'text', 'autocomplete="off" placeholder="yourname.github.io"')}
        ${err}
        <button class="btn small primary" type="submit" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Connecting…' : 'Connect'}</button>
      </form>
    </section>`;
  }
  const url = site.address.url;
  return `<section class="panel site-publish" id="sitePublish">
    <div class="panel-title"><span>Publish</span></div>
    <p class="small">Publishing to <b>${esc(c.repo)}</b> on GitHub. Everything on its pages is public.</p>
    ${url ? `<p class="small">Your website: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>` : ''}
    <p class="muted small">${c.last ? `Last published ${esc(new Date(c.last).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}.` : 'Not published from this device yet.'} After a Publish, GitHub takes a minute or two to show the change.</p>
    ${c.error && !ui.error ? `<p class="error small">${esc(c.error)}</p>` : ''}
    ${err}
    <div class="row">
      <button class="btn small primary" data-act="site-publish" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Publishing…' : 'Publish'}</button>
      <button class="link danger-link" data-act="site-disconnect">Disconnect</button>
    </div>
  </section>`;
}

function visitsPanel(site) {
  if (!SV.available()) return '';
  const on = !!site.count.site;
  const mine = SV.local();
  let body = '';
  if (on && mine && mine.site === site.count.site) {
    if (ui.visitsError) body = `<p class="error small">${esc(ui.visitsError)}</p>`;
    else if (!ui.visits) body = '<p class="muted small">Reading the counts…</p>';
    else body = chartHTML(ui.visits);
  } else if (on) body = '<p class="muted small">The counts show on the device that turned the counter on.</p>';
  return `<section class="panel site-visits" id="siteVisits">
    <div class="panel-title"><span>Visitors</span> <span class="tag">Less private</span></div>
    <label class="check"><input type="checkbox" data-site-count ${on ? 'checked' : ''} ${ui.countBusy ? 'disabled' : ''}> Count visits to each page</label>
    <p class="muted small">Each page tells Arise's visit counter that it was opened. The counter keeps the page, the day and a number. Not who opened it: no cookies, no IP addresses, nothing that tells one visitor from another. Its server does see that a page was opened. Browsers that ask sites not to track them aren't counted. Turning it on or off takes effect when you publish again.</p>
    ${body}
  </section>`;
}

function chartHTML(v) {
  const most = Math.max(1, ...v.days.map((d) => d.n));
  const w = 300 / v.days.length;
  const bars = v.days
    .map((d, i) => {
      const h = Math.round((d.n / most) * 70);
      return `<rect x="${(i * w + 1).toFixed(1)}" y="${78 - h}" width="${(w - 2).toFixed(1)}" height="${Math.max(h, d.n ? 2 : 1)}" rx="1"${d.n ? '' : ' class="none"'}><title>${esc(d.day)}: ${d.n}</title></rect>`;
    })
    .join('');
  return `<p class="small"><b>${v.total}</b> ${v.total === 1 ? 'visit' : 'visits'} in the last 30 days.</p>
    <svg class="site-chart" viewBox="0 0 300 80" role="img" aria-label="Visits per day, the last 30 days">${bars}</svg>
    ${v.pages.length ? `<ul class="site-list">${v.pages
      .slice(0, 10)
      .map((p) => `<li class="site-row"><span>${esc(p.page)}</span><b>${p.n}</b></li>`)
      .join('')}</ul>` : ''}`;
}

async function loadVisits() {
  const site = S.site();
  const mine = SV.local();
  if (!SV.available() || !site.count.site || mine?.site !== site.count.site) return;
  try {
    ui.visits = SV.summarize(await SV.counts(30), 30);
    ui.visitsError = '';
  } catch (err) {
    ui.visitsError = err?.message || "Couldn't read the counts.";
  }
  const el = $('#siteVisits');
  if (el) el.outerHTML = visitsPanel(S.site());
}

// ---------- what the buttons do

const change = (fn) => S.saveSite(fn(S.site()));

function edit(id) {
  ui.editing = id;
  redraw();
  $('#siteEditor')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  $('#siteEditor textarea')?.focus({ preventScroll: true });
}

export async function publishNow() {
  const site = S.site();
  if (!SP.conn().token) return false;
  ui.busy = true;
  ui.error = '';
  redraw();
  try {
    const count = SV.available() && site.count.site ? { server: SV.server(), site: site.count.site } : null;
    const { url, changed } = await SP.publish(SITE.build(site, { count }));
    if (url) change((s) => SITE.setAddress(s, url));
    toast(changed ? 'Published. GitHub takes a minute or two to show it.' : 'Nothing has changed since the last Publish.');
  } catch (err) {
    ui.error = err?.message || "Couldn't publish. Try again.";
  }
  ui.busy = false;
  redraw();
  return true;
}

async function ideas() {
  if (!AI.ready()) {
    ui.ideasError = 'Turn on the AI coach in Settings first. Then Arise can suggest ideas.';
    redraw();
    return;
  }
  ui.ideasBusy = true;
  ui.ideasError = '';
  redraw();
  try {
    ui.ideas = await AI.postIdeas();
  } catch (err) {
    ui.ideasError = err?.message || "Couldn't get ideas. Try again.";
  }
  ui.ideasBusy = false;
  redraw();
}

async function setCounting(on) {
  ui.countBusy = true;
  try {
    if (on) {
      const id = await SV.start();
      change((s) => SITE.setCount(s, id));
      toast('Counting is on. Publish again to start counting.');
    } else {
      await SV.stop();
      change((s) => SITE.setCount(s, ''));
      ui.visits = null;
      toast('Counting is off. Publish again to take the counter off your pages.');
    }
  } catch (err) {
    toast(err?.message || "That didn't work. Try again.");
  }
  ui.countBusy = false;
  redraw();
  void loadVisits();
}

export async function handleAction(act, el) {
  if (!act?.startsWith('site-')) return false;
  const id = el?.dataset?.id || '';
  switch (act) {
    case 'site-start':
      change((s) => SITE.startSite(s, (S.state.settings.name || S.state.profile?.name || '').trim()));
      ui.editing = 'home';
      redraw();
      break;
    case 'site-edit':
      ui.hint = '';
      edit(id);
      break;
    case 'site-done':
      ui.editing = '';
      ui.hint = '';
      redraw();
      break;
    case 'site-add-page':
    case 'site-add-post': {
      const r = SITE.addPage(S.site(), act === 'site-add-post' ? 'post' : 'page', '');
      if (!r) {
        toast(`A site can have up to ${SITE.MAX_PAGES} pages and posts.`);
        break;
      }
      S.saveSite(r.site);
      ui.hint = '';
      edit(r.id);
      break;
    }
    case 'site-delete': {
      const p = S.site().pages[id];
      if (!p || !globalThis.confirm?.(`Delete "${p.title}"? It also goes from your website the next time you publish.`)) break;
      change((s) => SITE.deletePage(s, id));
      ui.editing = '';
      redraw();
      break;
    }
    case 'site-up':
    case 'site-down':
      change((s) => SITE.movePage(s, id, act === 'site-up' ? -1 : 1));
      redraw();
      break;
    case 'site-ideas':
      await ideas();
      break;
    case 'site-idea': {
      const x = ui.ideas?.ideas?.[Number(el?.dataset?.i)];
      const r = x && SITE.addPage(S.site(), 'post', x.title);
      if (!r) break;
      S.saveSite(r.site);
      ui.hint = x.why || '';
      edit(r.id);
      break;
    }
    case 'site-publish':
      if (!globalThis.confirm?.('Publish your website? Everything on its pages will be public.')) break;
      await publishNow();
      break;
    case 'site-disconnect':
      if (!globalThis.confirm?.('Disconnect from GitHub? The key goes from this device. Your website stays up.')) break;
      SP.forget();
      ui.error = '';
      redraw();
      break;
    default:
      return false;
  }
  return true;
}

// For "Erase all data": the GitHub key and the counter's read key go from this device.
export async function forgetDevice() {
  SP.forget();
  await SV.stop().catch(() => {});
  ui.editing = '';
  ui.ideas = null;
  ui.visits = null;
}

// ---------- typing

function saveField(input) {
  const ed = input.closest('#siteEditor');
  const id = ed?.dataset.id;
  if (!id) return;
  const f = input.dataset.siteField;
  const value = f === 'draft' ? input.checked : input.value;
  const before = S.site().pages[id]?.title;
  change((s) => SITE.editPage(s, id, { [f]: value }));
  // A new title shows in the list (and the editor's heading).
  if (f === 'title' && S.site().pages[id]?.title !== before) redraw();
  if (f === 'draft') redraw();
}

globalThis.document?.addEventListener('input', (e) => {
  const t = e.target;
  if (!t?.dataset) return;
  if (t.dataset.siteField === 'body' || t.dataset.siteField === 'title') {
    const ed = t.closest('#siteEditor');
    const prev = ed && $('.site-preview', ed);
    if (!prev) return;
    const p = S.site().pages[ed.dataset.id];
    const title = p?.kind === 'home' ? S.site().look.name || 'My website' : $('[data-site-field="title"]', ed)?.value || p?.title || '';
    prev.innerHTML = previewHTML(title, $('[data-site-field="body"]', ed)?.value || '');
  }
});

globalThis.document?.addEventListener('change', (e) => {
  const t = e.target;
  if (!t?.dataset) return;
  if (t.dataset.siteField) saveField(t);
  else if (t.dataset.siteLook) {
    change((s) => SITE.setLook(s, { [t.dataset.siteLook]: t.value }));
    if (t.dataset.siteLook === 'theme') redraw();
  } else if (t.hasAttribute?.('data-site-count')) void setCounting(t.checked);
});

globalThis.document?.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form?.dataset?.siteForm !== 'connect') return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(form));
  ui.busy = true;
  ui.error = '';
  redraw();
  try {
    await SP.connect({ token: String(v.token || ''), repo: String(v.repo || '') });
    toast('Connected to GitHub.');
  } catch (err) {
    ui.error = err?.message || "That didn't work. Try again.";
  }
  ui.busy = false;
  redraw();
});
