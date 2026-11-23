// Apps Arise never reads (app-skip.ts), on screen: a button in Your life · Android and in the Mac
// helper's panel opens a sheet with the groups that are left out, the Player's own picks, and the
// apps Arise has seen on that device to pick from.

import { esc, openSheet, toast } from '../ui.js';
import * as APPS from './app-skip';
import type { Where } from './app-skip';
import { tellSkip } from './android-sense';

const ON: Record<Where, string> = {
  android: 'this phone',
  mac: 'this Mac',
};

export const skipButton = (where: Where) => {
  const own = APPS.load(where).skip.own.length;
  return `<button class="btn ghost small" data-act="skip-open" data-where="${where}">Apps Arise never reads${own ? ` (${own} of yours)` : ''}</button>`;
};

function sheetHTML(where: Where): string {
  const { skip, seen } = APPS.load(where);
  const groups = APPS.APP_GROUPS.map((g) => {
    const on = skip.groups[g.id];
    return `<button class="toggle-row" data-act="skip-group" data-where="${where}" data-g="${g.id}" aria-pressed="${on}"><span><b>${esc(g.name)}</b><small>Left out, like the sites the browser extension skips.</small></span><span class="switch ${on ? 'on' : ''}"></span></button>`;
  }).join('');
  const nameOf = (id: string) => seen.find((a) => a.id === id)?.name || id;
  const own = skip.own
    .map((id) => `<li class="row"><span>${esc(nameOf(id))} <small class="muted mono">${esc(id)}</small></span><button class="btn ghost small" data-act="skip-del" data-where="${where}" data-id="${esc(id)}">Read it again</button></li>`)
    .join('');
  const pick = seen
    .filter((a) => !APPS.skipped(a.id, a.name, skip))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `<li class="row"><span>${esc(a.name)} <small class="muted mono">${esc(a.id)}</small></span><button class="btn ghost small" data-act="skip-add" data-where="${where}" data-id="${esc(a.id)}">Never read</button></li>`)
    .join('');
  const left = seen.filter((a) => APPS.skipped(a.id, a.name, skip) && !skip.own.includes(a.id)).map((a) => a.name);
  return `<p class="kicker">Your life</p>
    <h2 class="display sheet-title">Apps Arise never reads</h2>
    <p>Arise leaves out the notifications from these apps and the time you spend in them, on ${ON[where]}.${where === 'android' ? ' The phone checks before it keeps anything.' : ''}</p>
    <p class="label">Left out for you</p>
    ${groups}
    ${left.length ? `<p class="muted small">Left out by these: ${esc(left.slice(0, 20).join(', '))}${left.length > 20 ? '…' : ''}.</p>` : ''}
    <p class="label">Your own picks</p>
    ${own ? `<ul class="plain">${own}</ul>` : '<p class="muted small">None yet.</p>'}
    <p class="label">Apps Arise has seen</p>
    ${pick ? `<ul class="plain">${pick}</ul>` : `<p class="muted small">None yet. Apps show up here once Arise has noted something from them on ${ON[where]}.</p>`}
    <label class="field"><span class="k">Or type its ${where === 'android' ? 'package name (com.example.app)' : 'bundle id (com.example.app)'}</span><input id="skipId" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200"></label>
    <div class="row"><button class="btn ghost small" data-act="skip-type" data-where="${where}">Never read it</button></div>
    <p class="muted small">What Arise already noted from an app stays in your life log until you delete it.</p>
    <button class="btn primary block" data-act="sheet-close">Done</button>`;
}

function change(where: Where, fn: (st: APPS.SkipState) => void) {
  const st = APPS.load(where);
  fn(st);
  APPS.save(where, { skip: APPS.cleanSkip(st.skip), seen: st.seen });
  if (where === 'android') void tellSkip(true);
  openSheet(sheetHTML(where));
}

export function handleAction(act: string, el: HTMLElement): boolean {
  if (!act.startsWith('skip-')) return false;
  const where = el.dataset.where as Where;
  if (where !== 'android' && where !== 'mac') return true;
  switch (act) {
    case 'skip-open':
      openSheet(sheetHTML(where));
      return true;
    case 'skip-group': {
      const g = el.dataset.g as APPS.GroupId;
      if (!APPS.GROUP_IDS.includes(g)) return true;
      change(where, (st) => {
        st.skip.groups[g] = !st.skip.groups[g];
      });
      return true;
    }
    case 'skip-add':
    case 'skip-type': {
      const id = APPS.cleanId(act === 'skip-add' ? el.dataset.id : (document.getElementById('skipId') as HTMLInputElement | null)?.value);
      if (!id) {
        toast('Type the app\'s id, like com.example.app.');
        return true;
      }
      change(where, (st) => {
        st.skip.own = [...st.skip.own.filter((x) => x !== id), id];
      });
      toast('Arise never reads it from now on.');
      return true;
    }
    case 'skip-del': {
      const id = el.dataset.id || '';
      change(where, (st) => {
        st.skip.own = st.skip.own.filter((x) => x !== id);
      });
      return true;
    }
  }
  return false;
}
