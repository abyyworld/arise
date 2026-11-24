// The box on Today: write anything, and Arise works out what it is, on the device, with no AI.
// A to-do (with its day and time if the words have one), groceries, money owed, a question for the
// coach, or else a note for the day. The person sees what it will be before it's saved and can pick
// another kind (everyday-ui.js).

import { type Dir, line } from './everyday';

export type Kind = 'todo' | 'grocery' | 'debt' | 'question' | 'note';

export interface Capture {
  kind: Kind;
  text: string; // what was written, tidied
  title?: string; // todo: without the day and time words
  day?: string; // todo, debt (due)
  time?: string; // todo
  items?: { name: string; qty?: string }[]; // grocery
  who?: string; // debt
  amount?: number;
  cur?: string;
  dir?: Dir;
  what?: string;
}

// ---------- days and times

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plus = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WD = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?';
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

interface Found {
  day?: string;
  time?: string;
  rest: string;
}

// Finds a day and a time in the words and takes them out.
export function findWhen(text: string, now = new Date()): Found {
  let rest = ` ${text} `;
  let day: string | undefined;
  let time: string | undefined;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean) => {
    const m = re.exec(rest);
    if (m && fn(m)) rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
  };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  take(/\s(?:by |on |for )?(\d{4})-(\d{2})-(\d{2})(?=[\s,.!]|$)/i, (m) => ((day = `${m[1]}-${m[2]}-${m[3]}`), true));
  if (!day) take(/\s(?:by |on |for )?(the )?day after tomorrow(?=[\s,.!]|$)/i, () => ((day = keyOf(plus(today, 2))), true));
  if (!day) take(/\s(?:by |for )?(today|tonight|this evening|this morning|this afternoon)(?=[\s,.!]|$)/i, () => ((day = keyOf(today)), true));
  if (!day) take(/\s(?:by |for )?(tomorrow|tmrw|tmr)(?=[\s,.!]|$)/i, () => ((day = keyOf(plus(today, 1))), true));
  if (!day)
    take(new RegExp(`\\s(?:by |on |this |next |for )?${WD}(?=[\\s,.!]|$)`, 'i'), (m) => {
      const want = WEEKDAYS.findIndex((w) => w.startsWith(m[1].toLowerCase().slice(0, 3)));
      if (want < 0) return false;
      // The next one to come ("on Friday" on a Friday: a week today).
      day = keyOf(plus(today, (want - today.getDay() + 7) % 7 || 7));
      return true;
    });
  if (!day)
    take(new RegExp(`\\s(?:by |on |for )?(?:(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MON}|${MON} (\\d{1,2})(?:st|nd|rd|th)?)(?=[\\s,.!]|$)`, 'i'), (m) => {
      const d = Number(m[1] || m[4]);
      const mon = MONTHS.indexOf((m[2] || m[3]).toLowerCase().slice(0, 3));
      if (mon < 0 || d < 1 || d > 31) return false;
      let when = new Date(today.getFullYear(), mon, d);
      if (when.getMonth() !== mon) return false;
      if (when < today) when = new Date(today.getFullYear() + 1, mon, d);
      day = keyOf(when);
      return true;
    });
  if (!day) take(/\s(?:by |for )?next week(?=[\s,.!]|$)/i, () => ((day = keyOf(plus(today, ((8 - today.getDay()) % 7) || 7))), true));

  take(/\s(?:at |@ ?|by )?(\d{1,2})(?::|\.)(\d{2})\s?(am|pm)?(?=[\s,.!]|$)/i, (m) => {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
    if (h > 23 || min > 59) return false;
    time = `${pad(h)}:${pad(min)}`;
    return true;
  });
  if (!time)
    take(/\s(?:at |@ ?|by )?(\d{1,2})\s?(am|pm)(?=[\s,.!]|$)/i, (m) => {
      const h = (Number(m[1]) % 12) + (/pm/i.test(m[2]) ? 12 : 0);
      if (Number(m[1]) > 12) return false;
      time = `${pad(h)}:00`;
      return true;
    });
  if (!time)
    take(/\sat (\d{1,2})(?=[\s,.!]|$)/i, (m) => {
      let h = Number(m[1]);
      if (h > 23) return false;
      if (h >= 1 && h <= 7) h += 12; // "at 5": in the afternoon
      time = `${pad(h)}:00`;
      return true;
    });
  if (time && !day) {
    // A time with no day: today, or tomorrow if it's already gone.
    const [h, m] = time.split(':').map(Number);
    const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m);
    day = keyOf(at.getTime() < now.getTime() ? plus(today, 1) : today);
  }
  return { day, time, rest: rest.replace(/\s+/g, ' ').trim() };
}

