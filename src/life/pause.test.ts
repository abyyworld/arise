// @vitest-environment jsdom
// Pause everything (pause.ts, pause-ui.ts): kept in the synced settings, what happened during it
// left out, the Android app reading nothing and its recorders told, and the card on Today.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 23, 12, 0).getTime();

async function load() {
  vi.resetModules();
  const S = await import('../store');
  const PAUSE = await import('./pause');
  return { S, PAUSE };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div><div id="toast"></div>';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('the switch', () => {
  it('pauses for an hour, in the settings that sync, and turns back on', async () => {
    const { S, PAUSE } = await load();
    expect(PAUSE.isPaused()).toBe(false);
    const told = vi.fn();
    PAUSE.onPauseChange(told);
    PAUSE.pause(HOUR);
    expect(S.state.settings.pauses).toEqual([[NOW, NOW + HOUR]]);
    expect(PAUSE.isPaused()).toBe(true);
    expect(PAUSE.pausedUntil()).toBe(NOW + HOUR);
    expect(JSON.parse(localStorage.getItem('pit-data-v1')!).settings.pauses).toEqual([[NOW, NOW + HOUR]]);
    expect(PAUSE.isPaused(NOW + 2 * HOUR)).toBe(false);
    vi.setSystemTime(NOW + HOUR / 2);
    PAUSE.resume();
    expect(PAUSE.isPaused()).toBe(false);
    expect(told).toHaveBeenCalledTimes(2);
    // What happened in that half hour stays out, also when it's read later.
    expect(PAUSE.unpaused([{ at: NOW + 60_000 }, { at: NOW + HOUR }])).toEqual([{ at: NOW + HOUR }]);
  });

  it('pauses until turned back on', async () => {
    const { PAUSE } = await load();
    PAUSE.pause(0);
    expect(PAUSE.pausedUntil()).toBe(PAUSE.FOREVER);
    expect(PAUSE.isPaused(NOW + 1000 * HOUR)).toBe(true);
  });
});

describe('the Android app while paused', () => {
  it('reads nothing, and tells the phone until when', async () => {
    const log: { method: string; options: Record<string, unknown> }[] = [];
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      PluginHeaders: [{ name: 'AriseLife' }],
      nativePromise: async (_p: string, method: string, options: Record<string, unknown> = {}) => {
        log.push({ method, options });
        return {};
      },
    };
    localStorage.setItem('arise-android-sense', JSON.stringify({ on: { calls: true } }));
    const { PAUSE } = await load();
    (await import('./store-port')).setLifeStore({ addEvents: async (e) => e.length });
    const A = await import('./android-sense');
    PAUSE.pause(HOUR);
    expect(await A.collect()).toBe(0);
    expect(log.map((l) => l.method)).toEqual(['setPause']);
    expect(log[0].options).toEqual({ until: NOW + HOUR });
  });
});

describe('on screen', () => {
  it('shows a card on Today only while paused, and turns back on from it', async () => {
    const { PAUSE } = await load();
    const UI = await import('./pause-ui');
    const app = document.getElementById('app')!;
    app.innerHTML = UI.todayCard() + UI.pausePanel();
    expect(document.querySelector('#pauseToday')!.textContent!.trim()).toBe('');
    const forHour = document.querySelector<HTMLElement>('[data-act="pause-for"]')!;
    expect(forHour.textContent).toBe('For 1 hour');
    expect(UI.handleAction('pause-for', forHour)).toBe(true);
    expect(PAUSE.isPaused()).toBe(true);
    expect(document.querySelector('#pauseToday')!.textContent).toMatch(/Paused until/);
    expect(document.querySelector('#pausePanel')!.textContent).toMatch(/Turn back on/);
    expect(UI.handleAction('pause-end', document.querySelector<HTMLElement>('#pauseToday [data-act="pause-end"]')!)).toBe(true);
    expect(PAUSE.isPaused()).toBe(false);
    expect(document.querySelector('#pauseToday')!.textContent!.trim()).toBe('');
    expect(UI.handleAction('lock-toggle', document.body)).toBe(false);
  });

  it('says "until you turn it back on"', async () => {
    const { PAUSE } = await load();
    const UI = await import('./pause-ui');
    PAUSE.pause(0);
    expect(UI.todayCard()).toContain('until you turn it back on');
  });
});
