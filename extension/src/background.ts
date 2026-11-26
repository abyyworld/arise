// The extension's background: it listens to the browser and hands everything to the recorder
// (lib/recorder.ts), which does the work. In Chrome it's a service worker that sleeps between
// events; in Firefox an event page. Either way, what it must remember is in storage, not here.
//
// It never runs in private (incognito) windows: the manifest says "not_allowed", and any private
// tab or window that still shows up is ignored.

import { api, ARISE } from './api';
import { browserName } from './lib/events';
import { NS, type Push, parseRequest } from './lib/pairing';
import * as R from './lib/recorder';
import * as Rm from './lib/remind';
import * as G from './lib/gemini';
import { matchesPrefix } from './lib/url';

const IDLE_SECONDS = 120; // no keys or mouse for 2 minutes: away (unless the tab plays sound)
const TICK = 'tick';

const nav = navigator as Navigator & { userAgentData?: { brands: { brand: string }[]; platform: string }; brave?: unknown };
const BROWSER = browserName(navigator.userAgent, nav.userAgentData?.brands, nav.userAgentData?.platform, !!nav.brave);

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

const area = (a: typeof api.storage.local): R.KV => ({
  get: (keys) => a.get(keys),
  set: (items) => a.set(items),
  remove: (keys) => (keys.length ? a.remove(keys) : Promise.resolve()),
});

const env: R.Env = {
  now: () => Date.now(),
  local: area(api.storage.local),
  session: area(api.storage.session),
  history: {
    search: (q) => api.history.search(q),
    getVisits: (d) => api.history.getVisits(d),
  },
  browser: BROWSER,
  version: api.runtime.getManifest().version,
  arise: ARISE,
  allowed: (origin) => ARISE.some((p) => originOf(p) === origin || matchesPrefix(origin + '/', [p])),
  push,
  openConfirm,
  reminded: () => planReminders(),
};

// Tells Arise's open tabs (their content script passes it to the page).
async function push(p: Push, origin: string) {
  const tabs = await api.tabs.query({});
  for (const t of tabs) {
    if (t.id == null || !t.url || t.incognito || originOf(t.url) !== origin || !matchesPrefix(t.url, ARISE)) continue;
    api.tabs.sendMessage(t.id, { ns: NS, push: p }).catch(() => {});
  }
}

// The small window with the 4 words to compare.
let confirmWindow: number | undefined;
async function openConfirm() {
  if (confirmWindow != null) {
    try {
      await api.windows.update(confirmWindow, { focused: true });
      return;
    } catch {}
  }
  const w = await api.windows.create({ url: api.runtime.getURL('popup.html?pair=1'), type: 'popup', width: 400, height: 600, focused: true });
  confirmWindow = w.id;
}

// The page in front, if it counts as time on a site right now.
async function currentUrl(): Promise<string | null> {
  try {
    const state = await api.idle.queryState(IDLE_SECONDS);
    if (state === 'locked') return null;
    const win = await api.windows.getLastFocused({ populate: true });
    if (!win?.focused || win.incognito || win.type === 'devtools') return null;
    const tab = win.tabs?.find((t) => t.active);
    if (!tab?.url || tab.incognito) return null;
    if (state === 'idle' && !tab.audible) return null;
    return tab.url;
  } catch {
    return null;
  }
}

const look = async () => R.observe(env, await currentUrl()).catch(() => {});
const tick = async (opts: { deep?: boolean } = {}) => R.tick(env, await currentUrl(), opts).catch(() => {});

// A visit: read the history a few seconds later (its title is in by then), not a minute later.
let soon: ReturnType<typeof setTimeout> | undefined;
function tickSoon(ms = 4000) {
  clearTimeout(soon);
  soon = setTimeout(() => void tick(), ms);
}

// The count of reminders not looked at yet, or "off" while recording is paused.
async function badge() {
  const s = await R.getSettings(env);
  const unread = (await Rm.isOn(env.local)) ? (await Rm.kept(env.local)).unread.length : 0;
  await api.action.setBadgeBackgroundColor({ color: unread ? '#2a8dff' : '#5a6472' }).catch(() => {});
  await api.action.setBadgeText({ text: Rm.badgeText(unread, s.paused) }).catch(() => {});
}

// ---------- reminders (lib/remind.ts)

// One alarm for each reminder still to come, planned again whenever the list or the switch
// changes. What came due while the browser was closed (up to an hour ago) is shown now.
async function planReminders() {
  for (const a of await api.alarms.getAll().catch(() => [])) if (a.name.startsWith(Rm.ALARM)) await api.alarms.clear(a.name).catch(() => false);
  if (await Rm.isOn(env.local)) {
    const now = Date.now();
    for (const a of Rm.alarmsFor((await Rm.kept(env.local)).pack, now)) await api.alarms.create(a.name, { when: a.when });
    await showDue();
  }
  await badge();
}

