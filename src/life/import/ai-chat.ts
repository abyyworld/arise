// What the importers of chats with AI apps share (Claude, ChatGPT, Gemini): each app's parser reads
// its export into conversations, and this makes the events. One event per conversation per day it
// was active, with the conversation's title, how many messages there were, and the Player's own
// questions (their text only: never the AI's answers), kept within the WhatsApp rule for text
// (PER_MESSAGE each, DETAIL_MAX in all). Every event carries the conversation's id in
// `meta.conv`, so the import screen can list the conversations and delete one on its own.

import type { LifeEvent, LifeSource } from '../types';
import type { AiChatInfo } from './types';
import { clean, dayOf, drain, hashId } from './util';
import { DETAIL_MAX } from './whatsapp';

const PER_MESSAGE = 80;
// The earliest questions of a day kept for its detail, more than fit, as chat.ts does.
const PICKS = 12;
const TITLE_MAX = 120;

export interface AiMessage {
  at: number; // ms
  me: boolean; // the Player's own message (else the AI's)
  text: string;
}

export interface AiConversation {
  id: string; // the app's own id for it
  title: string;
  messages: AiMessage[]; // in the order they were written
}

const plural = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`;

// A name for a conversation: its title, else the start of its first question.
export function titleOf(c: AiConversation): string {
  const t = clean(c.title, TITLE_MAX);
  if (t) return t;
  const first = c.messages.find((m) => m.me && clean(m.text, 10));
  return first ? clean(first.text, 60) : 'A chat with no title';
}

// The messages with a usable time, oldest first.
const timed = (c: AiConversation) => c.messages.filter((m) => Number.isFinite(m.at) && m.at > 0);

// How the picker lists it, or null when it has no message with a time.
export function chatInfo(c: AiConversation): AiChatInfo | null {
  const ms = timed(c);
  if (!ms.length) return null;
  let last = 0;
  for (const m of ms) if (m.at > last) last = m.at;
  return { id: c.id, title: titleOf(c), at: last, n: ms.length };
}

// The events of one conversation: one per day it was active.
export function conversationEvents(source: LifeSource, app: string, c: AiConversation): LifeEvent[] {
  const title = titleOf(c);
  const days = new Map<string, AiMessage[]>();
  for (const m of timed(c)) {
    const day = dayOf(m.at);
    let list = days.get(day);
    if (!list) days.set(day, (list = []));
    list.push(m);
  }
  const out: LifeEvent[] = [];
  for (const [day, list] of days) {
    let first = Infinity;
    let last = 0;
    let sent = 0;
    for (const m of list) {
      if (m.at < first) first = m.at;
      if (m.at > last) last = m.at;
      if (m.me) sent++;
    }
    const asked = list
      .filter((m) => m.me)
      .sort((a, b) => a.at - b.at)
      .slice(0, PICKS)
      .map((m) => clean(m.text, PER_MESSAGE))
      .filter(Boolean);
    const e: LifeEvent = {
      id: `${source}:${hashId(c.id, day)}`,
      source,
      kind: 'message',
      at: first,
      title: `Chatted with ${app}: ${title}`,
      detail: detailOf(list.length, sent, asked),
      value: list.length,
      unit: 'messages',
      tier: 3,
      meta: { chat: title, conv: c.id, day, sent, received: list.length - sent },
    };
    if (last > first) e.end = last;
    out.push(e);
  }
  return out.sort((a, b) => a.at - b.at);
}

// A summary that needs no AI: how many messages, how many were the Player's, and their questions
// in order (so the first question comes first).
export function detailOf(n: number, sent: number, asked: string[]): string {
  const head = `${plural(n)}, ${sent} from you.`;
  if (!asked.length) return head;
  const parts: string[] = [];
  let len = head.length + 10;
  for (const q of asked) {
    if (len >= DETAIL_MAX - 10) break;
    const cut = clean(q, Math.max(12, DETAIL_MAX - len));
    parts.push(cut);
    len += cut.length + 3;
  }
  return clean(`${head} You asked: ${parts.join(' · ')}`, DETAIL_MAX);
}

// Conversations as events, in batches, leaving out the ones not picked (`only`: their ids).
export async function* aiChatEvents(source: LifeSource, app: string, convs: AsyncIterable<AiConversation>, only?: readonly string[]): AsyncGenerator<LifeEvent[]> {
  const keep = only ? new Set(only) : null;
  const out: LifeEvent[] = [];
  for await (const c of convs) {
    if (keep && !keep.has(c.id)) continue;
    out.push(...conversationEvents(source, app, c));
    yield* drain(out);
  }
  yield* drain(out, true);
}

// Every conversation, as the picker lists it, newest first.
export async function listChats(convs: AsyncIterable<AiConversation>): Promise<AiChatInfo[]> {
  const out: AiChatInfo[] = [];
  const seen = new Set<string>();
  for await (const c of convs) {
    const info = chatInfo(c);
    if (!info || seen.has(info.id)) continue;
    seen.add(info.id);
    out.push(info);
  }
  return out.sort((a, b) => b.at - a.at);
}

// The text of a message written as a string or as a list of pieces ({ "type": "text", "text": … }).
export function piecesText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  const out: string[] = [];
  for (const p of v) {
    if (typeof p === 'string') out.push(p);
    else if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>;
      if ((o.type === undefined || o.type === 'text') && typeof o.text === 'string') out.push(o.text);
    }
  }
  return out.join('\n');
}
