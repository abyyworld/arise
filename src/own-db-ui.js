// Your own database (own-db.ts) on screen: one panel, the same in Setup and connections and in
// Settings. Connect with a Turso URL and token, pick what goes in, Check, Copy everything now,
// and Stop.

import * as ODB from './own-db';
import { SECTIONS, table } from './lib/own-db';
import { esc, icon, toast } from './ui.js';

export const DOCS = 'https://github.com/abyyworld/arise/blob/main/docs/OWN-DATABASE.md';
const LESS = 'Less private: your data sits in that database as plain text. Anyone with its token can read it, and so can Turso. Your synced copy stays end-to-end encrypted.';

const chip = (t, on = false) => ` <span class="tag status${on ? ' on' : ''}">${esc(t)}</span>`;
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const field = (name, label, type, extra = '') =>
  `<label class="field"><span class="k">${label}</span><input name="${name}" type="${type}" ${extra} spellcheck="false" autocapitalize="off" autocomplete="off"></label>`;

let busy = '';
let error = '';

// "3 changes: todos 2, checkins 1."
function lastLine(c) {
  if (!c.last) return 'Nothing copied yet.';
  const what = Object.entries(c.lastWhat)
    .filter(([k]) => table(k))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  const n = Object.values(c.lastWhat).reduce((a, b) => a + b, 0);
  return `Last copied ${when(c.last)}: ${n === 1 ? '1 change' : `${n} changes`}${what ? ` (${what})` : ''}. ${c.rows === 1 ? '1 row' : `${c.rows} rows`} from Arise in your database.`;
}

export function panel() {
  const c = ODB.conn();
  const title = `<div class="panel-title">${icon('note')}<span>Your own database</span>${chip(c ? 'Connected' : 'Optional', !!c)} <span class="tag less">Less private</span></div>`;
  const err = error ? `<p class="error small" role="alert">${esc(error)}</p>` : '';
  if (!c) {
    return `<section class="panel" id="ownDbPanel">${title}
    <p class="small">Keep a copy of your goals, to-dos, events, check-ins and more in a database you own, as tables you can query with SQL. Arise keeps it up to date a few seconds after each change.</p>
    <p class="muted small">${esc(LESS)}</p>
    <details class="other"><summary>How to make a Turso database</summary>
      <ol class="small">
        <li>Sign up at turso.tech. The free plan is enough.</li>
        <li>Make a database, for example arise.</li>
        <li>Open it, copy its URL (it starts with libsql://) and make a token with read and write.</li>
        <li>Paste both below. The token stays on this device.</li>
      </ol>
    </details>
    <form class="stack" data-odb-form="connect">
      ${field('url', 'Database URL', 'url', 'required placeholder="libsql://arise-you.turso.io"')}
      ${field('token', 'Token', 'password', 'required placeholder="eyJ…"')}
      ${err}
      <button class="btn small primary" type="submit" ${busy ? 'disabled' : ''}>${busy === 'connect' ? 'Connecting…' : 'Connect and copy'}</button>
    </form>
    <p class="muted small"><a href="${DOCS}" target="_blank" rel="noopener">The tables</a>, so you can query them.</p>
  </section>`;
  }
  const on = new Set(c.sections);
  return `<section class="panel" id="ownDbPanel">${title}
    <p class="small">Copying to <b>${esc(ODB.host())}</b> a few seconds after each change, from this device.</p>
    <p class="muted small">${esc(lastLine(c))}</p>
    ${c.error && !error ? `<p class="error small">${esc(c.error)}</p>` : ''}
    ${err}
    <p class="label">What goes in</p>
    ${SECTIONS.map(
      (s) =>
        `<button class="toggle-row" data-act="odb-sec" data-v="${s.id}" aria-pressed="${on.has(s.id)}"><span><b>${esc(s.name)}</b><small>${esc(s.what)}</small></span><span class="switch ${on.has(s.id) ? 'on' : ''}"></span></button>`,
    ).join('')}
    <p class="muted small">Turning one off takes its rows out of your database.</p>
    <div class="row">
      <button class="btn small ghost" data-act="odb-check" ${busy ? 'disabled' : ''}>${busy === 'check' ? 'Checking…' : 'Check'}</button>
      <button class="btn small primary" data-act="odb-all" ${busy ? 'disabled' : ''}>${busy === 'all' ? 'Copying…' : 'Copy everything now'}</button>
      <button class="link danger-link" data-act="odb-stop">Stop and forget the connection</button>
    </div>
    <p class="muted small">${esc(LESS)} <a href="${DOCS}" target="_blank" rel="noopener">The tables</a>.</p>
  </section>`;
}

function repaint() {
  const el = globalThis.document?.getElementById('ownDbPanel');
  if (el) el.outerHTML = panel();
}
ODB.onChange(() => repaint());

async function doing(what, fn) {
  busy = what;
  error = '';
  repaint();
  try {
    await fn();
  } catch (err) {
    error = err?.message || "That didn't work. Try again.";
  }
  busy = '';
  repaint();
}

export async function handleAction(act, el) {
  if (!act.startsWith('odb-')) return false;
  if (act === 'odb-sec') {
    const c = ODB.conn();
    const id = el?.dataset?.v;
    if (c && SECTIONS.some((s) => s.id === id)) ODB.setSection(id, !c.sections.includes(id));
    return true;
  }
  if (act === 'odb-check')
    await doing('check', async () => {
      await ODB.check();
      toast('It works. Arise wrote a test row and read it back.');
    });
  if (act === 'odb-all')
    await doing('all', async () => {
      const n = await ODB.copyNow({ everything: true });
      toast(n === 1 ? 'Copied 1 row.' : `Copied ${n} rows.`);
    });
  if (act === 'odb-stop' && globalThis.confirm?.('Stop copying to your database? The token goes from this device. What is in the database stays there.')) {
    ODB.forget();
    error = '';
    toast('Stopped.');
    repaint();
  }
  return true;
}

export async function connect(values) {
  await doing('connect', async () => {
    const n = await ODB.connect(values);
    toast(`Connected. Copied ${n === 1 ? '1 row' : `${n} rows`}.`);
  });
}

globalThis.document?.addEventListener('submit', (e) => {
  const form = e.target;
  if (form?.dataset?.odbForm !== 'connect') return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(form));
  void connect({ url: String(v.url || ''), token: String(v.token || '') });
});
