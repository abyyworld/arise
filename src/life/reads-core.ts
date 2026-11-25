// "Arise reads it for you", without the database or the AI: which AI may read a note or a file,
// what it's asked, how its answer is checked, and how the queue picks what's next. Pure, so it's
// tested on its own (reads-core.test.ts). The queue itself is reads.ts; the screens reads-ui.js.
//
// Privacy is the point. A note or a file goes only to an AI that may read its tier, the same rule
// as the coach's (policy.ts): the private AI, the AI on this device or the Player's own computer
// read everything; the free AI and the Player's own AI service only when they allowed less private
// AIs to read the life log. On top of that, what looks like it's about health, money or ID papers
// is held back unless the Player allows it, and what looks like ID papers never goes to a less
// private AI at all.

import { capFor, lessPrivate, type Engine } from './policy';
import { cleanReadTags, READ_DESC_MAX, READ_TIDY_MAX, type ReadJob, type ReadPrefs, type ReadQueue } from '../lib/validate';
import type { LifeSource, LifeTier } from './types';

// ---------- what's read

export interface Candidate {
  id: string; // the read's id: 'e:' and a note's id, or 'f:' and a file's
  kind: 'note' | 'file';
  tier: LifeTier;
  title: string;
  text: string; // its words (a note's title and words, a file's text)
  source?: LifeSource;
  rat?: number; // when the record was
}

// Too little to say anything about.
export const MIN_LETTERS = 40;
export const worthReading = (text: string) => (text.match(/\p{L}/gu) || []).length >= MIN_LETTERS;

// A short fingerprint of the words a read was made from (FNV-1a, 32 bits, and the length).
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${(h >>> 0).toString(36)}${(s.length % 1296).toString(36)}`;
}

// ---------- what's held back

export type Sensitive = 'health' | 'money' | 'id';

const HEALTH =
  /\b(doctors?|gp|nurse|diagnos\w*|prescri\w*|medications?|medicines?|meds|pills?|dosage|symptoms?|therap\w*|therapist|counsell?ing|psychiatr\w*|psycholog\w*|hospital|clinic|surgery|blood (test|pressure|sugar)|cholesterol|depress\w*|anxiety|panic attacks?|pregnan\w*|vaccin\w*|allerg\w*|cancer|tumou?r|diabet\w*|asthma|hiv|std|sti|mental health|illness|disease|injur\w*|x-ray|mri|scan results?|test results?|antidepressants?|insulin|chemo\w*|rehab)\b/i;
const MONEY =
  /\b(bank|banking|account (number|no)|iban|bic|swift|sort code|routing number|credit card|debit card|card number|cvv|pin code|salary|payslip|pay slip|wages?|invoice|tax return|taxes|mortgage|loan|debt|transactions?|paypal|venmo|revolut|crypto|bitcoin|net worth|savings account|pension)\b|[$€£¥₹]\s?\d|\b\d[\d,.]*\s?(usd|eur|gbp|dollars|euros|pounds)\b/i;
const ID_WORDS = /\b(passport|driver'?s licen[cs]e|driving licen[cs]e|national id|id card|identity card|social security|ssn|national insurance|tax id|tax number|personal number|date of birth|birth certificate|residence permit|visa number)\b/i;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const CARD = /\b(?:\d[ -]?){13,19}\b/;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/;
const LONG_NUMBER = /\b\d{9,}\b/;

// Whether these words look like they're about health, money or ID papers. Errs on the side of
// holding back: a false alarm only means the Player is asked first.
export function sensitive(text: string): Sensitive[] {
  const out: Sensitive[] = [];
  if (HEALTH.test(text)) out.push('health');
  if (MONEY.test(text) || CARD.test(text) || IBAN.test(text)) out.push('money');
  // A card or account number is as private as ID papers: never to a less private AI either.
  if (ID_WORDS.test(text) || SSN.test(text) || LONG_NUMBER.test(text) || CARD.test(text) || IBAN.test(text)) out.push('id');
  return out;
}

// ---------- the gate

export type Held = 'no-ai' | 'less-private' | 'tier' | Sensitive;

export interface GateOptions {
  lessPrivateOk: boolean; // "Let less private AIs read my life log"
  allow: Pick<ReadPrefs, 'health' | 'money' | 'id'>;
}

// Why this record may not go to this AI, or null when it may.
export function gate(c: Pick<Candidate, 'tier' | 'title' | 'text'>, e: Engine | null | undefined, o: GateOptions): Held | null {
  if (!e) return 'no-ai';
  if (lessPrivate(e) && !o.lessPrivateOk) return 'less-private';
  if (c.tier > capFor(e, { lessPrivateOk: o.lessPrivateOk })) return 'tier';
  const words = `${c.title}\n${c.text}`;
  for (const s of sensitive(words)) {
    // ID papers never go to a less private AI, whatever the switches say.
    if (s === 'id' && lessPrivate(e)) return 'id';
    if (!o.allow[s]) return s;
  }
  return null;
}

// ---------- the question

export const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'refined', 'tags'],
  properties: {
    description: { type: 'string', description: 'One line, at most 15 words: what this is. Plain words.' },
    refined: {
      type: 'string',
      description: "Their own note, tidied: spelling, order and repeats fixed, in their voice and language, shorter if it can be. Never add a fact, name, number, date or advice that isn't in it.",
    },
    tags: { type: 'array', items: { type: 'string' }, description: '1 to 5 short tags, one or two words each, lower case.' },
  },
} as const;

// Characters of a record sent to each AI (the AI on this device has a small context).
export const INPUT: Record<Engine, number> = { private: 12000, device: 2500, local: 8000, free: 8000, own: 8000 };

export function readPrompt(c: Pick<Candidate, 'kind' | 'title' | 'text'>, e: Engine): string {
  const what = c.kind === 'file' ? 'file' : 'note';
  const max = INPUT[e] ?? 2500;
  const body = c.text.length > max ? `${c.text.slice(0, max)}\n(The rest is left out.)` : c.text;
  return `Read this ${what} of mine and write three things.
