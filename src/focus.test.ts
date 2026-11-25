// @vitest-environment jsdom
// Focus (focus.ts, focus-ui.js): a timed block that survives a reload, pauses, ends with a
// notification, and ticks the quest or the to-do when it's done.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const T0 = new Date(2026, 10, 25, 9, 0).getTime();
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  document.body.innerHTML = '<main id="app"><div id="focusBar"></div></main><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div>';
});
afterEach(() => vi.useRealTimers());

describe('the focus timer', () => {
  it('counts down, pauses, and plans one plain notification for its end', async () => {
    vi.resetModules();
    const F = await import('./focus');
    expect(F.current()).toBeNull();
    const f = F.start('Essay draft', 25, 'q:q1', T0);
    expect(F.left(f, T0 + 60_000)).toBe(24 * 60_000);
    expect(F.clock(F.left(f, T0 + 61_500))).toBe('23:59');
    expect(F.nudges(T0)).toEqual([{ at: T0 + 25 * 60_000, title: 'Focus time is up', body: 'Your 25 minutes are up. Take a short break.', tag: `focus-${T0}` }]);
    // Paused for 5 minutes: it ends 5 minutes later, and plans nothing while paused.
    F.pause(T0 + 10 * 60_000);
    expect(F.nudges(T0 + 12 * 60_000)).toEqual([]);
    F.resume(T0 + 15 * 60_000);
    expect(F.endsAt(F.current()!, T0 + 16 * 60_000)).toBe(T0 + 30 * 60_000);
    expect(F.done(F.current()!, T0 + 30 * 60_000)).toBe(true);
    // Stopped after 20 minutes of work.
    expect(F.stop(T0 + 25 * 60_000)).toMatchObject({ ran: 20 });
    expect(F.current()).toBeNull();
  });

  it('starts from the plan, shows the bar, and ticks the quest when stopped', async () => {
    vi.resetModules();
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, goals: [{ id: 'g1', title: 'Learn', category: 'learning', why: '', by: '', created: '2026-11-01', updated: 1, status: 'active', quests: [{ id: 'q1', title: 'Study maths', schedule: { kind: 'daily' }, created: '2026-11-01' }], measures: [], milestones: [] }] }));
    const S = await import('./store');
    const UI = await import('./focus-ui.js');
    const replan = vi.fn();
    UI.initFocus({ replan });
    const btn = document.createElement('button');
    Object.assign(btn.dataset, { title: 'Study maths', min: '45', task: 'q:q1' });
    UI.handleAction('focus-start', btn);
    expect((document.querySelector('#focusTitle') as HTMLInputElement).value).toBe('Study maths');
    expect(document.querySelector('.focus-sheet [data-v="45"]')!.getAttribute('aria-pressed')).toBe('true');
    document.querySelector('[data-form="focus-go"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(replan).toHaveBeenCalled();
    document.querySelector('#focusBar')!.outerHTML = UI.bar();
    expect(document.querySelector('#focusBar')!.textContent).toContain('45:00');
    vi.setSystemTime(T0 + 30 * 60_000);
    UI.handleAction('focus-stop', null);
    const sheet = document.querySelector('.sheet-body')!.textContent!;
    expect(sheet).toContain('30 minutes on Study maths.');
    const tick = document.querySelector<HTMLElement>('[data-act="focus-tick"]')!;
    UI.handleAction('focus-tick', tick);
    expect(S.state.checks['2026-11-25']?.q1?.done).toBe(true);
  });
});
