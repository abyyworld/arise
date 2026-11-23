// GitHub backup (github-backup.ts) on screen: its panel in Setup and connections, next to Your
// files, and the backup password asked for by Load backup.

import * as GHB from './github-backup';
import { MIN_PASSWORD } from './lib/locked-backup';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';

const chip = (t, on = false) => ` <span class="tag status${on ? ' on' : ''}">${esc(t)}</span>`;
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const field = (name, label, type, extra = '') =>
  `<label class="field"><span class="k">${label}</span><input name="${name}" type="${type}" ${extra} spellcheck="false" autocapitalize="off"></label>`;

const SCRAMBLED = 'Each backup is locked on this device with a backup password first, so GitHub only ever sees scrambled data.';
const RESTORE = 'To restore: on GitHub, open the backups folder, download a file, then use Load backup in Settings. Arise asks for the backup password.';

let busy = false;
let error = '';

export function panel() {
  const st = GHB.state();
  const title = `<div class="panel-title">${icon('lock')}<span>GitHub backup</span>${chip(st.token ? 'Connected' : 'Optional', !!st.token)}</div>`;
  const err = error ? `<p class="error small" role="alert">${esc(error)}</p>` : '';
  if (!st.token) {
    return `<section class="panel" id="hubGitHub">${title}
    <p class="small">Optional: also keep your daily backup in a private repository on your GitHub account. ${SCRAMBLED}</p>
    <details class="other"><summary>How to make the key</summary>
      <ol class="small">
        <li>On GitHub, make a new <b>private</b> repository, for example arise-backup.</li>
        <li>Go to Settings, Developer settings, Personal access tokens, <b>Fine-grained tokens</b>, Generate new token.</li>
        <li>Repository access: <b>Only select repositories</b>, and pick that one. Permissions: <b>Contents</b>, Read and write. Nothing else.</li>
        <li>Copy the key and paste it below. It stays on this device.</li>
      </ol>
      <p class="muted small">If the repository isn't there yet and your key may make repositories, Arise makes it for you, private.</p>
    </details>
    <form class="stack" data-ghb-form="connect">
      ${field('token', 'GitHub key', 'password', 'required autocomplete="off" placeholder="github_pat_…"')}
      ${field('repo', 'Repository', 'text', 'autocomplete="off" placeholder="arise-backup"')}
      ${field('password', 'Backup password', 'password', `required minlength="${MIN_PASSWORD}" autocomplete="new-password" placeholder="At least ${MIN_PASSWORD} characters"`)}
      ${field('password2', 'Backup password again', 'password', 'required autocomplete="new-password"')}
      <p class="muted small">You need this password to open a backup again. If you forget it, nobody can open them. Use one you don't use anywhere else.</p>
      ${err}
      <button class="btn small primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Connect and back up'}</button>
    </form>
  </section>`;
  }
  return `<section class="panel" id="hubGitHub">${title}
    <p class="small">Backing up to <b>${esc(st.repo)}</b> (private), once a day while Arise is open. The newest 7 are kept. ${SCRAMBLED}</p>
    <p class="muted small">${st.last ? `Last backup ${esc(when(st.last))}.` : 'No backup yet.'}</p>
    ${st.error && !error ? `<p class="error small">${esc(st.error)}</p>` : ''}
    ${err}
    <div class="row">
      <button class="btn small primary" data-act="ghb-now" ${busy ? 'disabled' : ''}>${busy ? 'Backing up…' : 'Back up now'}</button>
      <button class="link danger-link" data-act="ghb-stop">Stop</button>
    </div>
    <p class="muted small">${RESTORE} Older backups also stay in the repository's history.</p>
  </section>`;
}

function repaint() {
  const el = globalThis.document?.getElementById('hubGitHub');
  if (el) el.outerHTML = panel();
}
GHB.onChange(() => repaint());

export async function handleAction(act) {
  if (!act.startsWith('ghb-')) return false;
  error = '';
  try {
    if (act === 'ghb-now') {
      busy = true;
      repaint();
      if (await GHB.backupNow()) toast('Backed up to GitHub.');
    }
    if (act === 'ghb-stop' && globalThis.confirm?.('Stop backing up to GitHub? The key goes from this device. The backups stay on GitHub.')) {
      await GHB.forget();
      toast('Stopped.');
    }
  } catch (err) {
    error = err?.message || "That didn't work. Try again.";
  }
  busy = false;
  repaint();
  return true;
}

export async function connect(values) {
  busy = true;
  error = '';
  repaint();
  try {
    await GHB.connect(values);
    toast('Connected. Backed up to GitHub.');
  } catch (err) {
    error = err?.message || "That didn't work. Try again.";
  }
  busy = false;
  repaint();
}

globalThis.document?.addEventListener('submit', (e) => {
  const form = e.target;
  if (form?.dataset?.ghbForm !== 'connect') return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(form));
  void connect({ token: String(v.token || ''), repo: String(v.repo || ''), password: String(v.password || ''), password2: String(v.password2 || '') });
});

// ---------- Load backup: the backup password for a locked backup

// Asks in a sheet. Null when the Player closes it.
export function askPassword(wrong = false) {
  return new Promise((resolve) => {
    openSheet(`<p class="kicker">Locked backup</p>
      <h2 class="display sheet-title">Backup password</h2>
      <p>This backup is locked. Type the backup password you set for GitHub backup.</p>
      <form class="stack" data-ghb-form="open">
        ${field('password', 'Backup password', 'password', 'required autocomplete="off"')}
        ${wrong ? `<p class="error small" role="alert">That password doesn't open this backup.</p>` : ''}
        <button class="btn primary block" type="submit">Open and load</button>
      </form>`);
    const sheet = globalThis.document.getElementById('sheet');
    const form = sheet?.querySelector('[data-ghb-form="open"]');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      watch.disconnect();
      resolve(v);
    };
    // Closed another way (the close button, Escape, a tap outside): not loaded.
    const watch = new MutationObserver(() => {
      if (sheet.hidden || !sheet.contains(form)) finish(null);
    });
    if (sheet) watch.observe(sheet, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pw = String(new FormData(form).get('password') || '');
      finish(pw);
      closeSheet();
    });
    form?.querySelector('input')?.focus();
  });
}

// For Load backup (app.js): the backup to load, or null when a locked one wasn't opened.
export const openBackup = (raw) => GHB.openBackup(raw, askPassword);
