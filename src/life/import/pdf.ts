// A PDF's words, read here with no PDF library: the pages are found from the file's objects,
// each page's content is unpacked (FlateDecode, with fflate, which Arise already has) and its
// text operators (Tj, TJ, ' and ") are read, with each font's ToUnicode map when it has one.
//
// What it can't read: a scan or photos of pages (the words are pictures), a PDF locked with a
// password, and fonts that keep no map back to letters. Then there are no words, and the import
// says so plainly. Whole documents become one note, named after the file.

import { Inflate } from 'fflate';
import type { LifeEvent } from '../types';
import type { TextInput } from './types';
import { baseName, noExt, noteBatches, type NoteDoc } from './notes';

const MAX_BYTES = 100 << 20; // more than this is left unread (what's before it is still read)
const MAX_PAGES = 2000;
const MAX_TEXT = 1 << 20; // the words kept while reading; a note keeps far fewer

// ---------- values

class Name {
  constructor(readonly n: string) {}
}
class Ref {
  constructor(readonly num: number) {}
}
class Str {
  constructor(readonly s: string) {} // its bytes, one character each
}
class Dict {
  constructor(readonly v: Record<string, Val>) {}
  get(k: string): Val | undefined {
    return Object.hasOwn(this.v, k) ? this.v[k] : undefined;
  }
}
class Op {
  constructor(readonly op: string) {}
}
type Val = number | boolean | null | Name | Ref | Str | Dict | Val[];

const END = Symbol('end');

// ---------- reading tokens

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

class Lexer {
  constructor(
    readonly s: string,
    public pos = 0,
    private end = s.length,
  ) {}

