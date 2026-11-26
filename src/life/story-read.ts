// Reads what a story is made from (story.ts), on this device: a day's events, notifications and
// signals, or a month's or a year's tally with its days and the one before. Nothing is kept or sent.

import * as S from '../store';
import * as L from './log';
import * as M from './memory';
import { dayEnd, dayKey, dayStart } from './dates';
import { daySignals } from './signals';
import { rowsFrom } from './rows';
import { daysOf, step, type Span, type Tally } from './lookback';
import { dayFacts, dayStory, spanStory, type DayFacts } from './story';
import type { LifeEvent } from './types';
import type { Voice } from './diary';

const HOUR = 3600e3;

export interface DayStory {
  facts: DayFacts;
  text: string; // '' when Arise saw nothing that day
}

// A day's story, in the voice the Player picked for their journal.
export async function dayStoryOf(k: string, { voice = M.journalVoice() }: { voice?: Voice } = {}): Promise<DayStory> {
  const [events, notes, sig] = await Promise.all([
    M.journalEvents(k), // the day and its night's sleep, places with the names they gave them
    L.eventsBetween(dayStart(k), dayEnd(k), { kinds: ['notification'], limit: 100000 }).catch(() => [] as LifeEvent[]),
    daySignals(k, k)
      .then((x) => x[0] || null)
      .catch(() => null),
  ]);
  const facts = dayFacts([...events, ...notes], k, { signals: sig, own: M.journalOwn(k) });
  return { facts, text: dayStory(facts, { voice, today: k === dayKey(Date.now()) }) };
}

// A month's or a year's days as rows (sleep, steps, training, mood, quests), read only for what
// those need, so a year of browsing is never read for it. Never past today.
async function rowsOf(span: Span, key: string) {
  const { first, last } = daysOf(span, key);
  const to = last > dayKey(Date.now()) ? dayKey(Date.now()) : last;
  if (to < first) return [];
  let events: LifeEvent[] = [];
  try {
    events = await L.eventsBetween(dayStart(first) - 12 * HOUR, dayEnd(to), { kinds: ['sleep', 'steps', 'workout', 'mood'], limit: 100000 });
  } catch {
    events = [];
  }
  return rowsFrom(events, first, to, S.state);
}

// What a month or a year says about itself, next to the one before.
export async function spanStoryOf(span: 'month' | 'year', key: string, tally: Tally, { voice = M.journalVoice(), before }: { voice?: Voice; before: string }): Promise<string> {
  const prevKey = step(span, key, -1);
  const [rows, prev] = await Promise.all([rowsOf(span, key), rowsOf(span, prevKey)]);
  return spanStory({ span, before, tally, rows, prev }, { voice });
}

