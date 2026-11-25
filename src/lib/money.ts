// Where the money went, from the Player's bank statements (life/import/bank.ts puts each line in
// the life log). Worked out on the device: spending and money in per month, the top categories
// (from the merchant's words with a small table here, and the Player's own changes), the biggest
// payments, subscriptions found (the same amount to the same merchant about once a month), and
// this month against the usual. No advice: no investing, no interest, just where it went.
//
// The Player's own categories (`moneyCats` in the main state) are keyed by the merchant's short
// name and synced end-to-end encrypted with the rest. Like names for places (place-names.ts):
// each keeps when it last changed (`at`), a removed one stays as a tombstone (`gone`) for a while,
// and two copies merge per merchant, the later change winning.
//
// Pure.

export const CATS = {
  groceries: 'Groceries',
  eating: 'Eating out',
  transport: 'Transport',
  bills: 'Bills',
  home: 'Home and rent',
  shopping: 'Shopping',
  apps: 'Apps and streaming',
  health: 'Health',
  fun: 'Fun',
  travel: 'Travel',
  giving: 'Giving',
  education: 'Learning',
  cash: 'Cash',
  transfers: 'Transfers',
  fees: 'Bank fees',
  other: 'Other',
} as const;
export type Cat = keyof typeof CATS;
export const isCat = (v: unknown): v is Cat => typeof v === 'string' && Object.hasOwn(CATS, v);
export const catLabel = (c: string) => (isCat(c) ? CATS[c] : CATS.other);

// The words that tell a category, as whole words in the merchant's text. The longest match wins,
// so "uber eats" is eating out and "uber" is transport.
const WORDS: Record<Exclude<Cat, 'other'>, string[]> = {
  groceries: ['tesco', 'sainsbury', 'sainsburys', 'asda', 'aldi', 'lidl', 'morrisons', 'waitrose', 'co-op', 'coop', 'rewe', 'edeka', 'carrefour', 'kroger', 'walmart', 'whole foods', 'trader joe', 'costco', 'ocado', 'iceland', 'spar', 'netto', 'migros', 'supermarket', 'grocery', 'groceries', 'korzinka', 'makro', 'havas', 'safeway', 'albert heijn', 'jumbo', 'auchan', 'leclerc', 'mercadona', 'penny', 'kaufland', 'biedronka', 'magnit', 'pyaterochka', 'butcher', 'halal meat'],
  eating: ['restaurant', 'cafe', 'coffee', 'starbucks', 'costa', 'pret', 'mcdonalds', 'mcdonald', 'kfc', 'burger king', 'subway', 'dominos', 'domino', 'pizza', 'nandos', 'greggs', 'deliveroo', 'uber eats', 'just eat', 'doordash', 'grubhub', 'wolt', 'glovo', 'bistro', 'kebab', 'bakery', 'takeaway', 'diner', 'grill', 'chipotle', 'tim hortons', 'dunkin', 'wagamama', 'leon', 'five guys'],
  transport: ['uber', 'bolt', 'lyft', 'tfl', 'trainline', 'rail', 'railway', 'train', 'bus', 'metro', 'taxi', 'yandex go', 'shell', 'esso', 'texaco', 'fuel', 'petrol', 'parking', 'ringgo', 'national express', 'citymapper', 'lime', 'gett'],
  bills: ['british gas', 'octopus energy', 'edf', 'eon', 'e.on', 'thames water', 'water', 'electric', 'electricity', 'energy', 'gas', 'council tax', 'vodafone', 'o2', 'virgin media', 'bt', 'sky', 'at&t', 'verizon', 't-mobile', 'comcast', 'internet', 'broadband', 'mobile', 'insurance', 'tv licence', 'telekom', 'beeline', 'ucell', 'uzmobile'],
  home: ['rent', 'letting', 'lettings', 'landlord', 'mortgage', 'ikea', 'b&q', 'wickes', 'homebase', 'home depot', 'dunelm', 'furniture'],
  shopping: ['amazon', 'ebay', 'argos', 'john lewis', 'zara', 'h&m', 'primark', 'uniqlo', 'asos', 'currys', 'temu', 'shein', 'aliexpress', 'etsy', 'wildberries', 'ozon', 'uzum', 'target', 'best buy', 'tk maxx', 'decathlon', 'apple store', 'clothing'],
  apps: ['netflix', 'spotify', 'disney', 'youtube', 'icloud', 'apple', 'google', 'prime video', 'audible', 'patreon', 'openai', 'chatgpt', 'adobe', 'microsoft', 'dropbox', 'notion', 'playstation plus', 'xbox game pass', 'deezer', 'hulu', 'hbo'],
  health: ['pharmacy', 'chemist', 'boots', 'superdrug', 'dentist', 'dental', 'doctor', 'clinic', 'hospital', 'gym', 'puregym', 'fitness', 'cvs', 'walgreens', 'optician', 'specsavers', 'apteka'],
  fun: ['cinema', 'odeon', 'vue', 'cineworld', 'steam', 'playstation', 'xbox', 'nintendo', 'ticketmaster', 'theatre', 'museum', 'concert', 'bowling', 'zoo'],
  travel: ['airbnb', 'booking', 'hotel', 'hotels', 'ryanair', 'easyjet', 'british airways', 'airline', 'airlines', 'airways', 'expedia', 'wizz', 'emirates', 'qatar airways', 'uzbekistan airways', 'hostel'],
  giving: ['charity', 'donation', 'donate', 'zakat', 'sadaqah', 'sadaqa', 'mosque', 'masjid', 'church', 'red cross', 'islamic relief', 'oxfam', 'gofundme', 'unicef', 'muslim aid', 'launchgood'],
  education: ['school', 'university', 'college', 'course', 'udemy', 'coursera', 'books', 'bookshop', 'waterstones', 'tuition', 'duolingo'],
  cash: ['atm', 'cash', 'cashpoint', 'withdrawal'],
  transfers: ['transfer', 'revolut', 'wise', 'venmo', 'zelle', 'monzo', 'starling', 'payme'],
  fees: ['fee', 'fees', 'charge', 'charges', 'overdraft', 'commission'],
};
const TABLE: [string, Cat][] = Object.entries(WORDS)
  .flatMap(([c, ws]) => ws.map((w) => [w, c as Cat] as [string, Cat]))
  .sort((a, b) => b[0].length - a[0].length);

