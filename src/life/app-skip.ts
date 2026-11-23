// Apps Arise never reads: their notifications and the time spent in them are left out, on Android
// and from the Mac helper. Groups like the browser extension's sites to skip (extension/src/lib/
// skip.ts), on until the Player turns one off: banking and money, health, passwords and sign-in.
// Plus the Player's own picks, from the apps Arise has seen on this device. An app matches by its
// id (an Android package name or a Mac bundle id), with everything under it, or by a word in its
// id or its name, so a bank that isn't listed is still left out.
//
// The list belongs to each device (one for the Android app, one for the Mac helper), kept in
// localStorage, never synced. Android also hands it to its own recorders (NotificationRecorder.kt,
// UsageReader), so those apps are never even noted there.

import type { LifeEvent } from './types';

export type GroupId = 'money' | 'health' | 'passwords';

export interface AppGroup {
  id: GroupId;
  name: string;
  apps: string[];
  words: string[];
}

export const APP_GROUPS: AppGroup[] = [
  {
    id: 'money',
    name: 'Banking and money',
    words: ['bank', 'banking', 'creditunion', 'wallet', 'paypal', 'venmo', 'revolut', 'coinbase', 'binance', 'kraken', 'robinhood', 'payme', 'brokerage', 'trading'],
    apps: [
      'com.paypal.android.p2pmobile', 'com.venmo', 'com.squareup.cash', 'com.zellepay.zelle', 'com.transferwise.android', 'com.revolut.revolut',
      'co.uk.getmondo', 'com.starlingbank.android', 'de.number26.android', 'com.onedebit.chime', 'com.sofi.mobile', 'com.ally.MobileBanking',
      'com.discoverfinancial.mobile', 'com.americanexpress.android.acctsvcs.us', 'com.konylabs.capitalone', 'com.chase.sig.android',
      'com.wf.wellsfargomobile', 'com.infonow.bofa', 'com.citi.citimobile', 'com.usaa.mobile.android.usaa', 'com.schwab.mobile',
      'com.fidelity.android', 'com.vanguard', 'com.etrade.mobilepro.activity', 'com.robinhood.android', 'com.webull.trade', 'com.coinbase.android',
      'com.binance.dev', 'com.kraken.trade', 'co.mona.android', 'com.klarna.android', 'com.affirm.central', 'com.afterpaymobile',
      'com.creditkarma.mobile', 'com.experian.android', 'com.intuit.mint', 'com.google.android.apps.walletnfcrel', 'com.samsung.android.spay',
      'uz.dida.payme', 'uz.paynet.app', 'com.apple.Passbook', 'com.apple.stocks',
    ],
  },
  {
    id: 'health',
    name: 'Health',
    words: ['mychart', 'patient', 'telehealth', 'telemed', 'clinic', 'hospital', 'pharmacy', 'therapy', 'periodtracker', 'fertility'],
    apps: [
      'epic.mychart.android', 'com.epic.mychart', 'org.kp.m', 'com.teladoc.members', 'com.zocdoc.android', 'com.goodrx', 'com.betterhelp',
      'com.talkspace.talkspaceapp', 'com.cerebral.cerebral', 'org.iggymedia.periodtracker', 'com.clue.android', 'com.glow.android',
      'com.babylon.patient', 'uk.nhs.nhsapp', 'com.doctolib.android', 'com.healow', 'com.uhc.myuhc', 'com.aetna.aetnahealth',
      'com.cigna.mycigna', 'com.humana.myhumana', 'com.twentythree.andme', 'com.ro.ro',
    ],
  },
  {
    id: 'passwords',
    name: 'Passwords and sign-in',
    words: ['password', 'passwords', 'passkey', 'authenticator', 'keychain', 'onepassword', '1password', 'bitwarden', 'lastpass', 'dashlane', 'keepass', 'nordpass', 'authy'],
    apps: [
      'com.agilebits.onepassword', 'com.onepassword.android', 'com.1password.1password', 'com.x8bit.bitwarden', 'com.bitwarden.desktop',
      'com.lastpass.lpandroid', 'com.lastpass.LastPass', 'com.dashlane', 'com.callpod.android_apps.keeper', 'com.nordpass.android.app.password.manager',
      'com.google.android.apps.authenticator2', 'com.azure.authenticator', 'com.authy.authy', 'com.okta.android.auth', 'com.duosecurity.duomobile',
      'com.apple.Passwords', 'com.apple.keychainaccess', 'me.proton.pass.android',
    ],
  },
];

export const GROUP_IDS: GroupId[] = APP_GROUPS.map((g) => g.id);

export interface AppSkip {
  groups: Record<GroupId, boolean>; // each group on unless the Player turned it off
  own: string[]; // the Player's own picks: app ids
}

export interface SeenApp {
  id: string;
  name: string;
}

const MAX_OWN = 300;
const MAX_SEEN = 300;
const ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;

// An app id as it is, or '' if it isn't one.
export const cleanId = (v: unknown) => (typeof v === 'string' && ID.test(v.trim()) ? v.trim() : '');