const ICON = () => api.runtime.getURL('icons/icon-128.png');
let showing: Promise<void> = Promise.resolve();
function showDue(): Promise<void> {
  showing = showing.then(
    async () => {
      if (!(await Rm.isOn(env.local))) return;
      const due = Rm.dueNow(await Rm.kept(env.local), Date.now());
      if (!due.show.length && !due.skip.length) return;
      await Rm.fire(env.local, due.show, due.skip);
      await badge();
      // In the quiet hours: only the count on the button.
      if (!due.show.length || due.quiet) return;
      for (const r of due.show.slice(-3)) {
        await api.notifications.create(`arise-remind:${r.id}`, { type: 'basic', iconUrl: ICON(), title: r.title, message: r.body || 'From Arise.', priority: 1 }).catch(() => '');
      }
      await openBanner();
    },
    () => {},
  );
  return showing;
}

// The small Arise window over the page in front, with what's due. Not inside the page: the
// extension can't reach other sites, and doesn't need to.
let bannerWindow: number | undefined;
async function openBanner() {
  if (bannerWindow != null) {
    try {
      await api.windows.get(bannerWindow);
      return; // already open: it shows the new ones by itself
    } catch {
      bannerWindow = undefined;
    }
  }
  const win = await api.windows.getLastFocused().catch(() => null);
  if (!win || win.incognito) return;
  const width = 360;
  const left = typeof win.left === 'number' && typeof win.width === 'number' ? Math.max(0, win.left + win.width - width - 24) : undefined;
  const top = typeof win.top === 'number' ? win.top + 72 : undefined;
  const w = await api.windows
    .create({ url: api.runtime.getURL('popup.html?remind=1'), type: 'popup', width, height: 260, ...(left !== undefined ? { left } : {}), ...(top !== undefined ? { top } : {}), focused: false })
    .catch(() => null);
  bannerWindow = w?.id;
}

// ---------- Gemini in your browser (lib/gemini.ts)

const GEMINI_TAB = 'gemini:tab'; // the tab it opened, in session storage
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const geminiEnv: G.GeminiEnv = {
  local: area(api.storage.local),
  now: () => Date.now(),
  link: async () => R.getLink(env),
  granted: () => api.permissions.contains({ origins: [G.ORIGIN] }),
  revoke: async () => void (await api.permissions.remove({ origins: [G.ORIGIN] })),
  openAllow,
  run: askGemini,
};

// The tab this extension opened for Gemini, on a new chat (so the newest answer is the only
// one), or a new tab in the background. Never a tab the person opened themselves.
async function geminiTab(): Promise<number | null> {
  const kept = (await api.storage.session.get([GEMINI_TAB]))[GEMINI_TAB];
  if (typeof kept === 'number') {
    const t = await api.tabs.get(kept).catch(() => null);
    if (t && !t.incognito && (t.url || '').startsWith('https://gemini.google.com/')) {
      await api.tabs.update(kept, { url: G.NEW_CHAT });
      return kept;
    }
  }
  const t = await api.tabs.create({ url: G.NEW_CHAT, active: false }).catch(() => null);
  if (t?.id == null) return null;
  await api.storage.session.set({ [GEMINI_TAB]: t.id });
  return t.id;
}

async function askGemini(prompt: string, o: { json: boolean }): Promise<{ ok: true; text: string } | { ok: false; error: G.AskError }> {
  const id = await geminiTab();
  if (id == null) return { ok: false, error: 'tab' };
  const until = Date.now() + G.LOAD_FOR;
  await wait(500);
  let tab = await api.tabs.get(id).catch(() => null);
  while (tab && tab.status !== 'complete' && Date.now() < until) {
    await wait(300);
    tab = await api.tabs.get(id).catch(() => null);
  }
  if (!tab) return { ok: false, error: 'tab' };
  // Sent to Google's sign-in page: not signed in to Gemini in this browser.
  if (!(tab.url || '').startsWith('https://gemini.google.com/')) return { ok: false, error: 'no-box' };
  try {
    await api.scripting.executeScript({ target: { tabId: id }, files: ['gemini.js'] });
  } catch {
    return { ok: false, error: 'tab' };
  }
  return G.askOverPort(api.tabs.connect(id, { name: G.PORT }), prompt, o);
}

// The extension's own window that asks to allow gemini.google.com (a web page can't).
async function openAllow() {
  await api.windows.create({ url: api.runtime.getURL('allow.html'), type: 'popup', width: 420, height: 520, focused: true });
}

// ---------- "Save this page to Arise" on the menu a right click opens

