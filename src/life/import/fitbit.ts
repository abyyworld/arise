// Fitbit: the "Fitbit" folder of a Google Takeout ("Global Export Data"), or the older export
// from the Fitbit account (MyFitbitData/…/Physical Activity, Sleep). Read from these files:
//   steps-2024-01-01.json               [{ "dateTime": "01/01/24 00:01:00", "value": "12" }, …] (a minute each)
//   resting_heart_rate-2024-01-01.json  [{ "dateTime": "01/01/24 00:00:00", "value": { "date": "01/01/24", "value": 58.2, "error": 6.8 } }]
//   sleep-2024-01-01.json               [{ "logId": 1, "dateOfSleep": "2024-01-02", "startTime": "2024-01-01T23:10:00.000",
//                                          "endTime": "2024-01-02T07:00:00.000", "minutesAsleep": 420, "mainSleep": true }]
// The events are the same kinds Apple Health makes (health.ts): a day of steps, a day's resting
// heart rate, and each sleep. Minute times are in UTC (Fitbit writes them so); sleep times are the
// clock where it happened.

import type { LifeEvent } from '../types';
import type { Parts } from './chat';
import { isObj } from './chat';
import { JsonItems } from './json-stream';
import { baseName } from './notes';
import { DAY, dayOf, drain, duration, hashId, int, localMs } from './util';

export const FITBIT_FILE = /(^|\/)(steps|sleep|resting_heart_rate)-\d{4}-\d{2}-\d{2}\.json$/i;
export const FITBIT_HEAD = /"(dateTime|dateOfSleep|logId)"\s*:/;

// "01/31/24 23:59:00": month, day and a two-digit year, in UTC.
function fitbitTime(v: unknown): number {
  const m = typeof v === 'string' && v.match(/^(\d{2})\/(\d{2})\/(\d{2,4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return Date.UTC(y, +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
}

// "01/31/24" → "2024-01-31".
function fitbitDay(v: unknown): string {
  const m = typeof v === 'string' && v.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return '';
  return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1]}-${m[2]}`;
}

// "2024-01-01T23:10:00.000" on the clock where it happened (read on this device's clock).
function wallTime(v: unknown): number {
  const m = typeof v === 'string' && v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? localMs(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN;
}

const startOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return localMs(y, m, d, 0);
};

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);

export async function* parseFitbit(parts: Parts): AsyncGenerator<LifeEvent[]> {
  const steps = new Map<string, number>(); // day → steps
  const resting = new Map<string, number>(); // day → bpm
  const out: LifeEvent[] = [];
  for await (const p of parts) {
    const kind = baseName(p.name).toLowerCase().replace(/-\d{4}-\d{2}-\d{2}\.json$/, '');
    const items = new JsonItems();
    const take = (v: unknown) => {
      if (!isObj(v)) return;
      if (kind === 'steps') {
        const at = fitbitTime(v.dateTime);
        const n = num(v.value);
        if (Number.isFinite(at) && n > 0) steps.set(dayOf(at), (steps.get(dayOf(at)) ?? 0) + n);
      } else if (kind === 'resting_heart_rate') {
        const r = isObj(v.value) ? v.value : null;
        const day = fitbitDay(r?.date) || (Number.isFinite(fitbitTime(v.dateTime)) ? dayOf(fitbitTime(v.dateTime)) : '');
        const bpm = num(r?.value);
        if (day && bpm > 0) resting.set(day, bpm);
      } else if (kind === 'sleep') {
        const e = sleepEvent(v);
        if (e) out.push(e);
      }
    };
    for await (const chunk of p.text) {
      for (const it of items.push(chunk)) take(it.value);
      yield* drain(out);
    }
  }
  for (const [day, n] of steps) {
    const at = startOf(day);
    if (!Number.isFinite(at)) continue;
    out.push({ id: `health:fitbit:steps:${day}`, source: 'health', kind: 'steps', at, end: at + DAY, title: `${int(n)} steps`, value: Math.round(n), unit: 'steps', tier: 2, meta: { day, from: 'Fitbit' } });
    yield* drain(out);
  }
  for (const [day, bpm] of resting) {
    const at = startOf(day);
    if (!Number.isFinite(at)) continue;
    out.push({ id: `health:fitbit:resting-hr:${day}`, source: 'health', kind: 'health', at, end: at + DAY, title: `Resting heart rate ${int(bpm)} bpm`, value: Math.round(bpm), unit: 'bpm', tier: 3, meta: { day, from: 'Fitbit' } });
    yield* drain(out);
  }
  yield* drain(out, true);
}

// One sleep: "Slept 7 h", or "Napped 40 min" when it wasn't the night's main sleep. Sleep is
// sensitive, so it's at the tier the life log gives it anyway (tiers.ts).
export function sleepEvent(v: Record<string, unknown>): LifeEvent | null {
  const at = wallTime(v.startTime);
  let end = wallTime(v.endTime);
  let min = num(v.minutesAsleep);
  if (!Number.isFinite(at)) return null;
  if (!(end > at)) end = at + num(v.duration);
  if (!(min > 0)) min = (end - at) / 60_000;
  if (!(end > at) || !(min >= 1) || end - at > DAY) return null;
  const day = typeof v.dateOfSleep === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.dateOfSleep) ? v.dateOfSleep : dayOf(end);
  const nap = v.mainSleep === false;
  const id = typeof v.logId === 'number' || typeof v.logId === 'string' ? String(v.logId) : hashId(at, end);
  return {
    id: `health:fitbit:sleep:${id}`,
    source: 'health',
    kind: 'sleep',
    at,
    end,
    title: `${nap ? 'Napped' : 'Slept'} ${duration(min)}`,
    value: Math.round(min),
    unit: 'min',
    tier: 3,
    meta: { day, from: 'Fitbit' },
  };
}
