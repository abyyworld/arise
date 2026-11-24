// @vitest-environment jsdom
// Looking ahead on screen: the plan and the early warnings on Today, putting a warning away, the
// check-back on a decision, deciding with Arise's advice on Coach, the settings for next-step
// messages, and the messages planned on the phone.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(data: object = {}, view = 'today') {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, ...data }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const S = await import('./store');
  await import('./app.js');
  return { S, AI: await import('./ai.js'), N: await import('./native.js'), AH: await import('./ahead') };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const tap = async (sel: string) => {
  $(sel)!.click();
  await new Promise((r) => setTimeout(r, 0));
};
const NOW = new Date(2026, 10, 24, 7, 0); // Tuesday 24 November 2026, 7:00

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

const GOAL = {
  id: 'g1',
  title: 'Pass the exam',
  category: 'learning',
  why: '',
  by: '',
  created: '2026-11-01',
  updated: 1,
  status: 'active',
  quests: [{ id: 'q1', title: 'Study maths', schedule: { kind: 'daily' }, amount: { target: 45, unit: 'min' }, created: '2026-11-01' }],
  measures: [],
  milestones: [{ id: 'm1', title: 'Mock test', due: '2026-11-26' }],
};

describe('looking ahead on Today', () => {
  it('shows the plan and a deadline warning, which can be put away and stays away', async () => {
    const { S } = await boot({ goals: [GOAL], todos: { t1: { id: 't1', title: 'Call the bank', day: '2026-11-24', created: 1, at: 1 } } });
    expect(text('#aheadPlan')).toContain('Your plan');
    expect(text('#aheadPlan')).toContain('Study maths');
    expect(text('#aheadPlan')).toContain('Work on: Mock test');
    expect(text('#aheadPlan')).toContain('Call the bank');
    expect(text('#aheadWarn')).toContain('Mock test is due in 2 days');
    const id = $('[data-act="ahead-dismiss"]')!.dataset.id!;
    await tap('[data-act="ahead-dismiss"]');
    expect($('#aheadWarn')).toBeNull();
    expect(S.state.dismissed[id]).toBe(NOW.getTime());
  });

  it('plans again when the day changes, and says what moved', async () => {
    const { S } = await boot({ goals: [GOAL] });
    const before = text('#aheadPlan');
    expect(before).not.toContain('changed');
    S.addEvent({ title: 'Dentist', start: '2026-11-24T08:00', end: '2026-11-24T10:00', tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    expect(text('#aheadPlan')).toContain('Your day changed, so the plan did too.');
    expect(text('#aheadPlan')).toContain('Dentist at 08:00 is new or moved in your calendar.');
    await tap('[data-act="ahead-seen"]');
    expect(text('#aheadPlan')).not.toContain('Your day changed');
  });

  it('shows the week', async () => {
    await boot({ goals: [GOAL] });
    await tap('[data-act="ahead-week"]');
    expect(text('.ahead-sheet')).toContain('This week');
    expect(document.querySelectorAll('.ahead-days > li')).toHaveLength(7);
  });

  it('asks how a decision went on its day', async () => {
    const { S } = await boot({ decisions: { d1: { id: 'd1', question: 'Take the job?', options: [], chose: 'Take it', checkOn: '2026-11-24', created: 1, at: NOW.getTime() } } });
    expect(text('#aheadBack')).toContain('Take the job?');
    await tap('[data-act="decision-outcome"][data-v="better"]');
    expect(S.state.decisions.d1.outcome).toBe('better');
    expect($('#aheadBack')).toBeNull();
  });
});

describe('deciding on Coach', () => {
  it('lays out the options with the pick, and saves what they chose with a day to check back', async () => {
    const { S, AI } = await boot({}, 'coach');
    vi.spyOn(AI, 'ready').mockReturnValue(true);
    const advise = vi.spyOn(AI, 'adviseDecision').mockResolvedValue({
      options: [
        { name: 'Take it', costs: 'Longer days', gains: 'Your career goal' },
        { name: 'Stay', costs: 'Slower growth', gains: 'Time with family' },
      ],
      pick: 'Take it',
      why: 'It moves your main goal.',
      unknown: 'The team.',
      tier: 1,
    });
    await tap('[data-act="decide-new"]');
    ($('#decQ') as HTMLTextAreaElement).value = 'Take the job?';
    $('form[data-form="decide-ask"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(text('#decOut')).toContain('Arise would pick this'));
    expect(advise).toHaveBeenCalledWith('Take the job?', '', expect.anything());
    (document.querySelectorAll('input[name="decChose"]')[1] as HTMLInputElement).checked = true;
    ($('#decExpect') as HTMLInputElement).value = 'More calm';
    ($('#decWeeks') as HTMLSelectElement).value = '2';
    $('form[data-form="decide-save"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const [d] = S.decisionsList();
    expect(d).toMatchObject({ question: 'Take the job?', chose: 'Stay', pick: 'Take it', expect: 'More calm', checkOn: '2026-12-08' });
    expect(text('#decideCard')).toContain('Your decisions (1)');
    await tap('[data-act="decide-list"]');
    await tap('[data-act="decision-open"]');
    await tap('[data-act="decision-del"]');
    expect(S.decisionsList()).toEqual([]);
  });
});

describe('next-step messages', () => {
  it('can be set, and are planned on the phone within the quiet hours rule', async () => {
    const { S, N } = await boot({ goals: [GOAL] }, 'settings');
    const sel = $('#aheadSettings select[data-set="nudges"]') as HTMLSelectElement;
    sel.value = '3';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(S.state.settings.nudges).toBe(3);
    const quiet = $('#aheadSettings input[data-set="quietTo"]') as HTMLInputElement;
    quiet.value = '09:00';
    quiet.dispatchEvent(new Event('change', { bubbles: true }));
    expect(S.state.settings.quietTo).toBe('09:00');
    const list = N.upcoming(new Date()).filter((n) => n.id >= 8000 && n.id < 9000);
    expect(list.length).toBeGreaterThan(0);
    for (const n of list) {
      const h = n.at.getHours();
      expect(h >= 9 && h < 22).toBe(true);
      expect(n.title + n.body).not.toContain('Mock test');
    }
  });
});
