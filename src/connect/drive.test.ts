// @vitest-environment jsdom
// Google Drive, a part of the Google link: the files the Player picks (and only those) read into
// the life log as notes, Docs as plain text, Markdown as it is, PDFs when their text can be read;
// a changed file replaces its note, one taken off the list takes its note with it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE } from '../connect-config';
import { fakeNet, useWeb, type Net } from '../test/fake-http';
import { fakeLife } from '../test/fake-life';
import * as D from './drive';
import * as G from './google';
import * as IDS from './ids';
import * as P from './panel';
import { blank, load, save, type SvcState } from './state';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const ctx = { save: vi.fn() };
let net: Net;
let life: ReturnType<typeof fakeLife>;

const PDF = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n4 0 obj\n<< /Length 60 >>\nstream\nBT /F1 12 Tf 72 720 Td (Quarterly plan: hire two people) Tj ET\nendstream\nendobj\n%%EOF\n';
const DOC = 'id1_plans_doc_000000';
const MD = 'id2_goals_md_0000000';
const PDFID = 'id3_report_pdf_00000';
const IMG = 'id4_photo_png_000000';
const meta: Record<string, Record<string, unknown>> = {
  [DOC]: { id: DOC, name: 'Plans', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-11-20T10:00:00.000Z', webViewLink: `https://docs.google.com/document/d/${DOC}/edit` },
  [MD]: { id: MD, name: 'goals.md', mimeType: 'text/markdown', modifiedTime: '2026-11-19T10:00:00.000Z', size: '40', webViewLink: `https://drive.google.com/file/d/${MD}/view` },
  [PDFID]: { id: PDFID, name: 'Report.pdf', mimeType: 'application/pdf', modifiedTime: '2026-11-18T10:00:00.000Z', size: String(PDF.length) },
  [IMG]: { id: IMG, name: 'photo.png', mimeType: 'image/png', modifiedTime: '2026-11-18T10:00:00.000Z', size: '9000' },
};
let docText = '﻿Plans for next year\r\nMove to Lisbon';

function signedIn(parts = ['drive']): SvcState {
  return { ...blank(), on: true, account: 'sam@example.com', user: 'sam@example.com', parts, auth: { token: 'ya29.token', expires: NOW + 50 * 60_000 } };
}

beforeEach(() => {
  net = fakeNet();
  useWeb(net);
  life = fakeLife();
  IDS.resetForTests();
  localStorage.clear();
  docText = '﻿Plans for next year\r\nMove to Lisbon';
  net
    .on(/\/drive\/v3\/files\/[\w-]+\?fields=/, (c) => {
      const id = /files\/([\w-]+)\?/.exec(c.url)![1];
      return meta[id] ? { body: meta[id] } : { status: 404, body: { error: { code: 404, status: 'NOT_FOUND' } } };
    })
    .on(new RegExp(`files/${DOC}/export\\?mimeType=text%2Fplain`), () => ({ body: docText, headers: { 'content-type': 'text/plain' } }))
    .on(new RegExp(`files/${MD}\\?alt=media`), { body: '# Goals\n- Run a half marathon', headers: { 'content-type': 'text/markdown' } })
    .on(new RegExp(`files/${PDFID}\\?alt=media`), { body: PDF, headers: { 'content-type': 'application/pdf' } })
    .on(/\/drive\/v3\/files\?/, { body: { files: [meta[DOC], meta[MD], meta[IMG]] } })
    .on(/\/drive\/v3\/about/, { body: { user: { emailAddress: 'sam@example.com' } } });
});
afterEach(() => {
  GOOGLE.clientId = '';
  vi.restoreAllMocks();
});

describe('Drive files', () => {
  it('knows which files it can read, and the id in a Drive link', () => {
    expect(D.kindOf('application/vnd.google-apps.document')).toBe('doc');
    expect(D.kindOf('application/pdf')).toBe('pdf');
    expect(D.kindOf('application/octet-stream', 'notes.md')).toBe('text');
    expect(D.kindOf('image/png', 'photo.png')).toBeNull();
    expect(D.fileIdFrom(`https://docs.google.com/document/d/${DOC}/edit?usp=sharing`)).toBe(DOC);
    expect(D.fileIdFrom(`https://drive.google.com/open?id=${MD}`)).toBe(MD);
    expect(D.fileIdFrom('hello there')).toBe('');
  });

  it('reads only the picked files into notes: Docs as text, Markdown, and a PDF', async () => {
    const st = signedIn();
    D.setPicks(st, [
      { id: DOC, name: 'Plans' },
      { id: MD, name: 'goals.md' },
      { id: PDFID, name: 'Report.pdf' },
      { id: IMG, name: 'photo.png' },
    ]);
    await D.syncDrive(st, ctx, NOW);
    const notes = life.list();
    expect(notes.map((e) => [e.title, e.detail])).toEqual([
      ['Drive: Plans', 'Plans for next year\nMove to Lisbon'],
      ['Drive: goals.md', '# Goals\n- Run a half marathon'],
      ['Drive: Report.pdf', 'Quarterly plan: hire two people'],
    ]);
    expect(notes[0]).toMatchObject({ source: 'other', kind: 'note', tier: 3, at: NOW, url: `https://docs.google.com/document/d/${DOC}/edit`, meta: { app: 'google-drive', file: 'Plans' } });
    // Nothing but those files: no listing of the Drive, no other file opened.
    expect(net.urls().every((u) => [DOC, MD, PDFID, IMG].some((id) => u.includes(id)))).toBe(true);
    expect(net.urls().every((u) => u.startsWith('https://www.googleapis.com/drive/v3/files/'))).toBe(true);
  });

  it('reads a file again only when it changed, and replaces its note', async () => {
    const st = signedIn();
    D.setPicks(st, [{ id: DOC, name: 'Plans' }]);
    await D.syncDrive(st, ctx, NOW);
    const exports = () => net.urls().filter((u) => u.includes('/export')).length;
    await D.syncDrive(st, ctx, NOW + 600_000);
    expect(exports()).toBe(1);
    meta[DOC].modifiedTime = '2026-11-23T11:00:00.000Z';
    docText = 'Plans changed: stay in Porto';
    await D.syncDrive(st, ctx, NOW + 1200_000);
    expect(exports()).toBe(2);
    expect(life.list().map((e) => e.detail)).toEqual(['Plans changed: stay in Porto']);
    meta[DOC].modifiedTime = '2026-11-20T10:00:00.000Z';
  });

  it('keeps about 4,000 characters of a long file', () => {
    const e = D.noteEvent({ id: DOC, name: 'Plans', mime: 'text/plain', modified: '', size: 0, link: '' }, 'x'.repeat(10_000), NOW);
    expect(e.detail!.length).toBeLessThan(4000);
    expect(e.detail).toMatch(/\(The rest is in Google Drive\.\)$/);
  });

  it('takes a note back out when its file leaves the list, and keeps at most 20', async () => {
    const st = signedIn();
    D.setPicks(st, [
      { id: DOC, name: 'Plans' },
      { id: MD, name: 'goals.md' },
    ]);
    await D.syncDrive(st, ctx, NOW);
    const gone = D.setPicks(st, [{ id: MD, name: 'goals.md' }]);
    expect(gone).toEqual([DOC]);
    await D.forgetFiles(gone);
    expect(life.titles()).toEqual(['Drive: goals.md']);
    D.setPicks(st, Array.from({ length: 30 }, (_, i) => ({ id: `file_${String(i).padStart(12, '0')}`, name: `f${i}` })));
    expect(D.picks(st)).toHaveLength(20);
  });

  it('keeps a file that went away on the list, and carries on', async () => {
    const st = signedIn();
    D.setPicks(st, [
      { id: 'gone_file_0000000000', name: 'Old' },
      { id: MD, name: 'goals.md' },
    ]);
    await D.syncDrive(st, ctx, NOW);
    expect(life.titles()).toEqual(['Drive: goals.md']);
    expect(D.picks(st).map((p) => p.name)).toEqual(['Old', 'goals.md']);
  });

  it('searches by name for files it can read, with quotes made safe', async () => {
    const st = signedIn();
    const found = await D.search(st, "Sam's plans");
    expect(found.map((f) => f.name)).toEqual(['Plans', 'goals.md']);
    const q = new URL(net.urls().at(-1)!).searchParams.get('q')!;
    expect(q).toContain("name contains 'Sam s plans'");
    expect(q).toContain('trashed = false');
  });

  it('as the only Google part: asks Drive who it is, and syncs only Drive', async () => {
    // Signed in again (who it is gets checked), and a first time (nobody known yet).
    const st = signedIn(['drive']);
    st.account = '';
    D.setPicks(st, [{ id: MD, name: 'goals.md' }]);
    await G.sync(st, ctx, NOW);
    expect(st.account).toBe('sam@example.com');
    expect(net.urls().some((u) => /calendar|gmail/.test(u))).toBe(false);
    expect(life.titles()).toEqual(['Drive: goals.md']);
    const first = signedIn(['drive']);
    first.user = first.account = '';
    await G.sync(first, ctx, NOW);
    expect(first.account).toBe('sam@example.com');
    expect(G.SCOPES.drive).toBe('https://www.googleapis.com/auth/drive.readonly');
  });
});

describe('Drive in Accounts', () => {
  const tap = async (act: string, data: Record<string, string> = {}) => {
    const b = document.createElement('button');
    b.dataset.act = act;
    Object.assign(b.dataset, data);
    document.body.append(b);
    await P.handleAction(act, b);
    b.remove();
  };
  beforeEach(() => {
    document.body.innerHTML = '<main id="app"></main><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div>';
    GOOGLE.clientId = 'test.apps.googleusercontent.com';
  });

  it('is off unless ticked, and says before connecting why Google asks for all of Drive', async () => {
    document.getElementById('app')!.innerHTML = P.settingsPanel();
    await tap('acct-connect', { s: 'google' });
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.acct-part')].map((b) => [b.value, b.checked]);
    expect(boxes).toEqual([
      ['calendar', true],
      ['mail', true],
      ['drive', false],
    ]);
    expect(document.querySelector('.sheet-body')!.textContent).toContain('Less private');
    expect(document.querySelector('.sheet-body')!.textContent).toContain('Arise only ever opens the files you pick');
  });

  it('picks files from a search of the Drive, and reads them', async () => {
    save('google', { ...signedIn(['calendar', 'drive']), auth: { token: 'ya29.token', expires: Date.now() + 50 * 60_000 } });
    net.on(/calendar\/v3/, { body: { items: [] } });
    document.getElementById('app')!.innerHTML = P.settingsPanel();
    expect(document.getElementById('acct-google')!.textContent).toContain('Drive: no files picked yet.');
    await tap('acct-drive', { s: 'google' });
    await vi.waitFor(() => expect(document.querySelectorAll('.drive-pick')).toHaveLength(2));
    const box = [...document.querySelectorAll<HTMLInputElement>('.drive-pick')].find((b) => b.value === MD)!;
    box.checked = true;
    await tap('acct-drive-save', { s: 'google' });
    expect(D.picks(load('google'))).toEqual([{ id: MD, name: 'goals.md' }]);
    await vi.waitFor(() => expect(life.titles()).toContain('Drive: goals.md'));
  });
});
