// @vitest-environment jsdom
// The script on the Gemini tab, against a small pretend Gemini page: it types the question,
// presses send and nothing else, waits until the answer stops changing, reads only the newest
// answer, and gives up plainly when the page isn't what it expects.

import { beforeEach, describe, expect, it } from 'vitest';
import { ANSWER_FOR, FIND_FOR, SEND_FOR, SETTLE, type Clock, answerText, askPage } from './gemini-page';

// A pretend Gemini page. `chunks`: the answer as it streams in, one piece per step after send.
function page({ box = true, sendWorks = true, chunks = ['Rest ', 'your knee ', 'today.'], answerHtml = '' } = {}) {
  document.body.innerHTML = `
    <nav><button aria-label="Main menu">Menu</button><button aria-label="New chat">New chat</button></nav>
    <div class="conversation">
      <model-response><message-content><div class="markdown"><p>An old answer from yesterday.</p></div></message-content></model-response>
    </div>
    ${box ? '<rich-textarea><div class="ql-editor" contenteditable="true"><p><br></p></div></rich-textarea>' : '<p>Sign in to Gemini</p>'}
    <button class="send-button" aria-label="Send message" aria-disabled="true">Send</button>
    <button aria-label="Share">Share</button>`;
  const clicks: string[] = [];
  document.addEventListener('click', (e) => clicks.push((e.target as Element).getAttribute('aria-label') || ''), true);
  const input = document.querySelector('.ql-editor');
  const send = document.querySelector<HTMLButtonElement>('.send-button')!;
  // Like the real page: send turns on once there's text.
  input?.addEventListener('input', () => {
    if (sendWorks && (input.textContent || '').trim()) send.setAttribute('aria-disabled', 'false');
  });
  let streaming = -1;
  let body: HTMLElement | null = null;
  send.addEventListener('click', () => {
    if (send.getAttribute('aria-disabled') === 'true') return;
    send.classList.add('stop');
    send.setAttribute('aria-label', 'Stop response');
    const r = document.createElement('model-response');
    r.innerHTML = '<message-content><div class="markdown"></div></message-content>';
    document.querySelector('.conversation')!.append(r);
    body = r.querySelector('.markdown');
    streaming = 0;
  });
  // One step of the page's own work, each time the script waits.
  const step = () => {
    if (streaming < 0 || !body) return;
    if (answerHtml) {
      body.innerHTML = answerHtml;
      streaming = chunks.length;
    } else if (streaming < chunks.length) body.textContent = (body.textContent || '') + chunks[streaming++];
    if (streaming >= chunks.length) {
      send.classList.remove('stop');
      send.setAttribute('aria-label', 'Send message');
      streaming = chunks.length;
    }
  };
  let t = 0;
  const clock: Clock = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      step();
    },
  };
  return { clicks, input, clock, now: () => t };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the Gemini tab', () => {
  it('types the question, presses only send, and reads only the newest answer once it stops changing', async () => {
    const p = page();
    const r = await askPage(document, 'Should I rest my knee?\nI ran 5 km.', { clock: p.clock });
    expect(r).toEqual({ ok: true, text: 'Rest your knee today.' });
    expect(p.input!.textContent).toContain('Should I rest my knee?');
    expect(p.input!.textContent).toContain('I ran 5 km.');
    expect(p.clicks).toEqual(['Send message']);
    expect(p.now()).toBeGreaterThanOrEqual(SETTLE); // waited for it to settle
  });

  it('reads an answer as text: paragraphs and lists, without the buttons in it', async () => {
    const p = page({
      answerHtml: '<p>Two options:</p><ul><li>Walk</li><li>Rest</li></ul><p>Pick one.<button aria-label="Copy">Copy</button></p>',
    });
    const r = await askPage(document, 'Hi', { clock: p.clock });
    expect(r).toEqual({ ok: true, text: 'Two options:\n\n- Walk\n- Rest\n\nPick one.' });
  });

  it('takes JSON from the code block Gemini puts it in, without its label or copy button', async () => {
    const p = page({
      answerHtml: '<p>Here it is:</p><code-block><div class="code-block-decoration"><span>JSON</span><button aria-label="Copy code">Copy</button></div><pre><code>{"ok": true,\n "why": "rest"}</code></pre></code-block>',
    });
    const r = await askPage(document, 'Reply with only a JSON object', { json: true, clock: p.clock });
    expect(r).toEqual({ ok: true, text: '{"ok": true,\n "why": "rest"}' });
    expect(JSON.parse((r as { text: string }).text)).toEqual({ ok: true, why: 'rest' });
    expect(p.clicks).toEqual(['Send message']);
  });

  it("says so when there's nowhere to type (signed out, or the page changed)", async () => {
    const p = page({ box: false });
    expect(await askPage(document, 'Hi', { clock: p.clock })).toEqual({ ok: false, error: 'no-box' });
    expect(p.now()).toBeGreaterThanOrEqual(FIND_FOR);
    expect(p.clicks).toEqual([]);
  });

  it("says so when send doesn't turn on, without clicking anything", async () => {
    const p = page({ sendWorks: false });
    expect(await askPage(document, 'Hi', { clock: p.clock })).toEqual({ ok: false, error: 'no-send' });
    expect(p.now()).toBeGreaterThanOrEqual(SEND_FOR);
    expect(p.clicks).toEqual([]);
  });

  it('gives up after its time when no answer comes', async () => {
    const p = page({ chunks: [] }); // an answer starts, but no words ever come
    const r = await askPage(document, 'Hi', { clock: p.clock, timeout: 30_000 });
    expect(r).toEqual({ ok: false, error: 'timeout' });
    expect(p.now()).toBeGreaterThanOrEqual(30_000);
    expect(p.now()).toBeLessThan(ANSWER_FOR);
  });

  it('keeps waiting while the answer is still coming', async () => {
    const chunks = Array.from({ length: 40 }, (_, i) => `part ${i} `);
    const p = page({ chunks });
    const r = await askPage(document, 'Hi', { clock: p.clock });
    expect(r.ok && r.text).toBe(chunks.join('').trim());
  });

  it('reads nothing outside the answer', () => {
    document.body.innerHTML = '<p>Your chats: Knee pain</p><model-response><message-content><div class="markdown"><p>Mine</p></div></message-content><button>Show drafts</button></model-response>';
    expect(answerText(document.querySelector('model-response')!)).toBe('Mine');
  });
});
