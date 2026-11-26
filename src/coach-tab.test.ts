// @vitest-environment jsdom
// The Coach tab: quick actions about the whole of life, each looking up the right stretch of the
// life log; the workout plan's button only with the plan; a quest bar that welcomes talk; and
// small print that says what the coach reads. Its chats: making, switching, renaming, deleting and
// forgetting them all, and "Ask how I'm doing".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

// Each boot starts the whole app again: the listeners the last one added go first.
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

// Starts the app on `view` with this saved data and one AI key the Player said yes to.
async function boot(view: string, data: object = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem("arise-tabs-shown", JSON.stringify(["goals", "coach"])); // the full tab bar (tabs.js)
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { name: 'Sam', onboarded: true }, ...data, settings: { aiEngine: 'own', ...((data as { settings?: object }).settings || {}) } }));
  localStorage.setItem('arise-ai-keys', JSON.stringify([{ id: 'k1', key: 'gsk_aaaa1111', provider: 'groq', model: 'llama-3.3-70b-versatile' }]));
  localStorage.setItem('arise-ai-consent', 'groq');
  localStorage.setItem('arise-version-seen', version); // no "What's new" on top
  localStorage.setItem('arise-look-hint', 'seen');
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  await import('./app.js');
  const AI = await import('./ai.js');
  const SYS = await import('./system.js');
  return { AI, SYS };
}
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const text = (sel: string) => ($(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
const tick = () => new Promise((r) => setTimeout(r, 0));
const tap = async (sel: string) => {
  $(sel)!.click();
  await tick();
  await tick();
};

const PLAN = [{ id: 'g1', title: 'Get strong', category: 'fitness', workouts: true, quests: [] }];
const READING = [{ id: 'g2', title: 'Read more', category: 'learning', quests: [{ id: 'q1', title: 'Read 10 pages', schedule: { kind: 'daily' }, created: '2026-10-01' }] }];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12)); // Friday 9 October 2026
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the Coach tab', () => {
  it('offers quick actions about the whole of life, and the workout plan only to people who use it', async () => {
    await boot('coach');
    expect($$('.quick [data-act="ai-quick"]').map((b) => b.textContent!.trim())).toEqual([
      'Review my week',
      'What helps me?',
      'Deep review of everything all data',
      'What would help me most?',
      'Is my goal right for me?',
      'Hard day',
      'Busy week',
      'I missed days',
      'Walk me through today',
    ]);
    expect($('.quick [data-v="plan"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Personalise my workout plan');

    await boot('coach', { goals: PLAN });
    expect(text('.quick [data-v="plan"]')).toBe('Personalise my workout plan →');
  });

  it('welcomes any question in an empty chat', async () => {
    await boot('coach');
    expect(text('.chat-empty p:not(.sys-line)')).toBe(
      "Ask me anything: your goals, your days or what's on your mind. I look at the whole picture: what Arise sees in your days (sleep, movement, focus, people), your goals, quests and workouts, and your life log as far as your privacy settings let this AI read it.",
    );
  });

  it("doesn't push quests: no goal is fine in the Arise look, and the System look keeps its push", async () => {
    await boot('coach');
    expect(text('.banner b')).toBe('No goal right now.');
    expect(text('.banner small')).toBe("That's fine. Ask me anything, or set one when you're ready.");
    expect(text('.banner .go')).toBe('Goals →');

    await boot('coach', { goals: READING });
    expect(text('.quest-bar b')).toBe("Today's quest: Read 10 pages");
    expect(text('.quest-bar small')).toBe("Still open today. Whenever you're ready.");

    await boot('coach', { goals: READING, settings: { look: 'system' } });
    expect(text('.quest-bar small')).toBe('Not done yet. Doing beats talking.');

    await boot('coach', { settings: { look: 'system' } });
    expect(text('.banner b')).toBe('No quests yet.');
  });

  it('looks up the right stretch of the life log for each quick action', async () => {
    const { AI } = await boot('coach');
    const chat = vi.spyOn(AI, 'chat').mockResolvedValue('Noted.');
    await tap('[data-act="ai-quick"][data-i="1"]');
    expect(chat).toHaveBeenLastCalledWith(expect.stringContaining('what goes with my good days and my hard days?'), expect.objectContaining({ full: false, recallAs: 'the last 6 weeks' }));
    await tap('[data-act="ai-quick"][data-i="2"]');
    expect(chat).toHaveBeenLastCalledWith(expect.stringContaining('Do a deep review of everything you know about me'), expect.objectContaining({ full: true, recallAs: 'the last 3 months' }));
    await tap('[data-act="ai-quick"][data-i="5"]');
    expect(chat).toHaveBeenLastCalledWith(expect.stringContaining('Today is hard.'), expect.objectContaining({ recallAs: 'the last 2 days' }));
    // Without one, the question's own words are looked up.
    await tap('[data-act="ai-quick"][data-i="6"]');
    expect(chat.mock.lastCall![1]).not.toHaveProperty('recallAs');
    await tap('[data-act="ai-quick"][data-i="8"]');
    expect(chat).toHaveBeenLastCalledWith(expect.stringContaining("Arise's plan for today"), expect.objectContaining({ recallAs: 'the last 2 days' }));
  });

  it('passes a question from another screen on with what to look up, and says when the coach is busy', async () => {
    const { AI, SYS } = await boot('today');
    let answer: (t: string) => void = () => {};
    const chat = vi.spyOn(AI, 'chat').mockImplementation(() => new Promise((r) => (answer = r)));
    expect(SYS.askCoach('Arise noticed: something. What do you make of it?', { recallAs: 'the last 6 weeks' })).toBe(true);
    expect(location.hash).toBe('#coach');
    expect(chat).toHaveBeenCalledWith('Arise noticed: something. What do you make of it?', expect.objectContaining({ recallAs: 'the last 6 weeks' }));
    expect(SYS.askCoach('And another thing?')).toBe(false);
    expect(text('#toast')).toBe('Your coach is still answering. Try again in a moment.');
    answer('Done.');
    await tick();
  });

  it('asks about a pattern from the life log only with an AI that may read it, and says so otherwise', async () => {
    const { AI, SYS } = await boot('today');
    const chat = vi.spyOn(AI, 'chat').mockResolvedValue('Noted.');
    // Your own keys, with the life log kept from them.
    vi.spyOn(AI, 'lifeCap').mockReturnValue(1);
    expect(SYS.askCoach('Arise noticed: you sleep less after late nights.', { recallAs: 'the last 6 weeks', about: 3 })).toBe(false);
    expect(chat).not.toHaveBeenCalled();
    expect(location.hash).toBe('#today');
    expect(text('#toast')).toBe("Your coach can't read this with the AI you use now. The private AI can, or you can let less private AIs read your life log in What Arise knows.");
    // An AI that may read it gets the question with its tier.
    vi.spyOn(AI, 'lifeCap').mockReturnValue(3);
    expect(SYS.askCoach('Arise noticed: you sleep less after late nights.', { recallAs: 'the last 6 weeks', about: 3 })).toBe(true);
    expect(chat).toHaveBeenCalledWith('Arise noticed: you sleep less after late nights.', expect.objectContaining({ recallAs: 'the last 6 weeks', about: 3 }));
    await tick();
  });

  it("says what the coach reads in the small print and in Settings", async () => {
    const { AI } = await boot('coach');
    expect(text('.small-print')).toContain('Less private: your goals, workouts and anything you typed or rated in Arise are sent to');
    expect(text('.small-print')).toContain('whenever the coach answers you, here or on Today. Your life log goes too only if you allowed it.');

    vi.spyOn(AI, 'engine').mockReturnValue('free');
    await tap('#tabs [data-v="today"]');
    await tap('#tabs [data-v="coach"]');
    expect(text('.small-print')).toContain("Less private: your goals, workouts and anything you typed or rated in Arise go to Cloudflare's servers, which can read them, whenever the coach answers you, here or on Today.");

    vi.restoreAllMocks();
    await tap('#tabs [data-v="settings"]');
    expect(text('#aiSettings')).toContain('Your profile, life check-in, check-ins, plan, workouts and weigh-ins go to');
    expect(text('#aiSettings')).not.toContain('daily log');
  });

  it('reflects on the day with nothing rated or written, in both looks', async () => {
    const { AI, SYS } = await boot('coach');
    const reflect = vi.spyOn(AI, 'reflect').mockResolvedValue('A full day: 6,400 steps.');
    const block = document.createElement('div');
    document.body.append(block);
    block.innerHTML = SYS.reflectionBlock('2026-10-09');
    const btn = block.querySelector('[data-act="ai-reflect"]') as HTMLButtonElement;
    expect(btn.textContent!.trim()).toBe('Reflect on today with your coach');
    expect(btn.hasAttribute('title')).toBe(false); // nothing to write first
    await tap('[data-act="ai-reflect"]');
    expect(reflect).toHaveBeenCalledWith('2026-10-09', expect.any(Object));
    expect(text('#toast')).toBe('');
    block.remove();

    const sys = await boot('coach', { settings: { look: 'system' } });
    block.innerHTML = sys.SYS.reflectionBlock('2026-10-09');
    expect(block.querySelector('[data-act="ai-reflect"]')!.textContent!.trim()).toBe('Reflect on today with the System');
  });

  it("turns the Reflect button in the Write something sheet back on after each try, whatever happened", async () => {
    const { AI } = await boot('today');
    const S = await import('./store');
    const reflect = vi.spyOn(AI, 'reflect').mockRejectedValueOnce(new Error('The AI is busy. Try again.'));
    $('[data-act="feel-write"]')!.click(); // Write something: the sheet with the reflect block
    const btn = () => $('#sheet [data-act="ai-reflect"]') as HTMLButtonElement;
    expect(btn().textContent!.trim()).toBe('Reflect on today with your coach');
    await tap('#sheet [data-act="ai-reflect"]');
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(text('#sheet #logAi')).toContain('The AI is busy. Try again.');
    expect(btn().disabled).toBe(false);
    expect(btn().textContent!.trim()).toBe('Reflect on today with your coach');

    reflect.mockImplementationOnce(async (k: string) => {
      S.setLog(k, { ai: 'A calm day.' });
      return 'A calm day.';
    });
    await tap('#sheet [data-act="ai-reflect"]');
    expect(reflect).toHaveBeenCalledTimes(2);
    expect(btn().disabled).toBe(false);
    expect(btn().textContent!.trim()).toBe('Reflect again');
  });
});

