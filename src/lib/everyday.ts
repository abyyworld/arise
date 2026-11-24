// Everyday lists: money owed between you and other people, and groceries. Both synced end-to-end
// encrypted with the rest (since SCHEMA 13), on Today (everyday-ui.js), and added from the box on
// Today in plain words (lib/capture.ts).
//
// Like to-dos, each item keeps the time it last changed (`at`); a deleted one stays as a tombstone
// (`gone`) for a while, so a copy on another device that still has it can't bring it back. Two
// copies merge per item: the later change wins.

export type Dir = 'owed' | 'owe'; // owed: they owe you. owe: you owe them.

export interface Debt {
  id: string;
  who: string; // the person's name, as you wrote it
  amount: number; // in the currency's main unit (12.5 = 12.50)
  cur: string; // ISO 4217 code, like GBP
  dir: Dir;
  what?: string; // what it was for
  due?: string; // YYYY-MM-DD
  settled?: number; // when it was paid back
  created: number;
  at: number;
  gone?: true;
}
export type Debts = Record<string, Debt>;

export interface Grocery {
  id: string;
  name: string;
  qty?: string; // "2", "500 g"
  got?: number; // when it was bought
  created: number;
  at: number;
  gone?: true;
}
export type Groceries = Record<string, Grocery>;

export const MAX_DEBTS = 1000;
export const MAX_GROCERIES = 500;
const KEEP_GONE = 180 * 86_400_000;
const KEEP_SETTLED = 400 * 86_400_000;
const KEEP_GOT = 30 * 86_400_000;

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CUR = /^[A-Z]{3}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
export const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function cleanDebt(raw: unknown): Debt | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id) || !isTime(r.at)) return null;
  const created = isTime(r.created) ? r.created : r.at;
  if (r.gone === true) return { id: r.id, who: '', amount: 0, cur: 'GBP', dir: 'owed', created, at: r.at, gone: true };
  const who = line(r.who, 60);
  const amount = typeof r.amount === 'number' && Number.isFinite(r.amount) ? Math.round(r.amount * 100) / 100 : NaN;
  if (!who || !(amount > 0) || amount > 1e12) return null;
  const cur = typeof r.cur === 'string' && CUR.test(r.cur) ? r.cur : 'GBP';
  const dir: Dir = r.dir === 'owe' ? 'owe' : 'owed';
  const out: Debt = { id: r.id, who, amount, cur, dir, created, at: r.at };
  const what = line(r.what, 120);
  if (what) out.what = what;
  if (typeof r.due === 'string' && DAY.test(r.due)) out.due = r.due;
  if (isTime(r.settled)) out.settled = r.settled;
  return out;
}

export function cleanGrocery(raw: unknown): Grocery | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id) || !isTime(r.at)) return null;
  const created = isTime(r.created) ? r.created : r.at;
  if (r.gone === true) return { id: r.id, name: '', created, at: r.at, gone: true };
  const name = line(r.name, 80);
  if (!name) return null;
  const out: Grocery = { id: r.id, name, created, at: r.at };
  const qty = line(r.qty, 20);
  if (qty) out.qty = qty;
  if (isTime(r.got)) out.got = r.got;
  return out;
}

type Item = { id: string; at: number; gone?: true };

// Old tombstones and long-finished items go; then, past the most kept, the oldest changes go first
// (items and deletions each on their own). In a fixed order (by id), so the same lists always save
// the same.
function cleanAll<T extends Item>(raw: unknown, clean: (v: unknown) => T | null, max: number, finished: (t: T) => number | undefined, keep: number, now: number): Record<string, T> {
  const out: T[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const t = clean(v);
      if (!t || t.id !== k) continue;
      if (t.gone && now - t.at > KEEP_GONE) continue;
      const f = finished(t);
      if (f && now - f > keep) continue;
      out.push(t);
    }
  }
  const newest = (list: T[]) => list.sort((a, b) => b.at - a.at).slice(0, max);
  const kept = [...newest(out.filter((t) => !t.gone)), ...newest(out.filter((t) => t.gone))];
  kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.fromEntries(kept.map((t) => [t.id, t]));
}

export const cleanDebts = (raw: unknown, now = Date.now()): Debts => cleanAll(raw, cleanDebt, MAX_DEBTS, (d) => d.settled, KEEP_SETTLED, now);
export const cleanGroceries = (raw: unknown, now = Date.now()): Groceries => cleanAll(raw, cleanGrocery, MAX_GROCERIES, (g) => g.got, KEEP_GOT, now);

function mergeAll<T extends Item>(a: Record<string, T>, b: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = { ...a };
  for (const [id, t] of Object.entries(b || {})) if (!out[id] || t.at > out[id].at) out[id] = t;
  return out;
}
export const mergeDebts = (a: Debts, b: Debts, now = Date.now()) => cleanDebts(mergeAll(a, b), now);
export const mergeGroceries = (a: Groceries, b: Groceries, now = Date.now()) => cleanGroceries(mergeAll(a, b), now);