// The bank's own words before the merchant ("CARD PAYMENT TO", "KARTENZAHLUNG", "PAYPAL *").
const LEAD = /^(card payment( to)?|card purchase|contactless( payment)?|pos( purchase)?|visa( debit)?|debit card|mastercard|direct debit( to)?|dd|so|standing order( to)?|fps|faster payments?( to)?|bill payment( to)?|purchase|payment( to)?|kartenzahlung|lastschrift|paypal|sq|sumup|zettle|izettle|sp|tst|apple pay|google pay)\b[\s*:/-]*/;
// Words that say nothing about who was paid.
const NOISE = new Set(['ltd', 'limited', 'plc', 'inc', 'llc', 'gmbh', 'co', 'store', 'stores', 'www', 'help', 'online', 'uk', 'gb', 'us', 'the', 'on', 'at', 'ref', 'reference', 'payment', 'card', 'sagt', 'danke', 'bill', 'com']);

// The merchant's text made plain: lower case, the bank's words before it and web endings gone,
// numbers and dates gone.
function plainWords(desc: string): string {
  let s = (desc || '').toLowerCase().replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  for (let i = 0; i < 3; i++) {
    const t = s.trim().replace(LEAD, '');
    if (t === s.trim()) break;
    s = t;
  }
  s = s
    .replace(/\.(com|co\.uk|co|uk|de|net|org|io|fr|es|it|nl|ru|uz)\b/g, ' ')
    .replace(/[*#_/\\|,;:()[\]{}"!?+=~^%$£€@]/g, ' ');
  // Numbers, dates and reference codes go ("3456", "12.03", "ab12cd"); a name like "o2" stays.
  const code = (w: string) => /\d/.test(w) && (!/\p{L}/u.test(w) || (w.match(/\d/g) || []).length >= 2);
  return s
    .split(/\s+/)
    .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter((w) => w && !NOISE.has(w) && !code(w))
    .join(' ');
}

const KEY = /^[\p{L}\p{N} &'.-]{1,40}$/u;
export const isMerchantKey = (k: unknown): k is string => typeof k === 'string' && KEY.test(k) && k.trim() === k;

// The table's word that fits a merchant's text, if any.
function tableMatch(words: string): [string, Cat] | null {
  const padded = ` ${words} `;
  for (const [w, c] of TABLE) if (padded.includes(` ${w} `)) return [w, c];
  return null;
}

// A short name for who was paid, the same for every payment to them: a word from the table when
// one fits ("tesco"), else the first two words ("joes barbers").
export function merchantKey(desc: string): string {
  const words = plainWords(desc);
  const hit = tableMatch(words);
  const k = (hit ? hit[0] : words.split(' ').slice(0, 2).join(' ')).slice(0, 40).trim();
  return isMerchantKey(k) ? k : 'unknown';
}

// "joes barbers" -> "Joes Barbers"; short ones in capitals ("tfl" -> "TFL").
export function merchantName(key: string): string {
  if (key === 'unknown') return 'Unknown';
  return key
    .split(' ')
    .map((w) => (w.length <= 3 && !/[aeiou]/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// ---------- the Player's own categories

export interface MoneyCat {
  cat: Cat | ''; // '' when gone
  at: number;
  gone?: true;
}
export type MoneyCats = Record<string, MoneyCat>;
export const MAX_MONEY_CATS = 500;
const KEEP_GONE = 180 * 86_400_000;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;

export function cleanMoneyCat(raw: unknown): MoneyCat | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isTime(r.at)) return null;
  if (r.gone === true) return { cat: '', at: r.at, gone: true };
  return isCat(r.cat) ? { cat: r.cat, at: r.at } : null;
}

export function cleanMoneyCats(raw: unknown, now = Date.now()): MoneyCats {
  const out: [string, MoneyCat][] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!isMerchantKey(k)) continue;
      const c = cleanMoneyCat(v);
      if (!c || (c.gone && now - c.at > KEEP_GONE)) continue;
      out.push([k, c]);
    }
  }
  const newest = (list: [string, MoneyCat][]) => list.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_MONEY_CATS);
  const kept = [...newest(out.filter(([, c]) => !c.gone)), ...newest(out.filter(([, c]) => c.gone))];
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(kept);
}

