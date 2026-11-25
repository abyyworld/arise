// Where the money went (lib/money.ts): merchants and their categories (the table and the Player's
// own, kept and merged like names for places), payments read from the life log, monthly sums,
// subscriptions, this month against the usual, and the coach's short summary.

import { describe, expect, it } from 'vitest';
import { cleanState, type Settings } from './validate';
import { merge } from './merge';
import * as MN from './money';

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
let n = 0;
const tx = (when: number, amount: number, desc: string, cur = 'GBP'): MN.Tx => ({ id: `bank:${++n}`, at: when, amount, cur, desc, key: MN.merchantKey(desc) });

describe('merchants', () => {
  it('gets a short name that is the same for every payment there', () => {
    expect(MN.merchantKey('CARD PAYMENT TO TESCO STORES 3456 LONDON ON 12/03')).toBe('tesco');
    expect(MN.merchantKey('Tesco Express 1234')).toBe('tesco');
    expect(MN.merchantKey('PAYPAL *SPOTIFY')).toBe('spotify');
    expect(MN.merchantKey('Netflix.com')).toBe('netflix');
    expect(MN.merchantKey('UBER *EATS HELP.UBER.COM')).toBe('uber eats');
    expect(MN.merchantKey('UBER *TRIP')).toBe('uber');
    expect(MN.merchantKey('KARTENZAHLUNG REWE SAGT DANKE 4711')).toBe('rewe');
    expect(MN.merchantKey("Joe's Barbers 12AB34")).toBe("joe's barbers");
    expect(MN.merchantKey('DD O2 UK')).toBe('o2');
    expect(MN.merchantKey('12345 67/89')).toBe('unknown');
    expect(MN.merchantName("joe's barbers")).toBe("Joe's Barbers");
    expect(MN.merchantName('tfl')).toBe('TFL');
  });

  it('is put in a category from the table, else Other', () => {
    expect(MN.categoryOf('tesco')).toBe('groceries');
    expect(MN.categoryOf('uber eats')).toBe('eating');
    expect(MN.categoryOf('uber')).toBe('transport');
    expect(MN.categoryOf('netflix')).toBe('apps');
    expect(MN.categoryOf('zakat')).toBe('giving');
    expect(MN.categoryOf("joe's barbers")).toBe('other');
  });

  it("uses the Player's own category, and goes back to the guess", () => {
    let cats: MN.MoneyCats = {};
    cats = MN.setMoneyCat(cats, 'tesco', 'eating', 1000)!;
    expect(MN.categoryOf('tesco', cats)).toBe('eating');
    expect(MN.isOwnCat('tesco', cats)).toBe(true);
    const back = MN.setMoneyCat(cats, 'tesco', null, 2000)!;
    expect(back.tesco).toEqual({ cat: '', at: 2000, gone: true });
    expect(MN.categoryOf('tesco', back)).toBe('groceries');
    expect(MN.setMoneyCat(cats, 'tesco', 'nope' as MN.Cat)).toBeNull();
    expect(MN.setMoneyCat(cats, 'bad\nkey', 'fun')).toBeNull();
    expect(MN.setMoneyCat({}, 'tesco', null)).toEqual({});
  });
});

describe('moneyCats in the state', () => {
  const NOW = Date.UTC(2026, 10, 25);

  it('is cleaned: bad keys, categories and times go, old tombstones go', () => {
    const raw = { tesco: { cat: 'eating', at: NOW }, 'bad\u0000': { cat: 'fun', at: NOW }, aldi: { cat: 'nope', at: NOW }, lidl: { cat: 'fun' }, old: { gone: true, at: NOW - 200 * 86_400_000 }, gone: { gone: true, at: NOW } };
    expect(MN.cleanMoneyCats(raw, NOW)).toEqual({ gone: { cat: '', at: NOW, gone: true }, tesco: { cat: 'eating', at: NOW } });
    expect(MN.cleanMoneyCats('nope', NOW)).toEqual({});
    const st = cleanState({ moneyCats: { tesco: { cat: 'fun', at: NOW } } }, {} as Settings);
    expect(st.moneyCats).toEqual({ tesco: { cat: 'fun', at: NOW } });
    expect(cleanState({}, {} as Settings).moneyCats).toEqual({});
  });

  it('merges per merchant, the later change winning, removals too', () => {
    const a: MN.MoneyCats = { tesco: { cat: 'eating', at: NOW - 10 }, aldi: { cat: 'fun', at: NOW - 5 } };
    const b: MN.MoneyCats = { tesco: { cat: 'groceries', at: NOW - 1 }, aldi: { cat: '', at: NOW - 9, gone: true }, lidl: { cat: 'shopping', at: NOW - 3 } };
    expect(MN.mergeMoneyCats(a, b, NOW)).toEqual({ aldi: { cat: 'fun', at: NOW - 5 }, lidl: { cat: 'shopping', at: NOW - 3 }, tesco: { cat: 'groceries', at: NOW - 1 } });
    // And through sync's merge of two whole copies.
    const copy = (x: object) => cleanState(x, {} as Settings);
    const m = merge(copy({ moneyCats: a }), 1, copy({ moneyCats: b }), 2, NOW);
    expect(m.moneyCats.tesco.cat).toBe('groceries');
    expect(m.moneyCats.lidl.cat).toBe('shopping');
  });
});

