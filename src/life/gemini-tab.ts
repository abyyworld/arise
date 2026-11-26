// Gemini in your browser, Arise's side: the coach's question goes to the Arise extension in this
// browser (over the same link as the rest, browser-link.ts), which types it into Gemini in a tab
// signed in with the Player's own Google account and hands back the answer
// (extension/src/lib/gemini.ts). Less private: Google reads the question, and what goes with it
// follows the same rules as the free AI and the Player's own keys (policy.ts, engine 'tab').
//
// The question is sealed for the extension's own key and the answer for this Arise's key, so
// other extensions that can see messages on Arise's page read neither. Registers itself with the
// AI layer (ai.js useTab), so ai.js never needs the extension to work.

import { AIError, useTab } from '../ai.js';
import * as BL from './browser-link';
import { isSealedBatch, sealBatch } from '../../extension/src/lib/seal';
import { randomId } from '../../extension/src/lib/bytes';
import { MAX_PROMPT, TOTAL_FOR, parseAnswer } from '../../extension/src/lib/gemini';

// What's typed into Gemini stays well under what its box takes.
export const TARGET = 30_000;
export const KEEP = 10; // the latest turns of a chat
// Arise waits a little longer than the extension does, so the extension's own message wins.
export const WAIT_FOR = TOTAL_FOR + 10_000;
const ASKING_FOR = 3 * 60_000; // waiting for "Allow" in the extension's window

export const status = { known: false, on: false, granted: false, gkey: '', error: '' };
let hooks = { render: () => {} };

type Reply = { ok?: boolean; on?: boolean; granted?: boolean; gkey?: unknown; error?: string; box?: unknown } | null;
const apply = (r: Reply) => {
  status.known = true;
  status.on = !!r?.on;
  status.granted = !!r?.granted;
  status.gkey = r?.on && r.granted && typeof r.gkey === 'string' ? r.gkey : '';
};

export const ready = () => !!BL.here() && status.on && status.granted && !!status.gkey;

// Asks the extension again. False when there's no linked extension here to ask.
export async function check(): Promise<boolean> {
  const h = BL.here();
  const was = JSON.stringify(status);
  if (!h) Object.assign(status, { known: false, on: false, granted: false, gkey: '' });
  else {
    const r = (await h.ask({ t: 'geminiStatus', link: h.id })) as Reply;
    if (r?.ok) apply(r);
  }
  if (JSON.stringify(status) !== was) hooks.render();
  return !!h;
}

// The switch. On: the extension opens its window to allow gemini.google.com, and this keeps
// asking until it's allowed (or a few minutes have gone).
export async function setOn(on: boolean): Promise<boolean> {
  const h = BL.here();
  if (!h) return false;
  const r = (await h.ask({ t: 'geminiOn', link: h.id, on })) as Reply;
  if (!r?.ok) {
    status.error = "The Arise extension didn't answer. Reload this page and try again.";
    hooks.render();
    return false;
  }
  status.error = '';
  apply(r);
  hooks.render();
  if (on && !status.granted) watch();
  return true;
}

let watching: ReturnType<typeof setInterval> | null = null;
function watch() {
  if (watching) clearInterval(watching);
  const from = Date.now();
  watching = setInterval(async () => {
    await check().catch(() => false);
    if (status.granted || !status.on || Date.now() - from > ASKING_FOR) {
      clearInterval(watching!);
      watching = null;
    }
  }, 2000);
}

// ---------- the question, as one message

export interface PromptParts {
  system?: string;
  context?: string;
  messages: { role: string; content: string }[];
  note?: string; // the JSON the answer must be (ai.js schemaNote)
}