// ---------- money

const CURS: [RegExp, string][] = [
  [/^(£|gbp|pounds?|quid)$/i, 'GBP'],
  [/^(\$|usd|dollars?|bucks)$/i, 'USD'],
  [/^(€|eur|euros?)$/i, 'EUR'],
  [/^(uzs|so'?m|soum|sum)$/i, 'UZS'],
  [/^(₹|inr|rupees?)$/i, 'INR'],
  [/^(¥|jpy|yen)$/i, 'JPY'],
  [/^(rub|roubles?|rubles?)$/i, 'RUB'],
  [/^(try|lira)$/i, 'TRY'],
];
const UNIT = "(?:£|\\$|€|₹|¥|gbp|usd|eur|uzs|inr|jpy|rub|try|pounds?|quid|dollars?|bucks|euros?|so'?m|soum|sum|rupees?|yen|roubles?|rubles?|lira)";
// Groups: the unit before, the number, thousand or million, the unit after.
const AMOUNT = `(?:(${UNIT})\\s?)?(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s?(k|thousand|million|m)?\\b\\s?(?:(${UNIT})(?![a-z]))?`;
const curOf = (s?: string) => (s ? CURS.find(([re]) => re.test(s.trim()))?.[1] : undefined);

function amountOf(m: RegExpExecArray, at: number): { amount: number; cur?: string } | null {
  const raw = m[at + 2].replace(/,/g, '');
  let n = Number(raw);
  const big = (m[at + 3] || '').toLowerCase();
  if (big === 'k' || big === 'thousand') n *= 1000;
  else if (big === 'm' || big === 'million') n *= 1_000_000;
  if (!(n > 0)) return null;
  return { amount: Math.round(n * 100) / 100, cur: curOf(m[at + 1]) || curOf(m[at + 4]) };
}

const NAME = "([A-Za-z\\u00C0-\\u024F][\\w\\u00C0-\\u024F'.-]*(?: [A-Z\\u00C0-\\u024F][\\w\\u00C0-\\u024F'.-]*)?)";
const FOR = '(?:\\s+(?:for|from) (.+))?';

interface DebtFound {
  who: string;
  amount: number;
  cur?: string;
  dir: Dir;
  what?: string;
}

export function findDebt(text: string): DebtFound | null {
  const t = text.trim().replace(/[.!]+$/, '');
  const tries: [RegExp, Dir, 'name-first' | 'amount-first'][] = [
    [new RegExp(`^${NAME} owes me ${AMOUNT}${FOR}$`, 'i'), 'owed', 'name-first'],
    [new RegExp(`^i owe ${NAME} ${AMOUNT}${FOR}$`, 'i'), 'owe', 'name-first'],
    [new RegExp(`^i lent ${NAME} ${AMOUNT}${FOR}$`, 'i'), 'owed', 'name-first'],
    [new RegExp(`^${NAME} lent me ${AMOUNT}${FOR}$`, 'i'), 'owe', 'name-first'],
    [new RegExp(`^i borrowed ${AMOUNT} from ${NAME}${FOR}$`, 'i'), 'owe', 'amount-first'],
    [new RegExp(`^${NAME} borrowed ${AMOUNT}(?: from me)?${FOR}$`, 'i'), 'owed', 'name-first'],
    [new RegExp(`^i paid ${AMOUNT} for ${NAME}${FOR}$`, 'i'), 'owed', 'amount-first'],
    [new RegExp(`^${NAME} paid ${AMOUNT} for me${FOR}$`, 'i'), 'owe', 'name-first'],
  ];
  for (const [re, dir, order] of tries) {
    const m = re.exec(t);
    if (!m) continue;
    const who = order === 'name-first' ? m[1] : m[5];
    const a = amountOf(m, order === 'name-first' ? 1 : 0);
    if (!who || !a || /^(i|me|you|we|they|he|she|it)$/i.test(who)) continue;
    const what = line(m[6], 120);
    return { who: who.charAt(0).toUpperCase() + who.slice(1), dir, ...a, ...(what ? { what } : {}) };
  }
  return null;
}

// ---------- groceries

const GROCERY = /^(?:(?:i )?need to buy|buy|pick up|get some|groceries:?|shopping:?|grocery list:?|shopping list:?|add (.+?) to (?:the |my )?(?:groceries|grocery list|shopping(?: list)?))\s*(.*)$/i;

export function findGroceries(text: string): { name: string; qty?: string }[] | null {
  const m = GROCERY.exec(text.trim().replace(/[.!]+$/, ''));
  if (!m) return null;
  const list = (m[1] || m[2] || '').trim();
  if (!list) return null;
  const items = list
    .split(/\s*(?:,|;|\band\b|&|\+)\s*/i)
    .map((s) => s.trim().replace(/^(?:some|a|an)\s+/i, ''))
    .filter(Boolean)
    .slice(0, 30)
    .map((s) => {
      const q = /^(\d+(?:[.,]\d+)?\s?(?:x|kg|g|l|ml|lb|lbs|packs?|bottles?|cans?|bags?|boxes?|loaf|loaves|dozen)?)\s+(?:of\s+)?(.+)$/i.exec(s);
      return q ? { name: line(q[2], 80), qty: line(q[1], 20) } : { name: line(s, 80) };
    })
    .filter((x) => x.name);
  return items.length ? items : null;
}

// ---------- the kind

const QUESTION = /^(what|whats|what's|how|why|when|where|who|which|should (?:i|we)|can (?:i|you|we)|could (?:i|you|we)|do (?:i|you|we)|does|did (?:i|you|we)|is|are|am i|will (?:i|you|we)|would|was|were|have (?:i|you|we)|has|tell me|help me|explain)\b/i;
const DOING = /^(call|ring|text|email|e-mail|message|book|pay|send|finish|fix|write|submit|clean|tidy|wash|pick up|drop off|return|renew|cancel|order|print|sign|post|reply|apply|prepare|plan|check|remember to|remind me to|don'?t forget to|go to|meet|visit|review|read|study|revise|practise|practice|do)\b/i;

export function classify(raw: string, now = new Date()): Capture {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'note', text };
  const when = findWhen(text, now);

  const debt = findDebt(when.rest || text);
  if (debt) return { kind: 'debt', text, ...debt, ...(when.day ? { day: when.day } : {}) };

  const items = findGroceries(text);
  if (items) return { kind: 'grocery', text, items };

  if (/\?\s*$/.test(text) || (QUESTION.test(text) && text.split(' ').length > 2)) return { kind: 'question', text };

  if (when.day || DOING.test(text)) {
    const title = line((when.rest || text).replace(/^(?:remember to|remind me to|don'?t forget to)\s+/i, '').replace(/^[,.\s]+|[,.\s]+$/g, ''), 200);
    const t = title ? title.charAt(0).toUpperCase() + title.slice(1) : line(text, 200);
    return { kind: 'todo', text, title: t, ...(when.day ? { day: when.day } : {}), ...(when.time ? { time: when.time } : {}) };
  }
  return { kind: 'note', text };
}

// The same words, as another kind (the person picked it).
export function asKind(c: Capture, kind: Kind, now = new Date()): Capture {
  if (c.kind === kind) return c;
  const text = c.text;
  if (kind === 'todo') {
    const when = findWhen(text, now);
    const title = line(when.rest || text, 200);
    return { kind, text, title: title.charAt(0).toUpperCase() + title.slice(1), ...(when.day ? { day: when.day } : {}), ...(when.time ? { time: when.time } : {}) };
  }
  if (kind === 'grocery') return { kind, text, items: findGroceries(`buy ${text.replace(/^(?:buy|get)\s+/i, '')}`) || [{ name: line(text, 80) }] };
  if (kind === 'debt') {
    const d = findDebt(findWhen(text, now).rest || text);
    return d ? { kind, text, ...d } : { kind, text };
  }
  return { kind, text };
}
