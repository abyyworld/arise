// Reads chosen values out of a big JSON file a piece of text at a time, by where they sit in it:
// a path of keys and array places, like ["chats", "list", 3, "messages", 120]. Only the values
// asked for are kept and parsed, so a file of hundreds of megabytes never has to be in memory,
// and the values can sit as deep as they like (JsonItems only finds them at the top).
//
// Anything before the first { or [ is skipped, so an X archive's "window.YTD.… = [" is fine.
// A value that is broken is skipped, not the whole file.

export type Seg = string | number;

export interface JsonHit {
  path: Seg[];
  value: unknown;
}

const QUOTE = 34;
const BACKSLASH = 92;
const OPEN_OBJ = 123;
const CLOSE_OBJ = 125;
const OPEN_ARR = 91;
const CLOSE_ARR = 93;
const COMMA = 44;
const COLON = 58;

const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;
const isEnd = (c: number) => c === COMMA || c === CLOSE_OBJ || c === CLOSE_ARR || isSpace(c);

interface Frame {
  arr: boolean;
  key: Seg; // the key (object) or place (array) of the value being read in it
  needKey: boolean; // an object waiting for its next key
}

// What's being kept: a whole object or array, a string, or a number (or true, false, null).
interface Keep {
  path: Seg[];
  kind: 'box' | 'str' | 'bare';
  depth: number; // for a box: how deep inside it
  parts: string[];
  inStr: boolean;
  esc: boolean;
}

export class JsonPaths {
  private stack: Frame[] = [];
  private started = false;
  private inStr = false; // inside a string that isn't kept
  private esc = false;
  private keyParts: string[] | null = null; // a key being read
  private keep: Keep | null = null;
  broken = 0;

  // `want` says, for the path of a value about to start, whether to keep it.
  constructor(private want: (path: readonly Seg[]) => boolean) {}

  private path(): Seg[] {
    return this.stack.map((f) => f.key);
  }

  push(s: string): JsonHit[] {
    const out: JsonHit[] = [];
    const n = s.length;
    let i = 0;
    while (i < n) {
      const k = this.keep;
      if (k) {
        i = this.keepGoing(k, s, i, out);
        continue;
      }
      if (this.inStr) {
        // Jump to the next quote or backslash.
        let j = i;
        for (; j < n; j++) {
          if (this.esc) {
            this.esc = false;
            continue;
          }
          const c = s.charCodeAt(j);
          if (c === BACKSLASH) this.esc = true;
          else if (c === QUOTE) break;
        }
        if (this.keyParts) this.keyParts.push(s.slice(i, Math.min(j, n)));
        if (j >= n) return out;
        this.inStr = false;
        if (this.keyParts) {
          const raw = this.keyParts.join('');
          this.keyParts = null;
          const f = this.stack[this.stack.length - 1];
          let key = raw;
          if (raw.includes('\\')) {
            try {
              key = JSON.parse(`"${raw}"`) as string;
            } catch {}
          }
          if (f) {
            f.key = key;
            f.needKey = false;
          }
        }
        i = j + 1;
        continue;
      }
      const c = s.charCodeAt(i);
      if (!this.started) {
        if (c !== OPEN_OBJ && c !== OPEN_ARR) {
          i++;
          continue;
        }
        this.started = true;
      }
      if (isSpace(c) || c === COLON) {
        i++;
        continue;
      }
      const top = this.stack[this.stack.length - 1];
      if (c === COMMA) {
        if (top) {
          if (top.arr) top.key = (top.key as number) + 1;
          else top.needKey = true;
        }
        i++;
        continue;
      }
      if (c === CLOSE_OBJ || c === CLOSE_ARR) {
        this.stack.pop();
        i++;
        continue;
      }
      if (top && !top.arr && top.needKey) {
        if (c === QUOTE) {
          this.inStr = true;
          this.keyParts = [];
        }
        i++;
        continue;
      }
      // A value starts here.
      if (this.stack.length && this.want(this.path())) {
        const kind = c === OPEN_OBJ || c === OPEN_ARR ? 'box' : c === QUOTE ? 'str' : 'bare';
        this.keep = { path: this.path(), kind, depth: 0, parts: [], inStr: false, esc: false };
        // A string or a box starts with the character itself; keepGoing reads from here.
        continue;
      }
      if (c === OPEN_OBJ) this.stack.push({ arr: false, key: '', needKey: true });
      else if (c === OPEN_ARR) this.stack.push({ arr: true, key: 0, needKey: false });
      else if (c === QUOTE) this.inStr = true;
      else {
        // A number, true, false or null nobody wants: step over it.
        while (i + 1 < n && !isEnd(s.charCodeAt(i + 1))) i++;
      }
      i++;
    }
    return out;
  }

  // Reads more of a kept value from s at i; gives back where it stopped.
  private keepGoing(k: Keep, s: string, i: number, out: JsonHit[]): number {
    const n = s.length;
    let j = i;
    let done = false;
    if (k.kind === 'bare') {
      while (j < n && !isEnd(s.charCodeAt(j))) j++;
      done = j < n;
      k.parts.push(s.slice(i, j));
    } else {
      for (; j < n; j++) {
        const c = s.charCodeAt(j);
        if (k.inStr) {
          if (k.esc) k.esc = false;
          else if (c === BACKSLASH) k.esc = true;
          else if (c === QUOTE) {
            k.inStr = false;
            if (k.kind === 'str') {
              j++;
              done = true;
              break;
            }
          }
          continue;
        }
        if (c === QUOTE) k.inStr = true;
        else if (c === OPEN_OBJ || c === OPEN_ARR) k.depth++;
        else if (c === CLOSE_OBJ || c === CLOSE_ARR) {
          k.depth--;
          if (!k.depth) {
            j++;
            done = true;
            break;
          }
        }
      }
      k.parts.push(s.slice(i, j));
    }
    if (done) {
      this.keep = null;
      try {
        out.push({ path: k.path, value: JSON.parse(k.parts.join('')) });
      } catch {
        this.broken++;
      }
    }
    return j;
  }

  // The end of the text: a number at the very end is complete now.
  end(): JsonHit[] {
    const k = this.keep;
    const out: JsonHit[] = [];
    if (k && k.kind === 'bare') {
      try {
        out.push({ path: k.path, value: JSON.parse(k.parts.join('')) });
      } catch {
        this.broken++;
      }
    }
    this.keep = null;
    return out;
  }
}

// Every value wanted from a stream of text.
export async function* jsonPaths(text: AsyncIterable<string>, want: (path: readonly Seg[]) => boolean): AsyncGenerator<JsonHit[]> {
  const r = new JsonPaths(want);
  for await (const chunk of text) {
    const hits = r.push(chunk);
    if (hits.length) yield hits;
  }
  const rest = r.end();
  if (rest.length) yield rest;
}
