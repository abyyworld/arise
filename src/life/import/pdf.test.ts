import { describe, expect, it } from 'vitest';
import { strToU8, zlibSync } from 'fflate';
import { parseCMap, pdfDate, pdfText, readable } from './pdf';
import { classify } from './index';
import { importAll } from './notes-fixtures';

// A small PDF made by hand: each object is text, or [dictionary, stream bytes]. No cross-reference
// table: Arise finds the objects without one.
type Part = string | [string, Uint8Array] | null; // null: that number is kept elsewhere
function makePdf(objects: Part[], trailer: string): Uint8Array {
  const chunks: Uint8Array[] = [strToU8('%PDF-1.5\n%âã\n', true)];
  objects.forEach((o, i) => {
    if (o === null) return;
    if (typeof o === 'string') chunks.push(strToU8(`${i + 1} 0 obj\n${o}\nendobj\n`, true));
    else chunks.push(strToU8(`${i + 1} 0 obj\n${o[0]}\nstream\n`, true), o[1], strToU8('\nendstream\nendobj\n', true));
  });
  chunks.push(strToU8(`trailer\n${trailer}\n%%EOF\n`, true));
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of chunks) out.set(c, (p += c.length) - c.length);
  return out;
}
const plain = (s: string): [string, Uint8Array] => [`<< /Length ${s.length} >>`, strToU8(s, true)];
const packed = (s: string, extra = ''): [string, Uint8Array] => {
  const z = zlibSync(strToU8(s, true));
  return [`<< /Length ${z.length} /Filter /FlateDecode ${extra}>>`, z];
};

// One page, Helvetica (a simple font: its bytes are the letters), text not packed.
const simplePdf = makePdf(
  [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    plain('BT /F1 12 Tf 72 720 Td (Hello world) Tj 0 -14 Td (Caf\\351 \\(open\\)) Tj ET'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Title (Shopping list) /CreationDate (D:20240102093000+01\'00\') >>',
  ],
  '<< /Root 1 0 R /Info 6 0 R >>',
);

// Two pages, packed, with a font whose codes are two bytes and mapped back to letters by a
// ToUnicode CMap, kept inside a packed object stream as newer PDFs do.
const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0048> <0002> <0069> endbfchar 1 beginbfrange <0003> <0004> <0041> endbfrange endcmap end end';
const objStm = (() => {
  const font = '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Body /Encoding /Identity-H /ToUnicode 7 0 R >>';
  const head = '6 0 ';
  return packed(head + font, `/Type /ObjStm /N 1 /First ${head.length} `);
})();
const cidPdf = makePdf(
  [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 2 /Resources << /Font << /F2 6 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents [4 0 R] >>',
    packed('BT /F2 11 Tf 1 0 0 1 72 700 Tm [<00010002> -300 <0003>] TJ ET'),
    objStm,
    null, // object 6 lives in the object stream above
    packed(cmap),
    null,
    '<< /Type /Page /Parent 2 0 R /Contents 10 0 R >>',
    packed('BT /F2 11 Tf 72 700 Td <0004> Tj ET'),
  ],
  '<< /Root 1 0 R >>',
);

// A scan: the page is one picture, with no words.
const scanPdf = makePdf(
  [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    plain('q 612 0 0 792 0 0 cm /Im1 Do Q'),
    ['<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /DCTDecode /Length 4 >>', new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
  ],
  '<< /Root 1 0 R >>',
);

const pdfFile = (bytes: Uint8Array, name: string) => new File([new Uint8Array(bytes)], name, { lastModified: Date.UTC(2020, 0, 1) });

describe('PDF', () => {
  it('reads the words of simple fonts, with lines, escapes and its details', () => {
    const r = pdfText(simplePdf);
    expect(r.text).toBe('Hello world\nCafé (open)');
    expect(r.pages).toBe(1);
    expect(r.title).toBe('Shopping list');
    expect(r.created).toBe(Date.UTC(2024, 0, 2, 8, 30));
    expect(r.locked).toBeUndefined();
  });

  it('reads packed pages, fonts kept in object streams, and two-byte codes through ToUnicode', () => {
    const r = pdfText(cidPdf);
    expect(r.pages).toBe(2);
    expect(r.text).toBe('Hi A\n\nB');
    const m = parseCMap(cmap);
    expect(m.bytes).toBe(2);
    expect([...m.map]).toEqual([
      [1, 'H'],
      [2, 'i'],
      [3, 'A'],
      [4, 'B'],
    ]);
  });

  it('finds no words in a scan or a locked file, and says so', async () => {
    expect(pdfText(scanPdf).text).toBe('');
    const locked = makePdf(['<< /Type /Catalog >>'], '<< /Root 1 0 R /Encrypt 2 0 R >>');
    expect(pdfText(locked)).toMatchObject({ text: '', locked: true });
    expect(readable('a b')).toBe(false);
    expect(readable('Hi A B')).toBe(true);
    const { result, events } = await importAll(pdfFile(scanPdf, 'Scan.pdf'));
    expect(result).toMatchObject({ found: 0, added: 0, problem: 'no-text', labels: [] });
    expect(events).toEqual([]);
  });

  it('makes one note from a PDF, named after the file and dated when it was made', async () => {
    expect(classify('x.pdf', '%PDF-1.7\n', false)).toBe('pdf');
    const { detection, result, events } = await importAll(pdfFile(simplePdf, 'Shopping.pdf'));
    expect(detection.found.map((f) => [f.kind, f.label])).toEqual([['pdf', 'PDF']]);
    expect(result).toMatchObject({ found: 1, labels: ['PDF'] });
    expect(result.problem).toBeUndefined();
    expect(events.map((e) => [e.title, e.at, e.detail, e.meta])).toEqual([['Shopping', Date.UTC(2024, 0, 2, 8, 30), 'Hello world\nCafé (open)', { app: 'PDF', pages: 1, file: 'Shopping.pdf' }]]);
    // No date inside: when the file was saved.
    const undated = await importAll(pdfFile(cidPdf, 'Letters.pdf'));
    expect(undated.events.map((e) => [e.title, e.at])).toEqual([['Letters', Date.UTC(2020, 0, 1)]]);
  });

  it('reads PDF dates', () => {
    expect(pdfDate("D:20240102093000+01'00'")).toBe(Date.UTC(2024, 0, 2, 8, 30));
    expect(pdfDate('D:20240102')).toBe(Date.UTC(2024, 0, 2));
    expect(pdfDate('D:20240102093000Z')).toBe(Date.UTC(2024, 0, 2, 9, 30));
    expect(pdfDate('nope')).toBeNaN();
  });
});