// Gemini gets one message: Arise's instructions, what it may know, the chat so far and the
// question. `fits`: nothing had to be left out but older turns of the chat.
export function buildPrompt({ system = '', context = '', messages, note = '' }: PromptParts, max = TARGET): { text: string; fits: boolean } {
  const turns = messages.filter((m) => m && typeof m.content === 'string').slice(-KEEP);
  while (turns.length > 1 && turns[0].role !== 'user') turns.shift();
  const last = turns.pop();
  const ask = `${last?.content || ''}${note}`;
  const make = (ctx: string, earlier: typeof turns) => {
    if (!system && !ctx && !earlier.length) return ask;
    const parts = [];
    if (system) parts.push(`Instructions from the Arise app for your answer:\n${system}`);
    if (ctx) parts.push(ctx);
    if (earlier.length) parts.push(`Our conversation so far:\n${earlier.map((m) => `${m.role === 'user' ? 'Me' : 'You'}: ${m.content}`).join('\n\n')}`);
    parts.push(`My message:\n${ask}`);
    return parts.join('\n\n');
  };
  const earlier = [...turns];
  let text = make(context, earlier);
  while (text.length > max && earlier.length) {
    earlier.shift();
    text = make(context, earlier);
  }
  if (text.length <= max) return { text, fits: true };
  // Still too long: the context is cut short, then (rarely) the message itself.
  const over = text.length - max;
  text = make(context.slice(0, Math.max(0, context.length - over - 1)), earlier);
  return { text: text.slice(0, Math.min(max, MAX_PROMPT)), fits: false };
}

// ---------- asking

const MESSAGES: Record<string, [string, string]> = {
  timeout: ['timeout', "Gemini didn't answer in time. Look at the Gemini tab in this browser, then try again."],
  'no-box': ['tab', "Arise couldn't find where to type on the Gemini page. Open gemini.google.com in this browser, check you're signed in, then try again."],
  'no-send': ['tab', "Arise couldn't press send on the Gemini page. Google may have changed the page. Try again later, or pick another AI."],
  empty: ['format', "Gemini's answer was empty. Try again."],
  busy: ['busy', 'Gemini is still answering your last question. Wait for it, then try again.'],
  off: ['no-ai', 'Turn on Gemini in your browser in Settings, AI coach first.'],
  'no-permission': ['no-ai', "Allow gemini.google.com in the Arise extension's window first (Settings, AI coach)."],
  'not-linked': ['no-ai', 'Link this browser to Arise first.'],
  tab: ['tab', "Arise couldn't open Gemini in a tab of this browser. Try again."],
  gone: ['tab', "The Arise extension didn't answer. Reload this page and try again."],
};
const fail = (code: string) => {
  const [c, msg] = MESSAGES[code] || MESSAGES.tab;
  return new AIError(c, msg);
};
const unreadable = () => new AIError('format', "Gemini sent an answer the app couldn't read. Try again.");

export async function ask(text: string, { json = false, signal, timeout = WAIT_FOR }: { json?: boolean; signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
  const h = BL.here();
  if (!h || !ready()) throw fail(h ? 'off' : 'not-linked');
  if (signal?.aborted) throw new AIError('aborted', 'Stopped.');
  const id = randomId(16);
  const now = Date.now();
  const box = await sealBatch(status.gkey, h.id, { id, from: now, to: now, n: 1 }, { v: 1, prompt: text.slice(0, MAX_PROMPT), json });
  const stopped = new Promise<'stopped'>((resolve) => signal?.addEventListener('abort', () => resolve('stopped'), { once: true }));
  const r = await Promise.race([h.ask({ t: 'gemini', link: h.id, box }, timeout) as Promise<Reply>, stopped]);
  if (r === 'stopped') throw new AIError('aborted', 'Stopped.');
  if (!r) throw fail('timeout'); // no answer in time (the link itself answers at once)
  if (!r.ok) {
    if (r.error === 'off' || r.error === 'no-permission' || r.error === 'not-linked') void check().catch(() => false);
    throw fail(r.error || 'tab');
  }
  if (!isSealedBatch(r.box) || r.box.id !== id || r.box.link !== h.id) throw unreadable();
  const answer = parseAnswer(await BL.openHere(r.box), id);
  if (!answer) throw unreadable();
  if (!answer.text.trim()) throw fail('empty');
  return answer.text;
}

// ---------- start

export function initGeminiTab(h: Partial<typeof hooks> = {}) {
  hooks = { ...hooks, ...h };
}

useTab({ ready, prompt: (p: PromptParts) => buildPrompt(p), ask });
// Linked, unlinked, or the extension said it's here: what it has may have changed.
BL.onLinkChange(() => void check().catch(() => false));
