// "Your GitHub" in Photos and files, next to the Cloudflare R2 setup (files-ui.js ownPart): the
// steps for a fine-grained token, connecting a private repository (made by Arise when the Player
// says yes and the token may), adding another when they near 1 GB, Check, and Stop. The storage
// itself is files-github.ts; the sync that uses it is files-sync.ts.

import { esc, toast } from '../ui.js';
import * as GH from './files-github';
import * as FS from './files-sync';
import * as F from './files';
import * as S from '../store';

const $ = (sel) => globalThis.document?.querySelector(sel) ?? null;
let open = false; // the setup form
let adding = false; // the form for another repository
let sizes = {}; // how full each repository is, after Check

const head = '<h3 class="sub">Your GitHub <span class="tag">About 1 GB per repository</span></h3>';
const warn = `<p class="muted small">GitHub isn't meant for keeping files, and may slow down or limit a repository past about 1 GB. Arise moves on to a new repository before that. A deleted file leaves the repository, but GitHub keeps it in the history, still encrypted.</p>`;

function repoLine(r) {
  const n = sizes[r];
  return `<li><b>${esc(r)}</b>${typeof n === 'number' && n >= 0 ? ` · ${esc(F.sizeText(n))} of 1 GB` : ''}</li>`;
}

export function ghPart() {
  const st = GH.settings();
  if (st && !open) {
    const full = FS.status.ghFull ? '<p class="small"><b>Your repositories are nearly full.</b> New files wait on this device until you add another private repository.</p>' : '';
    const add = adding
      ? `<div class="stack">
        <label class="field"><span class="k">New repository</span><input id="ghAddRepo" autocomplete="off" spellcheck="false" value="${esc(GH.nextName(st.repos))}"></label>
        <p class="muted small">If your token only has the repositories you picked, make this one on GitHub first (private, empty) and add it to the token.</p>
        <div class="row"><button class="btn primary small" data-act="myfiles-gh-add-save">Check and add</button><button class="btn ghost small" data-act="myfiles-gh-add-cancel">Cancel</button></div>
      </div>`
      : '';
    return `<div class="own-storage" id="ghFiles">${head}
      <p class="small">On: new photos and files from this device go to your private ${st.repos.length === 1 ? 'repository' : 'repositories'} on GitHub, up to ${esc(F.sizeText(FS.OWN_FILE_MAX))} each. They're encrypted here first, so GitHub only holds scrambled parts it can't open.</p>
      <ul class="small gh-repos">${st.repos.map(repoLine).join('')}</ul>
      ${full}${add}
      ${S.ownStorage() ? '<p class="muted small">On this device, new files go here, not to your Cloudflare storage.</p>' : ''}
      <p class="muted small">The token stays on this device. It doesn't sync and isn't in backups. To open these files on another device, connect your GitHub there too, with a token for the same repositories.</p>
      ${warn}
      <div class="row"><button class="btn ghost small" data-act="myfiles-gh-check">Check</button>${adding ? '' : '<button class="btn ghost small" data-act="myfiles-gh-add">Add a repository</button>'}<button class="btn ghost small" data-act="myfiles-gh-edit">New token</button><button class="btn ghost small danger" data-act="myfiles-gh-stop">Stop</button></div>
    </div>`;
  }
  if (!open) {
    return `<div class="own-storage" id="ghFiles">${head}
      <p class="small">Or keep them in private repositories in your own GitHub account. Files up to ${esc(F.sizeText(FS.OWN_FILE_MAX))}, and about 1 GB in each repository. They're encrypted on your device first, so GitHub can't open them.</p>
      <div class="row"><button class="btn ghost small" data-act="myfiles-gh-edit">Set it up</button></div>
    </div>`;
  }
  return `<div class="own-storage" id="ghFiles">${head}
    <ol class="own-steps small">
      <li>On GitHub, open <b>Settings</b>, <b>Developer settings</b>, <b>Personal access tokens</b>, <b>Fine-grained tokens</b>, <b>Generate new token</b>.</li>
      <li>Under <b>Repository access</b>, pick <b>Only select repositories</b> and choose an empty private repository you made for this. Or pick <b>All repositories</b>, and Arise can make one for you (this also needs <b>Administration: Read and write</b>).</li>
      <li>Under <b>Permissions</b>, set <b>Contents</b> to <b>Read and write</b>.</li>
      <li>Generate the token, copy it (it starts with <code>github_pat_</code>) and paste it here.</li>
    </ol>
    <div class="stack">
      <label class="field"><span class="k">Token</span><input id="ghToken" type="password" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span class="k">Repository</span><input id="ghRepo" autocomplete="off" spellcheck="false" value="${esc(GH.settings()?.repos[0] || GH.FIRST_NAME)}"></label>
      <p class="muted small">Arise writes, reads and deletes a small test file before it saves this. The token stays on this device only.</p>
      ${warn}
      <div class="row"><button class="btn primary small" data-act="myfiles-gh-save">Check and save</button><button class="btn ghost small" data-act="myfiles-gh-cancel">Cancel</button></div>
    </div>
  </div>`;
}

