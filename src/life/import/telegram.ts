// Telegram: the export Telegram Desktop makes (Settings, Advanced, Export Telegram data) in
// "Machine-readable JSON", a result.json. A full export holds every chat under "chats" > "list"
// (and chats left under "left_chats"), with "personal_information" saying who the Player is; a
// single chat's export (from the chat's ⋮ menu) is that chat on its own:
//   { "name": "Anna", "type": "personal_chat", "id": 123, "messages": [
//     { "id": 1, "type": "message", "date": "2024-01-13T21:15:04", "date_unixtime": "1705176904",
//       "from": "Anna", "from_id": "user123", "text": "Hi" or ["Hi ", { "type": "bold", "text": "you" }] },
//     { "type": "service", "actor": "Anna", "actor_id": "user123", "action": "phone_call",
//       "duration_seconds": 300, "discard_reason": "hangup" } ] }
// One event per chat per day (chat.ts), and calls as calls. Channels and Saved Messages are left
// out: they aren't talking with anyone.

import type { LifeEvent } from '../types';
import type { TextInput } from './types';
import { callEvent, ChatDays, isObj, listNames, type Parts } from './chat';
import { jsonPaths, type Seg } from './json-paths';
import { drain, localMs, num } from './util';

const SKIP_TYPES = new Set(['public_channel', 'private_channel', 'saved_messages']);
const FIELDS = new Set(['name', 'type', 'id']);

interface Chat {
  name?: string;
  type?: string;
  id?: string;
}

// The time of a message: its Unix time when it has one, else the clock time it was written with.
function timeOf(m: Record<string, unknown>): number {
  const unix = num(m.date_unixtime);
  if (Number.isFinite(unix) && unix > 0) return unix * 1000;
  const t = typeof m.date === 'string' && m.date.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  return t ? localMs(+t[1], +t[2], +t[3], +t[4], +t[5], +(t[6] || 0)) : NaN;
}

// Telegram's text is a string, or a list of strings and pieces like { "type": "link", "text": "…" }.
export function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (typeof p === 'string' ? p : isObj(p) && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

// Where a value sits: [where, place in the list, field] for a full export, [field] for one chat.
function want(path: readonly Seg[]): boolean {
  const n = path.length;
  if (n === 1) return path[0] === 'personal_information' || FIELDS.has(path[0] as string);
  if (n === 2) return path[0] === 'messages' && typeof path[1] === 'number';
  if ((path[0] !== 'chats' && path[0] !== 'left_chats') || path[1] !== 'list' || typeof path[2] !== 'number') return false;
  if (n === 4) return FIELDS.has(path[3] as string);
  return n === 5 && path[3] === 'messages' && typeof path[4] === 'number';
}

export async function* parseTelegram(parts: Parts): AsyncGenerator<LifeEvent[]> {
  const days = new ChatDays('telegram', 'Telegram');
  const chats = new Map<string, Chat>(); // by where it is in the file ("chats:3", "one")
  const names = new Map<string, string>(); // sender id → the name last seen
  const me = new Set<string>();
  const calls: { key: string; id: string; at: number; who: string; secs: number; missed: boolean; group: boolean }[] = [];
  const out: LifeEvent[] = [];
  for await (const input of parts) {
    for await (const hits of readOne(input)) {
      for (const { path, value } of hits) {
        if (path[0] === 'personal_information') {
          if (isObj(value) && value.user_id !== undefined) me.add(`user${value.user_id}`);
          continue;
        }
        const one = path[0] !== 'chats' && path[0] !== 'left_chats';
        const where = one ? `${input.name}` : `${input.name}\u0001${path[0]}:${path[2]}`;
        let chat = chats.get(where);
        if (!chat) chats.set(where, (chat = {}));
        const field = one ? path[0] : path[3];
        if (field !== 'messages') {
          if (field === 'name') chat.name = typeof value === 'string' ? value : '';
          else if (field === 'type' && typeof value === 'string') chat.type = value;
          else if (field === 'id' && (typeof value === 'number' || typeof value === 'string')) chat.id = String(value);
          continue;
        }
        if (!isObj(value) || (chat.type && SKIP_TYPES.has(chat.type))) continue;
        const key = chat.id ?? where;
        const at = timeOf(value);
        if (value.type === 'message') {
          const who = String(value.from_id ?? value.from ?? '');
          if (typeof value.from === 'string' && value.from) names.set(who, value.from);
          days.add(key, { at, who, text: textOf(value.text) });
        } else if (value.type === 'service' && (value.action === 'phone_call' || value.action === 'group_call') && Number.isFinite(at)) {
          const who = String(value.actor_id ?? value.actor ?? '');
          if (typeof value.actor === 'string' && value.actor) names.set(who, value.actor);
          const reason = String(value.discard_reason ?? '');
          calls.push({ key, id: `${key}:${value.id ?? at}`, at, who, secs: num(value.duration_seconds) || 0, missed: reason === 'missed' || reason === 'busy', group: value.action === 'group_call' });
        }
      }
    }
  }
  // Who the Player is: the account in the export, and in a one-to-one chat (whose id is the other
  // person's), whoever isn't the other person.
  const byKey = new Map<string, Chat>();
  for (const [where, c] of chats) byKey.set(c.id ?? where, c);
  const people = days.chats();
  for (const [key, senders] of people) {
    const c = byKey.get(key);
    if (c?.type === 'personal_chat' && c.id) for (const s of senders) if (s !== `user${c.id}`) me.add(s);
  }
  const isMe = (who: string) => me.has(who);
  const nameOf = (key: string) => {
    const c = byKey.get(key);
    if (c?.name) return c.name;
    if (c?.type === 'personal_chat') return 'a deleted account';
    const others = [...(people.get(key) ?? [])].filter((s) => !isMe(s)).map((s) => names.get(s) ?? '');
    return listNames(others) || 'a group';
  };
  yield* days.events({ chat: nameOf, me: me.size ? isMe : undefined, who: (s) => names.get(s) ?? s });
  for (const c of calls) {
    const out1 = isMe(c.who);
    out.push(callEvent('telegram', 'Telegram', { id: c.id, at: c.at, with: nameOf(c.key), out: out1, missed: c.missed, secs: c.secs }));
    yield* drain(out);
  }
  yield* drain(out, true);
}

function readOne(input: TextInput) {
  return jsonPaths(input.text, want);
}
