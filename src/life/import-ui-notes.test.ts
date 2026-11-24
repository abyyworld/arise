// @vitest-environment jsdom
// The Import screen with notes and documents: the new sources and their steps, a note brought in,
// a PDF with no words it can read, and the button that takes the life log out for Obsidian.

import { beforeEach, describe, expect, it } from 'vitest';
import { _reset, handleAction, renderImport, SOURCES } from './import-ui.js';
import { createImporter, type Importer } from './import/client';
import type { Detection } from './import/types';
import type { LifeEvent } from './types';

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
  if (el && el.dataset.act !== 'life-export-obsidian') handleAction(el.dataset.act);
});

function choose(...files: File[]) {
  const input = $('#lifeImportFile') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function memoryStore() {
  const kept = new Map<string, LifeEvent>();
  const put = async (events: LifeEvent[]) => {
    let n = 0;
    for (const e of events) if (JSON.stringify(kept.get(e.id)) !== JSON.stringify(e)) (kept.set(e.id, e), n++);
    return n;
  };
  return { kept, addEvents: put, upsertEvents: put };
}

let root: HTMLElement;
beforeEach(() => {
  _reset();
  document.body.innerHTML = '<main id="app"></main>';
  root = $('#app')!;
});

describe('notes and documents on the Import screen', () => {
  it('lists the notes apps, documents and Fitbit with plain steps, and the way to take it out', () => {
    renderImport(root, { store: memoryStore() });
    for (const id of ['fitbit', 'obsidian', 'notion', 'apple-notes', 'keep', 'documents']) expect($(`details[data-source="${id}"]`)).not.toBeNull();
    expect(text('details[data-source="apple-notes"]')).toContain('privacy.apple.com');
    expect(text('details[data-source="notion"]')).toContain('Markdown & CSV');
    expect(text('details[data-source="documents"]')).toContain('scanned PDF');
    expect(SOURCES.every((s) => !/\u2014/.test(`${s.name} ${s.what} ${s.steps.join(' ')}`))).toBe(true);
    expect(text('#importPanel')).toContain('Obsidian or Notion');
    expect(text('#exportPanel button')).toBe('Export to Obsidian');
    expect($('#exportPanel [data-act="life-export-obsidian"]')).not.toBeNull();
  });

  it('brings in a note on its own', async () => {
    const store = memoryStore();
    renderImport(root, { store, importer: createImporter(() => null) });
    choose(new File(['---\ndate: 2024-02-03\n---\n# Ideas\nPlant tomatoes.'], 'Ideas.md'));
    await until(() => !!$('#importResult'));
    expect(text('#importResult')).toBe('Added 1 event from 2024.');
    expect(text('#importStatus')).toContain('From: A note.');
    expect([...store.kept.values()].map((e) => [e.title, e.detail])).toEqual([['Ideas', 'Plant tomatoes.']]);
  });

  it('says plainly when a PDF has no words it can read', async () => {
    const det: Detection = { name: 'Scan.pdf', size: 10, zip: false, found: [{ kind: 'pdf', path: 'Scan.pdf', size: 10, label: 'PDF' }] };
    const fake: Importer = { detect: async () => det, run: async () => ({ found: 0, added: 0, labels: [], problem: 'no-text' }) };
    renderImport(root, { store: memoryStore(), importer: fake });
    choose(new File(['%PDF-1.4'], 'Scan.pdf'));
    await until(() => text('#importStatus').includes('no words'));
    expect(text('#importStatus')).toContain('Arise found no words it could read in this file. It may be a scan or photos of pages, or locked with a password.');
  });
});
