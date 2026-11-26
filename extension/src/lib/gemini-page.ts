// On a gemini.google.com tab the extension opened: type Arise's question, press send, wait for
// the answer, and read it. Nothing else. The only thing ever clicked is the send button, and the
// only thing ever read is the newest answer, the one that came after pressing send.
//
// Gemini's page isn't made for this and Google changes it without notice, so each part is looked
// for in a few ways (SEL below). When none fits, this says so plainly instead of guessing.

export const SEL = {
  input: ['rich-textarea div.ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'textarea[aria-label]'],
  send: ['button.send-button', 'button[aria-label="Send message"]', 'button[aria-label*="Send"]'],
  // While an answer is still coming, the send button turns into a stop button.
  stop: ['button[aria-label*="Stop"]', 'button.send-button.stop'],
  answer: ['model-response', '.model-response'],
  answerText: ['message-content .markdown', '.markdown', 'message-content'],
};

export type PageError = 'no-box' | 'no-send' | 'timeout' | 'empty';
export type PageResult = { ok: true; text: string } | { ok: false; error: PageError };

export const FIND_FOR = 20_000; // the page is still loading, or the person isn't signed in
export const SEND_FOR = 5_000; // the send button turns on once there's text
export const ANSWER_FOR = 150_000;
export const SETTLE = 2_000; // the answer has stopped changing for this long
const STEP = 250;
export const MAX_ANSWER = 100_000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const first = <T extends Element>(root: ParentNode, list: string[]): T | null => {
  for (const s of list) {
    const el = root.querySelector<T>(s);
    if (el) return el;
  }
  return null;
};
const all = (root: ParentNode, list: string[]): Element[] => {
  for (const s of list) {
    const els = [...root.querySelectorAll(s)];
    if (els.length) return els;
  }
  return [];
};

const shown = (el: Element) => !el.closest('[hidden], [aria-hidden="true"]');
export const findInput = (doc: Document) => {
  const el = first<HTMLElement>(doc, SEL.input);
  return el && shown(el) ? el : null;
};
export const findSend = (doc: Document) => {
  const el = first<HTMLButtonElement>(doc, SEL.send);
  return el && !el.matches(SEL.stop.join(',')) ? el : null;
};
const usable = (b: HTMLButtonElement | null) => !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
export const answering = (doc: Document) => !!first(doc, SEL.stop);
export const answers = (doc: Document) => all(doc, SEL.answer);

// The words of one answer, as a person would copy them: blocks on lines of their own, without
// the buttons and labels around code (Gemini puts "JSON" and "Copy code" over a code block).
const SKIP = 'button, svg, mat-icon, script, style, [hidden], [aria-hidden="true"], .code-block-decoration, sources-carousel, source-footnote';
const BLOCK = /^(P|DIV|UL|OL|PRE|H[1-6]|TR|TABLE|BLOCKQUOTE|SECTION|CODE-BLOCK)$/;
function textOf(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (el.matches(SKIP)) return '';
  if (el.tagName === 'BR') return '\n';
  let out = '';
  for (const c of el.childNodes) out += textOf(c);
  if (el.tagName === 'LI') return `\n- ${out.trim()}`;
  return BLOCK.test(el.tagName) ? `\n${out}\n` : out;
}
const tidy = (s: string) =>
  s
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// The newest answer's text. With `json`, a code block in it is the answer (Gemini usually puts
// JSON in one); otherwise the whole answer.
export function answerText(el: Element, json = false): string {
  const body = first(el, SEL.answerText) || el;
  if (json) {
    const code = body.querySelector('pre code, pre, code');
    const t = code ? tidy(code.textContent || '') : '';
    if (t.startsWith('{') || t.startsWith('[')) return t.slice(0, MAX_ANSWER);
  }
  return tidy(textOf(body)).slice(0, MAX_ANSWER);
}

// Puts the question in the box the way typing would, so the page sees it and turns on send.
export function typeInto(doc: Document, el: HTMLElement, text: string) {
  el.focus();
  if (el instanceof HTMLTextAreaElement) {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  let typed = false;
  try {
    const sel = doc.getSelection();
    sel?.selectAllChildren(el);
    typed = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, text);
  } catch {}
  if (!typed || !(el.textContent || '').includes(text.slice(0, 40))) {
    el.replaceChildren(
      ...text.split('\n').map((line) => {
        const p = doc.createElement('p');
        if (line) p.textContent = line;
        else p.append(doc.createElement('br'));
        return p;
      }),
    );
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

async function waitFor<T>(clock: Clock, until: number, fn: () => T | null | false): Promise<T | null> {
  for (;;) {
    const v = fn();
    if (v) return v;
    if (clock.now() >= until) return null;
    await clock.sleep(STEP);
  }
}

// One question, start to end. `timeout`: how long the answer may take after pressing send.
export async function askPage(doc: Document, prompt: string, { json = false, timeout = ANSWER_FOR, clock = realClock } = {}): Promise<PageResult> {
  const start = clock.now();
  const input = await waitFor(clock, start + FIND_FOR, () => findInput(doc));
  if (!input) return { ok: false, error: 'no-box' };
  const before = answers(doc).length;
  typeInto(doc, input, prompt);
  const send = await waitFor(clock, clock.now() + SEND_FOR, () => {
    const b = findSend(doc);
    return usable(b) ? b : null;
  });
  if (!send) return { ok: false, error: 'no-send' };
  send.click();
  const until = clock.now() + timeout;
  let last = '';
  let since = clock.now();
  for (;;) {
    const list = answers(doc);
    const newest = list.length > before ? list[list.length - 1] : null;
    const text = newest ? answerText(newest, json) : '';
    if (text !== last) {
      last = text;
      since = clock.now();
    } else if (text && !answering(doc) && clock.now() - since >= SETTLE) {
      return { ok: true, text };
    }
    if (clock.now() >= until) return last && !answering(doc) ? { ok: true, text: last } : { ok: false, error: 'timeout' };
    await clock.sleep(STEP);
  }
}