  skip(): void {
    const s = this.s;
    while (this.pos < this.end) {
      const c = s.charCodeAt(this.pos);
      if (WS.has(c)) this.pos++;
      else if (c === 37) {
        // % a comment, to the end of the line
        while (this.pos < this.end && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
      } else break;
    }
  }

  // One value, an operator, or END.
  value(depth = 0): Val | Op | typeof END {
    this.skip();
    if (this.pos >= this.end) return END;
    const s = this.s;
    const c = s[this.pos];
    if (c === '(') return this.literal();
    if (c === '<') {
      if (s[this.pos + 1] === '<') {
        this.pos += 2;
        return this.dict(depth);
      }
      return this.hex();
    }
    if (c === '[') {
      this.pos++;
      const arr: Val[] = [];
      for (;;) {
        this.skip();
        if (this.pos >= this.end) return arr;
        if (s[this.pos] === ']') {
          this.pos++;
          return arr;
        }
        const v = depth > 64 ? END : this.value(depth + 1);
        if (v === END) return arr;
        if (!(v instanceof Op)) arr.push(v);
      }
    }
    if (c === '/') {
      let i = this.pos + 1;
      while (i < this.end && !WS.has(s.charCodeAt(i)) && !DELIM.has(s[i])) i++;
      const raw = s.slice(this.pos + 1, i);
      this.pos = i;
      return new Name(raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === ']' || c === '>' || c === ')' || c === '{' || c === '}') {
      this.pos += c === '>' && s[this.pos + 1] === '>' ? 2 : 1;
      return new Op(c === '>' ? '>>' : c);
    }
    let i = this.pos;
    while (i < this.end && !WS.has(s.charCodeAt(i)) && !DELIM.has(s[i])) i++;
    if (i === this.pos) i++;
    const word = s.slice(this.pos, i);
    this.pos = i;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const n = Number(word);
      // "12 0 R": a reference to object 12.
      if (/^\d+$/.test(word)) {
        const m = /^\s+(\d+)\s+R(?![^\s/<>[\]()%])/.exec(s.slice(i, i + 24));
        if (m) {
          this.pos = i + m[0].length;
          return new Ref(n);
        }
      }
      return n;
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Op(word);
  }

  private dict(depth: number): Dict {
    const v: Record<string, Val> = {};
    for (;;) {
      this.skip();
      if (this.pos >= this.end) break;
      if (this.s[this.pos] === '>' && this.s[this.pos + 1] === '>') {
        this.pos += 2;
        break;
      }
      const k = this.value(depth + 1);
      if (k === END) break;
      if (!(k instanceof Name)) continue;
      const val = depth > 64 ? END : this.value(depth + 1);
      if (val === END) break;
      if (val instanceof Op) {
        if (val.op === '>>') break;
        continue;
      }
      v[k.n] = val;
    }
    return new Dict(v);
  }

  private literal(): Str {
    const s = this.s;
    let i = this.pos + 1;
    let depth = 1;
    let out = '';
    while (i < this.end) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        i += 2;
        if (n === 'n') out += '\n';
        else if (n === 'r') out += '\r';
        else if (n === 't') out += '\t';
        else if (n === 'b') out += '\b';
        else if (n === 'f') out += '\f';
        else if (n === '\r') {
          if (s[i] === '\n') i++;
        } else if (n === '\n') {
          // a line break that doesn't count
        } else if (n >= '0' && n <= '7') {
          let oct = n;
          while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') oct += s[i++];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (n !== undefined) out += n;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        i++;
        break;
      }
      out += c;
      i++;
    }
    this.pos = i;
    return new Str(out);
  }

  private hex(): Str {
    const close = this.s.indexOf('>', this.pos);
    const end = close < 0 ? this.end : close;
    let h = this.s.slice(this.pos + 1, end).replace(/[^0-9a-fA-F]/g, '');
    if (h.length % 2) h += '0';
    let out = '';
    for (let i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    this.pos = end + 1;
    return new Str(out);
  }
}

// ---------- bytes and streams

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return s;
}

// Unpacks what it can (a stream cut short still gives its start).
function inflate(data: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let size = 0;
  const zlib = data.length > 2 && (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0;
  const inf = new Inflate((c) => {
    parts.push(c);
    size += c.length;
  });
  try {
    inf.push(zlib ? data.subarray(2) : data, true);
  } catch {
    if (!size) return null;
  }
  const out = new Uint8Array(size);
  let p = 0;
  for (const c of parts) out.set(c, (p += c.length) - c.length);
  return out;
}

function asciiHex(data: Uint8Array): Uint8Array {
  const s = latin1(data).replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.ceil(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt((s.slice(i * 2, i * 2 + 2) + '0').slice(0, 2), 16);
  return out;
}

function ascii85(data: Uint8Array): Uint8Array {
  const s = latin1(data).replace(/^\s*<~/, '').replace(/~>.*$/s, '').replace(/\s+/g, '');
  const out: number[] = [];
  let group: number[] = [];
  const flush = (n: number) => {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + (group[i] ?? 84);
    const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...b.slice(0, n));
    group = [];
  };
  for (const ch of s) {
    if (ch === 'z' && !group.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) flush(4);
  }
  if (group.length > 1) flush(group.length - 1);
  return new Uint8Array(out);
}

interface Obj {
  val: Val;
  stream?: [number, number]; // where its data is in the file
  data?: Uint8Array | null; // unpacked, once asked for
}

class Pdf {
  objs = new Map<number, Obj>();
  private fonts = new Map<Dict, Font>();

  constructor(
    readonly bytes: Uint8Array,
    readonly s: string,
  ) {
    this.scan();
    this.unpackObjectStreams();
  }

  // Every "12 0 obj … endobj" in the file. A later one wins (a file saved again adds to its end).
  private scan(): void {
    const s = this.s;
    const re = /(\d+)\s+\d+\s+obj\b/g;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      const num = Number(m[1]);
      const lex = new Lexer(s, re.lastIndex);
      const val = lex.value();
      if (val === END || val instanceof Op) continue;
      const o: Obj = { val };
      lex.skip();
      if (s.startsWith('stream', lex.pos)) {
        let start = lex.pos + 6;
        if (s[start] === '\r') start++;
        if (s[start] === '\n') start++;
        const len = val instanceof Dict ? val.get('Length') : undefined;
        let end = -1;
        if (typeof len === 'number' && len >= 0 && /^\s*endstream/.test(s.slice(start + len, start + len + 20))) end = start + len;
        else {
          end = s.indexOf('endstream', start);
          if (end < 0) end = s.length;
          if (s[end - 1] === '\n') end--;
          if (s[end - 1] === '\r') end--;
        }
        o.stream = [start, Math.max(start, end)];
        re.lastIndex = end;
      }
      this.objs.set(num, o);
    }
  }

  // Objects packed inside other objects (PDF 1.5 and later).
  private unpackObjectStreams(): void {
    for (const o of [...this.objs.values()]) {
      if (!(o.val instanceof Dict) || !isName(o.val.get('Type'), 'ObjStm')) continue;
      const data = this.data(o);
      const n = o.val.get('N');
      const first = o.val.get('First');
      if (!data || typeof n !== 'number' || typeof first !== 'number') continue;
      const s = latin1(data);
      const nums = s.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i < n && i * 2 + 1 < nums.length; i++) {
        const num = nums[i * 2];
        if (this.objs.has(num)) continue;
        const end = i + 1 < n && i * 2 + 3 < nums.length ? first + nums[i * 2 + 3] : s.length;
        const v = new Lexer(s, first + nums[i * 2 + 1], end).value();
        if (v !== END && !(v instanceof Op)) this.objs.set(num, { val: v });
      }
    }
  }