1. description: one line, at most 15 words, saying what it is.
2. refined: my own ${what}, tidied. Fix spelling, order and repeats, keep my voice and my language, and make it shorter if you can. ${c.kind === 'file' ? 'For a long file, its main points as short lines. ' : ''}Never add a fact, a name, a number, a date or advice that isn't in it. If it's already tidy, give it back as it is.
3. tags: 1 to 5 short tags, one or two words each, lower case.
Plain words. No em dashes.

The ${what}${c.title ? `, "${c.title.slice(0, 200)}"` : ''}:
"""
${body}
"""`;
}

// ---------- the answer

export interface Parsed {
  desc: string;
  tidy?: string;
  tags: string[];
}

// No long dashes in what Arise shows, and no control characters.
const tidyDashes = (s: string) => s.replace(/\s*[\u2014\u2015]\s*/g, ', ').replace(/\u2013/g, '-');
const line = (v: unknown, max: number) =>
  typeof v === 'string'
    ? tidyDashes(v)
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^["'\s]+|["'\s]+$/g, '')
        .trim()
        .slice(0, max)
    : '';
const lines = (v: unknown, max: number) =>
  typeof v === 'string'
    ? tidyDashes(v)
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max)
    : '';

// The numbers in a text (with their digits only), to tell whether the tidy version added one.
const numbers = (s: string) => new Set((s.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(/[.,]/g, '')));

// Whether a tidy version keeps to the original: not much longer, and no number that isn't in it.
// A loose check: it can't see every added fact, but it catches the common ones.
export function keepsToOriginal(tidy: string, original: string): boolean {
  if (tidy.length > original.length * 1.3 + 60) return false;
  const have = numbers(original);
  for (const n of numbers(tidy)) if (!have.has(n)) return false;
  return true;
}

// An AI's answer as Arise keeps it, or null when it isn't usable. A tidy version that adds to the
// original is left out (the description and tags stay).
export function parseRead(json: unknown, original: string): Parsed | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;
  const desc = line(j.description, READ_DESC_MAX);
  const tags = cleanReadTags(Array.isArray(j.tags) ? j.tags.map((t) => line(t, 40)) : []);
  if (!desc || !tags.length) return null;
  const out: Parsed = { desc, tags };
  const tidy = lines(j.refined, READ_TIDY_MAX);
  if (tidy && keepsToOriginal(tidy, original)) out.tidy = tidy;
  return out;
}

// ---------- the queue

export const TRIES = 4; // then it waits for "Describe again"
export const BACKOFF = [10 * 60000, 60 * 60000, 6 * 3600000, 24 * 3600000];

// The order it's read in: what the Player asked for again first, then the newest noticed.
export function ordered(jobs: readonly ReadJob[], now: number): ReadJob[] {
  return jobs
    .filter((j) => !j.failed && j.next <= now)
    .sort((a, b) => Number(!!b.again) - Number(!!a.again) || b.added - a.added || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// New jobs at the front of the queue (one already there is left as it is).
export function enqueue(q: ReadQueue, ids: Iterable<string>, now: number, { again = false } = {}): ReadQueue {
  const have = new Map(q.jobs.map((j) => [j.id, j]));
  for (const id of ids) {
    const was = have.get(id);
    if (was && !again) continue;
    have.set(id, { id, added: now, n: 0, next: 0, ...(again ? { again: true as const } : {}) });
  }
  return { ...q, jobs: [...have.values()] };
}

export const without = (q: ReadQueue, id: string): ReadQueue => ({ ...q, jobs: q.jobs.filter((j) => j.id !== id) });

// A try that failed: it waits longer each time, and after TRIES it waits for the Player.
export function failed(q: ReadQueue, id: string, now: number): ReadQueue {
  return {
    ...q,
    jobs: q.jobs.map((j) => {
      if (j.id !== id) return j;
      const n = j.n + 1;
      const { again: _a, ...rest } = j;
      return n >= TRIES ? { ...rest, n, next: 0, failed: true } : { ...rest, n, next: now + BACKOFF[Math.min(n - 1, BACKOFF.length - 1)] };
    }),
  };
}

// How many more the AI may be asked today (the count starts again each day).
export function today(q: ReadQueue, day: string): ReadQueue {
  return q.day === day ? q : { ...q, day, done: 0 };
}
export const left = (q: ReadQueue, perDay: number) => Math.max(0, perDay - q.done);

// ---------- how it's going, in plain words

export type State = 'off' | 'no-ai' | 'plan' | 'waiting' | 'reading' | 'cap' | 'done';

export interface Status {
  state: State;
  notes: number; // still to read
  files: number;
  held: number; // held back: health, money or ID
  failed: number; // gave up on, until "Describe again"
  done: number; // asked of the AI today
  perDay: number;
  error: string; // the last one
}

export const status: Status = { state: 'off', notes: 0, files: 0, held: 0, failed: 0, done: 0, perDay: 20, error: '' };

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
export function waitingText(s: Pick<Status, 'notes' | 'files'>): string {
  const parts = [s.notes ? count(s.notes, 'note') : '', s.files ? count(s.files, 'file') : ''].filter(Boolean);
  return parts.join(' and ') || 'nothing';
}

export function statusText(s: Status = status): string {
  const what = waitingText(s);
  let text: string;
  switch (s.state) {
    case 'off':
      return 'Off. Turn it on in Settings, Your life log.';
    case 'no-ai':
      text = s.notes + s.files ? `Waiting for an AI: turn on the AI coach in Settings. ${what} to read.` : 'Waiting for an AI: turn on the AI coach in Settings.';
      break;
    case 'plan':
      text = `Waiting for the private AI. On the free plan, Arise doesn't use your free private questions for this. Arise Private does.${s.notes + s.files ? ` ${what} to read.` : ''}`;
      break;
    case 'waiting':
      text = `Waiting for the private AI. The AI you use now may not read ${s.notes + s.files === 1 ? 'it' : 'them'}. ${what} to read.`;
      break;
    case 'reading':
      text = `Arise is reading ${what}.`;
      break;
    case 'cap':
      text = `Done for today: ${s.done} of ${s.perDay}. ${what} wait${s.notes + s.files === 1 ? 's' : ''} for tomorrow.`;
      break;
    default:
      text = 'Done.';
  }
  if (s.held) text += ` ${s.held} held back: ${s.held === 1 ? 'it looks' : 'they look'} like health, money or ID papers. You can allow ${s.held === 1 ? 'it' : 'them'} in Settings.`;
  if (s.failed) text += ` ${s.failed} couldn't be read. Open ${s.failed === 1 ? 'it' : 'one'} and tap Describe again.`;
  return text;
}
