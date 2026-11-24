// ChatGPT: the zip from Settings, Data controls, Export data. Its conversations.json is a list of
// conversations, read one at a time:
//   [{ "title": "Trip ideas", "create_time": 1714557600.123, "update_time": 1714558000.5,
//      "id": "…" (or "conversation_id"), "current_node": "c",
//      "mapping": { "a": { "id": "a", "message": null, "parent": null, "children": ["b"] },
//                   "b": { "message": { "author": { "role": "user" }, "create_time": 1714557601.2,
//                          "content": { "content_type": "text", "parts": ["Where should I go?"] } },
//                          "parent": "a", "children": ["c"] }, … } }]
// A conversation is a tree (each edit or new answer starts a branch). The thread the Player last
// saw runs from "current_node" back to the start through "parent". System and tool messages,
// hidden ones and empty parts are left out. The events are made in ai-chat.ts.

import type { LifeEvent } from '../types';
import type { AiChatInfo, TextInput } from './types';
import { aiChatEvents, listChats, type AiConversation, type AiMessage } from './ai-chat';
import { isObj } from './chat';
import { JsonItems } from './json-stream';
import { num } from './util';

type Rec = Record<string, unknown>;

const TEXT_TYPES = new Set(['text', 'multimodal_text']);
const MAX_STEPS = 100_000;

const secs = (v: unknown): number => {
  const n = num(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : NaN;
};

// The nodes of the main thread, from the start.
function thread(mapping: Rec, current: unknown): Rec[] {
  let at = typeof current === 'string' && isObj(mapping[current]) ? current : '';
  if (!at) {
    // No current node: the last message written that ends a branch.
    let best = -Infinity;
    for (const [id, node] of Object.entries(mapping)) {
      if (!isObj(node) || (Array.isArray(node.children) && node.children.length)) continue;
      const t = isObj(node.message) ? secs(node.message.create_time) : NaN;
      const score = Number.isFinite(t) ? t : 0;
      if (score > best) (best = score), (at = id);
    }
  }
  const out: Rec[] = [];
  const seen = new Set<string>();
  while (at && !seen.has(at) && out.length < MAX_STEPS) {
    seen.add(at);
    const node = mapping[at];
    if (!isObj(node)) break;
    out.push(node);
    at = typeof node.parent === 'string' ? node.parent : '';
  }
  return out.reverse();
}

function messageOf(node: Rec): { role: string; text: string; at: number } | null {
  const m = node.message;
  if (!isObj(m)) return null;
  const role = isObj(m.author) && typeof m.author.role === 'string' ? m.author.role : '';
  if (role !== 'user' && role !== 'assistant') return null;
  if (isObj(m.metadata) && m.metadata.is_visually_hidden_from_conversation === true) return null;
  const c = m.content;
  if (!isObj(c) || !TEXT_TYPES.has(String(c.content_type))) return null;
  const parts = Array.isArray(c.parts) ? c.parts.filter((p): p is string => typeof p === 'string' && !!p.trim()) : [];
  const text = parts.join('\n').trim();
  if (!text) return null;
  return { role, text, at: secs(m.create_time) };
}

// One conversation from the file, or null when it isn't one.
export function chatgptConversation(v: unknown): AiConversation | null {
  if (!isObj(v) || !isObj(v.mapping)) return null;
  const id = typeof v.conversation_id === 'string' && v.conversation_id ? v.conversation_id : typeof v.id === 'string' && v.id ? v.id : '';
  if (!id) return null;
  const start = secs(v.create_time);
  const messages: AiMessage[] = [];
  let prev = start;
  for (const node of thread(v.mapping, v.current_node)) {
    const m = messageOf(node);
    if (!m) continue;
    const at = Number.isFinite(m.at) ? m.at : prev;
    prev = at;
    messages.push({ at, me: m.role === 'user', text: m.text });
  }
  return { id, title: typeof v.title === 'string' ? v.title : '', messages };
}

async function* conversations(input: TextInput): AsyncGenerator<AiConversation> {
  const items = new JsonItems();
  for await (const chunk of input.text) {
    for (const it of items.push(chunk)) {
      const c = chatgptConversation(it.value);
      if (c) yield c;
    }
  }
}

export const listChatGPT = (input: TextInput): Promise<AiChatInfo[]> => listChats(conversations(input));

export function parseChatGPT(input: TextInput, only?: readonly string[]): AsyncGenerator<LifeEvent[]> {
  return aiChatEvents('chatgpt', 'ChatGPT', conversations(input), only);
}