describe('payments from the life log', () => {
  it("reads the bank importer's titles", () => {
    expect(MN.txOf({ id: 'bank:1', source: 'bank', kind: 'purchase', at: 5, title: 'Spent 1,234.50 GBP at TESCO STORES 12', value: -1234.5, unit: 'GBP' })).toEqual({ id: 'bank:1', at: 5, amount: -1234.5, cur: 'GBP', desc: 'TESCO STORES 12', key: 'tesco' });
    expect(MN.txOf({ id: 'bank:2', source: 'bank', kind: 'purchase', at: 5, title: 'Received 2,000.00: SALARY ACME at work', value: 2000, unit: '' })).toMatchObject({ amount: 2000, cur: '', desc: 'SALARY ACME at work' });
    expect(MN.txOf({ id: 'x', source: 'manual', kind: 'purchase', at: 5, title: 'Spent 3 at shop', value: -3 })).toBeNull();
    expect(MN.txOf({ id: 'bank:3', source: 'bank', kind: 'purchase', at: 5, title: 'Spent 0 at shop', value: 0 })).toBeNull();
  });
});

describe('sums', () => {
  const txs = [
    tx(at(2026, 8, 3), -40, 'TESCO'),
    tx(at(2026, 8, 28), 2000, 'SALARY'),
    tx(at(2026, 10, 2), -60.5, 'TESCO'),
    tx(at(2026, 10, 20), -9.99, 'NETFLIX.COM'),
    tx(at(2026, 10, 28), 2000, 'SALARY'),
    tx(at(2026, 11, 1), -15, 'UBER *TRIP'),
  ];

  it('spending and money in per month, with the empty months between', () => {
    expect(MN.monthly(txs)).toEqual([
      { month: '2026-08', out: 40, in: 2000, n: 2 },
      { month: '2026-09', out: 0, in: 0, n: 0 },
      { month: '2026-10', out: 70.49, in: 2000, n: 3 },
      { month: '2026-11', out: 15, in: 0, n: 1 },
    ]);
    expect(MN.monthly([])).toEqual([]);
  });

  it('by category, most first, with the merchants in each', () => {
    const c = MN.byCategory(txs);
    expect(c.map((x) => [x.cat, x.total])).toEqual([
      ['groceries', 100.5],
      ['transport', 15],
      ['apps', 9.99],
    ]);
    expect(c[0].merchants).toEqual([{ key: 'tesco', total: 100.5, n: 2 }]);
    expect(c[0].share).toBeCloseTo(100.5 / 125.49);
    // The Player's own category moves every payment there.
    expect(MN.byCategory(txs, { tesco: { cat: 'eating', at: 1 } })[0].cat).toBe('eating');
  });

  it('the biggest payments out', () => {
    expect(MN.biggest(txs, 2).map((t) => t.amount)).toEqual([-60.5, -40]);
  });

  it('the main currency, and how many are in others', () => {
    expect(MN.mainCurrency([...txs, tx(at(2026, 11, 2), -5, 'CAFE', 'EUR')])).toEqual({ cur: 'GBP', others: 1 });
    expect(MN.cash(1234.5, 'GBP')).toBe('£1,234.50');
    expect(MN.cash(-1234.5, 'GBP', true)).toBe('£1,235');
    expect(MN.cash(12, 'UZS')).toBe('12 UZS');
    expect(MN.cash(12.5, '')).toBe('12.50');
  });
});

