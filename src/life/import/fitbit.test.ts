import { describe, expect, it } from 'vitest';
import { importAll, zipAt } from './notes-fixtures';
import { classify } from './index';
import { sleepEvent } from './fitbit';

const ZIPPED = new Date(2024, 5, 1, 8, 0, 0);
const DAY = 86_400_000;

const stepsJan1 = JSON.stringify([
  { dateTime: '01/01/24 08:00:00', value: '100' },
  { dateTime: '01/01/24 09:00:00', value: '50' },
  { dateTime: '01/02/24 10:00:00', value: '0' },
  { dateTime: '01/02/24 10:01:00', value: '7' },
  { dateTime: 'broken', value: '9' },
]);
const stepsJan2 = JSON.stringify([{ dateTime: '01/02/24 11:00:00', value: '3' }]);
const resting = JSON.stringify([
  { dateTime: '01/01/24 00:00:00', value: { date: '01/01/24', value: 58.4, error: 6.8 } },
  { dateTime: '01/02/24 00:00:00', value: { date: '01/02/24', value: 0, error: 0 } },
]);
const sleep = JSON.stringify([
  { logId: 111, dateOfSleep: '2024-01-02', startTime: '2024-01-01T23:10:00.000', endTime: '2024-01-02T07:00:00.000', duration: 28_200_000, minutesAsleep: 420, mainSleep: true },
  { logId: 112, dateOfSleep: '2024-01-02', startTime: '2024-01-02T14:00:00.000', endTime: '2024-01-02T14:40:00.000', duration: 2_400_000, minutesAsleep: 38, mainSleep: false },
  { logId: 113, dateOfSleep: '2024-01-03', startTime: 'never' },
]);

describe('Fitbit', () => {
  it('reads a sleep the way Apple Health sleeps are kept', () => {
    expect(sleepEvent(JSON.parse(sleep)[0])).toEqual({
      id: 'health:fitbit:sleep:111',
      source: 'health',
      kind: 'sleep',
      at: Date.UTC(2024, 0, 1, 23, 10),
      end: Date.UTC(2024, 0, 2, 7),
      title: 'Slept 7 h',
      value: 420,
      unit: 'min',
      tier: 3,
      meta: { day: '2024-01-02', from: 'Fitbit' },
    });
    expect(sleepEvent(JSON.parse(sleep)[2])).toBeNull();
  });

  it('reads a Takeout’s Fitbit folder: a day of steps from every file, resting heart rate, and each sleep', async () => {
    const zip = zipAt(
      {
        'Takeout/Fitbit/Global Export Data/steps-2024-01-01.json': stepsJan1,
        'Takeout/Fitbit/Global Export Data/steps-2024-01-02.json': stepsJan2,
        'Takeout/Fitbit/Global Export Data/resting_heart_rate-2024-01-01.json': resting,
        'Takeout/Fitbit/Global Export Data/sleep-2024-01-02.json': sleep,
        'Takeout/Fitbit/Global Export Data/heart_rate-2024-01-01.json': '[]',
      },
      ZIPPED,
      'takeout.zip',
    );
    const { detection, events, result } = await importAll(zip);
    expect(detection.found.map((f) => [f.kind, f.label, f.parts?.length])).toEqual([['fitbit', 'Fitbit', 4]]);
    expect(result.labels).toEqual(['Fitbit']);
    expect(events.map((e) => [e.id, e.title, e.at, e.end, e.value])).toEqual([
      ['health:fitbit:steps:2024-01-01', '150 steps', Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 1) + DAY, 150],
      ['health:fitbit:resting-hr:2024-01-01', 'Resting heart rate 58 bpm', Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 1) + DAY, 58],
      ['health:fitbit:sleep:111', 'Slept 7 h', Date.UTC(2024, 0, 1, 23, 10), Date.UTC(2024, 0, 2, 7), 420],
      ['health:fitbit:steps:2024-01-02', '10 steps', Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 2) + DAY, 10],
      ['health:fitbit:sleep:112', 'Napped 38 min', Date.UTC(2024, 0, 2, 14), Date.UTC(2024, 0, 2, 14, 40), 38],
    ]);
    expect(events.find((e) => e.kind === 'health')?.tier).toBe(3);
    expect(events.filter((e) => e.kind === 'steps').every((e) => e.meta?.day && e.unit === 'steps')).toBe(true);
  });

  it('knows one Fitbit file chosen on its own', () => {
    expect(classify('sleep-2024-01-02.json', sleep, false)).toBe('fitbit');
    expect(classify('steps-2024-01-01.json', stepsJan1, false)).toBe('fitbit');
    expect(classify('other.json', stepsJan1, false)).toBeNull();
  });
});
