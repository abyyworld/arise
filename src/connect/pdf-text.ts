// The text of a simple PDF, for Drive files people pick (drive.ts). Simple means: its pages are
// plain or zlib-packed (FlateDecode) content streams that write their text as strings (Tj, TJ, '
// and "), like most PDFs saved from a word processor. Scans (pictures of pages) and fonts that
// name glyphs by number give nothing readable, and then this gives '' rather than gibberish.

import { inflateSync, unzlibSync } from 'fflate';

const MAX_IN = 10_000_000;

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

function unpack(data: Uint8Array): Uint8Array | null {
  try {
    return new Uint8Array(unzlibSync(data));
  } catch {
    try {
      return new Uint8Array(inflateSync(data));
    } catch {
      return null;
    }
  }
}

// A literal string's bytes: (Hello \(world\) \101).
function literal(s: string): string {
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b' || n === 'f') out += ' ';
    else if (n === '\r' || n === '\n') {
      if (n === '\r' && s[i + 1] === '\n') i++;
    } else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1])) oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else out += n;
  }
  return decodeBytes(out);
}

function hexString(s: string): string {
  const h = s.slice(1, -1).replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt((h.slice(i, i + 2) + '0').slice(0, 2), 16));
  return decodeBytes(out);
}

// UTF-16 when it says so (a byte order mark), otherwise one byte a letter.
function decodeBytes(b: string): string {
  if (b.charCodeAt(0) === 0xfe && b.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < b.length; i += 2) out += String.fromCharCode((b.charCodeAt(i) << 8) | b.charCodeAt(i + 1));
    return out;
  }
  return b;
}

const TOKEN = /\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|<[0-9A-Fa-f\s]*>|\[|\]|-?(?:\d+\.?\d*|\.\d+)|\/[^\s/[\]()<>{}%]+|[A-Za-z'"*]+/g;

// The text a content stream writes.
export function contentText(stream: string): string {
  let out = '';
  const operands: (string | number | (string | number)[])[] = [];
  let array: (string | number)[] | null = null;
  for (const m of stream.matchAll(TOKEN)) {
    const t = m[0];
    if (t === '[') {
      array = [];
      continue;
    }
    if (t === ']') {
      if (array) operands.push(array);
      array = null;
      continue;
    }
    const value = t[0] === '(' ? literal(t) : t[0] === '<' ? hexString(t) : /^-?[\d.]/.test(t) ? Number(t) : t[0] === '/' ? null : undefined;
    if (value !== undefined) {
      if (value !== null) (array ?? operands).push(value);
      continue;
    }
    // An operator.
    const last = operands[operands.length - 1];
    if (t === 'Tj' && typeof last === 'string') out += last;
    else if ((t === "'" || t === '"') && typeof last === 'string') out += `\n${last}`;
    else if (t === 'TJ' && Array.isArray(last)) for (const x of last) out += typeof x === 'string' ? x : x < -200 ? ' ' : '';
    else if (t === 'Td' || t === 'TD') out += operands.length >= 2 && operands[operands.length - 1] !== 0 ? '\n' : ' ';
    else if (t === 'T*' || t === 'ET') out += '\n';
    else if (t === 'Tm') out += '\n';
    operands.length = 0;
  }
  return out;
}

// Mostly letters, digits, spaces and punctuation: real text, not glyph numbers.
const readable = (s: string) => {
  if (s.length < 3) return false;
  const good = (s.match(/[\p{L}\p{N}\p{P}\s]/gu) || []).length;
  return good / s.length > 0.85;
};

export function pdfText(bytes: Uint8Array, max = 200_000): string {
  if (bytes.length > MAX_IN || latin1(bytes.subarray(0, 5)) !== '%PDF-') return '';
  const s = latin1(bytes);
  const parts: string[] = [];
  const head = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>|<[^<>]*>)*)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  let total = 0;
  while ((m = head.exec(s)) && total < max) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    head.lastIndex = end;
    if (/\/Subtype\s*\/Image|\/Type\s*\/(XRef|XObject|Font)|\/Length1|\/FontFile/.test(dict)) continue;
    const filters = (/\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] || '').match(/\/\w+/g) || [];
    let data: Uint8Array | null = bytes.subarray(start, end);
    if (filters.some((f) => f !== '/FlateDecode')) continue;
    if (filters.length) data = unpack(data);
    if (!data) continue;
    const text = latin1(data);
    if (!/\bBT\b/.test(text)) continue;
    const got = contentText(text);
    parts.push(got);
    total += got.length;
  }
  const out = parts
    .join('\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
  return readable(out) ? out : '';
}
