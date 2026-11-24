// Money owed and groceries (lib/everyday.ts), and the box on Today that works out what you wrote
// (lib/capture.ts).

import { describe, expect, it } from 'vitest';
import * as E from './everyday';
import { classify, asKind, findWhen } from './capture';

const T = 1_700_000_000_000;

describe('money owed', () => {
  it('keeps only what makes sense, and a deletion as a tombstone', () => {
    expect(E.cleanDebt({ id: 'a', who: ' Sam ', amount: 12.345, cur: 'GBP', dir: 'owed', at: T })).toEqual({ id: 'a', who: 'Sam', amount: 12.35, cur: 'GBP', dir: 'owed', created: T, at: T });
    expect(E.cleanDebt({ id: 'a', who: 'Sam', amount: -1, at: T })).toBeNull();
    expect(E.cleanDebt({ id: 'a', who: '', amount: 5, at: T })).toBeNull();
    expect(E.cleanDebt({ id: 'a', who: 'Sam', amount: 5, cur: 'pounds', dir: 'x', due: '2026-13-01', at: T })).toEqual({ id: 'a', who: 'Sam', amount: 5, cur: 'GBP', dir: 'owed', created: T, at: T });
    expect(E.cleanDebt({ id: 'a', gone: true, at: T })?.gone).toBe(true);
  });

  it('adds up who owes whom per person and currency, settled ones left out', () => {
    const d = E.cleanDebts(
      {
        a: { id: 'a', who: 'Sam', amount: 20, cur: 'GBP', dir: 'owed', at: T },
        b: { id: 'b', who: 'sam', amount: 5, cur: 'GBP', dir: 'owe', at: T + 1, due: '2026-12-01' },
        c: { id: 'c', who: 'Ali', amount: 100000, cur: 'UZS', dir: 'owe', at: T },
        d: { id: 'd', who: 'Ali', amount: 50, cur: 'UZS', dir: 'owe', at: T, settled: T + 5 },
      },
      T,
    );
    const b = E.balances(d);
    expect(b.map((x) => [x.who, x.net, x.cur])).toEqual([
      ['Sam', 15, 'GBP'],
      ['Ali', -100000, 'UZS'],
    ]);
    expect(E.balanceText(b[0])).toBe('Sam owes you £15');
    expect(E.balanceText(b[1])).toBe('You owe Ali 100,000 UZS');
    expect(E.totals(d)).toEqual([
      { cur: 'GBP', owed: 15, owe: 0 },
      { cur: 'UZS', owed: 0, owe: 100000 },
    ]);
    expect(E.money(12.5, 'GBP')).toBe('£12.50');
    expect(E.everydayText(d, {}, '2026-12-02')).toContain('Sam owes the Player £15 (was due 2026-12-01)');
  });

  it('merges per item: the later change wins, and a deletion stays deleted', () => {
    const a = E.cleanDebts({ x: { id: 'x', who: 'Sam', amount: 5, at: T } }, T);
    const b = E.cleanDebts({ x: { id: 'x', gone: true, at: T + 10 }, y: { id: 'y', who: 'Jo', amount: 3, at: T } }, T);
    const m = E.mergeDebts(a, b, T);
    expect(m.x.gone).toBe(true);
    expect(m.y.who).toBe('Jo');
    expect(E.mergeDebts(b, a, T).x.gone).toBe(true);
  });

  it('drops old tombstones, long-settled debts and long-bought groceries', () => {
    const later = T + 500 * 86_400_000;
    expect(E.cleanDebts({ x: { id: 'x', gone: true, at: T }, y: { id: 'y', who: 'Jo', amount: 3, at: T, settled: T } }, later)).toEqual({});
    expect(E.cleanGroceries({ m: { id: 'm', name: 'Milk', at: T, got: T } }, T + 40 * 86_400_000)).toEqual({});
  });

  it('picks a first currency from the device region', () => {
    expect(E.currencyFor('en-GB')).toBe('GBP');
    expect(E.currencyFor('uz-UZ')).toBe('UZS');
    expect(E.currencyFor('de-DE')).toBe('EUR');
    expect(E.currencyFor('en')).toBe('GBP');
  });
});

describe('the box on Today', () => {
  // A Tuesday, 10:00.
  const now = new Date(2026, 10, 24, 10, 0);

  it('finds a day and a time and takes them out of the words', () => {
    expect(findWhen('call mum tomorrow at 5', now)).toEqual({ day: '2026-11-25', time: '17:00', rest: 'call mum' });
    expect(findWhen('dentist on friday 9:30am', now)).toEqual({ day: '2026-11-27', time: '09:30', rest: 'dentist' });
    expect(findWhen('pay rent by 1 dec', now)).toEqual({ day: '2026-12-01', rest: 'pay rent' });
    expect(findWhen('gym at 7am', now)).toEqual({ day: '2026-11-25', time: '07:00', rest: 'gym' }); // 7am has gone today
    expect(findWhen('submit essay 2026-12-03', now).day).toBe('2026-12-03');
    expect(findWhen('just a thought', now)).toEqual({ rest: 'just a thought' });
  });

  it('works out a to-do, groceries, money owed, a question or a note', () => {
    expect(classify('Call mum tomorrow at 5', now)).toMatchObject({ kind: 'todo', title: 'Call mum', day: '2026-11-25', time: '17:00' });
    expect(classify('remind me to book the flights', now)).toMatchObject({ kind: 'todo', title: 'Book the flights' });
    expect(classify('buy milk, 2 bread and eggs', now)).toMatchObject({ kind: 'grocery', items: [{ name: 'milk' }, { name: 'bread', qty: '2' }, { name: 'eggs' }] });
    expect(classify('add oat milk to the shopping list', now)).toMatchObject({ kind: 'grocery', items: [{ name: 'oat milk' }] });
    expect(classify('Sam owes me £12.50 for lunch', now)).toMatchObject({ kind: 'debt', who: 'Sam', amount: 12.5, cur: 'GBP', dir: 'owed', what: 'lunch' });
    expect(classify('I owe Ali 50k sum by friday', now)).toMatchObject({ kind: 'debt', who: 'Ali', amount: 50000, cur: 'UZS', dir: 'owe', day: '2026-11-27' });
    expect(classify('I borrowed 20 dollars from jo', now)).toMatchObject({ kind: 'debt', who: 'Jo', amount: 20, cur: 'USD', dir: 'owe' });
    expect(classify('Jo lent me 15', now)).toMatchObject({ kind: 'debt', who: 'Jo', amount: 15, dir: 'owe' });
    expect(classify('how did I sleep this week?', now).kind).toBe('question');
    expect(classify('what should I focus on today', now).kind).toBe('question');
    expect(classify('Had a lovely walk by the river with Sam', now).kind).toBe('note');
  });

  it('can be turned into another kind', () => {
    const c = classify('milk tomorrow', now);
    expect(c.kind).toBe('todo');
    expect(asKind(c, 'grocery', now)).toMatchObject({ kind: 'grocery', items: [{ name: 'milk tomorrow' }] });
    expect(asKind(c, 'note', now)).toEqual({ kind: 'note', text: 'milk tomorrow' });
    expect(asKind(classify('Had lunch', now), 'todo', now)).toMatchObject({ kind: 'todo', title: 'Had lunch' });
  });
});
