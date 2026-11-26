// @vitest-environment jsdom
// The story of a day, written on the device from what Arise saw: from a known day of signals, with
// and without each source; in "I" and "you"; the tier gate for Write it better; and the month's
// and year's summaries next to the one before.

import { describe, expect, it, vi } from 'vitest';
import type { State } from '../lib/validate';
import type { DayRow } from '../lib/patterns';
import { signalsFrom } from './signals';
import { tallyOf } from './lookback';
import { betterPrompt, cleanBetter, dayFacts, dayStory, mayWrite, spanStory, storyTier, writeBetter } from './story';
import type { LifeEvent } from './types';

const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const K = '2026-10-14'; // a Wednesday
type St = Pick<State, 'logs' | 'sessions' | 'goals' | 'checks' | 'ai'>;
const ST: St = { logs: {}, sessions: [], goals: [], checks: {}, ai: { chat: [] } as unknown as State['ai'] };

const DAY: LifeEvent[] = [
  // The night before, from Health.
  { id: 'health:sleep:1', source: 'health', kind: 'sleep', at: T('2026-10-13', 23, 20), end: T(K, 7, 10), title: 'Slept 7 h 50 min', value: 470, unit: 'min', tier: 3 },
  { id: 'health:steps:1', source: 'health', kind: 'steps', at: T(K, 0), end: T('2026-10-15', 0), title: 'Walked 8,214 steps', value: 8214, unit: 'steps', tier: 2, meta: { day: K } },
  // Places: home and a Wi-Fi network aren't said.
  { id: 'maps:visit:1', source: 'maps', kind: 'place', at: T(K, 9), end: T(K, 10), title: 'At Gym', tier: 3, meta: { place: 'Gym' } },
  { id: 'maps:visit:2', source: 'maps', kind: 'place', at: T(K, 12, 30), end: T(K, 13, 15), title: 'At Café Nero', tier: 3, meta: { place: 'Café Nero' } },
  { id: 'maps:visit:3', source: 'maps', kind: 'place', at: T(K, 18), end: T(K, 23), title: 'At Home', tier: 3, meta: { place: 'Home' } },
  { id: 'shortcut:wifi:1', source: 'shortcut', kind: 'place', at: T(K, 18, 1), title: 'Wi-Fi: HomeNet', tier: 3, meta: { via: 'wifi' } },
  // People.
  { id: 'android:call:1', source: 'android', kind: 'call', at: T(K, 11), end: T(K, 11, 12), title: 'Call from Sam (12 min)', value: 12, unit: 'min', tier: 3, meta: { name: 'Sam', number: '07700 900111' } },
  { id: 'whatsapp:1', source: 'whatsapp', kind: 'message', at: T(K, 8), title: 'Chatted with Alex: 2 messages', value: 2, unit: 'messages', tier: 3, meta: { chat: 'Alex' } },
  { id: 'mac:msg:1', source: 'mac', kind: 'message', at: T(K, 15), title: 'Message to +44 7700 900111', tier: 3, meta: { direction: 'out', with: '+44 7700 900111' } },
  // Screens: work in an editor, and a browser.
  { id: 'mac:app:code:1', source: 'mac', kind: 'app', at: T(K, 10, 30), end: T(K, 12), title: 'Used Code for 90 min', value: 90, unit: 'min', tier: 2, meta: { app: 'com.microsoft.VSCode' } },
  { id: 'mac:app:safari:1', source: 'mac', kind: 'app', at: T(K, 21), end: T(K, 21, 30), title: 'Used Safari for 30 min', value: 30, unit: 'min', tier: 2, meta: { app: 'com.apple.Safari' } },
  // The phone's notifications and the Mac's, and Android's unlocks for the day.
  { id: 'android:note:1', source: 'android', kind: 'notification', at: T(K, 9, 30), title: 'WhatsApp: Alex', detail: 'see you at 6', tier: 3, meta: { app: 'WhatsApp' } },
  { id: 'android:note:2', source: 'android', kind: 'notification', at: T(K, 14), title: 'Bank', tier: 3, meta: { app: 'Bank' } },
  { id: 'mac:note:1', source: 'mac', kind: 'notification', at: T(K, 16), title: 'Calendar', tier: 3 },
  { id: `android:unlocks:${K}`, source: 'android', kind: 'app', at: T(K, 0), end: T('2026-10-15', 0), title: 'Unlocked the phone 54 times, first used at 07:12, last at 23:40', value: 54, unit: 'unlocks', tier: 2, meta: { via: 'unlocks', first: T(K, 7, 12), last: T(K, 23, 40) } },
  // Workouts: Arise's, and a run from Health.
  { id: 'arise:workout:1', source: 'arise', kind: 'workout', at: T(K, 7, 30), end: T(K, 8, 20), title: 'Workout: Push', detail: 'Bench press 3x8; Dips 3x10', tier: 1 },
  { id: 'health:workout:1', source: 'health', kind: 'workout', at: T(K, 18, 30), end: T(K, 19), title: 'Running, 5.1 km, 30 min', tier: 2 },
  // Fun, quests and notes.
  { id: 'netflix:1', source: 'netflix', kind: 'watch', at: T(K, 22), title: 'Watched Dark: S1E1', tier: 2 },
  { id: 'arise:quest:1', source: 'arise', kind: 'quest', at: T(K, 20), title: 'Done: Read 10 pages', tier: 1 },
  { id: 'manual:n1', source: 'manual', kind: 'note', at: T(K, 21, 15), title: 'Bought a new lamp', tier: 2 },
];
const OWN = { text: 'A long one.', energy: 3, mood: 4 };