export const liveDebts = (d: Debts) => Object.values(d).filter((x) => !x.gone);
export const openDebts = (d: Debts) => liveDebts(d).filter((x) => !x.settled);
export const liveGroceries = (g: Groceries) => Object.values(g).filter((x) => !x.gone);

// ---------- money

const SIGN: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', INR: '₹', TRY: '₺', KRW: '₩', RUB: '₽', UAH: '₴', NGN: '₦' };
const NO_CENTS = new Set(['JPY', 'KRW', 'UZS', 'KZT', 'IDR', 'VND']);

export function money(amount: number, cur: string): string {
  const cents = !NO_CENTS.has(cur) && Math.round(amount * 100) % 100 !== 0;
  const n = amount.toLocaleString('en-GB', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  return SIGN[cur] ? `${SIGN[cur]}${n}` : `${n} ${cur}`;
}

// A good first currency from the device's region.
const BY_REGION: Record<string, string> = { GB: 'GBP', US: 'USD', UZ: 'UZS', KZ: 'KZT', RU: 'RUB', UA: 'UAH', TR: 'TRY', IN: 'INR', JP: 'JPY', KR: 'KRW', CA: 'CAD', AU: 'AUD', NZ: 'NZD', CH: 'CHF', AE: 'AED', SA: 'SAR', NG: 'NGN', PK: 'PKR', CN: 'CNY', SG: 'SGD', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN' };
const EURO = new Set(['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']);
export function currencyFor(locale = ''): string {
  const region = (/[-_]([A-Za-z]{2})\b/.exec(locale)?.[1] || '').toUpperCase();
  if (EURO.has(region)) return 'EUR';
  return BY_REGION[region] || 'GBP';
}

// Who owes whom, per person and currency: positive when they owe you. Only what isn't settled.
export interface Balance {
  who: string;
  cur: string;
  net: number;
  items: Debt[];
  due?: string; // the soonest due day among them
}
const keyOf = (who: string) => who.toLowerCase();
export function balances(d: Debts): Balance[] {
  const by = new Map<string, Balance>();
  for (const x of openDebts(d)) {
    const k = `${keyOf(x.who)}|${x.cur}`;
    const b = by.get(k) || { who: x.who, cur: x.cur, net: 0, items: [] };
    b.net = Math.round((b.net + (x.dir === 'owed' ? x.amount : -x.amount)) * 100) / 100;
    b.items.push(x);
    if (x.due && (!b.due || x.due < b.due)) b.due = x.due;
    by.set(k, b);
  }
  for (const b of by.values()) b.items.sort((a, c) => a.created - c.created);
  return [...by.values()].sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || Math.abs(b.net) - Math.abs(a.net) || a.who.localeCompare(b.who));
}

// Totals across everyone, per currency.
export function totals(d: Debts): { cur: string; owed: number; owe: number }[] {
  const by = new Map<string, { cur: string; owed: number; owe: number }>();
  for (const b of balances(d)) {
    const t = by.get(b.cur) || { cur: b.cur, owed: 0, owe: 0 };
    if (b.net > 0) t.owed = Math.round((t.owed + b.net) * 100) / 100;
    else if (b.net < 0) t.owe = Math.round((t.owe - b.net) * 100) / 100;
    by.set(b.cur, t);
  }
  return [...by.values()];
}

export function balanceText(b: Balance): string {
  if (b.net > 0) return `${b.who} owes you ${money(b.net, b.cur)}`;
  if (b.net < 0) return `You owe ${b.who} ${money(-b.net, b.cur)}`;
  return `You and ${b.who} are even`;
}

// For the coach (ai.js buildContext): open debts and what's still to buy.
export function everydayText(d: Debts, g: Groceries, today: string, compact = false): string {
  const out: string[] = [];
  const bs = balances(d).filter((b) => b.net !== 0);
  if (bs.length) {
    out.push('## Money owed (between the Player and other people, not settled)');
    for (const b of bs.slice(0, compact ? 6 : 20)) out.push(`- ${balanceText(b).replace(/\byou\b/gi, (m) => (m[0] === 'Y' ? 'The Player' : 'the Player'))}${b.due ? ` (${b.due < today ? 'was due' : 'due'} ${b.due})` : ''}`);
  }
  const need = liveGroceries(g).filter((x) => !x.got);
  if (need.length) out.push(`${out.length ? '\n' : ''}## Groceries to buy`, need.slice(0, compact ? 10 : 30).map((x) => (x.qty ? `${x.qty} ${x.name}` : x.name)).join(', '));
  return out.join('\n');
}