export function mergeMoneyCats(a: MoneyCats, b: MoneyCats, now = Date.now()): MoneyCats {
  const out: MoneyCats = { ...(a || {}) };
  for (const [k, c] of Object.entries(b || {})) if (!out[k] || c.at > out[k].at) out[k] = c;
  return cleanMoneyCats(out, now);
}

// Sets a merchant's category (null: back to Arise's own guess). A new copy; null if the key or
// the category isn't one.
export function setMoneyCat(cats: MoneyCats, key: string, cat: Cat | null, now = Date.now()): MoneyCats | null {
  if (!isMerchantKey(key) || (cat !== null && !isCat(cat))) return null;
  if (cat === null && (!cats[key] || cats[key].gone)) return cats;
  const at = Math.max(now, (cats[key]?.at || 0) + 1);
  return cleanMoneyCats({ ...cats, [key]: cat ? { cat, at } : { cat: '', at, gone: true } }, now);
}

// A merchant's category: the Player's own, else the table's, else Other.
export function categoryOf(key: string, cats: MoneyCats = {}): Cat {
  const own = cats[key];
  if (own && !own.gone && isCat(own.cat)) return own.cat;
  return tableMatch(key)?.[1] || 'other';
}
export const isOwnCat = (key: string, cats: MoneyCats = {}) => !!cats[key] && !cats[key].gone;

// ---------- payments

export interface Tx {
  id: string;
  at: number;
  amount: number; // minus: money out
  cur: string; // '' when the statement didn't say
  desc: string;
  key: string;
}