  get(v: Val | undefined, depth = 0): Val | undefined {
    if (v instanceof Ref) return depth > 16 ? undefined : this.get(this.objs.get(v.num)?.val, depth + 1);
    return v;
  }

  dict(v: Val | undefined): Dict | undefined {
    const d = this.get(v);
    return d instanceof Dict ? d : undefined;
  }

  // A stream's data, unpacked: null when it can't be (pictures, filters not known here).
  data(o: Obj | undefined): Uint8Array | null {
    if (!o?.stream) return null;
    if (o.data !== undefined) return o.data;
    let data: Uint8Array | null = this.bytes.subarray(o.stream[0], o.stream[1]);
    const d = o.val instanceof Dict ? o.val : null;
    const f = this.get(d?.get('Filter'));
    const filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => (x instanceof Name ? x.n : ''));
    for (const name of filters) {
      if (!data) break;
      if (name === 'FlateDecode' || name === 'Fl') data = inflate(data);
      else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHex(data);
      else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
      else data = null;
    }
    o.data = data;
    return data;
  }

  streamOf(v: Val | undefined): Obj | undefined {
    return v instanceof Ref ? this.objs.get(v.num) : undefined;
  }

  font(v: Val | undefined): Font | null {
    const d = this.dict(v);
    if (!d) return null;
    let f = this.fonts.get(d);
    if (!f) this.fonts.set(d, (f = makeFont(this, d)));
    return f;
  }
}

const isName = (v: Val | undefined, n: string) => v instanceof Name && v.n === n;

// ---------- fonts: from the codes in the page to letters

interface Font {
  bytes: 1 | 2; // how many bytes each code takes
  map: Map<number, string> | null; // ToUnicode
  diff: Map<number, string> | null; // simple fonts: codes named another way (/Differences)
  simple: boolean;
}

// Windows-1252 for 128 to 159, which simple fonts mostly use.
const WIN = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–\u2014˜™š›œ\u009džŸ';
const winAnsi = (c: number) => (c >= 128 && c < 160 ? WIN[c - 128] : c >= 32 ? String.fromCharCode(c) : c === 9 || c === 10 || c === 13 ? ' ' : '');

const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', underscore: '_', braceleft: '{', bar: '|', braceright: '}', quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '\u2014', bullet: '•', ellipsis: '…',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl',
  eacute: 'é', egrave: 'è', ecircumflex: 'ê', agrave: 'à', aacute: 'á', acircumflex: 'â', adieresis: 'ä', odieresis: 'ö', udieresis: 'ü', ccedilla: 'ç', germandbls: 'ß', ntilde: 'ñ', nbspace: ' ',
};

function glyph(name: string): string {
  if (/^[A-Za-z]$/.test(name)) return name;
  if (GLYPHS[name]) return GLYPHS[name];
  const u = name.match(/^uni([0-9A-Fa-f]{4})$/) ?? name.match(/^u([0-9A-Fa-f]{4,6})$/);
  return u ? String.fromCodePoint(parseInt(u[1], 16)) : '';
}

