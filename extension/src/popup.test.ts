// @vitest-environment jsdom
// The extension's menu: the person's own sites to skip can be set before linking, since linking
// reads the last 90 days of history straight away. Saving the page in front, the switch for
// reminders, and the small window that shows them when they're due.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PopupRequest, PopupState } from './lib/recorder';

const ext = vi.hoisted(() => ({ state: null as unknown as PopupState, sent: [] as PopupRequest[], opened: [] as string[] }));

vi.mock('./api', () => ({
  ARISE: ['https://abyyworld.github.io/arise/'],
  api: {
    runtime: {
      sendMessage: async ({ msg }: { msg: PopupRequest }) => {
        ext.sent.push(msg);
        if (msg.t === 'skip') ext.state = { ...ext.state, skip: msg.text.split('\n').filter(Boolean) };
        if (msg.t === 'remind') ext.state = { ...ext.state, remind: msg.on };
        if (msg.t === 'read') ext.state = { ...ext.state, unread: [] };
        return structuredClone(ext.state);
      },
    },
    tabs: {
      create: async (p: { url: string }) => void ext.opened.push(p.url),
      query: async () => [{ id: 1, windowId: 1, active: true, incognito: false, url: 'https://news.example.com/story?id=7', title: 'A good story' }],
    },
  },
}));

const base: PopupState = {
  linked: false,
  linkedAt: 0,
  arise: '',
  browser: 'Chrome on macOS',
  version: '1.0.0',
  paused: false,
  skip: [],
  waiting: 0,
  sent: { at: 0, n: 0 },
  backfilling: false,
  pairing: null,
  remind: false,
  unread: [],
  next: null,
};

async function open(state: PopupState, search = '') {
  ext.state = state;
  ext.sent = [];
  ext.opened = [];
  history.replaceState(null, '', `/popup.html${search}`);
  document.body.innerHTML = '<header><span id="browserName"></span></header><main id="main"></main>';
  vi.resetModules();
  await import('./popup');
  await vi.waitFor(() => expect(document.getElementById('browserName')!.textContent).toBe('Chrome on macOS'));
}

async function saveSkip(text: string) {
  (document.getElementById('skip') as HTMLTextAreaElement).value = text;
  (document.querySelector('button[data-act="skip"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(ext.sent.some((m) => m.t === 'skip')).toBe(true));
}

describe('sites to skip in the menu', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('can be set before the browser is linked', async () => {
    await open(base);
    expect(document.body.textContent).toContain('Not linked yet.');
    expect(document.body.textContent).toContain('linking also reads the last 90 days');
    await saveSkip('mytherapist.example');
    expect(ext.sent.at(-1)).toEqual({ t: 'skip', text: 'mytherapist.example' });
    await vi.waitFor(() => expect((document.getElementById('skip') as HTMLTextAreaElement).value).toBe('mytherapist.example'));
  });

  it('can be set in the window with the 4 words, before "They match"', async () => {
    await open({ ...base, pairing: { link: 'L'.repeat(22), code: ['apple', 'river', 'stone', 'cloud'] } });
    expect(document.body.textContent).toContain('apple · river · stone · cloud');
    await saveSkip('private-forum.example');
    expect(ext.sent.at(-1)).toEqual({ t: 'skip', text: 'private-forum.example' });
  });

  it('is still there once linked', async () => {
    await open({ ...base, linked: true, linkedAt: 1, skip: ['work.example'] });
    expect((document.getElementById('skip') as HTMLTextAreaElement).value).toBe('work.example');
  });
});

const click = (act: string) => (document.querySelector(`button[data-act="${act}"]`) as HTMLButtonElement).click();
const linked = { ...base, linked: true, linkedAt: 1 };
const DUE = { id: 'todo-a1', at: Date.now() - 60_000, title: 'Something on your to-do list', body: 'Open Arise to see it.' };

describe('saving the page in front', () => {
  it('sends its address and title, once linked', async () => {
    await open(linked);
    click('save');
    await vi.waitFor(() => expect(ext.sent.at(-1)).toEqual({ t: 'save', url: 'https://news.example.com/story?id=7', title: 'A good story' }));
    await vi.waitFor(() => expect(document.getElementById('savedPage')?.hidden).toBe(false));
  });

  it("isn't offered before linking", async () => {
    await open(base);
    expect(document.querySelector('button[data-act="save"]')).toBeNull();
  });
});

describe('reminders in the menu', () => {
  it('has a switch, off until turned on', async () => {
    await open(linked);
    expect(document.body.textContent).toContain('Reminders here');
    expect(document.body.textContent).toContain('Kept only in this browser');
    click('remind');
    await vi.waitFor(() => expect(ext.sent.at(-1)).toEqual({ t: 'remind', on: true }));
    await vi.waitFor(() => expect(document.querySelector('button[data-act="remind"]')!.textContent).toBe('On'));
    click('remind');
    await vi.waitFor(() => expect(ext.sent.at(-1)).toEqual({ t: 'remind', on: false }));
  });

  it("says what's next, and what's due until it's looked at", async () => {
    await open({ ...linked, remind: true, next: { id: 'ev-1', at: Date.now() + 3_600_000, title: 'Something in your calendar', body: '' }, unread: [DUE] });
    expect(document.body.textContent).toContain('Next: Something in your calendar');
    expect(document.body.textContent).toContain('Something on your to-do list');
    click('read');
    await vi.waitFor(() => expect(ext.sent.at(-1)).toEqual({ t: 'read' }));
  });

  it('shows only what is due in its own small window', async () => {
    await open({ ...linked, remind: true, unread: [DUE] }, '?remind=1');
    expect(document.body.textContent).toContain('A reminder from Arise');
    expect(document.body.textContent).toContain('Open Arise to see it.');
    expect(document.querySelector('#skip')).toBeNull();
    expect(document.querySelector('button[data-act="unlink"]')).toBeNull();
    click('open');
    await vi.waitFor(() => expect(ext.opened).toEqual(['https://abyyworld.github.io/arise/#today']));
    expect(ext.sent.some((m) => m.t === 'read')).toBe(true);
  });
});