const factsOf = (events: LifeEvent[], own: typeof OWN | null = OWN) => dayFacts(events, K, { signals: signalsFrom(events, K, K, ST)[0], own });
const storyOf = (events: LifeEvent[], own: typeof OWN | null = OWN) => dayStory(factsOf(events, own));

const FULL = [
  'I woke up at 07:10 after 7 h 50 min of sleep.',
  'I walked 8,214 steps.',
  'I went to Gym and Café Nero.',
  'I was in touch with Sam and Alex (1 call, 3 messages).',
  'I spent 1 h 30 min on focused work, out of 2 h on screens.',
  'My phone and Mac showed 3 notifications, and I unlocked my phone 54 times.',
  'I did 2 workouts: push (50 min) and running (30 min).',
  'I watched Dark.',
  'I finished 1 quest.',
  'I wrote 1 note.',
  'My mood was good and my energy was 3 out of 5.',
];

describe("a day's story", () => {
  it('tells a known day in plain sentences, from every source it has', () => {
    expect(storyOf(DAY)).toBe(FULL.join(' '));
  });

  it('says it to "you" when the journal does', () => {
    const s = dayStory(factsOf(DAY), { voice: 'you' });
    expect(s).toContain('You woke up at 07:10 after 7 h 50 min of sleep.');
    expect(s).toContain('You were in touch with Sam and Alex (1 call, 3 messages).');
    expect(s).toContain('Your phone and Mac showed 3 notifications, and you unlocked your phone 54 times.');
    expect(s).toContain('Your mood was good and your energy was 3 out of 5.');
    expect(s).not.toMatch(/\bI\b|\bmy\b/);
  });

  // Each source taken away: its sentence goes, and nothing else changes or is made up.
  const WITHOUT: [string, (e: LifeEvent) => boolean, string, string?][] = [
    ['Health sleep', (e) => e.kind === 'sleep', FULL[0], 'I first used my phone at 07:12.'],
    ['steps', (e) => e.kind === 'steps', FULL[1]],
    ['places', (e) => e.kind === 'place', FULL[2]],
    ['calls and messages', (e) => e.kind === 'call' || e.kind === 'message', FULL[3]],
    ['app use', (e) => e.kind === 'app' && e.unit !== 'unlocks', FULL[4]],
    ['notifications', (e) => e.kind === 'notification', FULL[5], 'I unlocked my phone 54 times.'],
    ['unlocks', (e) => e.unit === 'unlocks', FULL[5], 'My phone and Mac showed 3 notifications.'],
    ['workouts', (e) => e.kind === 'workout', FULL[6]],
    ['shows', (e) => e.kind === 'watch', FULL[7]],
    ['quests', (e) => e.kind === 'quest', FULL[8]],
    ['notes', (e) => e.kind === 'note', FULL[9]],
  ];
  for (const [name, drop, gone, instead] of WITHOUT) {
    it(`leaves out what isn't there: without ${name}`, () => {
      const want = FULL.flatMap((s) => (s === gone ? (instead ? [instead] : []) : [s]));
      expect(storyOf(DAY.filter((e) => !drop(e)))).toBe(want.join(' '));
    });
  }

  it("leaves out the check-in when there's none, and the phone's first use when the night is known", () => {
    const s = storyOf(DAY, null);
    expect(s).not.toContain('mood');
    expect(s).not.toContain('energy');
    expect(s).not.toContain('first used');
  });

  it('says "about" for a night worked out from the devices, and "so far today" for today', () => {
    const f = dayFacts([], K, { signals: { day: K, wake: 450, sleepMin: 433, sleepFrom: 'inferred', tier: { wake: 3, sleepMin: 3 }, from: {} } });
    expect(dayStory(f)).toBe('I woke up around 07:30 after about 7 h 15 min of sleep.');
    expect(dayStory(factsOf(DAY.filter((e) => e.kind === 'steps' || e.unit === 'unlocks'), null), { today: true })).toBe('So far today, I first used my phone at 07:12. I walked 8,214 steps. I unlocked my phone 54 times.');
    expect(dayStory(factsOf(DAY.filter((e) => e.unit === 'unlocks'), null), { today: true, voice: 'you' })).toBe('So far today, you first used your phone at 07:12. You unlocked your phone 54 times.');
  });

  it('says nothing for a day with nothing in it, and claims no feeling or reason', () => {
    expect(storyOf([], null)).toBe('');
    const s = storyOf(DAY);
    expect(s).not.toMatch(/\u2014|\u2013|because|only|great|well done|too much|felt/i);
  });

  it('keeps what has no time to it apart, without the unlocks it already said', () => {
    const f = factsOf([...DAY, { id: 'calendar:hol', source: 'calendar', kind: 'event', at: T(K, 0), end: T('2026-10-15', 0), title: 'Bank holiday', tier: 2, meta: { allDay: true } }]);
    expect(f.aside).toBe('All day: Bank holiday.');
  });
});

