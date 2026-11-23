// X (Twitter): the archive from Settings, "Your account", "Download an archive of your data". Its
// data/ folder has the messages as JavaScript that sets a variable to JSON:
//   data/direct-messages.js        window.YTD.direct_messages.part0 = [ { "dmConversation": {
//                                    "conversationId": "111-222", "messages": [ { "messageCreate": {
//                                    "senderId": "111", "recipientId": "222", "text": "Hi",
//                                    "createdAt": "2024-01-13T21:15:04.000Z" } } ] } } ]
//   data/direct-messages-group.js  the same for groups (no recipientId; "conversationNameUpdate"
//                                    gives a group its name)
//   data/account.js                window.YTD.account.part0 = [ { "account": { "accountId": "111" } } ]
// Big archives split a file into direct-messages-part1.js and so on. Older archives call them
// direct-message.js. The archive has no names for the other people, only their numbers.

import type { LifeEvent } from '../types';
import { ChatDays, isObj, type Parts } from './chat';
import { jsonPaths, type Seg } from './json-paths';
import { isoMs } from './util';

export const X_DMS = /(?:^|\/)data\/direct-messages?(-group)?(?:-part\d+)?\.js$/i;
export const X_ACCOUNT = /(?:^|\/)data\/account\.js$/i;

function want(path: readonly Seg[]): boolean {
  if (typeof path[0] !== 'number') return false;
  if (path.length === 2) return path[1] === 'account';
  if (path[1] !== 'dmConversation') return false;
  if (path.length === 3) return path[2] === 'conversationId';
  return path.length === 4 && path[2] === 'messages' && typeof path[3] === 'number';
}

interface Convo {
  group: boolean;
  ids: Set<string>;
  name?: string;
  nameAt?: number;
}

export async function* parseX(parts: Parts): AsyncGenerator<LifeEvent[]> {
  const days = new ChatDays('x', 'X');
  const convos = new Map<string, Convo>();
  let me = '';
  for await (const input of parts) {
    const group = /group/i.test(input.name.split('/').pop()!);
    const current = new Map<number, string>(); // place in the file → conversation id
    for await (const hits of jsonPaths(input.text, want)) {
      for (const { path, value } of hits) {
        const i = path[0] as number;
        if (path[1] === 'account') {
          if (isObj(value) && value.accountId !== undefined) me = String(value.accountId);
          continue;
        }
        if (path[2] === 'conversationId') {
          if (typeof value === 'string' || typeof value === 'number') current.set(i, String(value));
          continue;
        }
        const key = current.get(i) ?? `${input.name}:${i}`;
        let c = convos.get(key);
        if (!c) {
          c = { group, ids: new Set() };
          // A one-to-one conversation's id is the two people's numbers.
          if (!group) for (const p of key.split('-')) if (/^\d+$/.test(p)) c.ids.add(p);
          convos.set(key, c);
        }
        if (!isObj(value)) continue;
        const rename = value.conversationNameUpdate;
        if (isObj(rename) && typeof rename.name === 'string') {
          const at = isoMs(rename.createdAt);
          if (!c.name || !(at < (c.nameAt ?? -Infinity))) (c.name = rename.name), (c.nameAt = at);
          continue;
        }
        const m = value.messageCreate;
        if (!isObj(m)) continue;
        const who = String(m.senderId ?? '');
        if (who) c.ids.add(who);
        days.add(key, { at: isoMs(m.createdAt), who, text: typeof m.text === 'string' ? m.text : '' });
      }
    }
  }
  // No account file: the Player is the one number in every one-to-one conversation.
  if (!me) {
    const ones = [...convos.values()].filter((c) => !c.group && c.ids.size === 2);
    if (ones.length >= 2) {
      const [a, b] = [...ones[0].ids];
      const inAll = [a, b].filter((p) => ones.every((c) => c.ids.has(p)));
      if (inAll.length === 1) me = inAll[0];
    }
  }
  const isMe = (who: string) => !!me && who === me;
  const nameOf = (key: string) => {
    const c = convos.get(key);
    if (!c) return 'someone';
    if (c.name) return c.name;
    if (c.group) return 'a group';
    const others = [...c.ids].filter((p) => p !== me);
    return me && others.length === 1 ? `X user ${others[0]}` : 'someone';
  };
  yield* days.events({ chat: nameOf, me: me ? isMe : undefined, who: (s) => `X user ${s}` });
}