export function cleanSkip(raw: unknown): AppSkip {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const g = (o.groups && typeof o.groups === 'object' ? o.groups : {}) as Record<string, unknown>;
  const own = [...new Set((Array.isArray(o.own) ? o.own : []).map(cleanId).filter(Boolean))].slice(0, MAX_OWN);
  return { groups: Object.fromEntries(GROUP_IDS.map((id) => [id, g[id] !== false])) as Record<GroupId, boolean>, own };
}

export function cleanSeen(raw: unknown): SeenApp[] {
  const out = new Map<string, SeenApp>();
  for (const x of Array.isArray(raw) ? raw : []) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const id = cleanId(o.id);
    if (!id) continue;
    const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    out.set(id, { id, name: name || id });
  }
  return [...out.values()].slice(-MAX_SEEN);
}

const covers = (id: string, app: string) => id === app.toLowerCase() || id.startsWith(`${app.toLowerCase()}.`);

// Which built-in group an app is in, if any.
export function groupOf(id: string, name = ''): GroupId | null {
  const lower = id.toLowerCase();
  const parts = lower.split('.');
  const label = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const g of APP_GROUPS) {
    if (g.apps.some((a) => covers(lower, a))) return g.id;
    // In the id, every part but a two-letter start like "uk" or "de"; in the name, anywhere.
    if (g.words.some((w) => parts.some((p) => p.length > 2 && p.includes(w)) || (label && label.includes(w)))) return g.id;
  }
  return null;
}

// Whether Arise leaves this app out.
export function skipped(id: string, name: string, skip: AppSkip): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();
  if (skip.own.some((a) => covers(lower, a))) return true;
  const g = groupOf(id, name);
  return !!g && skip.groups[g];
}

// For the Android app's own recorders: the ids and words to leave out, as one plain list each.
export function nativeList(skip: AppSkip): { apps: string[]; words: string[] } {
  const on = APP_GROUPS.filter((g) => skip.groups[g.id]);
  return { apps: [...new Set([...on.flatMap((g) => g.apps), ...skip.own])], words: [...new Set(on.flatMap((g) => g.words))] };
}

// Apps seen in these events, added to the list (the newest name wins).
export function addSeen(seen: readonly SeenApp[], apps: readonly SeenApp[]): SeenApp[] {
  const map = new Map(seen.map((a) => [a.id, a] as const));
  for (const a of apps) {
    const id = cleanId(a.id);
    if (!id) continue;
    map.delete(id);
    map.set(id, { id, name: (a.name || id).slice(0, 80) });
  }
  return [...map.values()].slice(-MAX_SEEN);
}

// ---------- each device's list

export type Where = 'android' | 'mac';
const KEY: Record<Where, string> = { android: 'arise-app-skip-android', mac: 'arise-app-skip-mac' };

export interface SkipState {
  skip: AppSkip;
  seen: SeenApp[];
}

export function load(where: Where): SkipState {
  try {
    const o = JSON.parse(localStorage.getItem(KEY[where]) || '{}');
    return { skip: cleanSkip(o?.skip), seen: cleanSeen(o?.seen) };
  } catch {
    return { skip: cleanSkip({}), seen: [] };
  }
}

export function save(where: Where, st: SkipState) {
  try {
    localStorage.setItem(KEY[where], JSON.stringify(st));
  } catch {}
}

export function forget(where: Where) {
  try {
    localStorage.removeItem(KEY[where]);
  } catch {}
}

// ---------- the events from each

// Android: notifications and app use carry the package (meta.pkg) and the app's name (meta.app).
const androidApp = (e: LifeEvent): SeenApp | null => (e.source === 'android' && (e.kind === 'notification' || e.kind === 'app') && typeof e.meta?.pkg === 'string' ? { id: e.meta.pkg, name: typeof e.meta.app === 'string' ? e.meta.app : e.meta.pkg } : null);

// The Mac helper: notifications and app use carry the bundle id (meta.app); the name is in the title.
function macApp(e: LifeEvent): SeenApp | null {
  if (e.source !== 'mac' || (e.kind !== 'notification' && e.kind !== 'app') || typeof e.meta?.app !== 'string') return null;
  const m = /^Notification from (.+)$/.exec(e.title) || /^Used (.+) for /.exec(e.title);
  return { id: e.meta.app, name: m?.[1] || e.meta.app };
}

// Leaves out the apps on the device's list, and notes the apps seen (for the Player to pick from).
export function filterEvents<T extends LifeEvent>(where: Where, events: readonly T[]): T[] {
  const st = load(where);
  const appOf = where === 'android' ? androidApp : macApp;
  const seen: SeenApp[] = [];
  const out = events.filter((e) => {
    const app = appOf(e);
    if (!app) return true;
    seen.push(app);
    return !skipped(app.id, app.name, st.skip);
  });
  if (seen.length) save(where, { ...st, seen: addSeen(st.seen, seen) });
  return out;
}