describe('chats on the Coach tab', () => {
  const T = new Date(2026, 9, 9, 12).getTime();
  const CHATS = {
    ai: {
      chat: [
        { role: 'user', text: 'From the one long chat', at: T - 3 * 86400_000 },
        { role: 'assistant', text: 'An old answer.', at: T - 3 * 86400_000 + 1000 },
        { role: 'user', text: 'My knee hurts after runs', at: T - 2 * 3600_000, c: 'k1' },
        { role: 'assistant', text: 'Rest it for two days.', at: T - 2 * 3600_000 + 1000, c: 'k1' },
        { role: 'user', text: 'How do I save more?', at: T - 86400_000, c: 'm1' },
        { role: 'assistant', text: 'Start with one small rule.', at: T - 86400_000 + 1000, c: 'm1' },
      ],
      chatNames: { m1: { title: 'Money', at: T - 86400_000 } },
    },
  };
  const bubbles = () => $$('#chatLog .bubble').map((b) => b.textContent!.trim());
  const rows = () => $$('#sheet .chat-open').map((b) => [b.querySelector('b')!.textContent, b.querySelector('small')!.textContent]);
  const submit = (sel: string) => $(sel)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

  it('opens the chat used last, lists every chat, and switches between them', async () => {
    await boot('coach', CHATS);
    expect(text('.chat-name')).toBe('My knee hurts after runs');
    expect(bubbles()).toEqual(['My knee hurts after runs', 'Rest it for two days.']);
    expect(text('[data-act="ai-chats"]')).toBe('Chats (3)');

    await tap('[data-act="ai-chats"]');
    expect(text('#sheet .sheet-title')).toBe('Your chats');
    expect(rows()).toEqual([
      ['My knee hurts after runs', 'Last used today at 10:00 · 2 messages'],
      ['Money', 'Last used yesterday · 2 messages'],
      ['From the one long chat', 'Last used on Tuesday · 2 messages'],
    ]);
    expect($('#sheet .chat-item.on [data-id="k1"]')).not.toBeNull();

    await tap('#sheet [data-act="ai-open"][data-id="first"]');
    expect($('#sheet')!.hidden).toBe(true);
    expect(text('.chat-name')).toBe('From the one long chat');
    expect(bubbles()).toEqual(['From the one long chat', 'An old answer.']);
  });

  it('starts a new chat, and the coach answers within the chat that is open', async () => {
    const { AI } = await boot('coach', CHATS);
    const chat = vi.spyOn(AI, 'chat').mockResolvedValue('Noted.');
    await tap('[data-act="ai-new"]');
    expect($('.chat-name')).toBeNull();
    expect($('.chat-empty')).not.toBeNull();
    expect(text('.chat-empty [data-act="ai-how"]')).toBe("Ask how I'm doing");
    ($('#chatText') as HTMLTextAreaElement).value = 'A new question';
    submit('#chatForm');
    await tick();
    const id = chat.mock.lastCall![1]!.chat as string;
    expect(id).toMatch(/^[a-z0-9]+$/);
    expect(['k1', 'm1', 'first']).not.toContain(id);

    // Back in the knee chat, a question goes there.
    await tap('[data-act="ai-chats"]');
    await tap('#sheet [data-act="ai-open"][data-id="k1"]');
    ($('#chatText') as HTMLTextAreaElement).value = 'And now?';
    submit('#chatForm');
    await tick();
    expect(chat).toHaveBeenLastCalledWith('And now?', expect.objectContaining({ chat: 'k1' }));
    // So do the quick actions.
    await tap('[data-act="ai-quick"][data-i="0"]');
    expect(chat).toHaveBeenLastCalledWith(expect.stringContaining('Review my last 7 days'), expect.objectContaining({ chat: 'k1' }));
  });

  it("asks how I'm doing in a new chat, gently, from the last week", async () => {
    const { AI } = await boot('coach', CHATS);
    const chat = vi.spyOn(AI, 'chat').mockResolvedValue('You slept less this week. How are you, really?');
    expect(text('.quick [data-act="ai-how"]')).toBe("Ask how I'm doing new chat");
    await tap('.quick [data-act="ai-how"]');
    const [question, opts] = chat.mock.lastCall!;
    expect(question.split('\n')[0]).toBe("Ask me how I'm really doing this week.");
    expect(question).toContain('ask me one gentle, open question about how I really am');
    expect(question).toContain('as far as you may read it');
    expect(opts).toEqual(expect.objectContaining({ recallAs: 'the last 7 days' }));
    expect(['k1', 'm1', 'first']).not.toContain(opts!.chat);
    expect(question).not.toMatch(/\u2014/);
  });

  it('offers more ways in: where I stand, the one thing, my values, what I avoid', async () => {
    const { AI } = await boot('coach', CHATS);
    const S = await import('./store');
    const chat = vi.spyOn(AI, 'chat').mockResolvedValue('Here is where you stand.');
    expect([...document.querySelectorAll('.quick [data-act="ai-mirror"]')].map((b) => b.textContent!.replace(' new chat', '').trim())).toEqual(['Where do I really stand?', 'The one thing', 'Am I living by my values?', 'What am I avoiding?']);
    await tap('.quick [data-act="ai-mirror"][data-i="1"]');
    expect(chat.mock.lastCall![0]).toContain('If I changed one thing this week');
    expect(chat.mock.lastCall![1]).toEqual(expect.objectContaining({ recallAs: 'the last 4 weeks' }));
    // Values: asks for them first, then checks the weeks against each.
    await tap('.quick [data-act="ai-mirror"][data-i="2"]');
    expect(text('#toast')).toContain('Pick your values first');
    S.state.profile = { ...(S.state.profile || {}), life: { at: 1, areas: {}, grow: [], values: ['Family', 'Faith'], hope: '' } } as never;
    await tap('.quick [data-act="ai-mirror"][data-i="2"]');
    expect(chat.mock.lastCall![0]).toContain('My values: Family, Faith.');
  });

  it('starts a chat of its own for a question from another screen', async () => {
    const { AI, SYS } = await boot('today', CHATS);
    const chat = vi.spyOn(AI, 'chat').mockResolvedValue('Noted.');
    expect(SYS.askCoach('Arise noticed: something. What do you make of it?', { recallAs: 'the last 6 weeks' })).toBe(true);
    await tick();
    expect(['k1', 'm1', 'first']).not.toContain(chat.mock.lastCall![1]!.chat);
  });

  it('renames a chat, and an empty name goes back to its first question', async () => {
    await boot('coach', CHATS);
    const S = await import('./store');
    await tap('[data-act="ai-chats"]');
    await tap('#sheet [data-act="ai-rename"][data-id="k1"]');
    const input = $('#chatName') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('My knee hurts after runs');
    input.value = '  Knee  ';
    submit('#sheet form[data-form="chat-rename"]');
    expect(rows()[0][0]).toBe('Knee');
    expect(text('.chat-name')).toBe('Knee');
    expect(S.state.ai.chatNames.k1.title).toBe('Knee');

    await tap('#sheet [data-act="ai-rename"][data-id="m1"]');
    expect(($('#chatName') as HTMLInputElement).value).toBe('Money');
    ($('#chatName') as HTMLInputElement).value = '';
    submit('#sheet form[data-form="chat-rename"]');
    expect(rows()[1][0]).toBe('How do I save more?');
  });

  it('deletes one chat after asking, on every device (with a stamp), and opens the one used last', async () => {
    await boot('coach', CHATS);
    const S = await import('./store');
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await tap('[data-act="ai-chats"]');
    await tap('#sheet [data-act="ai-del"][data-id="k1"]');
    expect(ask).toHaveBeenLastCalledWith('Delete "My knee hurts after runs"? It goes from all your devices, and this can\'t be undone.');
    expect(rows()).toHaveLength(3);

    ask.mockReturnValueOnce(true);
    await tap('#sheet [data-act="ai-del"][data-id="k1"]');
    expect(rows().map((r) => r[0])).toEqual(['Money', 'From the one long chat']);
    expect(S.state.ai.chat.some((m) => m.c === 'k1')).toBe(false);
    expect(S.state.stamps.chat.k1).toBeLessThan(0);
    expect(text('.chat-name')).toBe('Money');
    expect(text('[data-act="ai-chats"]')).toBe('Chats (2)');
  });

  it('forgets every chat after a plain question, on every device', async () => {
    await boot('coach', CHATS);
    const S = await import('./store');
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await tap('[data-act="ai-chats"]');
    await tap('#sheet [data-act="ai-forget"]');
    expect(ask).toHaveBeenLastCalledWith("Forget every chat? They go from all your devices, and this can't be undone. The questions you asked stay in your life log until you delete them there.");
    expect($('#sheet')!.hidden).toBe(true);
    expect(S.state.ai.chat).toEqual([]);
    expect(S.state.ai.chatNames).toEqual({});
    expect(S.state.stamps.chat.cleared).toBe(Date.now());
    expect($('.chat-empty')).not.toBeNull();
    expect($('[data-act="ai-chats"]')).toBeNull();
    expect(text('#toast')).toBe('Every chat is forgotten.');
  });
});
