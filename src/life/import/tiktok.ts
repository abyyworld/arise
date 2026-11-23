// TikTok: "Download your data" in JSON (Settings, Account, Download your data), a zip with
// user_data_tiktok.json (user_data.json in older ones). The messages sit under
//   "Direct Message" > "Direct Messages" > "ChatHistory" (older: "Direct Messages" > "ChatHistory")
//     > "Chat History with anna_b:" > [ { "Date": "2024-01-13 21:15:04", "From": "anna_b", "Content": "hi" } ]
// with the Player's own name under "Profile" > "Profile Information" > "ProfileMap" > "userName".
// The times are in UTC.

import type { LifeEvent } from '../types';
import { ChatDays, isObj, utcText, type Parts } from './chat';
import { jsonPaths, type Seg } from './json-paths';

export const TIKTOK = /(?:^|\/)user_data(?:_tiktok)?\.json$/i;
const ME_KEYS = new Set(['userName', 'username', 'UserName']);

function want(path: readonly Seg[]): boolean {
  const n = path.length;
  if (n >= 2 && path[n - 2] === 'ProfileMap' && ME_KEYS.has(path[n - 1] as string)) return true;
  return n >= 4 && path[n - 3] === 'ChatHistory' && typeof path[n - 1] === 'number' && /^direct messages?$/i.test(String(path[n - 4]));
}

// "Chat History with anna_b:" → "anna_b".
export const tiktokChat = (key: string): string => key.replace(/^chat history with\s*/i, '').replace(/:\s*$/, '').trim();

export async function* parseTikTok(parts: Parts): AsyncGenerator<LifeEvent[]> {
  const days = new ChatDays('tiktok', 'TikTok');
  const mine = new Set<string>();
  for await (const input of parts) {
    for await (const hits of jsonPaths(input.text, want)) {
      for (const { path, value } of hits) {
        if (typeof path[path.length - 1] === 'string') {
          if (typeof value === 'string' && value.trim()) mine.add(value.trim());
          continue;
        }
        if (!isObj(value)) continue;
        const key = tiktokChat(String(path[path.length - 2]));
        const who = String(value.From ?? value.from ?? value.Sender ?? '').trim();
        const text = value.Content ?? value.Message ?? value.content;
        days.add(key, { at: utcText(value.Date ?? value.date), who, text: typeof text === 'string' ? text : '' });
      }
    }
  }
  const chats = days.chats();
  let me = mine;
  if (!me.size) {
    // In a chat named after someone, whoever else wrote is the Player.
    me = new Set();
    for (const [key, senders] of chats) if (senders.has(key)) for (const s of senders) if (s !== key) me.add(s);
    if (me.size !== 1) me = new Set();
  }
  const isMe = (who: string) => me.has(who);
  yield* days.events({ chat: (key) => key || 'someone', me: me.size ? isMe : undefined });
}
