// @vitest-environment jsdom
// The Import screen with chats from an AI app: the picker before reading (every chat ticked, Tick
// all and Untick all, only the ticked ones read), and afterwards the list of chats in the life
// log, each with Delete, and Delete everything. The store is a fake in memory.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _reset, _state, groupChats, handleAction, renderImport, SOURCES } from './import-ui.js';
import { createImporter } from './import/client';
import { File as NodeFile } from 'node:buffer';
import { zipBytes } from '../test/life-fixtures';
import type { LifeEvent, LifeSource } from './types';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const text = (sel: string) => ($(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (el) handleAction(el.dataset.act, el);
});

function choose(...files: File[]) {
  const input = $('#lifeImportFile') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const boxes = () => [...document.querySelectorAll('input[name="importChat"]')] as HTMLInputElement[];
function untick(value: string) {
  const b = boxes().find((x) => x.value === value)!;
  b.checked = false;
  b.dispatchEvent(new Event('change', { bubbles: true }));
}

// Like the life log: same id kept once, changed ones replaced, deletes by id and by source.
function lifeStore() {
  const kept = new Map<string, LifeEvent>();
  const wiped: LifeSource[] = [];
  const removed: string[][] = [];
  return {
    kept,
    wiped,
    removed,
    addEvents: async (events: LifeEvent[]) => {
      let n = 0;
      for (const e of events) if (!kept.has(e.id)) (kept.set(e.id, e), n++);
      return n;
    },
    upsertEvents: async (events: LifeEvent[]) => {
      for (const e of events) kept.set(e.id, e);
      return events.length;
    },
    removeIds: async (ids: string[]) => {
      removed.push(ids);
      return ids.filter((id) => kept.delete(id)).length;
    },
    eventsFrom: async (source: LifeSource) => [...kept.values()].filter((e) => e.source === source),
    deleteSource: async (source: LifeSource) => {
      wiped.push(source);
      let n = 0;
      for (const [id, e] of kept) if (e.source === source) (kept.delete(id), n++);
      return n;
    },
  };
}

const iso = (d: number, h = 12) => new Date(Date.UTC(2024, 4, d, h)).toISOString();
// A zip as Node's own File (jsdom's Blob would turn the bytes into text), its files' bytes made
// here, so the zip library knows them for bytes under jsdom.
const zipFile = (files: Record<string, string>, name: string) => {
  const bytes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(new TextEncoder().encode(v))]));
  return new NodeFile([zipBytes(bytes)], name) as unknown as File;
};
const claudeZip = (name: string) =>
  zipFile({
    'conversations.json': JSON.stringify([
      { uuid: 'c1', name: 'Garden plans', created_at: iso(1), chat_messages: [{ sender: 'human', text: 'What grows in shade?', created_at: iso(1) }, { sender: 'assistant', text: 'Ferns.', created_at: iso(1) }] },
      { uuid: 'c2', name: 'Cover <b>letter</b>', created_at: iso(2), chat_messages: [{ sender: 'human', text: 'Make this shorter', created_at: iso(2) }, { sender: 'human', text: 'And kinder', created_at: iso(3) }] },
      { uuid: 'c3', name: 'Tax question', created_at: iso(3), chat_messages: [{ sender: 'human', text: 'When is it due?', created_at: iso(4) }] },
    ]),
    'users.json': '[]',
  }, name);