// A bank line from the life log: its amount, currency and the merchant's text from its title
// ("Spent 12.30 GBP at TESCO", "Received 1,500.00 GBP: SALARY").
export function txOf(e: { id: string; source: string; kind: string; at: number; title: string; value?: number; unit?: string }): Tx | null {
  if (e.source !== 'bank' || e.kind !== 'purchase' || typeof e.value !== 'number' || !Number.isFinite(e.value) || e.value === 0) return null;
  const m = /^(?:Spent [\d.,]+(?: [A-Z]{3})? at |Received [\d.,]+(?: [A-Z]{3})?: )(.*)$/s.exec(e.title || '');
  const desc = (m ? m[1] : e.title || '').trim();
  return { id: e.id, at: e.at, amount: e.value, cur: (e.unit || '').trim(), desc, key: merchantKey(desc) };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const monthOf = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const dayOfMonth = (at: number) => new Date(at).getDate();
const r2 = (n: number) => Math.round(n * 100) / 100;
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// The currency most payments are in ('' when none said), and how many are in others.
export function mainCurrency(txs: readonly Tx[]): { cur: string; others: number } {
  const n = new Map<string, number>();
  for (const t of txs) n.set(t.cur, (n.get(t.cur) || 0) + 1);
  let cur = '';
  let most = -1;
  for (const [c, k] of n) if (k > most || (k === most && c < cur)) (cur = c), (most = k);
  return { cur, others: txs.length - Math.max(0, most) };
}

export interface Month {
  month: string; // 2026-11
  out: number; // spent, as a plus number
  in: number;
  n: number;
}

// Spending and money in per month, oldest first, with the months in between that had nothing.
export function monthly(txs: readonly Tx[]): Month[] {
  if (!txs.length) return [];
  const by = new Map<string, Month>();
  for (const t of txs) {
    const k = monthOf(t.at);
    const m = by.get(k) || { month: k, out: 0, in: 0, n: 0 };
    if (t.amount < 0) m.out = r2(m.out - t.amount);
    else m.in = r2(m.in + t.amount);
    m.n++;
    by.set(k, m);
  }
  const keys = [...by.keys()].sort();
  const out: Month[] = [];
  for (let k = keys[0]; k <= keys[keys.length - 1]; k = addMonths(k, 1)) out.push(by.get(k) || { month: k, out: 0, in: 0, n: 0 });
  return out;
}

export interface CatSum {
  cat: Cat;
  total: number;
  share: number; // of all spending in the time, 0 to 1
  merchants: { key: string; total: number; n: number }[]; // most first
}

// Spending by category, most first.
export function byCategory(txs: readonly Tx[], cats: MoneyCats = {}): CatSum[] {
  const by = new Map<Cat, { total: number; m: Map<string, { total: number; n: number }> }>();
  let all = 0;
  for (const t of txs) {
    if (t.amount >= 0) continue;
    const c = categoryOf(t.key, cats);
    const x = by.get(c) || { total: 0, m: new Map() };
    x.total = r2(x.total - t.amount);
    const m = x.m.get(t.key) || { total: 0, n: 0 };
    m.total = r2(m.total - t.amount);
    m.n++;
    x.m.set(t.key, m);
    by.set(c, x);
    all -= t.amount;
  }
  return [...by.entries()]
    .map(([cat, x]) => ({ cat, total: x.total, share: all > 0 ? x.total / all : 0, merchants: [...x.m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1)) }))
    .sort((a, b) => b.total - a.total || (a.cat < b.cat ? -1 : 1));
}

// The biggest payments out, biggest first.
export function biggest(txs: readonly Tx[], n = 5): Tx[] {
  return txs
    .filter((t) => t.amount < 0)
    .sort((a, b) => a.amount - b.amount || b.at - a.at)
    .slice(0, n);
}

export interface Subscription {
  key: string;
  amount: number; // a month, as a plus number
  cur: string;
  times: number; // payments found
  last: number; // when the last one was
}
const DAY = 86_400_000;

// The same amount to the same merchant about once a month (25 to 35 days apart), at least 3 times,
// the last one in the 40 days before `now`. Biggest first.
export function subscriptions(txs: readonly Tx[], now: number): Subscription[] {
  const by = new Map<string, Tx[]>();
  for (const t of txs) {
    if (t.amount >= 0 || t.key === 'unknown') continue;
    const k = `${t.key}\u0001${t.cur}\u0001${Math.round(-t.amount * 100)}`;
    const list = by.get(k);
    if (list) list.push(t);
    else by.set(k, [t]);
  }
  const out: Subscription[] = [];
  for (const list of by.values()) {
    if (list.length < 3) continue;
    list.sort((a, b) => a.at - b.at);
    // The longest run of payments about a month apart, ending with the last one.
    let run = 1;
    for (let i = list.length - 1; i > 0; i--) {
      const gap = (list[i].at - list[i - 1].at) / DAY;
      if (gap >= 25 && gap <= 35) run++;
      else break;
    }
    const last = list[list.length - 1];
    if (run < 3 || now - last.at > 40 * DAY) continue;
    out.push({ key: last.key, amount: -last.amount, cur: last.cur, times: run, last: last.at });
  }
  return out.sort((a, b) => b.amount - a.amount || (a.key < b.key ? -1 : 1));
}

