import { describe, expect, it } from 'vitest';
import { cleanDecision, cleanDecisions, cleanDismissed, decisionsText, dueBack, mergeDecisions, mergeDismissed } from './decisions';

const base = { id: 'd1', question: 'Take the offer?', options: [{ name: 'Take it', costs: 'Evenings', gains: 'Career' }, { name: 'Stay' }], created: 1000, at: 1000 };

describe('decisions', () => {
  it('keeps only what is right', () => {
    expect(cleanDecision({ ...base, outcome: 'great', checkOn: 'soon', tier: 5, pick: 'Take it' })).toEqual({
      id: 'd1',
      question: 'Take the offer?',
      options: [
        { name: 'Take it', costs: 'Evenings', gains: 'Career' },
        { name: 'Stay', costs: '', gains: '' },
      ],
      pick: 'Take it',
      created: 1000,
      at: 1000,
    });
    expect(cleanDecision({ ...base, question: '  ' })).toBeNull();
    expect(cleanDecision({ ...base, id: 'bad id!' })).toBeNull();
    expect(cleanDecision({ ...base, tier: 3, outcome: 'worse', checkOn: '2026-12-01' })).toMatchObject({ tier: 3, outcome: 'worse', checkOn: '2026-12-01' });
    expect(cleanDecisions({ d2: base })).toEqual({});
  });

  it('merge per decision: the later change wins, a deletion too', () => {
    const t = 1_800_000_000_000;
    const a = cleanDecisions({ d1: { ...base, chose: 'Stay', at: t + 2000 } }, t);
    const b = cleanDecisions({ d1: { id: 'd1', gone: true, created: 1000, at: t + 3000 }, d2: { ...base, id: 'd2', at: t } }, t);
    const m = mergeDecisions(a, b, t + 4000);
    expect(m.d1.gone).toBe(true);
    expect(m.d2.question).toBe('Take the offer?');
    expect(mergeDecisions(b, a, t + 4000)).toEqual(m);
  });

  it('due back once the day came and nobody said how it went', () => {
    const all = cleanDecisions({
      d1: { ...base, chose: 'Stay', checkOn: '2026-11-20' },
      d2: { ...base, id: 'd2', chose: 'Stay', checkOn: '2026-11-20', outcome: 'better' },
      d3: { ...base, id: 'd3', chose: 'Stay', checkOn: '2026-12-20' },
      d4: { ...base, id: 'd4', checkOn: '2026-11-20' },
    });
    expect(dueBack(all, '2026-11-24').map((d) => d.id)).toEqual(['d1']);
  });

  it('tells the coach what they chose and how it went, only what this AI may read', () => {
    const all = cleanDecisions({
      d1: { ...base, pick: 'Take it', chose: 'Stay', expect: 'Calmer weeks', outcome: 'worse', note: 'Bored' },
      d2: { ...base, id: 'd2', question: 'About Max?', chose: 'Call', tier: 3 },
    });
    const text = decisionsText(all, 8, 1);
    expect(text).toContain('Take the offer? Chose: Stay (Arise picked Take it). Expected: Calmer weeks. How it went: worse than expected: Bored.');
    expect(text).not.toContain('Max');
    expect(decisionsText(all, 8, 3)).toContain('About Max?');
    expect(decisionsText({}, 8, 3)).toBe('');
  });

  it('warnings put away merge by keeping both, and old ones go', () => {
    const now = 200 * 86_400_000;
    expect(mergeDismissed({ a: now - 1 }, { b: now - 2, a: now - 5 }, now)).toEqual({ a: now - 1, b: now - 2 });
    expect(cleanDismissed({ old: 1, ok: now }, now)).toEqual({ ok: now });
  });
});