function repaint() {
  const el = $('#ghFiles');
  if (el) el.outerHTML = ghPart();
}

// Runs `fn`; with a repository that isn't there, asks to make it and runs it again with make.
async function withMake(fn, name) {
  try {
    return await fn(false);
  } catch (err) {
    if (err?.code !== 'missing') throw err;
    if (!globalThis.confirm?.(`There's no repository ${err.full || name} yet. Make it now, private, in your GitHub account?`)) return null;
    return fn(true);
  }
}

async function busy(el, fn) {
  if (el) el.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err?.message || "That didn't work. Try again.");
    return undefined;
  } finally {
    if (el) el.disabled = false;
  }
}

async function fillSizes() {
  sizes = await GH.sizes().catch(() => ({}));
  repaint();
}

export async function handleAction(act, el) {
  switch (act) {
    case 'myfiles-gh-edit':
      open = true;
      repaint();
      return true;
    case 'myfiles-gh-cancel':
      open = false;
      repaint();
      return true;
    case 'myfiles-gh-save': {
      const token = $('#ghToken')?.value || '';
      const repo = ($('#ghRepo')?.value || '').trim() || GH.FIRST_NAME;
      const st = await busy(el, () => withMake((make) => GH.connect({ token, repo, make }), repo));
      if (!st) return true;
      open = false;
      sizes = {};
      repaint();
      toast('Your GitHub works. New files from this device go there from now on.');
      void FS.syncNow();
      return true;
    }
    case 'myfiles-gh-add':
      adding = true;
      repaint();
      return true;
    case 'myfiles-gh-add-cancel':
      adding = false;
      repaint();
      return true;
    case 'myfiles-gh-add-save': {
      const repo = ($('#ghAddRepo')?.value || '').trim();
      const full = await busy(el, () => withMake((make) => GH.addRepo(repo, make), repo));
      if (!full) return true;
      adding = false;
      FS.status.ghFull = false;
      repaint();
      toast(`Added ${full}. New files go there once the others are full.`);
      void FS.syncNow();
      return true;
    }
    case 'myfiles-gh-check': {
      const n = await busy(el, () => GH.checkAll());
      if (n === undefined) return true;
      toast(n === 1 ? 'Checked. Arise can write, read and delete there.' : `Checked all ${n}. Arise can write, read and delete in each.`);
      await fillSizes();
      return true;
    }
    case 'myfiles-gh-stop':
      if (!globalThis.confirm?.("Stop using your GitHub on this device? The token goes from this device. Files already there stay there, and this device can't open the ones it doesn't have.")) return true;
      GH.forget();
      Object.assign(FS.status, { ghFull: false });
      open = adding = false;
      sizes = {};
      repaint();
      toast('Your GitHub is off on this device.');
      return true;
    default:
      return false;
  }
}
