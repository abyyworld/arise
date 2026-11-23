// Calendars by link, in Accounts (Setup and connections, and Settings): each calendar with its
// name, its server (never the secret link), when it was last read and how many events came from
// it, with Sync now, Rename and Remove; and a sheet to add one. Its buttons use the app's
// data-act clicks, handed over by panel.ts.

import { esc, icon, openSheet, closeSheet, toast } from '../ui.js';
import * as F from './ics-feeds';
import { ConnectError } from './http';

const ago = (t: number, now = Date.now()) => {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `on ${new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
};
const events = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'event' : 'events'}`;
export const LESS = "Less private: on the web, the link and your events pass through Arise's small helper on Cloudflare while it fetches them. It keeps nothing, but it could read them.";

function card(f: F.Feed): string {
  const less = f.helper && F.onWeb() ? ' <span class="tag less">Less private</span>' : '';
  const lines = [`<small>From ${esc(F.hostOf(f.url))}. ${f.last ? `Last read ${ago(f.last)}` : 'Not read yet'}. ${events(f.count)}.</small>`];
  if (F.busy(f.id)) lines.unshift('<small>Reading…</small>');
  else if (f.error) lines.unshift(`<small class="error">${esc(f.error)}</small>`);
  return `<div class="engine" style="cursor:default" id="ics-${esc(f.id)}">
    <span class="engine-head"><b>${esc(f.name)}</b>${less}</span>
    ${lines.join('')}
    <div class="row">
      <button class="btn small primary" data-act="ics-sync" data-id="${esc(f.id)}" ${F.busy(f.id) ? 'disabled' : ''}>${icon('refresh')} Sync now</button>
      <button class="btn small ghost" data-act="ics-rename" data-id="${esc(f.id)}">Rename</button>
      <button class="btn small ghost" data-act="ics-del" data-id="${esc(f.id)}">Remove</button>
    </div>
  </div>`;
}

// The part inside Accounts.
export function block(): string {
  const list = F.feeds();
  return `<p class="small ics-head"><b>Calendars by link.</b> Add any calendar by its private link (ICS or webcal): from Google Calendar, Outlook, iCloud, a school or a team app. Arise reads it every hour, and its events show on your Calendar and in your days.</p>
    ${list.length ? `<div class="engines">${list.map(card).join('')}</div>` : ''}
    <div class="row"><button class="btn small ghost" data-act="ics-add">${icon('days')} Add a calendar by link</button></div>`;
}

const err = (text: string) => {
  const el = document.getElementById('icsErr');
  if (el) {
    el.textContent = text;
    el.hidden = !text;
  }
};
const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value || '';

function addSheet() {
  const web = F.onWeb();
  const helper = web
    ? `<label class="check"><input type="checkbox" id="icsHelper"${F.helperReady() ? '' : ' disabled'}> If the calendar's server blocks web pages, read it through Arise's helper <span class="tag less">Less private</span></label>
      <p class="muted small">${esc(LESS)}${F.helperReady() ? '' : " The helper isn't set up yet, so on the web only calendars that allow web pages work. The phone apps read any calendar."}</p>`
    : '';
  openSheet(`<p class="kicker">Your life</p><h2 class="display sheet-title">Add a calendar by link</h2>
    <ol class="changes">
      <li>In your calendar app, find its private or secret address in ICS (iCal) format. In Google Calendar it's in the calendar's Settings, under Integrate calendar. In Outlook: Settings, Calendar, Shared calendars, Publish a calendar.</li>
      <li>Copy it and paste it here.</li>
    </ol>
    <label class="field"><span class="k">Name (if you like)</span><input id="icsName" type="text" maxlength="80" autocomplete="off" placeholder="Work"></label>
    <label class="field"><span class="k">The link</span><input id="icsUrl" type="url" autocomplete="off" spellcheck="false" placeholder="https://… or webcal://…"></label>
    ${helper}
    <p class="muted small">The link works like a password, so it stays on this device: never synced, never in a backup, and Arise only ever shows its server. The events go into your life log, end-to-end encrypted.</p>
    <p class="error small" id="icsErr" role="alert" hidden></p>
    <button class="btn primary block" data-act="ics-go">Add it</button>`);
}

function renameSheet(f: F.Feed) {
  openSheet(`<p class="kicker">Calendars by link</p><h2 class="display sheet-title">Rename it</h2>
    <label class="field"><span class="k">Name</span><input id="icsName" type="text" maxlength="80" autocomplete="off" value="${esc(f.name)}"></label>
    ${
      F.onWeb()
        ? `<label class="check"><input type="checkbox" id="icsHelper"${f.helper ? ' checked' : ''}${F.helperReady() || f.helper ? '' : ' disabled'}> Read it through Arise's helper when its server blocks web pages <span class="tag less">Less private</span></label>
      <p class="muted small">${esc(LESS)}</p>`
        : ''
    }
    <p class="error small" id="icsErr" role="alert" hidden></p>
    <button class="btn primary block" data-act="ics-rename-save" data-id="${esc(f.id)}">Save</button>`);
}

// True when it was one of these buttons.
export async function handleAction(act: string, el: HTMLElement, refresh: () => void): Promise<boolean> {
  if (!act.startsWith('ics-')) return false;
  const id = el.dataset.id || '';
  switch (act) {
    case 'ics-add':
      addSheet();
      return true;
    case 'ics-go': {
      const helper = !!(document.getElementById('icsHelper') as HTMLInputElement | null)?.checked;
      if (!val('icsUrl').trim()) return err('Paste the calendar link first.'), true;
      try {
        const f = F.addFeed({ name: val('icsName'), url: val('icsUrl'), helper });
        closeSheet();
        toast('Added. Reading its events…');
        refresh();
        await F.syncFeed(f.id, { manual: true });
      } catch (e) {
        err(e instanceof ConnectError ? e.message : "That didn't work. Try again.");
      }
      return true;
    }
    case 'ics-sync':
      await F.syncFeed(id, { manual: true });
      return true;
    case 'ics-rename': {
      const f = F.get(id);
      if (f) renameSheet(f);
      return true;
    }
    case 'ics-rename-save': {
      const f = F.get(id);
      if (!f) return closeSheet(), true;
      if (!F.renameFeed(id, val('icsName'))) return err('Give it a name.'), true;
      const box = document.getElementById('icsHelper') as HTMLInputElement | null;
      if (box && box.checked !== f.helper) F.setHelper(id, box.checked);
      closeSheet();
      refresh();
      void F.syncFeed(id, { manual: true });
      return true;
    }
    case 'ics-del': {
      const f = F.get(id);
      if (!f || !confirm(`Remove ${f.name}? Arise stops reading it, and its events come out of your calendar and your days.`)) return true;
      try {
        await F.removeFeed(id);
        toast(`Removed ${f.name}.`);
      } catch {
        toast("Your life log isn't ready yet. Try again in a moment.");
      }
      refresh();
      return true;
    }
  }
  return false;
}