// Hex "<0041>" in a CMap as text (UTF-16, big end first).
function utf16(hex: string): string {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  if (hex.length % 4 === 2) out += String.fromCharCode(parseInt(hex.slice(-2), 16));
  return out;
}

// A ToUnicode CMap: each code's letters, and how many bytes a code takes.
export function parseCMap(text: string): { map: Map<number, string>; bytes: 1 | 2 } {
  const map = new Map<number, string>();
  const space = text.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/);
  const bytes: 1 | 2 = space && space[1].length <= 2 ? 1 : 2;
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), utf16(m[2]));
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 0xffff);
      if (m[3].startsWith('[')) {
        const list = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
        list.forEach((t, i) => lo + i <= hi && map.set(lo + i, t));
      } else {
        const base = m[3].slice(1, -1);
        const head = utf16(base.slice(0, -4));
        const last = parseInt(base.slice(-4) || '0', 16);
        for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(last + c - lo));
      }
    }
  }
  return { map, bytes };
}

function makeFont(pdf: Pdf, d: Dict): Font {
  const simple = !isName(d.get('Subtype'), 'Type0');
  const f: Font = { bytes: simple ? 1 : 2, map: null, diff: null, simple };
  const tu = pdf.data(pdf.streamOf(d.get('ToUnicode')));
  if (tu) {
    const c = parseCMap(latin1(tu));
    if (c.map.size) {
      f.map = c.map;
      if (!simple) f.bytes = c.bytes;
    }
  }
  const enc = pdf.dict(d.get('Encoding'));
  const diffs = enc ? pdf.get(enc.get('Differences')) : undefined;
  if (Array.isArray(diffs)) {
    f.diff = new Map();
    let code = 0;
    for (const x of diffs) {
      if (typeof x === 'number') code = x;
      else if (x instanceof Name) f.diff.set(code++, glyph(x.n));
    }
  }
  return f;
}

function decodeText(s: string, font: Font | null): string {
  if (!font) {
    let out = '';
    for (let i = 0; i < s.length; i++) out += winAnsi(s.charCodeAt(i));
    return out;
  }
  let out = '';
  for (let i = 0; i + font.bytes <= s.length; i += font.bytes) {
    const code = font.bytes === 2 ? (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1) : s.charCodeAt(i);
    const t = font.map?.get(code) ?? font.diff?.get(code);
    if (t !== undefined) out += t;
    else if (font.simple) out += winAnsi(code);
  }
  return out;
}

// ---------- the text on a page

class Text {
  out = '';
  private lastY: number | null = null;
  private moved = false;
  size = 12;

  move(y: number): void {
    this.moved = true;
    this.y = y;
  }
  y = 0;

  add(t: string): void {
    if (!t || this.out.length > MAX_TEXT) return;
    if (this.lastY !== null) {
      const gap = Math.abs(this.y - this.lastY);
      const line = Math.max(1, Math.abs(this.size));
      if (gap > line * 0.5) this.out += gap > line * 1.9 ? '\n\n' : '\n';
      else if (this.moved && !/\s$/.test(this.out) && !/^\s/.test(t)) this.out += ' ';
    }
    this.out += t;
    this.lastY = this.y;
    this.moved = false;
  }

  page(): void {
    if (this.out && !this.out.endsWith('\n\n')) this.out += '\n\n';
    this.lastY = null;
  }
}

