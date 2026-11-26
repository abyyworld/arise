// What was sent to an AI: a log, on this device only, of every request Arise makes to any AI
// (ai.js sends each one through `sentTo`, so nothing goes around it). For each: when, which AI,
// what it was for, how many characters went and in which parts, the most private part of the life
// log that AI may read, and whether an answer came back. The full text sent is kept only when the
// Player turns it on, and only for 7 days. Never synced, never in backups; "Delete all" empties it,
// and erasing this device's data does too.

export type SentAI = 'private' | 'device' | 'local' | 'free' | 'own' | 'tab';
export type Purpose = 'chat' | 'daily' | 'reflect' | 'plan' | 'quests' | 'decision' | 'write' | 'ideas' | 'reminders' | 'memory' | 'story' | 'reads' | 'test' | 'other';
export type Answer = 'yes' | 'no' | 'stopped';

export const AI_NAMES: Record<SentAI, string> = {
  private: 'Private AI',
  device: 'AI on this device',
  local: "Your computer's AI",
  free: 'Free AI',
  own: 'Your own key',
  tab: 'Gemini in your browser',
};

export const PURPOSES: Record<Purpose, string> = {
  chat: 'Coach chat',
  daily: 'Daily message',
  reflect: 'Thoughts on your day',
  plan: 'Workout plan',
  quests: 'Quest ideas',
  decision: 'Help me decide',
  write: 'Write it my way',
  ideas: 'Post ideas',
  reminders: 'Reminder texts',
  memory: 'Learning from your days',
  story: 'Day story',
  reads: 'Descriptions of notes and files',
  test: 'Test',
  other: 'Something else',
};

// Plain words for the most private part of the life log an AI may read (life/policy.ts tiers).
export const TIER_WORDS: Record<1 | 2 | 3, string> = { 1: 'your goals and quests only', 2: 'everyday notes', 3: 'sensitive notes too' };

export interface SentPart {
  name: string;
  chars: number;
}

export interface Sent {
  id: string;
  at: number;
  ms: number; // how long until the answer (or the error)
  ai: SentAI;
  who?: string; // the service, for your own key ("Claude (Anthropic)"), or the model on your computer
  for: Purpose;
  chars: number; // everything sent, in characters
  parts: SentPart[];
  tier?: 1 | 2 | 3; // with anything from the life log: the most private part that AI may read
  answer: Answer;
  why?: string; // when no answer came back
  bg?: true; // nobody asked for it just then
  text?: string; // the full text, only with the switch on, and only for 7 days
}

export const LOG_KEY = 'arise-ai-sent';
export const FULL_KEY = 'arise-ai-sent-full';
const DAY = 86_400_000;
export const KEEP_DAYS = 90;
export const TEXT_DAYS = 7;
export const MAX_ENTRIES = 1000;
export const TEXT_BUDGET = 1_500_000; // characters of full text kept in all, newest first

const AIS = Object.keys(AI_NAMES) as SentAI[];
const isAI = (v: unknown): v is SentAI => typeof v === 'string' && (AIS as string[]).includes(v);
const isPurpose = (v: unknown): v is Purpose => typeof v === 'string' && Object.hasOwn(PURPOSES, v);
const count = (v: unknown) => (Number.isFinite(v) && (v as number) >= 0 ? Math.min(Math.round(v as number), 1e13) : 0);
const words = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');

// ---------- the parts of a request

