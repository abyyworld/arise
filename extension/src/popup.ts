// The extension's menu (the toolbar button), and the small window that opens to compare the 4
// words while linking (popup.html?pair=1). Built with DOM calls, never HTML strings.

import { api, ARISE } from './api';
import { POPUP_NS, type PopupRequest, type PopupState } from './lib/recorder';

const main = document.getElementById('main')!;
const inWindow = new URLSearchParams(location.search).has('pair');
// The small window that opens when a reminder is due (background.ts openBanner).
const inBanner = new URLSearchParams(location.search).has('remind');

type Child = Node | string | null | false;
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('data-')) el.dataset[k.slice(5)] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}
const button = (act: string, label: string, cls = '', data: Record<string, string> = {}) => h('button', { class: cls, 'data-act': act, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v])) }, label);

async function ask(msg: PopupRequest): Promise<PopupState | null> {
  const r = (await api.runtime.sendMessage({ ns: POPUP_NS, msg }).catch(() => null)) as PopupState | { ok: false; error: string } | null;
  if (r && 'ok' in r && r.ok === false) {
    main.prepend(h('p', { class: 'warn' }, r.error));
    return null;
  }
  return r as PopupState | null;
}

function ago(t: number) {
  if (!t) return 'not yet';
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hours = Math.round(m / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(t).toLocaleDateString();
}

// The person's own sites to skip. Shown before linking too: linking reads the last 90 days at once.
function skipBox(s: PopupState, note: string): HTMLElement {
  const skip = h('textarea', { id: 'skip', spellcheck: 'false', placeholder: 'example.com' }) as HTMLTextAreaElement;
  skip.value = s.skip.join('\n');
  return h(
    'div',
    { class: 'box' },
    h('label', { for: 'skip' }, 'Sites to skip, one per line'),
    skip,
    h('div', { class: 'row', style: 'margin-top:8px' }, button('skip', 'Save'), h('span', { class: 'saved', id: 'saved', hidden: '' }, 'Saved')),
    h('p', { class: 'small muted', style: 'margin:8px 0 0' }, note),
  );
}
const ALWAYS = 'Always skipped: banks, health portals, adult sites, password managers and sign-in pages, and private windows.';
const BEFORE = 'Add them before linking: linking also reads the last 90 days of history.';

const clock = (t: number) => {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
};

function reminderList(s: PopupState): Node[] {
  return s.unread.map((r) => h('div', { class: 'remind' }, h('b', {}, r.title), h('span', { class: 'small muted' }, `${clock(r.at)}${r.body ? `. ${r.body}` : ''}`)));
}

// The reminders' window: what's due, and nothing else.
function bannerView(s: PopupState): Node[] {
  if (!s.unread.length) return [h('p', { class: 'muted' }, 'Nothing due right now.'), button('close', 'Close', 'block')];
  return [h('p', { class: 'ok' }, s.unread.length === 1 ? 'A reminder from Arise' : `${s.unread.length} reminders from Arise`), ...reminderList(s), h('div', { class: 'row' }, button('read', 'Got it', 'primary'), button('open', 'Open Arise'))];
}

// The switch, and what's coming. Only the plain words Arise sent; nothing leaves this browser.
function remindBox(s: PopupState): HTMLElement {
  return h(
    'div',
    { class: 'box' },
    h('div', { class: 'row between' }, h('b', {}, 'Reminders here'), button('remind', s.remind ? 'On' : 'Off', s.remind ? 'primary small-btn' : 'small-btn', { on: s.remind ? '' : '1' })),
    s.remind
      ? h('p', { class: 'small muted', style: 'margin:8px 0 0' }, s.next ? `Next: ${s.next.title}, ${clock(s.next.at)}.` : 'Nothing coming up yet. Arise sends them when it is open in this browser.')
      : h('p', { class: 'small muted', style: 'margin:8px 0 0' }, 'Your to-dos with a time, your events and the morning brief, as a notification while this browser is open, even with Arise closed. Kept only in this browser.'),
    ...(s.remind && s.unread.length ? [...reminderList(s), button('read', 'Got it', 'block')] : []),
  );
}

function view(s: PopupState): Node[] {
  if (inBanner) return bannerView(s);
  if (s.pairing) {
    const link = { link: s.pairing.link };
    return [
      h(
        'div',
        { class: 'box' },
        h('h2', {}, 'Link this browser to Arise'),
        h('p', {}, 'Does Arise show these 4 words?'),
        h('p', { class: 'code' }, s.pairing.code.join(' · ')),
        h('div', { class: 'row' }, button('confirm', 'They match', 'primary', link), button('decline', "They don't match", '', link)),
      ),
      h('p', { class: 'small muted' }, 'Only press "They match" if the words are the same. Then this browser seals what it records so only that Arise can open it.'),
      skipBox(s, `${BEFORE} ${ALWAYS}`),
    ];
  }
  if (!s.linked) {
    return [
      h('p', {}, 'Not linked yet.'),
      h('p', {}, 'Open Arise, then Setup and connections, Connections, and press "Link this browser" under Browser.'),
      button('open', 'Open Arise', 'primary block'),
      h('p', { class: 'small muted' }, "Until it's linked, nothing is recorded."),
      skipBox(s, `${BEFORE} ${ALWAYS}`),
    ];
  }
  return [
    h('p', { class: 'ok' }, 'Linked to Arise'),
    button('save', 'Save this page to Arise', 'block primary'),
    h('p', { class: 'small muted', id: 'savedPage', hidden: '' }, 'Saved. It goes to Your links in Arise.'),
    h(
      'p',
      { class: 'small' },
      s.paused
        ? 'Paused. Nothing is recorded until you resume.'
        : `Recording the sites you visit, what you search, and your time on each site. It's sealed right away, so only your Arise can read it.${s.backfilling ? ' Reading the last 90 days now…' : ''}`,
    ),
    h('dl', { class: 'stats' }, h('dt', {}, 'Waiting for Arise'), h('dd', {}, s.waiting.toLocaleString()), h('dt', {}, 'Last sent'), h('dd', {}, ago(s.sent.at))),
    h('p', { class: 'small muted' }, "Arise collects them when it's open in this browser."),
    s.paused ? button('resume', 'Resume', 'block primary') : button('pause', 'Pause', 'block'),
    button('forget', 'Forget the last hour', 'block'),
    remindBox(s),
    skipBox(s, ALWAYS),
    button('unlink', 'Unlink this browser', 'block danger'),
  ];
}

let shown = '';
let editing = false;

function render(s: PopupState, { force = false } = {}) {
  document.getElementById('browserName')!.textContent = s.browser;
  // Redrawn only when something changed, and never while the list of sites is being typed.
  const key = JSON.stringify({ ...s, sent: ago(s.sent.at) });
  if ((key === shown && !force) || editing) return;
  shown = key;
  main.replaceChildren(...view(s));
}

async function refresh() {
  const s = await ask({ t: 'state' });
  if (s) render(s);
}

main.addEventListener('focusin', (e) => {
  if ((e.target as HTMLElement).id === 'skip') editing = true;
});
main.addEventListener('focusout', (e) => {
  if ((e.target as HTMLElement).id === 'skip') editing = false;
});

// A second press within a few seconds does it (menus can't show an "Are you sure?" box everywhere).
function armed(el: HTMLButtonElement, text: string): boolean {
  if (el.dataset.armed) return true;
  const was = el.textContent;
  el.dataset.armed = '1';
  el.textContent = text;
  setTimeout(() => {
    if (!el.isConnected) return;
    delete el.dataset.armed;
    el.textContent = was;
  }, 4000);
  return false;
}

main.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act!;
  const link = el.dataset.link || '';
  el.disabled = true;
  let s: PopupState | null = null;
  switch (act) {
    case 'confirm':
    case 'decline':
      s = await ask({ t: act, link });
      if (s && inWindow) return window.close();
      break;
    case 'open':
      if (inBanner) await ask({ t: 'read' });
      await api.tabs.create({ url: `${ARISE[0]}${inBanner ? '#today' : '#connect'}` });
      return window.close();
    case 'close':
      return window.close();
    case 'save': {
      // The page in front of the browser window this menu belongs to.
      const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      s = tab?.url && !tab.incognito ? await ask({ t: 'save', url: tab.url, title: tab.title }) : null;
      if (!tab?.url) main.prepend(h('p', { class: 'warn' }, 'No page to save here.'));
      if (s) {
        render(s, { force: true });
        document.getElementById('savedPage')?.removeAttribute('hidden');
        return;
      }
      break;
    }
    case 'remind':
      s = await ask({ t: 'remind', on: el.dataset.on === '1' });
      break;
    case 'read':
      s = await ask({ t: 'read' });
      if (s && inBanner) return window.close();
      break;
    case 'pause':
    case 'resume':
      s = await ask({ t: act });
      break;
    case 'forget':
      if (!armed(el, 'Press again to forget the last hour')) break;
      s = await ask({ t: 'forget' });
      break;
    case 'skip': {
      const text = (document.getElementById('skip') as HTMLTextAreaElement).value;
      editing = false;
      s = await ask({ t: 'skip', text });
      break;
    }
    case 'unlink':
      if (!armed(el, 'Press again: stop recording and delete what is waiting')) break;
      s = await ask({ t: 'unlink' });
      break;
  }
  el.disabled = false;
  if (s) {
    render(s, { force: true });
    if (act === 'skip') document.getElementById('saved')?.removeAttribute('hidden');
  }
});

void refresh();
setInterval(refresh, 1500);