const SAVE_PAGE = 'arise-save-page';
const SAVE_LINK = 'arise-save-link';
const quiet = () => void (globalThis as { chrome?: { runtime?: { lastError?: unknown } } }).chrome?.runtime?.lastError;
async function menus() {
  try {
    await api.contextMenus.removeAll();
    api.contextMenus.create({ id: SAVE_PAGE, title: 'Save this page to Arise', contexts: ['page', 'selection'] }, quiet);
    api.contextMenus.create({ id: SAVE_LINK, title: 'Save this link to Arise', contexts: ['link'] }, quiet);
  } catch {}
}

async function saved(ok: boolean, error = '') {
  const message = ok ? 'It goes to Your links next time Arise is open here.' : error;
  await api.notifications.create(`arise-saved:${Date.now()}`, { type: 'basic', iconUrl: ICON(), title: ok ? 'Saved to Arise' : "Couldn't save it", message }).catch(() => '');
}

async function start() {
  if (!(await api.alarms.get(TICK))) await api.alarms.create(TICK, { periodInMinutes: 1 });
  api.idle.setDetectionInterval(IDLE_SECONDS);
  await badge();
  // Alarms can go when the browser closes: the reminders' are planned again at each start.
  if (!started) {
    started = true;
    await planReminders();
  }
}
let started = false;

// ---------- listeners (all at the top, so a sleeping service worker wakes for them)

api.runtime.onInstalled.addListener((d) => {
  void start();
  void menus();
  // Just added: Arise pages open since before can't see it until they load again, so they do.
  if (d?.reason === 'install') void reloadArise();
});

async function reloadArise() {
  try {
    const tabs = await api.tabs.query({ url: ARISE.map((a) => `${a}*`) });
    for (const t of tabs) if (typeof t.id === 'number') await api.tabs.reload(t.id).catch(() => {});
  } catch {}
}
api.runtime.onStartup.addListener(() => {
  void start();
  void menus();
});
api.alarms.onAlarm.addListener((a) => {
  if (a.name === TICK) void tick();
  else if (a.name.startsWith(Rm.ALARM)) void showDue();
});
api.notifications.onClicked.addListener((id) => {
  void api.notifications.clear(id).catch(() => false);
  if (id.startsWith('arise-remind:')) void api.tabs.create({ url: `${ARISE[0]}#today` }).catch(() => {});
});
api.contextMenus.onClicked.addListener((info, tab) => {
  if ((info.menuItemId !== SAVE_PAGE && info.menuItemId !== SAVE_LINK) || tab?.incognito) return;
  const link = info.menuItemId === SAVE_LINK;
  const url = (link ? info.linkUrl : info.pageUrl || tab?.url) || '';
  R.savePage(env, { url, title: link ? '' : tab?.title, selection: info.selectionText, time: Date.now() }).then(
    (r) => saved(r.ok, r.ok ? '' : r.error),
    () => saved(false, 'Something went wrong. Try again.'),
  );
});
api.history.onVisited.addListener(() => tickSoon());
api.tabs.onActivated.addListener(() => void look());
api.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.status === 'complete' || change.audible !== undefined)) void look();
});
api.windows.onFocusChanged.addListener(() => void look());
api.idle.onStateChanged.addListener(() => void look());
// The last window closed: the hour so far is sealed before memory goes.
api.windows.onRemoved.addListener(async () => {
  const left = await api.windows.getAll({ windowTypes: ['normal'] }).catch(() => [{}]);
  if (!left.length) await R.flush(env).catch(() => {});
});

api.runtime.onMessage.addListener((msg, sender, respond) => {
  const m = msg as { ns?: string; msg?: unknown };
  if (sender.id !== api.runtime.id || !m || typeof m !== 'object') return;

  // From Arise's page, through the content script: only from Arise's own pages.
  if (m.ns === NS) {
    const url = sender.tab?.url || sender.url || '';
    // Gemini's questions can take minutes: they don't wait behind the recorder's work, nor it behind them.
    const g = G.parseGeminiRequest(m.msg);
    if (g && sender.tab && !sender.tab.incognito && matchesPrefix(url, ARISE)) {
      G.pageRequest(geminiEnv, g, originOf(url)).then(respond, () => respond({ ok: false, error: 'failed' }));
      return true;
    }
    const req = parseRequest(m.msg);
    if (!req || !sender.tab || sender.tab.incognito || !matchesPrefix(url, ARISE)) {
      respond({ ok: false, error: 'not-arise' });
      return;
    }
    R.pageRequest(env, req, originOf(url)).then(respond, () => respond({ ok: false, error: 'failed' }));
    return true;
  }

  // From the extension's own menu or its window with the 4 words.
  if (m.ns === R.POPUP_NS && (sender.url || '').startsWith(api.runtime.getURL(''))) {
    const req = m.msg as R.PopupRequest;
    R.popupRequest(env, req).then(
      async (r) => {
        respond(r);
        if (req.t === 'confirm' || req.t === 'resume' || req.t === 'forget') tickSoon(200);        await badge();
      },
      () => respond({ ok: false, error: 'failed' }),
    );
    return true;
  }
});

void start();
