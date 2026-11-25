// The Player's corrections and the snapshots of what Arise knew, on their own: how a correction
// changes an event, how two devices' lists come together, how a month's pack follows them, what
// the memory must never learn again, and what Arise knew on a past day.

import { describe, expect, it } from 'vitest';
import { cleanLifeFix, cleanLifeKnew, type LifeFix, type LifeKnew } from '../lib/validate';
import { applyFix, isWrong, knewDiff, knewOn, mergeFixes, mergeKnew, sameClaim, thinKnew, withAreaFixes, wrongs } from './fixes';
import { canonical, cleanContent, emptyContent, LIFE_SCHEMA, MEM, mergeContent, type Content, type SyncedEvent } from './packs';
import type { LifeEvent } from './types';

const at = (s: string) => Date.parse(`${s}Z`);
const ev = (id: string, when: string, extra: Partial<LifeEvent> = {}): LifeEvent => ({ id: `spotify:${id}`, source: 'spotify', kind: 'listen', at: at(when), title: `Song ${id}`, tier: 2, ...extra });
const synced = (e: LifeEvent, m: number): SyncedEvent => ({ ...e, m });
const content = (part: Partial<Content>): Content => ({ ...emptyContent(), ...part });

describe('a correction', () => {
  it('is checked like everything else from storage', () => {
    expect(cleanLifeFix({ id: 'spotify:1', at: 5, title: '  Better  title ' })).toEqual({ id: 'spotify:1', at: 5, title: 'Better title' });
    expect(cleanLifeFix({ id: 'spotify:1', at: 5 })).toBeNull(); // says nothing
    expect(cleanLifeFix({ id: 'nosuch:1', at: 5, gone: true })).toBeNull(); // no such source
    expect(cleanLifeFix({ id: 'spotify:1', at: 5, kind: 'dance' })).toBeNull();
    expect(cleanLifeFix({ id: 'fact:fab1', at: 5, wrong: 'You run.', right: 'You walk.', tier: 2 })).toEqual({ id: 'fact:fab1', at: 5, wrong: 'You run.', right: 'You walk.', tier: 2 });
    expect(cleanLifeFix({ id: 'area:sleep', at: 5, gone: true, wrong: 'Short nights.' })).toEqual({ id: 'area:sleep', at: 5, gone: true, wrong: 'Short nights.' });
    expect(cleanLifeFix({ id: 'fact:<b>', at: 5, wrong: 'x' })).toBeNull();
  });

  it('changes an event the same way however often it comes in, and keeps its length when its time moves', () => {
    const e = ev('1', '2026-10-05T09:00', { end: at('2026-10-05T09:30') });
    const fix: LifeFix = { id: e.id, at: 1, title: 'Lunch with Sam', kind: 'event', start: at('2026-10-05T12:00') };
    const once = applyFix(e, fix)!;
    expect(once).toMatchObject({ title: 'Lunch with Sam', kind: 'event', at: at('2026-10-05T12:00'), end: at('2026-10-05T12:30') });
    expect(applyFix(once, fix)).toEqual(once);
    expect(applyFix(e, { id: e.id, at: 1, gone: true })).toBeNull();
    expect(applyFix(e, undefined)).toBe(e);
    // A new kind can only make it more private.
    expect(applyFix({ ...e, tier: 2 }, { id: e.id, at: 1, kind: 'message' })!.tier).toBe(3);
  });

  it('comes together with the list from another device: the newest for each thing, none from before Delete everything', () => {
    const a: LifeFix[] = [
      { id: 'spotify:1', at: 10, title: 'A' },
      { id: 'spotify:2', at: 10, gone: true },
    ];
    const b: LifeFix[] = [
      { id: 'spotify:1', at: 20, title: 'B' },
      { id: 'spotify:3', at: 30, title: 'C' },
    ];
    expect(mergeFixes(a, b).map((f) => [f.id, f.title ?? 'gone'])).toEqual([
      ['spotify:2', 'gone'],
      ['spotify:1', 'B'],
      ['spotify:3', 'C'],
    ]);
    expect(mergeFixes(a, b)).toEqual(mergeFixes(b, a));
    expect(mergeFixes(a, b, [{ at: 25, what: 'all' }]).map((f) => f.id)).toEqual(['spotify:3']);
    // "Forget what Arise learned" leaves the Player's own corrections.
    expect(mergeFixes(a, b, [{ at: 25, what: 'memory' }])).toHaveLength(3);
  });

  it("wins in a month's pack over another device's older copy, even one changed later", () => {
    const key = 'e:2026-10';
    const e = ev('1', '2026-10-05T09:00');
    const fixes: LifeFix[] = [
      { id: e.id, at: 100, title: 'Fixed title' },
      { id: 'spotify:2', at: 100, gone: true },
      { id: 'spotify:3', at: 100, start: at('2026-11-02T09:00') }, // moved to November
    ];
    const here = content({ events: [synced(applyFix(e, fixes[0])!, 100)] });
    // The other device imported the same events again after the fix, as they first were.
    const there = content({ events: [synced(e, 500), synced(ev('2', '2026-10-06T09:00'), 500), synced(ev('3', '2026-10-07T09:00'), 500)] });
    const out = mergeContent(key, here, there, { now: 1000, fixes });
    expect(out.events.map((x) => [x.id, x.title])).toEqual([['spotify:1', 'Fixed title']]);
    expect(out.events[0].m).toBe(500);
    // The same either way round, so every device agrees.
    expect(canonical(key, mergeContent(key, there, here, { now: 1000, fixes }))).toBe(canonical(key, out));
  });

  it('syncs in the memory pack, which looks the same as before when there are none', () => {
    expect(LIFE_SCHEMA).toBe(5); // 4 brought these; 5 the r: packs (reads.ts)
    const plain = content({ facts: [] });
    expect(canonical(MEM, plain)).toBe(JSON.stringify({ v: 1, k: MEM, tombs: {}, facts: [], prefs: { paused: false, at: 0 }, wipes: [] }));
    const fixes: LifeFix[] = [{ id: 'fact:fa1', at: 5, wrong: 'You run.' }];
    const knew: LifeKnew[] = [{ day: '2026-10-01', at: 5, facts: [{ id: 'fa1', text: 'You run.' }] }];
    const back = cleanContent(MEM, JSON.parse(canonical(MEM, content({ fixes, knew }))));
    expect(back.fixes).toEqual(fixes);
    expect(back.knew).toEqual(knew);
    const merged = mergeContent(MEM, content({ fixes }), content({ knew }), { now: at('2026-10-02T00:00') });
    expect(merged.fixes).toEqual(fixes);
    expect(merged.knew).toEqual(knew);
  });
});

