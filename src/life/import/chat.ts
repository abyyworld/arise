// What the message importers share (Telegram, Instagram, Messenger, X, TikTok, Snapchat, Discord,
// LinkedIn): messages are counted into one event per chat per day, the same way as a WhatsApp
// chat. Who and when are always kept; the text only as the first few messages of each day, cut
// short (the WhatsApp rule: DETAIL_MAX in all, PER_MESSAGE each). Every event is a message, the
// most private tier.

import type { LifeEvent, LifeSource } from '../types';
import type { TextInput } from './types';
import { clean, dayOf, drain, hashId } from './util';
import { DETAIL_MAX } from './whatsapp';

const PER_MESSAGE = 80;
// The earliest messages of a day kept for its detail. More than fit, since some are left out
// (no text), and files can list a day's messages newest first.
const PICKS = 12;

export interface ChatMessage {
  at: number; // ms
  who: string; // who sent it: an id or a name, the same for the same person in the whole file
  text?: string;
}

interface Day {
  chat: string;
  day: string;
  first: number;
  last: number;
  n: number;
  senders: Map<string, number>;
  picks: { at: number; who: string; text: string }[];
}

// How the counted days become events, once the whole file is read (so "me" and the chats' names
// can come from anywhere in it).
export interface ChatNames {
  chat(key: string): string; // the chat's name for people: "Anna", "Gym friends"
  me?(who: string): boolean; // the Player's own messages
  who?(who: string): string; // a sender's name for the detail (else `who` itself)
  // Words for the title: "Chatted with Anna on Telegram: 3 messages" by default.
  title?(chat: string, n: number, key: string): string;
}