let root: HTMLElement;
beforeEach(() => {
  _reset();
  document.body.innerHTML = '<main id="app"></main>';
  root = $('#app')!;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('the Import screen with AI chats', () => {
  it('has steps for Claude, ChatGPT and Gemini, each with room for its chats', () => {
    renderImport(root, { store: lifeStore() });
    for (const id of ['claude', 'chatgpt', 'gemini']) {
      expect(SOURCES.find((s) => s.id === id)?.ai).toBe(true);
      expect($(`details[data-source="${id}"] #aiChats-${id}`)).not.toBeNull();
    }
    expect(text('details[data-source="claude"]')).toContain('Export data');
    expect(text('details[data-source="chatgpt"]')).toContain('Data controls');
    expect(text('details[data-source="gemini"]')).toContain('Gemini Apps');
    expect($('#aiChats-google')).toBeNull();
  });

  it('lists every chat ticked first, reads only the ticked ones, then lists them with Delete', async () => {
    const store = lifeStore();
    renderImport(root, { store, importer: createImporter(() => null) });
    choose(claudeZip('data-2024.zip'));
    await until(() => !!$('#importChats'));
    // Newest first, each with its date and length, the title as text.
    expect(boxes().map((b) => [b.value, b.checked])).toEqual([
      ['c3', true],
      ['c2', true],
      ['c1', true],
    ]);
    expect(text('#importChats')).toContain('Claude chats: 3 chats.');
    expect(text('#importChats li:nth-child(2)')).toBe('Cover <b>letter</b> 3 May 2024 · 2 messages');
    expect(text('#importChatCount')).toBe('3 of 3 ticked');

    // Untick all, and nothing can be read.
    $('[data-act="life-import-untick-all"]')!.click();
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(text('#importChatCount')).toBe('0 of 3 ticked');
    $('[data-act="life-import-go"]')!.click();
    expect(text('#importAskErr')).toBe('Tick at least one chat.');
    expect(store.kept.size).toBe(0);

    // Tick all, leave one out, and a redraw keeps the choice.
    $('[data-act="life-import-tick-all"]')!.click();
    expect(text('#importChatCount')).toBe('3 of 3 ticked');
    untick('c2');
    expect(text('#importChatCount')).toBe('2 of 3 ticked');
    renderImport(root, { store, importer: createImporter(() => null) });
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);
    $('[data-act="life-import-go"]')!.click();
    await until(() => !!$('#importResult'));
    expect(text('#importResult')).toBe('Added 2 events from 2024.');
    expect([...store.kept.values()].map((e) => e.meta?.conv).sort()).toEqual(['c1', 'c3']);

    // Its list opens with what came in.
    await until(() => document.querySelectorAll('#aiChats-claude li').length === 2);
    expect(($('details[data-source="claude"]') as HTMLDetailsElement).open).toBe(true);
    expect(text('#aiChats-claude')).toContain('Your Claude chats in Arise');
    expect([...document.querySelectorAll('#aiChats-claude li b')].map((b) => b.textContent)).toEqual(['Tax question', 'Garden plans']);

    // One deleted on its own, by its ids.
    ($('[data-act="life-import-ai-del"][data-v="c1"]') as HTMLElement).click();
    await until(() => text('#aiChats-claude').includes('Deleted.'));
    expect(store.removed.map((ids) => ids.length)).toEqual([1]);
    expect([...store.kept.values()].map((e) => e.meta?.conv)).toEqual(['c3']);
    expect([...document.querySelectorAll('#aiChats-claude li b')].map((b) => b.textContent)).toEqual(['Tax question']);

    // Everything from Claude, in one go (a wipe of the source, so every device deletes it too).
    $('[data-act="life-import-ai-wipe"]')!.click();
    await until(() => text('#aiChats-claude').includes('Deleted everything from Claude.'));
    expect(store.wiped).toEqual(['claude']);
    expect(store.kept.size).toBe(0);
    expect(text('#aiChats-claude')).toContain('No Claude chats in your life log yet.');
  });

  it('asks before deleting, and keeps the chat when the answer is no', async () => {
    const store = lifeStore();
    renderImport(root, { store, importer: createImporter(() => null) });
    choose(claudeZip('data.zip'));
    await until(() => !!$('#importChats'));
    $('[data-act="life-import-go"]')!.click();
    await until(() => document.querySelectorAll('#aiChats-claude li').length === 3);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    ($('[data-act="life-import-ai-del"][data-v="c2"]') as HTMLElement).click();
    $('[data-act="life-import-ai-wipe"]')!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.removed).toEqual([]);
    expect(store.wiped).toEqual([]);
    expect(store.kept.size).toBe(4);
    expect(_state.phase).toBe('done');
  });

  it('puts a chat’s days together, newest first, with its messages counted', () => {
    const ev = (id: string, conv: string, at: number, value: number, chat = 'T'): LifeEvent => ({ id: `claude:${id}`, source: 'claude', kind: 'message', at, title: `Chatted with Claude: ${chat}`, value, tier: 3, meta: { conv, chat } });
    expect(groupChats([ev('1', 'a', 10, 2, 'A'), ev('2', 'b', 30, 1, 'B'), ev('3', 'a', 50, 3, 'A'), { ...ev('4', '', 60, 1), meta: {} }])).toEqual([
      { conv: 'a', title: 'A', at: 50, n: 5, ids: ['claude:1', 'claude:3'] },
      { conv: 'b', title: 'B', at: 30, n: 1, ids: ['claude:2'] },
    ]);
  });
});