describe('Write it better', () => {
  const facts = factsOf(DAY);

  it('needs an AI that may read the most private part of the day', () => {
    expect(storyTier(facts)).toBe(3);
    expect(mayWrite(facts, 3)).toBe(true);
    expect(mayWrite(facts, 1)).toBe(false);
    expect(mayWrite(facts, 0)).toBe(false);
    // A day of quests and a check-in only: any AI may.
    const plain = factsOf(DAY.filter((e) => e.kind === 'quest'));
    expect(storyTier(plain)).toBe(1);
    expect(mayWrite(plain, 1)).toBe(true);
  });

  it("never asks an AI that may not read it, and sends only the day's story", async () => {
    const write = vi.fn(async () => '"I woke at 07:10 \u2014 and walked 8,214 steps."');
    await expect(writeBetter(facts, { cap: 1, write })).rejects.toMatchObject({ code: 'tier' });
    expect(write).not.toHaveBeenCalled();
    await expect(writeBetter(dayFacts([], K), { cap: 3, write })).rejects.toMatchObject({ code: 'empty' });
    expect(write).not.toHaveBeenCalled();

    expect(await writeBetter(facts, { cap: 3, write })).toBe('I woke at 07:10, and walked 8,214 steps.');
    const prompt = (write.mock.calls[0] as unknown as [string])[0];
    expect(prompt).toBe(betterPrompt(FULL.join(' '), 'first'));
    expect(prompt).toContain('Add nothing');
    expect(prompt).not.toContain('see you at 6'); // what a notification said never goes
    expect(prompt).not.toContain('Bought a new lamp'); // nor what a note says
  });

  it('cleans what comes back', () => {
    expect(cleanBetter('  “A slow day \u2014 mostly at home.”  ')).toBe('A slow day, mostly at home.');
  });
});

