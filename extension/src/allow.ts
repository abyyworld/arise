// The window that asks to let Arise use Gemini in this browser (lib/gemini.ts). It opens when
// the person turns it on in Arise: only a page of the extension's own, after a click there, can
// ask the browser for gemini.google.com. Also where it's turned off again. Built with DOM calls.

import { api } from './api';
import * as G from './lib/gemini';

const main = document.getElementById('main')!;
const kv = api.storage.local;

function h(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}
function button(label: string, cls: string, onClick: () => void) {
  const b = h('button', { class: cls }, label);
  b.addEventListener('click', onClick);
  return b;
}

const SEES =
  'Arise types its question into Gemini in a tab of this browser, with your own Google account, and reads back the answer. Google sees each question, with what Arise sends to help answer it, and keeps it in your Gemini activity like any chat you have there.';
const ONLY = 'The extension gets access to gemini.google.com and no other site. It never clicks anything there but the send button, and reads only the answer to its own question.';

async function draw() {
  const link = (await kv.get(['link'])).link as { id?: string } | undefined;
  const granted = await api.permissions.contains({ origins: [G.ORIGIN] }).catch(() => false);
  const on = !!link?.id && (await G.isOn(kv, link.id));
  if (!on && granted) await api.permissions.remove({ origins: [G.ORIGIN] }).catch(() => false);
  main.replaceChildren();
  if (!link?.id) {
    main.append(h('p', {}, 'Link this browser to Arise first.'), button('Close', 'block', () => window.close()));
    return;
  }
  if (!on) {
    main.append(h('p', {}, 'Gemini in your browser is off. To use it, pick it in Arise: Settings, AI coach.'), button('Close', 'block', () => window.close()));
    return;
  }
  if (granted) {
    main.append(
      h('p', { class: 'ok' }, 'Arise can use Gemini in this browser.'),
      h('p', { class: 'small muted' }, SEES),
      h('div', { class: 'row' }, button('Done', 'primary', () => window.close()), button('Turn it off', 'danger', turnOff)),
    );
    return;
  }
  main.append(
    h('h2', {}, 'Let Arise use Gemini here?'),
    h('p', {}, SEES),
    h('p', { class: 'small muted' }, ONLY),
    h('p', { class: 'small muted' }, 'Be signed in at gemini.google.com in this browser first.'),
    h('div', { class: 'row' }, button('Allow gemini.google.com', 'primary', allow), button('Not now', '', notNow)),
  );
}

async function allow() {
  // Straight from the click: the browser shows its own question.
  const ok = await api.permissions.request({ origins: [G.ORIGIN] }).catch(() => false);
  if (!ok) main.prepend(h('p', { class: 'warn' }, "It wasn't allowed. Arise won't use Gemini here."));
  else await draw();
}

async function notNow() {
  await G.forget(kv);
  window.close();
}

async function turnOff() {
  await G.forget(kv);
  await api.permissions.remove({ origins: [G.ORIGIN] }).catch(() => false);
  await draw();
}

void draw();
