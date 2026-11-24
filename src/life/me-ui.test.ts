// @vitest-environment jsdom
// Arise as "me" for other apps, on screen in What Arise knows: the About me text (what goes in,
// how private, the exact words before copying) and Connected apps (what each app gets, making a
// link, turning it off).

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeFact } from '../lib/validate';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));
vi.mock('../lib/crypto', async (orig) => {
  const real = await orig<typeof import('../lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

const FACTS: LifeFact[] = [
  { id: 'f1', text: 'You run before work most days.', since: '2026-09-01', from: 'ai', tier: 1, share: 1, sources: ['2026-09-01', '2026-09-02'], at: 1 },
  { id: 'f2', text: 'You love jazz.', since: '2026-09-03', from: 'ai', tier: 2, share: 2, sources: ['2026-09-03'], at: 1 },
  { id: 'f3', text: 'You look up knee pain most weeks.', since: '2026-09-05', from: 'ai', tier: 3, share: 3, sources: ['2026-09-05'], at: 1 },
];
const GOAL = { id: 'g1', title: 'Run a half marathon', category: 'fitness', why: 'Feel strong at 40', created: '2026-10-01', quests: [{ id: 'q1', title: 'Run', schedule: { kind: 'daily' }, created: '2026-10-01' }] };
const LINK = { id: 'a'.repeat(22), key: 'b'.repeat(43), app: 'Buddy', at: 1, choice: { sections: ['name', 'goals'], tier: 1 }, sent: new Date(2026, 9, 17, 9, 30).getTime() };

// Each boot starts the whole app again: the listeners the last one added go first.
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot({ links = [] as object[], facts = FACTS, asks = [] as object[] } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, settings: { name: 'Sam Lee' }, goals: [GOAL] }));
  if (links.length) localStorage.setItem('arise-me-links', JSON.stringify(links));
  if (asks.length) localStorage.setItem('arise-me-asks', JSON.stringify(asks));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', '#knows');
  const db = await (await import('./db')).open();
  const tx = db.transaction('facts', 'readwrite');
  for (const f of facts) tx.objectStore('facts').put(f);
  await new Promise((r) => (tx.oncomplete = r));
  await import('../app.js');
  return { M: await import('./memory'), SYNC: await import('../sync'), ME: await import('../me') };
}
const box = () => document.getElementById('aboutMeText') as HTMLTextAreaElement;
const click = (sel: string) => (document.querySelector(sel) as HTMLElement).click();
const text = (sel: string) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('About me', () => {
  it('turns what Arise knows into a short text in the Player’s voice, with nothing sensitive until they pick it', async () => {
    await boot();
    await vi.waitFor(() => expect(box().value).toContain('I love jazz.'));
    expect(box().value).toBe(
      ['My name is Sam.', "What I'm working toward:\n- Run a half marathon. Why: Feel strong at 40.", 'My routines:\n- I run before work most days.', 'What I like:\n- I love jazz.'].join('\n\n'),
    );
    expect([...document.querySelectorAll('#aboutMe [data-act="me-about-sec"]')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Your first name', 'true'],
      ['Your goals', 'true'],
      ['Your routines', 'true'],
      ['What you like', 'true'],
      ['What helps you', 'true'],
      ['Other facts', 'true'],
    ]);
    expect(text('#aboutMe [data-act="me-about-tier"][aria-pressed="true"]')).toBe('Everyday');
    expect(text('#aboutMe')).toContain('ChatGPT: Settings, Personalization, Custom instructions.');
    expect(text('#aboutMe')).toContain('Claude: Settings, Profile.');
    expect(text('#aboutMe')).toContain('Nothing leaves Arise until you copy or share it.');

    // Sensitive things only when picked; what's unpicked goes. The choice is remembered.
    click('#aboutMe [data-act="me-about-tier"][data-t="3"]');
    expect(box().value).toContain('I look up knee pain most weeks.');
    click('#aboutMe [data-act="me-about-sec"][data-s="name"]');
    expect(box().value).not.toContain('My name is');
    expect(document.querySelector('#aboutMe [data-s="name"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(localStorage.getItem('arise-about-me')!)).toEqual({ sections: ['goals', 'routines', 'likes', 'helps', 'other'], tier: 3 });
  });

  it('copies exactly the words in the box, changes included, and keeps them while Arise learns', async () => {
    const { M } = await boot();
    await vi.waitFor(() => expect(box().value).toContain('I love jazz.'));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    box().value = 'I am Sam. I like short, kind check-ins.';
    box().dispatchEvent(new Event('input', { bubbles: true }));
    expect(text('#aboutMeCount')).toBe('39 characters.');
    await M.addFact('You like mornings.');
    await new Promise((r) => setTimeout(r, 400));
    expect(box().value).toBe('I am Sam. I like short, kind check-ins.');
    click('[data-act="me-about-copy"]');
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('I am Sam. I like short, kind check-ins.'));
    expect(text('#toast')).toBe('Copied. Paste it into the app.');
  });
});

describe('Connected apps', () => {
  it('lists each app with what it gets and when it was last updated, with the warning', async () => {
    await boot({ links: [LINK] });
    expect(text('#meApps .fact-text')).toBe('Buddy');
    expect(text('#meApps .fact')).toContain('Gets: First name, goals. Only what comes from your goals and quests.');
    expect(text('#meApps .fact')).toContain(`Updated ${new Date(LINK.sent).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`);
    expect([...document.querySelectorAll('#meApps .fact-acts button')].map((b) => b.textContent)).toEqual(['See what it gets', 'New link', 'Turn off']);
    expect(text('#meApps')).toContain("The app you give this link to can read what's in it and keep a copy.");

    // What it gets, exactly.
    click('#meApps [data-act="me-app"]');
    await vi.waitFor(() => expect(text('.sheet-body .me-preview')).toContain('Run a half marathon'));
    expect(text('.sheet-body h2')).toBe('Buddy');
    expect((document.getElementById('meLinkIn') as HTMLInputElement).value).toMatch(new RegExp(`#me=${LINK.id}\\.${LINK.key}$`));
    expect(text('.sheet-body .me-preview')).not.toContain('jazz');
    const exact = JSON.parse(document.querySelector('.sheet-body .me-json')!.textContent!);
    expect(Object.keys(exact)).toEqual(['format', 'name', 'about', 'facts', 'goals', 'updated']);
    expect(exact).toMatchObject({ format: 'arise.me/v1', name: 'Sam', facts: [], goals: [{ title: 'Run a half marathon', why: 'Feel strong at 40' }] });
  });

  it('shows exactly what a new app would get, and asks for an account first', async () => {
    await boot();
    expect(text('#meAppList')).toBe('No apps connected yet.');
    click('[data-act="me-connect"]');
    expect(text('.sheet-body h2')).toBe('Connect an app');
    await vi.waitFor(() => expect(text('.sheet-body .me-preview')).toContain('I love jazz.'));
    expect(document.querySelectorAll('.sheet-body [data-act="me-sec"]')).toHaveLength(8);
    expect(text('.sheet-body .me-preview')).not.toContain('knee');
    expect(text('.sheet-body .me-preview')).not.toContain("Today's quests");
    (document.getElementById('meAppName') as HTMLInputElement).value = 'Buddy';
    click('.sheet-body [data-act="me-sec"][data-s="today"]');
    expect([...document.querySelectorAll('.sheet-body .me-preview .label')].map((x) => x.textContent)).toEqual(['First name', 'About me', 'Goals', 'Facts', "Today's quests"]);
    expect([...document.querySelectorAll('.sheet-body .me-preview .sum-list:last-of-type li > span')].map((x) => x.textContent)).toEqual(['Run', 'not yet']);
    expect((document.getElementById('meAppName') as HTMLInputElement).value).toBe('Buddy');
    expect(text('.sheet-body')).toContain('Connecting an app needs an account');
    expect(document.querySelector('.sheet-body [data-act="me-make"]')).toBeNull();
  });

  it('shows what an app gets once trimmed to fit in a link, and says some was left out', { timeout: 30_000 }, async () => {
    const C = await import('../lib/crypto');
    const noise = (n: number) => C.toB64(C.randomBytes(n)).slice(0, n); // doesn't compress, like many different facts
    const many: LifeFact[] = Array.from({ length: 100 }, (_, i) => ({ id: `fm${i}`, text: `You ${i} ${noise(220)}`, since: '2026-09-01', from: 'ai', tier: 1, share: 1, sources: ['2026-09-01'], at: 1 }));
    await boot({ facts: many });
    click('[data-act="me-connect"]');
    await vi.waitFor(() => expect(text('.sheet-body .me-preview')).toContain("That's too much for one link, so the app gets less"), { timeout: 10_000 });
    const exact = JSON.parse(document.querySelector('.sheet-body .me-json')!.textContent!);
    expect(exact.facts.length).toBeGreaterThan(0);
    expect(exact.facts.length).toBeLessThan(100);
    expect(document.querySelectorAll('.sheet-body .me-preview ul.changes li')).toHaveLength(exact.facts.length);
    // What's shown is what goes in the page, as it is.
    const ME = await import('../lib/me');
    expect((await ME.fitMe(exact)).trimmed).toBe(false);
  });

  it('makes a link for an app, then turns it off', { timeout: 30_000 }, async () => {
    const { SYNC, ME } = await boot();
    await SYNC.submit('up', { email: 'me@example.com', password: 'correct horse battery', password2: 'correct horse battery' });
    expect(SYNC.status.error).toBe('');
    click('#tabs [data-v="today"]');
    click('#tabs [data-v="days"]');
    click('[data-act="nav"][data-v="knows"]');
    click('[data-act="me-connect"]');
    (document.getElementById('meAppName') as HTMLInputElement).value = 'My buddy app';
    click('.sheet-body [data-act="me-make"]');
    await vi.waitFor(() => expect(document.getElementById('meLinkIn')).not.toBeNull(), { timeout: 5000 });
    const [l] = ME.links();
    expect(l.app).toBe('My buddy app');
    expect((document.getElementById('meLinkIn') as HTMLInputElement).value).toContain(`#me=${l.id}.${l.key}`);
    expect(text('#meApps .fact-text')).toBe('My buddy app');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    click('.sheet-body [data-act="me-app-off"]');
    await vi.waitFor(() => expect(ME.links()).toEqual([]));
    await vi.waitFor(() => expect(text('#meAppList')).toBe('No apps connected yet.'));
    expect(document.getElementById('sheet')!.hidden).toBe(true);
  });

  it('explains what the web costs before it can be turned on, then gives the address and what the app did', { timeout: 30_000 }, async () => {
    // The connector isn't answering in this test.
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      asked.push(String(u));
      return new Response('{}', { status: 503 });
    });
    const { SYNC, ME } = await boot();
    await SYNC.submit('up', { email: 'web@example.com', password: 'correct horse battery', password2: 'correct horse battery' });
    expect(SYNC.status.error).toBe('');
    click('#tabs [data-v="today"]');
    click('#tabs [data-v="days"]');
    click('[data-act="nav"][data-v="knows"]');
    click('[data-act="me-connect"]');
    (document.getElementById('meAppName') as HTMLInputElement).value = 'Claude';
    click('.sheet-body [data-act="me-make"]');
    await vi.waitFor(() => expect(document.getElementById('meLinkIn')).not.toBeNull(), { timeout: 5000 });
    // Off by default, and labelled.
    expect(text('.sheet-body .me-web')).toContain('Use it on the web Less private');
    expect(document.getElementById('meWebIn')).toBeNull();
    expect(asked.filter((u) => u.includes('arise-connector'))).toEqual([]); // nothing asked of the connector

    click('.sheet-body [data-act="me-web-explain"]');
    expect(text('.sheet-body')).toContain("So this app gets an address of its own, and Arise's connector, a small server Arise runs on Cloudflare, opens it for a moment");
    expect(text('.sheet-body')).toContain('that server and Cloudflare could read what this app gets');
    expect(text('.sheet-body [data-act="me-web-notes"][aria-pressed="true"]')).toBe('No, only read');
    expect(text('.sheet-body [data-act="me-web-days"][aria-pressed="true"]')).toBe('A month');
    expect(ME.links()[0].web).toBeUndefined(); // nothing changes until Turn it on
    click('.sheet-body [data-act="me-web-days"][data-d="7"]');
    click('.sheet-body [data-act="me-web-on"]');
    await vi.waitFor(() => expect(document.getElementById('meWebIn')).not.toBeNull(), { timeout: 5000 });
    const [l] = ME.links();
    expect(l.web!.notes).toBe(false);
    expect(l.web!.tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.now() + 7 * 86_400_000 - l.web!.until!).toBeGreaterThanOrEqual(0); // a week from when it was turned on
    expect(Date.now() + 7 * 86_400_000 - l.web!.until!).toBeLessThan(60_000);
    expect(l.web!.id).not.toBe(l.id); // an address of its own, not the link
    expect((document.getElementById('meWebIn') as HTMLInputElement).value).toBe(`https://arise-connector.abyyworld.workers.dev/mcp/${l.web!.id}.${l.web!.key}`);
    expect(text('.sheet-body .me-web')).toContain('It only reads.');
    expect(text('.sheet-body .me-web')).toContain('Nothing yet.');
    await vi.waitFor(() => expect(text('.sheet-body .me-web')).toContain("The connector isn't answering right now"));
    expect(text('#meApps .fact')).toContain('On the web until');
    vi.unstubAllGlobals();
  });

  it("shows each app's rules and what it asked to add, which goes in only on Allow", { timeout: 30_000 }, async () => {
    // A connector from before rules: it answers, but doesn't say it keeps to them.
    vi.stubGlobal('fetch', async (u: string) => (String(u).endsWith('/health') ? new Response(JSON.stringify({ ok: true, name: 'arise-connector', version: '1.0.0' })) : new Response('{}', { status: 404 })));
    const web = { notes: true, id: 'c'.repeat(22), key: 'd'.repeat(43), tok: 'e'.repeat(43), fh: '0'.repeat(64) };
    const rules = { ask: ['todo'], never: ['health'], house: "Don't mention my exams unless I ask." };
    const { ME } = await boot({
      links: [{ ...LINK, app: 'Claude', web, rules }],
      asks: [
        { link: LINK.id, web: web.id, n: 1, at: 1000, want: 'add_todo', text: 'Call mum', day: '2026-10-20', client: 'Claude' },
        { link: LINK.id, web: web.id, n: 2, at: 2000, want: 'add_note', text: 'Ran 5 km.', client: 'Claude' },
      ],
    });
    const S = await import('../store');
    expect(text('#meApps .fact')).toContain("Rules: Ask me first: add a to-do. Never: read anything about my health. House rules: \u201cDon't mention my exams unless I ask.\u201d");
    const tue = new Date(2026, 9, 20).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    expect([...document.querySelectorAll('#meApps .me-ask p')].map((x) => x.textContent!.replace(/\s+/g, ' ').trim())).toEqual([`Claude wants to: add a to-do \u201cCall mum\u201d for ${tue}`, 'Claude wants to: add a note \u201cRan 5 km.\u201d']);

    click('#meApps .me-ask:last-child [data-act="me-ask-no"]');
    await vi.waitFor(() => expect(ME.asks()).toHaveLength(1));
    expect(document.querySelectorAll('#meApps .me-ask')).toHaveLength(1);
    click('#meApps [data-act="me-ask-allow"]');
    await vi.waitFor(() => expect(ME.asks()).toEqual([]));
    expect(Object.values(S.state.todos)).toMatchObject([{ title: 'Call mum', day: '2026-10-20', from: 'Claude' }]);
    expect(document.querySelectorAll('#meApps .me-ask')).toHaveLength(0);

    // The sheet has them too, and says the connector needs its update.
    click('#meApps [data-act="me-app"]');
    expect(text('.sheet-body .me-rules')).toContain('Rules for this app Ask me first: add a to-do.');
    await vi.waitFor(() => expect(text('.sheet-body .me-rules')).toContain('Needs the connector update.'));
    expect(document.querySelector('.sheet-body [data-act="me-rules-edit"]')).toBeNull(); // signed out
    // What it gets carries the rules, and nothing about their health.
    await vi.waitFor(() => expect(document.querySelector('.sheet-body .me-json')).not.toBeNull());
    const exact = JSON.parse(document.querySelector('.sheet-body .me-json')!.textContent!);
    expect(exact.rules).toEqual(rules);
    vi.unstubAllGlobals();
  });

  it('lets the Player pick and write the rules for an app', { timeout: 30_000 }, async () => {
    const { SYNC, ME } = await boot();
    await SYNC.submit('up', { email: 'rules@example.com', password: 'correct horse battery', password2: 'correct horse battery' });
    expect(SYNC.status.error).toBe('');
    click('#tabs [data-v="today"]');
    click('#tabs [data-v="days"]');
    click('[data-act="nav"][data-v="knows"]');
    click('[data-act="me-connect"]');
    (document.getElementById('meAppName') as HTMLInputElement).value = 'Claude';
    click('.sheet-body [data-act="me-make"]');
    await vi.waitFor(() => expect(document.getElementById('meLinkIn')).not.toBeNull(), { timeout: 5000 });
    expect(text('.sheet-body .me-rules')).toContain('No rules yet. It may do all you let it.');
    click('.sheet-body [data-act="me-rules-edit"]');
    expect(text('.sheet-body')).toContain('Pick what Claude may just do, must ask you about first, or may never do.');
    expect([...document.querySelectorAll('.sheet-body [data-act="me-rule"][aria-pressed="true"]')].map((b) => b.textContent)).toEqual(['May just do', 'May just do', 'May just do', 'May just do']);
    click('.sheet-body [data-act="me-rule"][data-a="todo"][data-v="ask"]');
    click('.sheet-body [data-act="me-rule"][data-a="note"][data-v="never"]');
    click('.sheet-body [data-act="me-rule"][data-a="health"][data-v="never"]');
    (document.getElementById('meHouse') as HTMLTextAreaElement).value = 'Keep it short.';
    click('.sheet-body [data-act="me-rule-pick"][data-i="0"]');
    expect((document.getElementById('meHouse') as HTMLTextAreaElement).value).toBe("Keep it short.\nDon't mention my exams unless I ask.");
    expect(document.querySelector('.sheet-body [data-act="me-rule"][data-a="todo"][data-v="ask"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(ME.links()[0].rules).toBeUndefined(); // nothing changes until Save
    click('.sheet-body [data-act="me-rules-save"]');
    await vi.waitFor(() => expect(ME.links()[0].rules).toEqual({ ask: ['todo'], never: ['health', 'note'], house: "Keep it short.\nDon't mention my exams unless I ask." }), { timeout: 5000 });
    await vi.waitFor(() => expect(text('.sheet-body .me-rules')).toContain('Ask me first: add a to-do. Never: read anything about my health, add a note.'));
    expect(text('#meApps .fact')).toContain('Rules: Ask me first: add a to-do.');
  });

  it("says so when a link's page is another account's, which only that account can turn off", { timeout: 30_000 }, async () => {
    const mine = { ...LINK, id: 'c'.repeat(22), app: 'Old buddy' };
    const theirs = { ...LINK, id: 'd'.repeat(22), app: 'Old coach' };
    const { SYNC, ME } = await boot({ links: [mine, theirs] });
    const { cloud } = await import('../test/fake-firebase');
    for (const l of [mine, theirs]) cloud.docs.set(`shares/${l.id}`, { owner: 'someone', iv: 'A'.repeat(16), ct: 'AAAA', v: 1, updated: 1 });
    await SYNC.submit('up', { email: 'links@example.com', password: 'correct horse battery', password2: 'correct horse battery' });
    expect(SYNC.status.error).toBe('');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    click('#tabs [data-v="today"]');
    click('#tabs [data-v="days"]');
    click('[data-act="nav"][data-v="knows"]');

    // Turn off isn't reported as done.
    click(`#meApps [data-act="me-app-off"][data-id="${mine.id}"]`);
    await vi.waitFor(() => expect(text('#toast')).toContain('This link was made with another account'));
    expect(text('#toast')).toContain('It goes off the next time that account is signed in here.');
    // Nor is New link: the sheet says why, not that it was turned off.
    click(`#meApps [data-act="me-app-new"][data-id="${theirs.id}"]`);
    await vi.waitFor(() => expect(text('.sheet-body')).toContain('This link was made with another account'));
    expect(text('.sheet-body h2')).toBe('Old coach');
    expect(ME.links()).toEqual([]);
    for (const l of [mine, theirs]) expect(cloud.docs.get(`shares/${l.id}`)).toMatchObject({ owner: 'someone', ct: 'AAAA' });
    expect(JSON.parse(localStorage.getItem('arise-me-off')!)).toEqual([
      { id: mine.id, owner: 'someone' },
      { id: theirs.id, owner: 'someone' },
    ]);
  });

  it('keeps every link on when the Player stops Erase all data to keep changes not yet in the cloud', { timeout: 30_000 }, async () => {
    const { SYNC, ME } = await boot();
    await SYNC.submit('up', { email: 'erase@example.com', password: 'correct horse battery', password2: 'correct horse battery' });
    expect(SYNC.status.error).toBe('');
    const l = await ME.connect('Buddy', { sections: ['goals'], tier: 1 });
    // Offline, with a change that hasn't reached the cloud.
    SYNC.status.locked = true;
    const S = await import('../store');
    S.state.settings.sound = !S.state.settings.sound;
    S.save();
    click('#tabs [data-v="settings"]');
    const asked: string[] = [];
    vi.spyOn(window, 'confirm').mockImplementation((m) => (asked.push(String(m)), asked.length === 1)); // Erase: yes. Lose the changes: no.
    click('[data-act="reset"]');
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).toContain("Some changes haven't reached the cloud yet");
    await new Promise((r) => setTimeout(r, 50));
    expect(SYNC.status.user).not.toBeNull();
    expect(ME.links().map((x) => x.id)).toEqual([l.id]);
    const { cloud } = await import('../test/fake-firebase');
    expect(cloud.docs.get(`shares/${l.id}`)).toHaveProperty('ct');
  });
});