// The coach's context (ai.js buildContext) is in sections, each under a "## " heading. These are
// their names in plain words; anything new shows under its own heading.
const SECTIONS: [RegExp, string][] = [
  [/^What Arise saw/, 'What Arise saw in your days'],
  [/^(Patterns Arise found|What came with)/, 'Patterns Arise found'],
  [/^Their own ratings/, 'Your life check-in'],
  [/^Today's quests/, "Today's quests"],
  [/^To-dos/, 'To-dos'],
  [/^(Money owed|Groceries)/, 'Money owed and groceries'],
  [/^Money, from/, 'Money from your bank statements'],
  [/^Calendar/, 'Your calendar'],
  [/^Arise's plan/, 'Your plan for the day'],
  [/^People/, 'People you keep in touch with'],
  [/^Decisions/, 'Past decisions'],
  [/^Profile/, 'Profile'],
  [/^Goals/, 'Goals'],
  [/^Study/, 'Study'],
  [/^(Status|The last two weeks)/, 'Streak and the last two weeks'],
  [/^(Current plan|Workouts|Exercise trends|Older history|Body)/, 'Workouts and body'],
  [/^Daily check-ins/, 'Check-ins'],
  [/^What Arise knows/, 'What Arise knows about you'],
  [/^From the Player's life log/, 'Life log notes'],
];
// The parts that come from the life log, whose privacy depends on the AI (policy.ts).
export const LIFE_PARTS = new Set(['What Arise saw in your days', 'Patterns Arise found', 'Money from your bank statements', 'People you keep in touch with', 'What Arise knows about you', 'Life log notes']);

const sectionName = (heading: string) => {
  const h = heading.replace(/\s*\(.*$/, '').trim();
  for (const [re, name] of SECTIONS) if (re.test(h)) return name;
  return h.replace(/the Player's/g, 'your').replace(/the Player/g, 'you').slice(0, 60) || 'Other';
};

// The context, split into its sections, with the characters in each (the same name adds up).
export function contextParts(context: string): SentPart[] {
  const out = new Map<string, number>();
  const add = (name: string, n: number) => n > 0 && out.set(name, (out.get(name) || 0) + n);
  let name = "Today's date";
  let n = 0;
  for (const line of String(context || '').split('\n')) {
    const m = /^## (.+)/.exec(line);
    if (m) {
      add(name, n);
      name = sectionName(m[1]);
      n = 0;
    }
    n += line.length + 1;
  }
  add(name, n ? n - 1 : 0);
  return [...out].map(([k, v]) => ({ name: k, chars: v }));
}

// What the messages are, by what the request was for.
const ASKED: Partial<Record<Purpose, string>> = {
  memory: 'Your days from the life log',
  story: 'Your day from the life log',
  reads: 'The note or file to describe',
  write: 'Your notes and writing sample',
  test: 'A test line',
};

export function messageParts(purpose: Purpose, messages: readonly { role?: string; content?: unknown }[]): SentPart[] {
  const len = (m: { content?: unknown }) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length);
  if (!messages.length) return [];
  if (purpose === 'chat') {
    const last = messages[messages.length - 1];
    const before = messages.slice(0, -1).reduce((a, m) => a + len(m), 0);
    return [{ name: 'Your message', chars: len(last) }, ...(before ? [{ name: 'Earlier messages in this chat', chars: before }] : [])];
  }
  return [{ name: ASKED[purpose] || 'What Arise asked', chars: messages.reduce((a, m) => a + len(m), 0) }];
}

// ---------- one entry

export interface NoteInput {
  at?: number;
  ms?: number;
  ai: SentAI;
  who?: string;
  for?: string;
  background?: boolean;
  instructions?: string;
  context?: string;
  messages?: readonly { role?: string; content?: unknown }[];
  cap?: number; // the highest tier of the life log that AI may read
  error?: { code?: string; message?: string } | null;
}

// Requests that never left the device: nothing to log.
const NOT_SENT = new Set(['no-ai', 'attestation', 'no-account', 'no-key', 'no-provider', 'no-base', 'wrong-service', 'confirm-host', 'web-only', 'consent', 'weak', 'changed']);
export const wasSent = (err: NoteInput['error']) => !err || !NOT_SENT.has(String(err.code || ''));

let seq = 0;
const newId = (at: number) => `${at.toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 6)}`;

export function makeEntry(o: NoteInput, full = false): Sent {
  const at = o.at ?? Date.now();
  const purpose: Purpose = isPurpose(o.for) ? o.for : 'other';
  const msgs = o.messages || [];
  const parts = [...(o.instructions ? [{ name: "Arise's instructions (the same each time)", chars: o.instructions.length }] : []), ...contextParts(o.context || ''), ...messageParts(purpose, msgs)].filter((p) => p.chars > 0);
  const chars = parts.reduce((a, p) => a + p.chars, 0);
  const life = parts.some((p) => LIFE_PARTS.has(p.name)) || ['memory', 'story', 'reads'].includes(purpose);
  const cap = o.cap === 1 || o.cap === 2 || o.cap === 3 ? o.cap : 0;
  const err = o.error;
  const answer: Answer = !err ? 'yes' : err.code === 'aborted' ? 'stopped' : 'no';
  const e: Sent = { id: newId(at), at, ms: count(o.ms), ai: o.ai, ...(o.who ? { who: words(o.who, 80) } : {}), for: purpose, chars, parts, answer };
  if (life && cap) e.tier = cap;
  if (answer === 'no') e.why = words(err?.message || 'No answer came back.', 200);
  if (o.background) e.bg = true;
  if (full) {
    const msgText = msgs.map((m) => `[${m.role === 'assistant' ? 'Earlier answer' : 'Message'}]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n');
    e.text = [o.instructions, o.context, msgText].filter(Boolean).join('\n\n');
  }
  return e;
}

// ---------- kept on this device

function cleanPart(raw: unknown): SentPart | null {
  const p = raw as Partial<SentPart> | null;
  const name = words(p?.name, 80);
  return name ? { name, chars: count(p?.chars) } : null;
}

export function cleanSent(raw: unknown): Sent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const at = count(r.at);
  if (!at || typeof r.id !== 'string' || !/^[a-z0-9]{1,40}$/.test(r.id) || !isAI(r.ai)) return null;
  const parts = Array.isArray(r.parts) ? r.parts.map(cleanPart).filter((p): p is SentPart => !!p).slice(0, 40) : [];
  const answer: Answer = r.answer === 'no' || r.answer === 'stopped' ? r.answer : 'yes';
  const out: Sent = { id: r.id, at, ms: count(r.ms), ai: r.ai, for: isPurpose(r.for) ? r.for : 'other', chars: count(r.chars), parts, answer };
  const who = words(r.who, 80);
  if (who) out.who = who;
  if (r.tier === 1 || r.tier === 2 || r.tier === 3) out.tier = r.tier;
  if (answer === 'no') out.why = words(r.why, 200) || 'No answer came back.';
  if (r.bg === true) out.bg = true;
  if (typeof r.text === 'string' && r.text) out.text = r.text;
  return out;
}

// Oldest out first: 90 days and 1,000 entries at most; the full text for 7 days, and only as much
// as fits (the newest first).
export function prune(list: readonly Sent[], now = Date.now()): Sent[] {
  const kept = list
    .filter((e) => e.at > now - KEEP_DAYS * DAY && e.at <= now + DAY)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ENTRIES);
  let budget = TEXT_BUDGET;
  return kept.map((e) => {
    if (e.text === undefined) return e;
    const { text, ...rest } = e;
    if (e.at <= now - TEXT_DAYS * DAY || text.length > budget) return rest;
    budget -= text.length;
    return e;
  });
}

const listeners = new Set<() => void>();
export function onSentChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => {
  try {
    fn();
  } catch {}
});

function read(): Sent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    return Array.isArray(raw) ? raw.map(cleanSent).filter((e): e is Sent => !!e) : [];
  } catch {
    return [];
  }
}

function write(list: Sent[]) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list));
  } catch {
    // Full: the full texts go first, then the oldest entries.
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(list.map(({ text: _t, ...rest }) => rest).slice(0, MAX_ENTRIES / 2)));
    } catch {}
  }
}

// Newest first, pruned. `ai`: only that AI.
export function sentList({ ai, now = Date.now() }: { ai?: SentAI | '' ; now?: number } = {}): Sent[] {
  const list = prune(read(), now);
  return ai ? list.filter((e) => e.ai === ai) : list;
}

// Keeps one request. Returns it, or null when nothing left the device.
export function noteSent(o: NoteInput): Sent | null {
  if (!wasSent(o.error)) return null;
  const e = makeEntry(o, fullText());
  write(prune([e, ...read()], Math.max(Date.now(), e.at)));
  changed();
  return e;
}

export function deleteAllSent() {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {}
  changed();
}

// Keeping the full text: off unless the Player turns it on, on this device.
export function fullText(): boolean {
  try {
    return localStorage.getItem(FULL_KEY) === '1';
  } catch {
    return false;
  }
}
export function setFullText(on: boolean) {
  try {
    if (on) localStorage.setItem(FULL_KEY, '1');
    else localStorage.removeItem(FULL_KEY);
  } catch {}
  // Turned off: the texts kept so far go too.
  if (!on) write(read().map(({ text: _t, ...rest }) => rest));
  changed();
}

// Erasing this device's data.
export function forgetSent() {
  try {
    localStorage.removeItem(FULL_KEY);
  } catch {}
  deleteAllSent();
}

// The AIs that have had something, for the filter, most used first.
export function sentAIs(list: readonly Sent[]): SentAI[] {
  const n = new Map<SentAI, number>();
  for (const e of list) n.set(e.ai, (n.get(e.ai) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || AIS.indexOf(a[0]) - AIS.indexOf(b[0])).map(([k]) => k);
}

// "12,400 characters" in short: "12.4k characters".
export function charsText(n: number): string {
  if (n < 1000) return `${n} character${n === 1 ? '' : 's'}`;
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k characters`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m characters`;
}