describe('what the memory must never learn again', () => {
  it('knows the same claim in close words, and not a different one', () => {
    expect(sameClaim('You run every Sunday morning.', 'You go running on Sunday mornings.')).toBe(true);
    expect(sameClaim('You run every Sunday morning.', 'You swim on Tuesdays.')).toBe(false);
    const list = wrongs([
      { id: 'fact:fa1', at: 1, wrong: 'You have a dog called Rex.', right: 'Rex is my sister’s dog.' },
      { id: 'spotify:1', at: 1, title: 'x' },
    ]);
    expect(list).toEqual(['You have a dog called Rex.']);
    expect(isWrong('You have a dog named Rex', list)).toBe(true);
    expect(isWrong('You walk to work.', list)).toBe(false);
  });

  it('shows a part of life in their words for 4 weeks after they said it', () => {
    const areas = [
      { id: 'sleep', label: 'Sleep', score: 2, reason: 'About 5 h a night.', trend: 'down', tier: 3, help: '' },
      { id: 'body', label: 'Body', score: 4, reason: 'More steps.', trend: 'up', tier: 2 },
    ];
    const fixes: LifeFix[] = [{ id: 'area:sleep', at: at('2026-10-01T00:00'), wrong: 'About 5 h a night.', right: 'I sleep 8 hours; the Mac stays on.', tier: 3 }];
    const out = withAreaFixes(areas, fixes, at('2026-10-10T00:00'));
    expect(out[0]).toMatchObject({ score: null, trend: null, reason: 'You said: I sleep 8 hours; the Mac stays on.', fixed: true });
    expect(out[1]).toBe(areas[1]);
    expect(withAreaFixes(areas, fixes, at('2026-11-10T00:00'))[0]).toBe(areas[0]);
  });
});

