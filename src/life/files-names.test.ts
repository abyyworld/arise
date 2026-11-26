// Clearer names for files with names that say nothing, and which preview a file gets (with a
// PDF's first page as a picture, and the words of a text file), all on the device.

import { describe, expect, it } from 'vitest';
import * as N from './files-names';
import * as PV from './files-preview';
import { firstPagePicture } from './import/pdf';

describe('names that say nothing', () => {
  it('knows camera, scanner and download names, and leaves real names alone', () => {
    for (const n of ['IMG_1234.jpg', 'IMG_E0042.HEIC', 'PXL_20231010_101010123.jpg', 'DSC00012.JPG', 'scan.pdf', 'Scan 3.pdf', 'document (3).docx', 'Untitled document.docx', 'image.png', 'Screenshot 2026-11-20 at 10.30.00.png', 'WhatsApp Image 2026-01-01 at 12.00.00.jpeg', '20261120_101500.jpg', '3f2a9c1e4b7d8e9f0a1b.pdf', 'File', 'Photo', 'copy of scan.pdf', 'download (2).pdf'])
      expect(N.unhelpful(n), n).toBe(true);
    for (const n of ['CV 2026.docx', 'Lease, flat 4.pdf', 'Passport.jpg', 'Rome trip.mov', 'tax return.pdf', 'Copy of lease.pdf'])
      expect(N.unhelpful(n), n).toBe(false);
  });

  it('takes the first heading, then what Arise wrote about it, then the date', () => {
    const f = { name: 'document (3).docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', day: '2026-11-26' };
    expect(N.suggestName(f, { heading: '\n  Curriculum Vitae\nJane Doe\nExperience...' })).toEqual({ name: 'Curriculum Vitae.docx', from: 'heading' });
    expect(N.suggestName({ ...f, name: 'Untitled.md', type: 'text/markdown' }, { heading: 'Some text first.\n\n# Packing list: Rome\n- socks' })).toEqual({ name: 'Packing list Rome.md', from: 'heading' });
    // A first line that's a sentence isn't a heading: the description is next.
    expect(N.suggestName(f, { heading: 'I went to the shop today and bought a lot of things for the week.', desc: 'A scanned receipt from Tesco for groceries, with 12 items.' })).toEqual({ name: 'Receipt from Tesco for groceries.docx', from: 'description' });
    expect(N.suggestName({ name: 'IMG_1234.jpg', type: 'image/jpeg', day: '2026-11-26' })).toEqual({ name: 'Photo 26 Nov 2026.jpg', from: 'date' });
    expect(N.suggestName({ name: 'scan.pdf', type: 'application/pdf', day: '2026-03-02' }, { desc: 'A photo of a parking ticket.' })).toEqual({ name: 'Parking ticket.pdf', from: 'description' });
    expect(N.suggestName({ name: 'scan', type: 'application/pdf', day: '2026-03-02' })).toEqual({ name: 'Scan 2 Mar 2026.pdf', from: 'date' });
  });

  it('suggests nothing for a good name, one the Player gave or kept, or when it would be the same', () => {
    expect(N.suggestName({ name: 'CV 2026.docx', type: 'application/msword', day: '2026-11-26' })).toBeNull();
    expect(N.suggestName({ name: 'IMG_1234.jpg', type: 'image/jpeg', day: '2026-11-26', renamed: 5 })).toBeNull();
    expect(N.suggestName({ name: 'Photo 26 Nov 2026.jpg', type: 'image/jpeg', day: '2026-11-26' })).toBeNull();
  });

  it('reads a heading and a description the plain way', () => {
    expect(N.firstHeading('## Plan for 2027 ##\nmore')).toBe('Plan for 2027');
    expect(N.firstHeading('x')).toBe('');
    expect(N.firstHeading('Invoice\n\nNo. 42')).toBe('Invoice');
    expect(N.fromDescription('This is a photo of a birthday cake with candles.')).toBe('Birthday cake with candles');
    expect(N.fromDescription('An electricity bill from EDF for March 2026; total due 84 euros.')).toBe('Electricity bill from EDF for March 2026');
    expect(N.dayWords('2026-01-05')).toBe('5 Jan 2026');
    // The words never carry characters a file name can't have.
    expect(N.suggestName({ name: 'scan.pdf', type: 'application/pdf', day: '2026-11-26' }, { heading: '# Q3: In/Out' })?.name).toBe('Q3 In Out.pdf');
  });
});

describe('previews', () => {
  it('chooses one by type, and by name for files saved without one', () => {
    const k = (type: string, name = 'x') => PV.previewKind({ type, name });
    expect(k('image/jpeg')).toBe('image');
    expect(k('application/pdf')).toBe('pdf');
    expect(k('application/octet-stream', 'Lease.PDF')).toBe('pdf');
    expect(k('audio/mpeg')).toBe('audio');
    expect(k('application/octet-stream', 'memo.m4a')).toBe('audio');
    expect(k('video/quicktime')).toBe('video');
    expect(k('application/octet-stream', 'clip.webm')).toBe('video');
    expect(k('text/markdown')).toBe('markdown');
    expect(k('text/plain', 'notes.md')).toBe('markdown');
    expect(k('text/plain')).toBe('text');
    expect(k('text/csv')).toBe('text');
    expect(k('application/json')).toBe('text');
    expect(k('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'cv.docx')).toBeNull();
    expect(k('application/zip', 'a.zip')).toBeNull();
    expect(k('text/html', 'page.html')).toBeNull(); // never drawn as a page
  });

  it('shows the start of a long text file', () => {
    const long = new TextEncoder().encode('﻿hello ' + 'x'.repeat(50));
    expect(PV.textOf(long, 10)).toEqual({ text: 'hello xxxx', more: true });
    expect(PV.textOf(new TextEncoder().encode('short'))).toEqual({ text: 'short', more: false });
  });

  it("finds a scanned PDF's first page picture", () => {
    const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(n).fill(7), 0xff, 0xd9]);
    const big = jpeg(300);
    const small = jpeg(20);
    const parts: Uint8Array[] = [];
    const add = (x: string | Uint8Array) => parts.push(typeof x === 'string' ? enc(x) : x);
    add('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n');
    add('3 0 obj << /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R /Im2 4 0 R >> >> /Contents 6 0 R >> endobj\n');
    add(`4 0 obj << /Type /XObject /Subtype /Image /Width 9 /Height 9 /Filter /DCTDecode /Length ${big.length} >>\nstream\n`);
    add(big);
    add('\nendstream\nendobj\n');
    add(`5 0 obj << /Type /XObject /Subtype /Image /Width 2 /Height 2 /Filter [/DCTDecode] /Length ${small.length} >>\nstream\n`);
    add(small);
    add('\nendstream\nendobj\n6 0 obj << /Length 0 >>\nstream\n\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF');
    const pdf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      pdf.set(p, at);
      at += p.length;
    }
    expect(firstPagePicture(pdf)).toEqual(big);
    // A PDF of words only: none.
    expect(firstPagePicture(enc('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] >> endobj\n3 0 obj << /Type /Page >> endobj\ntrailer << /Root 1 0 R >>'))).toBeNull();
  });
});