describe('a month and a year', () => {
  const ev = (id: string, k: string, extra: Partial<LifeEvent> = {}): LifeEvent => ({ id, source: 'manual', kind: 'note', at: T(k), title: 'x', tier: 2, ...extra });
  const events: LifeEvent[] = [
    ...['01', '01', '01', '02', '02', '05'].map((d, i) => ev(`n${i}`, `2026-10-${d}`)),
    ev('p1', '2026-10-03', { source: 'maps', kind: 'place', title: 'At Gym', meta: { place: 'Gym' }, tier: 3 }),
    ev('p2', '2026-10-04', { source: 'maps', kind: 'place', title: 'At Gym', meta: { place: 'Gym' }, tier: 3 }),
    ev('p3', '2026-10-04', { source: 'maps', kind: 'place', title: 'At Park', meta: { place: 'Park' }, tier: 3 }),
    ev('c1', '2026-10-06', { source: 'android', kind: 'call', title: 'Call from Sam (5 min)', value: 5, unit: 'min', meta: { name: 'Sam', number: '07700 900111' }, tier: 3 }),
    ev('arise:goal:g1', '2026-10-07', { source: 'arise', kind: 'event', title: 'New goal: Run a 10K', tier: 1 }),
    ev('arise:milestone:g1:m1', '2026-10-20', { source: 'arise', kind: 'event', title: 'Milestone reached: Ran 5K', tier: 1 }),
  ];
  const day = (n: number, r: Partial<DayRow>): DayRow => ({ day: `2026-10-${String(n).padStart(2, '0')}`, ...r });
  const rows = [
    day(1, { sleepMin: 450, steps: 9000, trained: true, due: 2, done: 2, mood: 4 }),
    day(2, { sleepMin: 420, steps: 7000, trained: false, due: 2, done: 1, mood: 3 }),
    day(3, { sleepMin: 480, steps: 8000, trained: true, due: 2, done: 2, mood: 4 }),
  ];
  const prev = [day(1, { sleepMin: 400, steps: 8000, trained: true }), day(2, { sleepMin: 410, steps: 8100 }), day(3, { sleepMin: 390, steps: 7900 })];

  it('says the busiest days, places, people, sleep and steps next to the one before, training, quests, goals and milestones', () => {
    const s = spanStory({ span: 'month', before: 'September 2026', tally: tallyOf(events), rows, prev });
    expect(s).toBe(
      [
        'The busiest days were Thursday 1 October, Friday 2 October and Sunday 4 October.',
        'The places that came up most: Gym and Park.',
        'I was in touch most with Sam.',
        "I slept 7 h 30 min a night, over 3 nights. That's 50 min more than in September 2026.",
        'I walked 8,000 steps a day, over 3 days. About the same as in September 2026.',
        'I trained on 2 days. In September 2026 it was 1.',
        'I finished 5 of 6 quests due.',
        'I set a new goal: Run a 10K.',
        'I reached a milestone: Ran 5K.',
        'My mood averaged 3.7 out of 5, over 3 days.',
      ].join(' '),
    );
  });

  it("leaves out what isn't known, and compares only with enough days before", () => {
    const s = spanStory({ span: 'year', before: '2025', tally: tallyOf([]), rows: rows.map((r) => ({ day: r.day, sleepMin: r.sleepMin })), prev: [] }, { voice: 'you' });
    expect(s).toBe('You slept 7 h 30 min a night, over 3 nights.');
    expect(spanStory({ span: 'year', before: '2025', tally: tallyOf([]), rows: [], prev: [] })).toBe('');
  });
});