function runContent(pdf: Pdf, content: string, resources: Dict | undefined, text: Text, depth: number, seen: Set<Obj>): void {
  const fonts = pdf.dict(resources?.get('Font'));
  const xobjects = pdf.dict(resources?.get('XObject'));
  const lex = new Lexer(content);
  const args: Val[] = [];
  let font: Font | null = null;
  let fontSize = 12;
  let tm = [1, 0, 0, 1, 0, 0]; // the text matrix
  let lm = [1, 0, 0, 1, 0, 0]; // the start of the line
  let leading = 0;
  const num = (i: number) => (typeof args[i] === 'number' ? (args[i] as number) : 0);
  const setSize = () => (text.size = fontSize * (Math.abs(tm[3]) || 1));
  const td = (x: number, y: number) => {
    lm = [lm[0], lm[1], lm[2], lm[3], lm[4] + x * lm[0] + y * lm[2], lm[5] + x * lm[1] + y * lm[3]];
    tm = lm.slice();
    setSize();
    text.move(tm[5]);
  };
  const show = (s: Val | undefined) => s instanceof Str && text.add(decodeText(s.s, font));
  for (let guard = 0; guard < 5_000_000; guard++) {
    const v = lex.value();
    if (v === END) break;
    if (!(v instanceof Op)) {
      args.push(v);
      continue;
    }
    switch (v.op) {
      case 'BT':
        tm = [1, 0, 0, 1, 0, 0];
        lm = tm.slice();
        break;
      case 'Tf': {
        const name = args[0];
        font = name instanceof Name && fonts ? pdf.font(fonts.get(name.n)) : null;
        fontSize = num(1) || fontSize;
        setSize();
        break;
      }
      case 'TL':
        leading = num(0);
        break;
      case 'Td':
        td(num(0), num(1));
        break;
      case 'TD':
        leading = -num(1);
        td(num(0), num(1));
        break;
      case 'Tm':
        tm = [num(0), num(1), num(2), num(3), num(4), num(5)];
        lm = tm.slice();
        setSize();
        text.move(tm[5]);
        break;
      case 'T*':
        td(0, -leading);
        break;
      case 'Tj':
        show(args[0]);
        break;
      case "'":
        td(0, -leading);
        show(args[0]);
        break;
      case '"':
        td(0, -leading);
        show(args[2]);
        break;
      case 'TJ': {
        const arr = Array.isArray(args[0]) ? args[0] : [];
        let s = '';
        for (const x of arr) {
          if (x instanceof Str) s += decodeText(x.s, font);
          else if (typeof x === 'number' && x < -200 && !/\s$/.test(s)) s += ' ';
        }
        text.add(s);
        break;
      }
      case 'Do': {
        // A form (a part drawn from elsewhere) can hold words too.
        const name = args[0];
        const ref = name instanceof Name && xobjects ? xobjects.get(name.n) : undefined;
        const o = pdf.streamOf(ref);
        if (!o || seen.has(o) || depth > 4 || !(o.val instanceof Dict) || !isName(o.val.get('Subtype'), 'Form')) break;
        const data = pdf.data(o);
        if (!data) break;
        seen.add(o);
        runContent(pdf, latin1(data), pdf.dict(o.val.get('Resources')) ?? resources, text, depth + 1, seen);
        break;
      }
      case 'BI': {
        // A picture written into the page: skip its bytes, up to "EI".
        const at = content.indexOf('ID', lex.pos);
        const end = at < 0 ? -1 : content.slice(at + 3).search(/\sEI(\s|$)/);
        lex.pos = at < 0 || end < 0 ? content.length : at + 3 + end + 3;
        break;
      }
    }
    args.length = 0;
  }
}

