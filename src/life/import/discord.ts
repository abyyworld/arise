// Discord: the data package (User Settings, Data & Privacy, Request all of my data), a zip with
//   messages/index.json          { "123": "Direct Message with anna", "456": "general in Our Server" }
//   messages/c123/channel.json   { "id": "123", "type": 1, "recipients": […] } or with "name" and "guild"
//   messages/c123/messages.json  [ { "ID": 1, "Timestamp": "2024-01-13 21:15:04", "Contents": "hi" } ]
// Older packages have messages/123/ (no "c") and messages.csv with the columns
// ID,Timestamp,Contents,Attachments (times like "2020-01-13 21:15:04.123000+00:00"). Newer
// ones may write "Messages/" with a capital. The package holds only the Player's own messages, so
// every one is theirs: "Sent 3 messages to anna on Discord".

import type { LifeEvent } from '../types';
import type { TextInput } from './types';
import { allText, ChatDays, isObj, parseJson, utcText, type Parts } from './chat';
import { jsonPaths } from './json-paths';
import { CsvRows } from './text-stream';

export const DISCORD_INDEX = /(?:^|\/)messages\/index\.json$/i;
export const DISCORD_FILE = /(?:^|\/)messages\/c?(\d+)\/(channel\.json|messages\.json|messages\.csv)$/i;

const ME = 'me';
const plural = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`;

interface Channel {
  name?: string; // from the index
  dm?: boolean;
  own?: string; // from channel.json
}

// "Direct Message with anna#0000" → { name: "anna", dm: true }.
export function indexName(v: unknown): { name: string; dm: boolean } | null {
  if (typeof v !== 'string' || !v.trim() || v === 'None') return null;
  const m = v.match(/^direct message with (.+)$/i);
  if (m) return { name: m[1].replace(/#0$/, '').trim(), dm: true };
  return { name: v.trim(), dm: false };
}

function channelName(v: unknown): { name: string; dm: boolean } | null {
  if (!isObj(v)) return null;
  const type = v.type;
  const dm = type === 1 || type === 3 || type === 'DM' || type === 'GROUP_DM';
  const guild = isObj(v.guild) && typeof v.guild.name === 'string' ? v.guild.name : '';
  const name = typeof v.name === 'string' ? v.name : '';
  if (name && guild) return { name: `#${name} in ${guild}`, dm: false };
  if (name) return { name, dm };
  return null;
}

async function* csvMessages(input: TextInput): AsyncGenerator<Record<string, unknown>> {
  const rows = new CsvRows(',');
  let head: string[] | null = null;
  const take = (r: string[]) => {
    if (!head) {
      head = r.map((c) => c.replace(/^﻿/, '').trim().toLowerCase());
      return null;
    }
    const at = head.indexOf('timestamp');
    const text = head.indexOf('contents');
    return { Timestamp: r[at], Contents: text >= 0 ? r[text] : '' };
  };
  for await (const c of input.text) for (const r of rows.push(c)) {
    const m = take(r);
    if (m) yield m;
  }
  for (const r of rows.end()) {
    const m = take(r);
    if (m) yield m;
  }
}

async function* jsonMessages(input: TextInput): AsyncGenerator<Record<string, unknown>> {
  for await (const hits of jsonPaths(input.text, (p) => p.length === 1 && typeof p[0] === 'number')) for (const h of hits) if (isObj(h.value)) yield h.value;
}

export async function* parseDiscord(parts: Parts): AsyncGenerator<LifeEvent[]> {
  const days = new ChatDays('discord', 'Discord');
  const channels = new Map<string, Channel>();
  const get = (id: string) => {
    let c = channels.get(id);
    if (!c) channels.set(id, (c = {}));
    return c;
  };
  for await (const input of parts) {
    if (DISCORD_INDEX.test(input.name)) {
      const index = parseJson(await allText(input));
      if (isObj(index))
        for (const [id, v] of Object.entries(index)) {
          const n = indexName(v);
          if (n) Object.assign(get(id), n);
        }
      continue;
    }
    const m = input.name.match(DISCORD_FILE);
    if (!m) continue;
    const id = m[1];
    const file = m[2].toLowerCase();
    if (file === 'channel.json') {
      const n = channelName(parseJson(await allText(input, 1 << 20)));
      if (n) {
        const c = get(id);
        c.own = n.name;
        c.dm ||= n.dm;
      }
      continue;
    }
    for await (const msg of file === 'messages.csv' ? csvMessages(input) : jsonMessages(input)) {
      const text = msg.Contents ?? msg.contents;
      days.add(id, { at: utcText(msg.Timestamp ?? msg.timestamp), who: ME, text: typeof text === 'string' ? text : '' });
    }
  }
  const nameOf = (id: string) => {
    const c = channels.get(id);
    // A server's channel reads better from channel.json ("#general in Our Server"); a direct
    // message from the index, which has the other person's name.
    return (c?.dm ? c?.name || c?.own : c?.own || c?.name) || (c?.dm ? 'someone' : 'a channel');
  };
  const dms = new Set([...channels].filter(([, c]) => c.dm).map(([id]) => id));
  yield* days.events({
    chat: nameOf,
    me: () => true,
    title: (chat, n, id) => `Sent ${plural(n)} ${dms.has(id) ? 'to' : 'in'} ${chat} on Discord`,
  });
}
