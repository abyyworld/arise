// Gemini: Google Takeout, My Activity, Gemini Apps ("Takeout/My Activity/Gemini Apps/MyActivity.json",
// or MyActivity.html when the export was made in HTML). Each record is one question:
//   { "header": "Gemini Apps", "title": "Prompted what should I cook tonight?",
//     "time": "2024-11-03T18:15:22.123Z", "products": ["Gemini Apps"],
//     "safeHtmlItem": [{ "html": "<p>The answer…</p>" }] }
// The HTML has the same in a cell each: "Prompted what should I cook tonight?<br>Nov 3, 2024,
// 7:15:22 PM CET<br>…the answer".
//
// Takeout keeps no conversation id, so the questions are put together one conversation per day
// (on this device's clock): a day of questions is what people remember as "that day I asked
// Gemini about…", the picker stays short, and each day can be deleted on its own. Its id is
// "day:2024-11-03" and its name its first question. Only the Player's questions are kept; an
// answer only counts as a message.

import type { LifeEvent } from '../types';
import type { AiChatInfo, TextInput } from './types';
import { aiChatEvents, listChats, type AiConversation, type AiMessage } from './ai-chat';
import { isObj } from './chat';
import { JsonItems } from './json-stream';
import { clean, dayOf, isoMs, localMs } from './util';

interface Ask {
  at: number;
  title: string;
  answered: boolean;
}

// "Prompted …" in English. Other English titles (feedback, Gems made, features used) aren't
// questions. Takeout writes the titles in the Player's language: when none is in English, every
// record counts as a question.
const PROMPTED = /^Prompted\s+/i;
const isHtml = (name: string) => /\.html?$/i.test(name);

function fromJson(v: unknown): Ask | null {
  if (!isObj(v)) return null;
  const at = isoMs(v.time);
  const title = clean(v.title, 300);
  if (!Number.isFinite(at) || !title) return null;
  const answered = Array.isArray(v.safeHtmlItem) && v.safeHtmlItem.some((x) => isObj(x) && typeof x.html === 'string' && !!x.html.trim());
  return { at, title, answered };
}

// ---------- HTML

const ENTITY: Record<string, string> = { nbsp: ' ', emsp: ' ', ensp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function htmlText(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, name: string) => {
      const lower = name.toLowerCase();
      if (lower in ENTITY) return ENTITY[lower];
      if (lower.startsWith('#x')) return safeChar(parseInt(lower.slice(2), 16));
      if (lower.startsWith('#')) return safeChar(parseInt(lower.slice(1), 10));
      return all;
    });
}

const safeChar = (n: number) => (Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const month = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

// The time on an HTML record, in English: "Nov 3, 2024, 7:15:22 PM CET" or "3 Nov 2024, 19:15:22
// GMT". The zone is left out and the time read on this device's clock, which is the zone the
// Player's Google account writes in nearly always.
export function htmlTime(line: string): number {
  const s = clean(line, 120);
  let y: number, mo: number, d: number, rest: string;
  let m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4}),? (.*)$/);
  if (m) [mo, d, y, rest] = [month(m[1]), +m[2], +m[3], m[4]];
  else {
    m = s.match(/^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4}),? (.*)$/);
    if (!m) return NaN;
    [d, mo, y, rest] = [+m[1], month(m[2]), +m[3], m[4]];
  }
  const t = rest.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
  if (!t || mo < 1) return NaN;
  let h = +t[1];
  const pm = t[4]?.toLowerCase();
  if (pm === 'pm' && h < 12) h += 12;
  if (pm === 'am' && h === 12) h = 0;
  return localMs(y, mo, d, h, +t[2], +(t[3] || 0));
}

const CELL = 'class="outer-cell';

function fromCell(cell: string): Ask | null {
  const c = cell.match(/class="content-cell[^"]*"[^>]*>([\s\S]*?)(<\/div>|$)/);
  if (!c) return null;
  const lines = c[1]
    .split(/<br\s*\/?>/i)
    .map((x) => clean(htmlText(x), 300))
    .filter(Boolean);
  if (lines.length < 2) return null;
  const at = htmlTime(lines[1]);
  if (!Number.isFinite(at)) return null;
  return { at, title: lines[0], answered: lines.length > 2 };
}

async function* htmlAsks(input: TextInput): AsyncGenerator<Ask> {
  let buf = '';
  for await (const chunk of input.text) {
    buf += chunk;
    let start = buf.indexOf(CELL);
    if (start < 0) {
      buf = buf.slice(-CELL.length);
      continue;
    }
    for (let next = buf.indexOf(CELL, start + 1); next >= 0; next = buf.indexOf(CELL, start + 1)) {
      const a = fromCell(buf.slice(start, next));
      if (a) yield a;
      start = next;
    }
    buf = buf.slice(start);
  }
  if (buf.startsWith(CELL)) {
    const a = fromCell(buf);
    if (a) yield a;
  }
}

async function* jsonAsks(input: TextInput): AsyncGenerator<Ask> {
  const items = new JsonItems();
  for await (const chunk of input.text) {
    for (const it of items.push(chunk)) {
      const a = fromJson(it.value);
      if (a) yield a;
    }
  }
}

// The whole file's questions, one conversation per day, oldest first.
async function* conversations(input: TextInput): AsyncGenerator<AiConversation> {
  const asks: Ask[] = [];
  for await (const a of isHtml(input.name) ? htmlAsks(input) : jsonAsks(input)) asks.push(a);
  const english = asks.some((a) => PROMPTED.test(a.title));
  const days = new Map<string, AiMessage[]>();
  for (const a of asks.sort((x, y) => x.at - y.at)) {
    if (english && !PROMPTED.test(a.title)) continue;
    const text = a.title.replace(PROMPTED, '').trim();
    if (!text) continue;
    const day = dayOf(a.at);
    let list = days.get(day);
    if (!list) days.set(day, (list = []));
    list.push({ at: a.at, me: true, text });
    if (a.answered) list.push({ at: a.at, me: false, text: 'answer' });
  }
  for (const [day, messages] of days) yield { id: `day:${day}`, title: '', messages };
}

export const listGemini = (input: TextInput): Promise<AiChatInfo[]> => listChats(conversations(input));

export function parseGemini(input: TextInput, only?: readonly string[]): AsyncGenerator<LifeEvent[]> {
  return aiChatEvents('gemini', 'Gemini', conversations(input), only);
}
