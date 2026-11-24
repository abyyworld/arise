import { describe, expect, it } from 'vitest';
import { importAll, zipAt } from './notes-fixtures';
import { wordDate, wordText } from './word';

const body = (paras: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:sectPr/></w:body></w:document>`;
const doc = body(
  '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Letter</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Dear</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> Sam &amp; Jo,</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>line two</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>',
);
const core = '<?xml version="1.0"?><cp:coreProperties xmlns:dcterms="http://purl.org/dc/terms/"><dcterms:created xsi:type="dcterms:W3CDTF">2024-03-04T05:06:07Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2024-04-01T00:00:00Z</dcterms:modified></cp:coreProperties>';
const types = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
// Word writes no times in its zip: 1 January 1980.
const NO_TIME = new Date(1980, 0, 1, 0, 0, 0);

describe('Word', () => {
  it('reads paragraphs, tabs and line breaks, and leaves deleted words out', () => {
    expect(wordText(doc)).toBe('Letter\nDear\t Sam & Jo,\nLine one\nline two\n');
    expect(wordDate(core)).toBe(Date.UTC(2024, 2, 4, 5, 6, 7));
    expect(wordDate('<x/>')).toBeNaN();
  });

  it('makes one note from a .docx, named after the file, dated when it was written', async () => {
    const file = zipAt({ '[Content_Types].xml': types, 'word/document.xml': doc, 'docProps/core.xml': core }, NO_TIME, 'Letter to Sam.docx');
    const { detection, events, result } = await importAll(file);
    expect(detection.found.map((f) => [f.kind, f.label, f.file])).toEqual([['word', 'Word document', 'Letter to Sam.docx']]);
    expect(result).toMatchObject({ found: 1, labels: ['Word document'] });
    expect(result.problem).toBeUndefined();
    expect(events.map((e) => [e.title, e.at, e.detail, e.meta?.app])).toEqual([['Letter to Sam', Date.UTC(2024, 2, 4, 5, 6, 7), 'Letter\nDear Sam & Jo,\nLine one\nline two', 'Word']]);
  });

  it('without its details, the date is when the file was saved; with no words, it says so', async () => {
    const plain = zipAt({ 'word/document.xml': doc }, NO_TIME, 'Plain.docx');
    expect((await importAll(plain)).events.map((e) => e.at)).toEqual([Date.UTC(2020, 0, 1)]);
    const empty = await importAll(zipAt({ 'word/document.xml': body('<w:p><w:r><w:drawing/></w:r></w:p>') }, NO_TIME, 'Picture.docx'));
    expect(empty.result).toMatchObject({ found: 0, problem: 'no-text', labels: [] });
  });
});
