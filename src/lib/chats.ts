// Separate chats with the coach.
//
// Every message is still kept in one list, state.ai.chat, as before chats. Each message carries the
// id of its chat (`c`). A message without one belongs to the first chat, the one long chat from
// before chats, so an older app that drops the id still has every message, all in one list.
//
// A chat's name is made on the device from its first question. A name the Player gave it is in
// state.ai.chatNames (id -> { title, at }), the later one winning when two devices renamed it.
//
// Deleting goes by change stamps, so a device that was offline can't bring a chat back:
// stamps.chat.cleared, "Forget every chat" (as "New chat" did before chats): every message from
// before it goes, in every chat; and stamps.chat[id] < 0, one chat deleted then: its messages from
// before then go. Anything written after (on a device that didn't know yet) is new and is kept.

export const FIRST = 'first'; // the chat of messages without a chat id
export const CHAT_MAX = 400; // messages kept in all, the oldest going first
const ID = /^[a-z0-9]{1,32}$/i;

export interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  at: number;
  error?: boolean;
  tier?: 2 | 3; // the highest tier of the life log it was made from (see ai.js, chat)
  c?: string; // its chat (none: FIRST)
}
export type ChatNames = Record<string, { title: string; at: number }>;
type Stamps = Record<string, Record<string, number>>;

export const isChatId = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && v !== 'cleared';
export const chatOf = (m: Pick<ChatMsg, 'c'>) => m.c || FIRST;
export const newChatId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
// A message for `chat`: the first chat's keep no id, as before chats.
export const inChat = <T extends object>(m: T, chat: string): T & { c?: string } => (chat === FIRST ? m : { ...m, c: chat });

// Is this message deleted by the stamps (a "Forget every chat", or its chat deleted after it)?
export function gone(stamps: Stamps, m: Pick<ChatMsg, 'at' | 'c'>): boolean {
  const s = stamps.chat || {};
  if (m.at <= Math.max(0, s.cleared || 0)) return true;
  const del = s[chatOf(m)];
  return typeof del === 'number' && del < 0 && m.at <= -del;
}

// A chat's name from its first question: the first line, cut short at a word.
export function titleFrom(text: string, max = 48): string {
  const line = (text.split('\n').find((l) => l.trim()) || '').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,.;:!?]+$/, '')}…`;
}

export interface ChatInfo {
  id: string;
  title: string;
  named: boolean; // the Player gave it this name
  at: number; // when it was last used
  count: number; // messages in it
  tier: 1 | 2 | 3; // the highest tier of the life log in it
}

export const messagesOf = <T extends Pick<ChatMsg, 'c'>>(msgs: T[], chat: string): T[] => msgs.filter((m) => chatOf(m) === chat);

// Every chat, the one used last first.
export function listChats(msgs: ChatMsg[], names: ChatNames = {}): ChatInfo[] {
  const by = new Map<string, ChatInfo & { first: string }>();
  for (const m of msgs) {
    const id = chatOf(m);
    let c = by.get(id);
    if (!c) by.set(id, (c = { id, title: '', named: false, at: 0, count: 0, tier: 1, first: '' }));
    c.count++;
    c.at = Math.max(c.at, m.at);
    c.tier = Math.max(c.tier, m.tier || 1) as 1 | 2 | 3;
    if (!c.first && m.role === 'user' && !m.error && m.text.trim()) c.first = m.text;
  }
  return [...by.values()]
    .map(({ first, ...c }) => {
      const name = names[c.id]?.title?.trim();
      return { ...c, title: name || titleFrom(first) || 'A chat', named: !!name };
    })
    .sort((a, b) => b.at - a.at);
}

// The chat to open when none is: the one used last, or none (a new one) when there are none.
export const lastChat = (msgs: ChatMsg[]): string | null => (msgs.length ? chatOf(msgs.reduce((a, b) => (b.at >= a.at ? b : a))) : null);

// Every message from both copies, minus the deleted ones (by the stamps already merged).
// A message in both keeps the higher tier of the two, and its chat id where only one copy has it
// (an older app's copy drops the id).
export function mergeChat<T extends ChatMsg>(older: T[], newer: T[], stamps: Stamps): T[] {
  const seen = new Map<string, T>();
  for (const m of [...older, ...newer]) {
    const key = `${m.at}|${m.role}|${m.text.length}`;
    const had = seen.get(key);
    if (!had) {
      seen.set(key, m);
      continue;
    }
    let both = had;
    if ((m.tier || 1) > (had.tier || 1)) both = { ...both, tier: m.tier };
    if (!had.c && m.c) both = { ...both, c: m.c };
    if (both !== had) seen.set(key, both);
  }
  return [...seen.values()]
    .filter((m) => !gone(stamps, m)) // (after the ids are joined: an older app's copy of a deleted chat's message has none)
    .sort((a, b) => a.at - b.at)
    .slice(-CHAT_MAX);
}

// The names of both copies: for each chat the later one, unless the chat was deleted after it.
export function mergeChatNames(a: ChatNames, b: ChatNames, stamps: Stamps): ChatNames {
  const out: ChatNames = {};
  for (const src of [a, b]) for (const [id, n] of Object.entries(src)) if (!out[id] || n.at > out[id].at) out[id] = n;
  for (const [id, n] of Object.entries(out)) if (gone(stamps, { at: n.at, c: id })) delete out[id];
  return out;
}

// When a chat was last used, in plain words: "just now", "5 minutes ago", "today at 14:05",
// "yesterday", "on Monday", or the date.
export function usedLabel(t: number, now = Date.now()): string {
  const min = Math.floor((now - t) / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} minutes ago`;
  const d = new Date(t);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86400000);
  if (days <= 0) return `today at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `on ${d.toLocaleDateString('en-GB', { weekday: 'long' })}`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}

export function cleanChatNames(raw: unknown): ChatNames {
  const out: ChatNames = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) {
    const n = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const at = typeof n.at === 'number' && Number.isFinite(n.at) && n.at > 0 && n.at < 8.64e15 ? n.at : 0;
    if (isChatId(id) && typeof n.title === 'string' && at) out[id] = { title: n.title.replace(/\s+/g, ' ').trim().slice(0, 80), at };
  }
  return out;
}