describe('subscriptions', () => {
  const now = at(2026, 11, 25);
  it('the same amount to the same place about once a month, 3 times or more, lately', () => {
    const txs = [
      ...[7, 8, 9, 10, 11].map((m) => tx(at(2026, m, 3), -10.99, 'NETFLIX.COM')),
      ...[9, 10, 11].map((m) => tx(at(2026, m, 15), -4.99, 'PAYPAL *SPOTIFY')),
      // Not one: a different amount each time, twice only, or stopped months ago.
      ...[8, 9, 10, 11].map((m, i) => tx(at(2026, m, 10), -20 - i, 'TESCO')),
      ...[10, 11].map((m) => tx(at(2026, m, 1), -8, 'GYM GROUP')),
      ...[3, 4, 5].map((m) => tx(at(2026, m, 1), -6, 'DISNEY PLUS')),
      // Weekly, not monthly.
      ...[1, 8, 15, 22].map((d) => tx(at(2026, 11, d), -3, 'CAFE NERO')),
    ];
    const s = MN.subscriptions(txs, now);
    expect(s.map((x) => [x.key, x.amount, x.times])).toEqual([
      ['netflix', 10.99, 5],
      ['spotify', 4.99, 3],
    ]);
    expect(s[0].last).toBe(at(2026, 11, 3));
  });
});

describe('this month against the usual', () => {
  it('by the same day of the month, and whole months, from up to 6 full months', () => {
    const now = at(2026, 11, 10);
    const txs = [
      tx(at(2026, 9, 2), -100, 'TESCO'),
      tx(at(2026, 9, 20), -300, 'RENT'),
      tx(at(2026, 10, 5), -200, 'TESCO'),
      tx(at(2026, 10, 25), -100, 'RENT'),
      tx(at(2026, 11, 4), -120, 'TESCO'),
    ];
    expect(MN.pace(txs, now)).toEqual({ month: '2026-11', spent: 120, usualByNow: 150, usualMonth: 350, months: 2 });
  });

  it("leaves out a first month that started late, and says when there's no usual yet", () => {
    const now = at(2026, 11, 10);
    expect(MN.pace([tx(at(2026, 10, 20), -50, 'TESCO'), tx(at(2026, 11, 2), -10, 'TESCO')], now)).toEqual({ month: '2026-11', spent: 10, usualByNow: null, usualMonth: null, months: 0 });
  });
});

describe('the summary', () => {
  const now = at(2026, 11, 10);
  const txs = [
    ...[8, 9, 10, 11].map((m) => tx(at(2026, m, 2), -9.99, 'NETFLIX.COM')),
    tx(at(2026, 6, 2), -500, 'IKEA'), // before the last 3 months
    tx(at(2026, 9, 5), -80, 'TESCO'),
    tx(at(2026, 10, 5), -120, 'TESCO'),
    tx(at(2026, 10, 28), 2000, 'SALARY'),
    tx(at(2026, 11, 4), -30, 'UBER *TRIP'),
  ];
  const s = MN.summarize(txs, now);

  it('has the last 3 months for the categories and the biggest payments', () => {
    expect(s.cur).toBe('GBP');
    expect(s.top.map((x) => x.cat)).toEqual(['groceries', 'transport', 'apps']);
    expect(s.big[0].key).toBe('tesco');
    expect(s.big.some((t) => t.key === 'ikea')).toBe(false);
    expect(s.subs.map((x) => x.key)).toEqual(['netflix']);
  });

  it('gives the coach a short monthly summary, only an AI that may read money, and no advice', () => {
    expect(MN.moneyText(s, 1)).toEqual({ text: '', tier: 1 });
    expect(MN.moneyText(s, 2)).toEqual({ text: '', tier: 1 });
    const t = MN.moneyText(s, 3);
    expect(t.tier).toBe(3);
    expect(t.text).toContain('November 2026 so far: spent £40');
    expect(t.text).toContain('October 2026: spent £130, money in £2,000.');
    expect(t.text).toContain('Most went on (last 3 months): Groceries £200, Transport £30, Apps and streaming £30.');
    expect(t.text).toContain('Subscriptions found: 1, about £10 a month.');
    // The heading tells the coach not to suggest investing or interest; the lines are only sums.
    expect(t.text.split('\n')[0]).toContain('no advice on investing or interest');
    expect(t.text.split('\n').slice(1).join('\n')).not.toMatch(/invest|interest|save more|savings/i);
    expect(t.text).not.toMatch(/—/);
    const small = MN.moneyText(s, 3, true).text;
    expect(small).not.toContain('September');
    expect(MN.moneyText(null, 3).text).toBe('');
  });
});