export interface Pace {
  month: string; // this month
  spent: number; // so far
  usualByNow: number | null; // what the usual month had spent by this day (null: no full month yet)
  usualMonth: number | null; // a usual whole month
  months: number; // the full months the usual is from (at most 6)
}

// This month so far against the usual: the full months before it that have any payments (up to
// 6), by the same day of the month, and whole.
export function pace(txs: readonly Tx[], now: number): Pace {
  const month = monthOf(now);
  const day = dayOfMonth(now);
  const spentIn = (m: string, upTo = 31) => r2(txs.filter((t) => t.amount < 0 && monthOf(t.at) === m && dayOfMonth(t.at) <= upTo).reduce((s, t) => s - t.amount, 0));
  const had = new Set(txs.map((t) => monthOf(t.at)));
  const first = txs.reduce((m, t) => Math.min(m, t.at), Infinity);
  const before: string[] = [];
  for (let m = addMonths(month, -1); before.length < 6 && Number.isFinite(first) && m >= monthOf(first); m = addMonths(m, -1)) {
    // The first month only counts when it starts near its beginning (a statement from the 20th
    // isn't a whole month).
    if (m === monthOf(first) && dayOfMonth(first) > 7) break;
    if (had.has(m)) before.push(m);
  }
  const avg = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return { month, spent: spentIn(month), usualByNow: avg(before.map((m) => spentIn(m, day))), usualMonth: avg(before.map((m) => spentIn(m))), months: before.length };
}

// ---------- in words

const SIGN: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', INR: '₹', TRY: '₺', KRW: '₩', RUB: '₽', UAH: '₴', NGN: '₦' };
const NO_CENTS = new Set(['JPY', 'KRW', 'UZS', 'KZT', 'IDR', 'VND']);
// 1234.5 -> "£1,234.50"; to the whole unit when `round`.
export function cash(amount: number, cur: string, round = false): string {
  const cents = !round && !NO_CENTS.has(cur) && Math.round(Math.abs(amount) * 100) % 100 !== 0;
  const n = Math.abs(amount).toLocaleString('en-GB', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  if (!cur) return n;
  return SIGN[cur] ? `${SIGN[cur]}${n}` : `${n} ${cur}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;

export interface Summary {
  cur: string;
  others: number;
  months: Month[];
  pace: Pace;
  top: CatSum[]; // the last 3 months, this one in
  big: Tx[]; // the biggest payments in the same 3 months
  subs: Subscription[];
}

// Everything the Money screen and the coach need, in the main currency.
export function summarize(all: readonly Tx[], now: number, cats: MoneyCats = {}): Summary {
  const { cur, others } = mainCurrency(all);
  const txs = all.filter((t) => t.cur === cur);
  const from = addMonths(monthOf(now), -2);
  const recent = txs.filter((t) => monthOf(t.at) >= from);
  return { cur, others, months: monthly(txs), pace: pace(txs, now), top: byCategory(recent, cats), big: biggest(recent), subs: subscriptions(txs, now) };
}

const HEAD = "## Money, from the Player's bank statements (worked out on this device; where it went, with no advice on investing or interest)";

// For the coach: a short monthly summary, only for an AI that may read money (tier 3).
export function moneyText(s: Summary | null, cap: number, compact = false): { text: string; tier: 1 | 3 } {
  if (!s || cap < 3 || !s.months.length) return { text: '', tier: 1 };
  const c = (n: number) => cash(n, s.cur, true);
  const lines = [HEAD];
  const p = s.pace;
  lines.push(`- ${monthName(p.month)} so far: spent ${c(p.spent)}${p.usualByNow != null ? ` (by this day of the month they usually spend ${c(p.usualByNow)}; a usual month is ${c(p.usualMonth!)})` : ''}.`);
  const past = s.months.filter((m) => m.month < p.month).slice(compact ? -1 : -3).reverse();
  for (const m of past) lines.push(`- ${monthName(m.month)}: spent ${c(m.out)}, money in ${c(m.in)}.`);
  const top = s.top.slice(0, compact ? 3 : 5);
  if (top.length) lines.push(`- Most went on (last 3 months): ${top.map((x) => `${CATS[x.cat]} ${c(x.total)}`).join(', ')}.`);
  if (s.subs.length) lines.push(`- Subscriptions found: ${s.subs.length}, about ${c(s.subs.reduce((a, x) => a + x.amount, 0))} a month.`);
  return { text: lines.join('\n'), tier: 3 };
}