// The pages in order (from the catalog's page tree), each with its resources.
function pages(pdf: Pdf): { page: Dict; resources?: Dict }[] {
  const out: { page: Dict; resources?: Dict }[] = [];
  const seen = new Set<Dict>();
  const walk = (node: Dict | undefined, resources: Dict | undefined, depth: number) => {
    if (!node || seen.has(node) || depth > 32 || out.length >= MAX_PAGES) return;
    seen.add(node);
    const res = pdf.dict(node.get('Resources')) ?? resources;
    const kids = pdf.get(node.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) walk(pdf.dict(k), res, depth + 1);
    else if (isName(node.get('Type'), 'Page') || node.get('Contents') !== undefined) out.push({ page: node, resources: res });
  };
  const roots = [...pdf.s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  const root = roots.length ? pdf.dict(new Ref(Number(roots[roots.length - 1][1]))) : undefined;
  walk(pdf.dict(root?.get('Pages')), undefined, 0);
  if (out.length) return out;
  // No page tree found: every page, in the order of their numbers.
  const all = [...pdf.objs.entries()].filter(([, o]) => o.val instanceof Dict && isName(o.val.get('Type'), 'Page')).sort((a, b) => a[0] - b[0]);
  for (const [, o] of all.slice(0, MAX_PAGES)) {
    const page = o.val as Dict;
    let res = pdf.dict(page.get('Resources'));
    for (let p = pdf.dict(page.get('Parent')), i = 0; !res && p && i < 32; p = pdf.dict(p.get('Parent')), i++) res = pdf.dict(p.get('Resources'));
    out.push({ page, resources: res });
  }
  return out;
}

// A date written the PDF way: "D:20240102093000+01'00'".
export function pdfDate(s: string): number {
  const m = s.match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-])?(\d{2})?'?(\d{2})?/);
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +(m[2] ?? 1) - 1, +(m[3] ?? 1), +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const off = m[7] === '+' || m[7] === '-' ? (m[7] === '-' ? -1 : 1) * (+(m[8] ?? 0) * 60 + +(m[9] ?? 0)) : 0;
  return t - off * 60_000;
}

// Text in the document's details: UTF-16 when it starts with FE FF, else one byte a letter.
function infoText(v: Val | undefined): string {
  if (!(v instanceof Str)) return '';
  const s = v.s;
  if (s.startsWith('þÿ')) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  }
  return s;
}

export interface PdfRead {
  text: string;
  pages: number;
  created?: number;
  title?: string;
  locked?: boolean;
}

// The words of a PDF, page by page.
export function pdfText(bytes: Uint8Array): PdfRead {
  const s = latin1(bytes);
  // Locked with a password (or kept from copying): its contents are scrambled.
  if (/\/Encrypt\s+(\d+\s+\d+\s+R|<<)/.test(s)) return { text: '', pages: 0, locked: true };
  const pdf = new Pdf(bytes, s);
  const text = new Text();
  const list = pages(pdf);
  for (const { page, resources } of list) {
    const c = pdf.get(page.get('Contents'));
    const refs = Array.isArray(c) ? c : [page.get('Contents')];
    const content = refs
      .map((r) => pdf.data(pdf.streamOf(r)))
      .filter((d): d is Uint8Array => !!d)
      .map(latin1)
      .join('\n');
    if (content) runContent(pdf, content, resources, text, 0, new Set());
    text.page();
    if (text.out.length > MAX_TEXT) break;
  }
  const out: PdfRead = { text: text.out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), pages: list.length };
  const infos = [...s.matchAll(/\/Info\s+(\d+)\s+\d+\s+R/g)];
  const info = infos.length ? pdf.dict(new Ref(Number(infos[infos.length - 1][1]))) : undefined;
  const made = info ? pdfDate(infoText(pdf.get(info.get('CreationDate')))) : NaN;
  if (Number.isFinite(made)) out.created = made;
  const title = info ? infoText(pdf.get(info.get('Title'))).trim() : '';
  if (title) out.title = title;
  return out;
}

// Enough letters or numbers to be words, not a stray mark or two.
export const readable = (text: string): boolean => (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 4;

async function allBytes(input: TextInput): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  if (input.raw) {
    for await (const b of input.raw()) {
      const take = b.subarray(0, MAX_BYTES - size);
      parts.push(take);
      size += take.length;
      if (size >= MAX_BYTES) break;
    }
  }
  const out = new Uint8Array(size);
  let p = 0;
  for (const c of parts) out.set(c, (p += c.length) - c.length);
  return out;
}

// A PDF file as one note: its words (none when it's a scan), named after the file.
export function parsePdf(input: TextInput): AsyncGenerator<LifeEvent[]> {
  return noteBatches(
    (async function* (): AsyncGenerator<NoteDoc> {
      const r = pdfText(await allBytes(input));
      if (!readable(r.text)) return;
      const file = baseName(input.name);
      const at = r.created ?? input.modified ?? NaN;
      yield { app: 'PDF', key: file, title: noExt(file), text: r.text, at, extra: { pages: r.pages, file: file.slice(0, 200) } };
    })(),
  );
}
