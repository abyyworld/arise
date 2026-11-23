// Instagram and Facebook Messenger: Meta's "Download your information" in JSON. Each chat is a
// folder with its messages in message_1.json, message_2.json… (newest first):
//   your_instagram_activity/messages/inbox/anna_1234567890/message_1.json   (Instagram)
//   your_facebook_activity/messages/inbox/anna_1234567890/message_1.json    (Facebook)
//   messages/inbox/…                                                          (older exports)
// Facebook also has archived_threads/ and e2ee_cutover/ (chats from after end-to-end encryption).
//   { "participants": [{ "name": "Anna" }, { "name": "Sam" }],
//     "messages": [{ "sender_name": "Anna", "timestamp_ms": 1705180504000, "content": "Hi" }],
//     "title": "Anna", "thread_path": "inbox/anna_1234567890" }
// Meta writes each UTF-8 byte as its own character, so names and text are put back together
// (unmojibake). Who the Player is: the name in the export's profile file, else the one person in
// every chat, else in a chat of two named after the other one, whoever is left.

import type { LifeEvent, LifeSource } from '../types';
import { allText, callEvent, ChatDays, isObj, listNames, parseJson, unmojibake, type Parts } from './chat';
import { jsonPaths, type Seg } from './json-paths';
import { drain, num } from './util';

// The chat folder of a message file: "inbox/anna_123/message_1.json" → "anna_123".
export const META_THREAD = /(?:^|\/)messages\/(inbox|archived_threads|e2ee_cutover)\/([^/]+)\/message_\d+\.json$/i;
// The files that say who the Player is.
export const META_PROFILE = /(?:^|\/)(?:personal_information\/)?(?:personal_information\/personal_information|profile_information\/profile_information)\.json$/i;

interface Thread {
  title?: string;
  people: Set<string>;
}

function want(path: readonly Seg[]): boolean {
  if (path.length === 1) return path[0] === 'title' || path[0] === 'threadName';
  return path.length === 2 && (path[0] === 'messages' || path[0] === 'participants') && typeof path[1] === 'number';
}

// Names in the profile file: Instagram's "Name" (and "Username"), Facebook's full name.
export function profileNames(v: unknown): string[] {
  const out: string[] = [];
  const visit = (x: unknown, depth: number) => {
    if (depth > 8 || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach((y) => visit(y, depth + 1));
    const o = x as Record<string, unknown>;
    if (typeof o.full_name === 'string') out.push(o.full_name);
    for (const k of ['Name', 'Username']) {
      const f = o[k];
      if (isObj(f) && typeof f.value === 'string') out.push(f.value);
    }
    for (const y of Object.values(o)) visit(y, depth + 1);
  };
  visit(v, 0);
  return [...new Set(out.map((s) => unmojibake(s).trim()).filter(Boolean))];
}

export async function* parseMeta(parts: Parts, app: 'instagram' | 'messenger'): AsyncGenerator<LifeEvent[]> {
  const source: LifeSource = app;
  const label = app === 'instagram' ? 'Instagram' : 'Messenger';
  const days = new ChatDays(source, label);
  const threads = new Map<string, Thread>();
  const mine = new Set<string>();
  const calls: { key: string; id: string; at: number; who: string; secs: number }[] = [];
  for await (const input of parts) {
    if (META_PROFILE.test(input.name)) {
      for (const n of profileNames(parseJson(await allText(input)))) mine.add(n);
      continue;
    }
    // The chat: its folder, the same in every export; a file on its own is a chat of its own.
    const key = input.name.match(META_THREAD)?.[2] ?? input.name.split('/').pop()!;
    let t = threads.get(key);
    if (!t) threads.set(key, (t = { people: new Set() }));
    for await (const hits of jsonPaths(input.text, want)) {
      for (const { path, value } of hits) {
        if (path[0] === 'title' || path[0] === 'threadName') {
          if (typeof value === 'string' && value.trim()) t.title = unmojibake(value);
          continue;
        }
        if (!isObj(value)) continue;
        if (path[0] === 'participants') {
          const n = typeof value.name === 'string' ? unmojibake(value.name) : '';
          if (n) t.people.add(n);
          continue;
        }
        const who = unmojibake(String(value.sender_name ?? value.senderName ?? ''));
        const at = num(value.timestamp_ms ?? value.timestamp);
        if (!Number.isFinite(at)) continue;
        const type = String(value.type ?? '');
        if (type === 'Subscribe' || type === 'Unsubscribe') continue; // someone joined or left
        if (type === 'Call') {
          calls.push({ key, id: `${key}:${at}`, at, who, secs: num(value.call_duration) || 0 });
          continue;
        }
        const raw = value.content ?? value.text;
        days.add(key, { at, who, text: typeof raw === 'string' ? unmojibake(raw) : '' });
        if (who) t.people.add(who);
      }
    }
  }
  const me = whoIsMe(threads, mine);
  const isMe = (n: string) => me.has(n);
  const nameOf = (key: string) => {
    const t = threads.get(key);
    if (t?.title) return t.title;
    return listNames([...(t?.people ?? [])].filter((p) => !isMe(p))) || 'someone';
  };
  yield* days.events({ chat: nameOf, me: me.size ? isMe : undefined });
  const out: LifeEvent[] = [];
  for (const c of calls) {
    out.push(callEvent(source, label, { id: c.id, at: c.at, with: nameOf(c.key), out: isMe(c.who), missed: !c.secs, secs: c.secs }));
    yield* drain(out);
  }
  yield* drain(out, true);
}

function whoIsMe(threads: Map<string, Thread>, named: Set<string>): Set<string> {
  const all = [...threads.values()].filter((t) => t.people.size);
  if (named.size) {
    // The profile's name, as the chats write it.
    const inChats = new Set<string>();
    for (const t of all) for (const p of t.people) if (named.has(p)) inChats.add(p);
    if (inChats.size) return inChats;
  }
  if (all.length >= 2) {
    const count = new Map<string, number>();
    for (const t of all) for (const p of t.people) count.set(p, (count.get(p) ?? 0) + 1);
    const best = [...count].filter(([, n]) => n === all.length);
    if (best.length === 1) return new Set([best[0][0]]);
  }
  // A chat of two named after one of them: the other is the Player.
  const me = new Set<string>();
  for (const t of all) {
    if (t.people.size !== 2 || !t.title || !t.people.has(t.title)) continue;
    for (const p of t.people) if (p !== t.title) me.add(p);
  }
  return me.size === 1 ? me : new Set();
}
