// Reminders in a linked browser: Arise hands the Arise extension the next few days of reminders
// (to-dos with a time, your own events' reminders, the morning brief if it's on), so the browser
// shows each at its time even while Arise isn't open (extension/src/lib/remind.ts). Only while
// the switch is on, in Arise's browser panel or the extension's menu (one switch, kept in the
// extension). Sent again whenever Arise saves.
//
// What goes: a title and a line for each, in plain words unless details in notifications are on
// (like the lock screen), the time, and the quiet hours from the plan settings. Sealed for the
// extension's own key on the way (other extensions can see messages on Arise's page), never sent
// anywhere else by either side.

import * as S from '../store';
import * as EV from '../lib/events';
import * as BL from './browser-link';
import { sealBatch } from '../../extension/src/lib/seal';
import { randomId } from '../../extension/src/lib/bytes';
import type { RemindItem, RemindPack } from '../../extension/src/lib/remind';

export const DAYS = 3;
const DAY = 86_400_000;
const MAX = 60;

type Nudge = { at: number; title: string; body: string; tag: string };
let hooks = { brief: (_now: number): Nudge[] => [], now: () => Date.now() };

export const status = { on: false, known: false, sending: false, sent: 0, error: '' };

const timeOn = (k: string, hhmm: string) => {
  const [y, m, d] = k.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, h || 0, min || 0).getTime();
};

// What's coming in the next few days, soonest first: the same words the phone and the web app's
// notifications use.
export function upcoming(now = hooks.now(), days = DAYS): RemindItem[] {
  const until = now + days * DAY;
  const details = !!S.state.settings.notifyDetails;
  const out: RemindItem[] = [];
  for (const t of Object.values(S.state.todos)) {
    if (t.gone || t.done || !t.day || !t.time) continue;
    const at = timeOn(t.day, t.time);
    if (at <= now || at > until) continue;
    out.push({ id: `todo-${t.id}`, at, title: details ? t.title : 'Something on your to-do list', body: details ? 'On your to-do list in Arise.' : 'Open Arise to see it.' });
  }
  for (const r of EV.reminders(S.state.events, now, until)) out.push({ id: r.tag, at: r.at, ...EV.reminderText(r, details) });
  try {
    for (const b of hooks.brief(now) || []) if (b && b.at > now && b.at <= until) out.push({ id: b.tag, at: b.at, title: b.title, body: b.body });
  } catch {}
  const clean = out.filter((r) => /^[A-Za-z0-9:._-]{1,160}$/.test(r.id));
  return clean.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(0, MAX);
}

export function pack(now = hooks.now()): RemindPack {
  const st = S.state.settings;
  return { v: 1, made: now, items: upcoming(now), quietFrom: st.quietFrom || '', quietTo: st.quietTo || '' };
}

// ---------- talking to the extension

const reply = (r: unknown) => r as { ok?: boolean; remind?: boolean; rkey?: string; error?: string } | null;

// Whether reminders are on in this browser's extension (asked again each time).
export async function check(): Promise<{ on: boolean; rkey?: string } | null> {
  const h = BL.here();
  if (!h) {
    status.known = false;
    return null;
  }
  const s = reply(await h.ask({ t: 'status', link: h.id }));
  if (!s?.ok) return null;
  status.on = !!s.remind;
  status.known = true;
  return { on: status.on, ...(s.rkey ? { rkey: s.rkey } : {}) };
}

// The switch in Arise's browser panel. On: the list goes straight away.
export async function setOn(on: boolean): Promise<boolean> {
  const h = BL.here();
  if (!h) return false;
  const r = reply(await h.ask({ t: 'remindOn', link: h.id, on }));
  if (!r?.ok) return false;
  status.on = !!r.remind;
  status.known = true;
  if (status.on) await send();
  return true;
}

// Sends the list again, sealed for the extension. Says how many went (0 with nothing to send to).
export async function send(): Promise<number> {
  const h = BL.here();
  if (!h) return 0;
  const s = await check();
  if (!s?.on || !s.rkey) return 0;
  const now = hooks.now();
  const p = pack(now);
  const times = p.items.map((r) => r.at);
  const meta = { id: randomId(16), from: times.length ? Math.min(...times) : now, to: times.length ? Math.max(...times) : now, n: p.items.length };
  try {
    const box = await sealBatch(s.rkey, h.id, meta, p);
    const r = reply(await h.ask({ t: 'remind', link: h.id, box }, 8000));
    if (!r?.ok) throw new Error(r?.error || 'no answer');
    status.sent = now;
    status.error = '';
    return p.items.length;
  } catch {
    status.error = "Couldn't hand the reminders to this browser. They'll go again next time Arise saves.";
    return 0;
  }
}

// ---------- start

let timer: ReturnType<typeof setTimeout> | null = null;
function soon(ms = 1500) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void send().catch(() => {});
  }, ms);
}

export function initBrowserRemind(h: Partial<typeof hooks> = {}) {
  hooks = { ...hooks, ...h };
  S.onSave(() => soon());
  // Linked again, or the extension said it's here: what it has may be out of date.
  BL.onLinkChange(() => soon(500));
  // Once a day at least, while Arise is open (the brief and repeats move on).
  if (typeof setInterval === 'function') setInterval(() => soon(0), 6 * 3_600_000);
  soon(3000);
}