describe('what Arise knew', () => {
  const snap = (day: string, texts: string[], t = at(`${day}T12:00`)): LifeKnew => ({ day, at: t, facts: texts.map((text, i) => ({ id: `f${i}`, text })) });

  it('is checked like everything else from storage', () => {
    expect(cleanLifeKnew({ day: '2026-10-01', at: 5, facts: [{ id: 'fa', text: 'You run.' }, { id: 'bad id', text: 'x' }] })).toEqual({ day: '2026-10-01', at: 5, facts: [{ id: 'fa', text: 'You run.' }] });
    expect(cleanLifeKnew({ day: 'soon', facts: [] })).toBeNull();
  });

  it('keeps the last two weeks day by day, then one a month, and always the first', () => {
    const days: LifeKnew[] = [];
    for (let i = 0; i < 120; i++) {
      const d = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);
      days.push(snap(d, [`fact on ${d}`]));
    }
    const kept = thinKnew(days, '2026-09-28');
    const list = kept.map((k) => k.day);
    expect(list[0]).toBe('2026-06-01');
    expect(list).toContain('2026-06-30');
    expect(list).toContain('2026-07-31');
    expect(list).not.toContain('2026-07-15');
    expect(list.filter((k) => k > '2026-09-14')).toHaveLength(14);
    expect(thinKnew(kept, '2026-09-28')).toEqual(kept);
    // A cap, and the first stays.
    const many: LifeKnew[] = [];
    for (let m = 0; m < 60; m++) many.push(snap(new Date(Date.UTC(2020, m, 28)).toISOString().slice(0, 10), ['x']));
    const capped = thinKnew(many, '2026-01-01');
    expect(capped).toHaveLength(40);
    expect(capped[0].day).toBe('2020-01-28');
    // "Forget what Arise learned" takes them all.
    expect(mergeKnew(many, [], at('2026-01-01T00:00'), [{ at: at('2025-12-31T00:00'), what: 'memory' }])).toEqual([]);
  });

  it('finds the one that stood on a day, or says when they began', () => {
    const list = [snap('2026-09-30', ['You run.']), snap('2026-10-20', ['You run.', 'You swim.'])];
    expect(knewOn(list, '2026-10-05').knew?.day).toBe('2026-09-30');
    expect(knewOn(list, '2026-10-31').knew?.day).toBe('2026-10-20');
    expect(knewOn(list, '2026-08-01')).toEqual({ knew: null, first: '2026-09-30' });
    expect(knewOn([], '2026-08-01')).toEqual({ knew: null, first: null });
  });

  it('says what changed since then: added, changed and dropped', () => {
    const then = [
      { id: 'fa', text: 'You run on Sundays.' },
      { id: 'fb', text: 'You live in Leeds.' },
      { id: 'fc', text: 'You play chess.' },
    ];
    const now = [
      { id: 'fa', text: 'You run on Sundays and Wednesdays.' },
      { id: 'fd', text: 'You swim.' },
      { id: 'fe', text: 'You play chess.' }, // learned again under a new id
    ];
    expect(knewDiff(then, now)).toEqual({ added: ['You swim.'], changed: [{ was: 'You run on Sundays.', now: 'You run on Sundays and Wednesdays.' }], dropped: ['You live in Leeds.'] });
  });
});
