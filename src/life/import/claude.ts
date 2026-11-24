// Claude: the zip from Settings, Privacy, Export data. Its conversations.json is a list of
// conversations, read one at a time so a big file never has to be in memory at once:
//   [{ "uuid": "…", "name": "Trip ideas", "created_at": "2024-05-01T10:00:00.000000Z",
//      "updated_at": "…", "chat_messages": [
//        { "uuid": "…", "sender": "human", "text": "Where should I go?",
//          "content": [{ "type": "text", "text": "Where should I go?" }],
//          "created_at": "2024-05-01T10:00:01.000000Z" },
//        { "sender": "assistant", … } ] }]
// The events are made in ai-chat.ts.

import type { LifeEvent } from '../types';
import type { AiChatInfo, TextInput } from './types';
import { aiChatEvents, listChats, piecesText, type AiConversation, type AiMessage } from './ai-chat';
import { isObj } from './chat';
import { JsonItems } from './json-stream';
import { isoMs } from './util';

// One conversation from the file, or null when it isn't one.
export function claudeConversation(v: unknown): AiConversation | null {
  if (!isObj(v) || !Array.isArray(v.chat_messages)) return null;
  const id = typeof v.uuid === 'string' && v.uuid ? v.uuid : '';
  if (!id) return null;
  const start = isoMs(v.created_at);
  const messages: AiMessage[] = [];
  let prev = Number.isFinite(start) ? start : NaN;
  for (const m of v.chat_messages) {
    if (!isObj(m)) continue;
    if (m.sender !== 'human' && m.sender !== 'assistant') continue;
    // The pieces of text when there are any (newer exports), else the text on its own.
    const text = (piecesText(m.content) || (typeof m.text === 'string' ? m.text : '')).trim();
    if (!text) continue;
    let at = isoMs(m.created_at);
    if (!Number.isFinite(at)) at = prev;
    prev = at;
    messages.push({ at, me: m.sender === 'human', text });
  }
  return { id, title: typeof v.name === 'string' ? v.name : '', messages };
}

async function* conversations(input: TextInput): AsyncGenerator<AiConversation> {
  const items = new JsonItems();
  for await (const chunk of input.text) {
    for (const it of items.push(chunk)) {
      const c = claudeConversation(it.value);
      if (c) yield c;
    }
  }
}

export const listClaude = (input: TextInput): Promise<AiChatInfo[]> => listChats(conversations(input));

export function parseClaude(input: TextInput, only?: readonly string[]): AsyncGenerator<LifeEvent[]> {
  return aiChatEvents('claude', 'Claude', conversations(input), only);
}