const plural = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`;

export class ChatDays {
  private days = new Map<string, Day>();
  count = 0;

  constructor(
    private source: LifeSource,
    private app: string, // "Telegram"
  ) {}

  // One message in chat `key` (a stable id for the chat, or its name).
  add(key: string, m: ChatMessage): void {
    if (!Number.isFinite(m.at) || m.at <= 0) return;
    const day = dayOf(m.at);
    const id = `${key}\u0001${day}`;
    let d = this.days.get(id);
    if (!d) {
      d = { chat: key, day, first: m.at, last: m.at, n: 0, senders: new Map(), picks: [] };
      this.days.set(id, d);
    }
    this.count++;
    d.n++;
    if (m.at < d.first) d.first = m.at;
    if (m.at > d.last) d.last = m.at;
    d.senders.set(m.who, (d.senders.get(m.who) ?? 0) + 1);
    const text = clean(m.text ?? '', PER_MESSAGE * 2);
    if (!text) return;
    const p = { at: m.at, who: m.who, text };
    if (d.picks.length < PICKS) d.picks.push(p);
    else {
      // Keep the earliest: swap out the latest one kept, if this is earlier.
      let late = 0;
      for (let i = 1; i < d.picks.length; i++) if (d.picks[i].at > d.picks[late].at) late = i;
      if (m.at < d.picks[late].at) d.picks[late] = p;
    }
  }

  // Everyone who sent a message, with how many.
  senders(): Map<string, number> {
    const all = new Map<string, number>();
    for (const d of this.days.values()) for (const [s, n] of d.senders) all.set(s, (all.get(s) ?? 0) + n);
    return all;
  }

  // Each chat and the senders in it.
  chats(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const d of this.days.values()) {
      let set = out.get(d.chat);
      if (!set) out.set(d.chat, (set = new Set()));
      for (const s of d.senders.keys()) set.add(s);
    }
    return out;
  }

  *events(names: ChatNames): Generator<LifeEvent[]> {
    const out: LifeEvent[] = [];
    const days = [...this.days.values()].sort((a, b) => a.first - b.first);
    for (const d of days) {
      const chat = clean(names.chat(d.chat), 80) || 'someone';
      const e: LifeEvent = {
        id: `${this.source}:${hashId(d.chat, d.day)}`,
        source: this.source,
        kind: 'message',
        at: d.first,
        title: names.title ? names.title(chat, d.n, d.chat) : `Chatted with ${chat} on ${this.app}: ${plural(d.n)}`,
        value: d.n,
        unit: 'messages',
        tier: 3,
        meta: { chat, day: d.day },
      };
      if (d.last > d.first) e.end = d.last;
      if (names.me) {
        let sent = 0;
        for (const [s, n] of d.senders) if (names.me(s)) sent += n;
        e.meta!.sent = sent;
        e.meta!.received = d.n - sent;
      }
      const detail = detailOf(d, names);
      if (detail) e.detail = detail;
      out.push(e);
      yield* drain(out);
    }
    yield* drain(out, true);
  }
}

// The first messages of the day, the way a WhatsApp day's detail is made.
function detailOf(d: Day, names: ChatNames): string {
  const picks = [...d.picks].sort((a, b) => a.at - b.at);
  const parts: string[] = [];
  let len = 0;
  for (const p of picks) {
    if (len >= DETAIL_MAX - 10) break;
    const who = names.me?.(p.who) ? 'You' : clean(names.who ? names.who(p.who) : p.who, 60) || 'Someone';
    const piece = `${who}: ${clean(p.text, PER_MESSAGE)}`;
    const cut = clean(piece, Math.max(12, DETAIL_MAX - len));
    parts.push(cut);
    len += cut.length + 3;
  }
  return clean(parts.join(' · '), DETAIL_MAX);
}

// The people in a chat, for a name when it has none: "Anna, Ben and Cleo", "Anna, Ben and others".
export function listNames(people: string[]): string {
  const p = people.filter(Boolean);
  if (p.length <= 3) return p.join(', ').replace(/, ([^,]*)$/, ' and $1');
  return `${p.slice(0, 2).join(', ')} and others`;
}

// Meta (Instagram, Facebook) writes each UTF-8 byte of a name or a message as its own character
// ("Ã©" for "é"). Put the bytes back together; text that isn't like that stays as it is.
export function unmojibake(s: string): string {
  let high = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) return s;
    if (c >= 0x80) high = true;
  }
  if (!high) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

// A call, as its own event (as the Android app's call log makes them).
export function callEvent(source: LifeSource, app: string, c: { id: string; at: number; with: string; out: boolean; missed: boolean; secs: number }): LifeEvent {
  const secs = Math.max(0, Math.round(c.secs || 0));
  const long = secs ? ` (${secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`})` : '';
  const title = c.missed ? (c.out ? `Called ${c.with} on ${app} (no answer)` : `Missed call from ${c.with} on ${app}`) : c.out ? `Called ${c.with} on ${app}${long}` : `Call from ${c.with} on ${app}${long}`;
  const e: LifeEvent = {
    id: `${source}:call:${hashId(c.id)}`,
    source,
    kind: 'call',
    at: c.at,
    title,
    tier: 3,
    meta: { chat: c.with, direction: c.out ? 'out' : 'in', missed: c.missed },
  };
  if (secs && !c.missed) {
    e.end = c.at + secs * 1000;
    e.value = secs;
    e.unit = 's';
  }
  return e;
}

// The parts of one export, a file at a time (a zip's entries, or a single file).
export type Parts = AsyncIterable<TextInput>;

export async function* onePart(input: TextInput): AsyncGenerator<TextInput> {
  yield input;
}

// All of a small file's text (a profile, an index of channels).
export async function allText(input: TextInput, max = 8 << 20): Promise<string> {
  let s = '';
  for await (const c of input.text) {
    if (s.length < max) s += c;
  }
  return s;
}

export function parseJson(s: string): unknown {
  try {
    return JSON.parse(s.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

// Times written as UTC without a zone, with or without "UTC" after them, or with a zone:
// "2023-01-13 21:15:04", "2023-01-13 21:15:04 UTC", "2020-01-13 21:15:04.123000+00:00".
export function utcText(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return NaN;
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), ms);
  const z = m[8];
  if (z && /^[+-]/.test(z)) {
    const zm = z.match(/^([+-])(\d{2}):?(\d{2})$/)!;
    const off = (+zm[2] * 60 + +zm[3]) * 60000;
    t += zm[1] === '+' ? -off : off;
  }
  return t;
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
