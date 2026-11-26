// Put on a gemini.google.com tab by the extension, only when Arise asks a question and only on
// the tab the extension opened for it (lib/gemini.ts). It types the question, presses send, and
// reads back the newest answer (lib/gemini-page.ts). Nothing else on the page is touched or read.

import { api } from './api';
import { ANSWER_FOR, askPage } from './lib/gemini-page';
import { MAX_PROMPT, PORT } from './lib/gemini';

const g = globalThis as { __ariseGemini?: boolean };
if (!g.__ariseGemini) {
  g.__ariseGemini = true;
  let busy = false;
  api.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT || port.sender?.id !== api.runtime.id) return;
    port.onMessage.addListener(async (m) => {
      const q = m as { t?: string; prompt?: unknown; json?: unknown; timeout?: unknown };
      if (q?.t !== 'ask' || typeof q.prompt !== 'string' || !q.prompt.trim() || q.prompt.length > MAX_PROMPT) return port.postMessage({ t: 'fail', error: 'bad' });
      if (busy) return port.postMessage({ t: 'fail', error: 'busy' });
      busy = true;
      // Tells the background it's still at it, so the browser doesn't put it to sleep meanwhile.
      const beat = setInterval(() => port.postMessage({ t: 'wait' }), 10_000);
      try {
        const timeout = typeof q.timeout === 'number' && q.timeout > 0 ? Math.min(q.timeout, ANSWER_FOR) : ANSWER_FOR;
        const r = await askPage(document, q.prompt, { json: q.json === true, timeout });
        port.postMessage(r.ok ? { t: 'done', text: r.text } : { t: 'fail', error: r.error });
      } catch {
        port.postMessage({ t: 'fail', error: 'no-box' });
      } finally {
        clearInterval(beat);
        busy = false;
      }
    });
  });
}
