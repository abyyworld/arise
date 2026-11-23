// The text of simple PDFs for Drive files: packed and plain content streams, the ways a PDF
// writes strings, and nothing at all rather than gibberish when the text can't be read.

import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { contentText, pdfText } from './pdf-text';

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
function makePdf(content: string, { flate = true, extra = '' } = {}): Uint8Array {
  const data = flate ? new Uint8Array(zlibSync(enc(content))) : enc(content);
  const head = enc(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n${extra}4 0 obj\n<< /Length ${data.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`);
  const tail = enc('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out;
}

const PAGE = 'BT /F1 12 Tf 72 720 Td (Goals for 2027) Tj 0 -14 Td (Run a half marathon\\, ship) Tj T* [(Sa) 20 (ve) -300 (more)] TJ ET';

describe('PDF text', () => {
  it('reads the strings a page writes, line by line', () => {
    expect(contentText(PAGE).trim()).toBe('Goals for 2027\nRun a half marathon, ship\nSave more');
  });

  it('reads a packed (FlateDecode) page and a plain one', () => {
    expect(pdfText(makePdf(PAGE))).toBe('Goals for 2027\nRun a half marathon, ship\nSave more');
    expect(pdfText(makePdf(PAGE, { flate: false }))).toBe('Goals for 2027\nRun a half marathon, ship\nSave more');
  });

  it('reads escapes, octal letters and UTF-16 strings', () => {
    expect(contentText('BT (caf\\351 \\(open\\)) Tj ET').trim()).toBe('café (open)');
    expect(contentText('BT <FEFF004800690021> Tj ET').trim()).toBe('Hi!');
  });

  it('skips pictures, and gives nothing for text it cannot read or a file that is not a PDF', () => {
    const image = '5 0 obj\n<< /Type /XObject /Subtype /Image /Length 3 /Filter /DCTDecode >>\nstream\nabc\nendstream\nendobj\n';
    expect(pdfText(makePdf(PAGE, { extra: image }))).toContain('Goals for 2027');
    expect(pdfText(makePdf('BT <0001000200030004000500060007> Tj ET'))).toBe('');
    expect(pdfText(enc('Just some text'))).toBe('');
  });
});
