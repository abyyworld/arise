// @vitest-environment jsdom
// Your own database on this device: connecting to Turso (a pretend one on a real SQLite), the copy
// a few seconds after each save in small batches, trying again later, the sections, Check, Copy
// everything now, Stop, the token never leaving this device, and the panel in Setup and
// connections and in Settings.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeTurso, TOKEN, URL_, type FakeTurso } from './test/fake-turso';
import type { LifeEvent } from './life/types';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

type ODB = typeof import('./own-db');
type Store = typeof import('./store');
let O: ODB;
let S: Store;
let db: FakeTurso;
const T = 1_780_000_000_000;
const LIBSQL = URL_.replace('https://', 'libsql://');

async function boot() {
  vi.resetModules();
  S = await import('./store');
  O = await import('./own-db');
  db = fakeTurso();
  O._setNet({ fetch: db.fetch as unknown as typeof fetch, wait: async () => {} });
  O._setNotesReader(async () => []);
}
const todo = (id: string, title = `To-do ${id}`) => {
  S.state.todos[id] = { id, title, created: T, at: T };
};

beforeEach(async () => {
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div><div id="toast"></div>';
  await boot();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('your own database: copying', () => {
  it('connects: makes the tables, checks it can write and read, then copies everything', async () => {
    todo('t1');
    S.state.groceries.r1 = { id: 'r1', name: 'Milk', created: T, at: T };
    S.save();
    await expect(O.connect({ url: 'nope', token: TOKEN })).rejects.toThrow('database URL');
    await expect(O.connect({ url: LIBSQL, token: 'a.b.c' })).rejects.toThrow('Turso turned down the token');
    expect(O.isOn()).toBe(false);
    const from = db.calls.length;

    expect(await O.connect({ url: LIBSQL, token: TOKEN })).toBe(2);
    expect(O.isOn()).toBe(true);
    expect(O.host()).toBe('arise-sam.aws-eu-west-1.turso.io');
    expect(db.tables()).toEqual(expect.arrayContaining(['arise_info', 'goals', 'quests', 'ticks', 'todos', 'events', 'checkins', 'money_owed', 'groceries', 'people', 'workouts', 'weigh_ins', 'notes']));
    expect(db.rows('todos')).toEqual([{ id: 't1', title: 'To-do t1', day: null, at_time: null, done_at: null, big: 0, added_by: null, created_at: T, changed_at: T }]);
    expect(db.rows('groceries')).toMatchObject([{ id: 'r1', name: 'Milk' }]);
    expect(db.rows('arise_info').map((r) => r.key)).toEqual(['check', 'copied_at', 'schema']);
    const c = O.conn()!;
    expect(c).toMatchObject({ kind: 'turso', url: URL_, token: TOKEN, ready: true, rows: 2, lastWhat: { todos: 1, groceries: 1 }, error: '' });
    expect(c.sections).not.toContain('notes');
    expect(c.last).toBeGreaterThan(0);
    for (const call of db.calls.slice(from)) expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('copies a few seconds after each save, only what changed, in small batches', async () => {
    await O.connect({ url: LIBSQL, token: TOKEN });
    O.initOwnDb();
    vi.useFakeTimers();
    const before = db.calls.length;
    for (let i = 0; i < 85; i++) todo(`n${i}`);
    S.save();
    S.save(); // once, for both
    await vi.advanceTimersByTimeAsync(O.DELAY - 100);
    expect(db.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(db.count('todos')).toBe(85));
    const sent = db.sql().slice(before);
    expect(sent.map((s) => s.length)).toEqual([40, 40, 6]); // the last one also says when
    expect(sent[2][5]).toBe('INSERT INTO arise_info (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    expect(O.conn()).toMatchObject({ rows: 85, lastWhat: { todos: 85 } });

    // A change and a deletion: two statements, nothing else sent again.
    S.state.todos.n1 = { ...S.state.todos.n1, title: 'Changed', at: T + 1 };
    delete S.state.todos.n2;
    S.save();
    await vi.advanceTimersByTimeAsync(O.DELAY + 10);
    await vi.waitFor(() => expect(db.count('todos')).toBe(84));
    expect(db.sql().at(-1)).toEqual([expect.stringMatching(/^INSERT INTO todos /), 'DELETE FROM todos WHERE id = ?', expect.stringMatching(/^INSERT INTO arise_info /)]);
    expect(db.rows('todos').find((r) => r.id === 'n1')).toMatchObject({ title: 'Changed' });

    // Nothing changed: nothing sent.
    const now = db.calls.length;
    S.save();
    await vi.advanceTimersByTimeAsync(O.DELAY + 10);
    expect(db.calls.length).toBe(now);
  });

  it('tries again later when Turso is busy or the network is down, and keeps what got through', async () => {
    await O.connect({ url: LIBSQL, token: TOKEN });
    O.initOwnDb();
    vi.useFakeTimers();
    for (let i = 0; i < 50; i++) todo(`n${i}`);
    db.fail = [0, 503, 503, 503]; // the first batch goes, the second fails three times
    S.save();
    await vi.advanceTimersByTimeAsync(O.DELAY + 10);
    await vi.waitFor(() => expect(O.conn()!.error).toBe('Turso is busy. Arise tries again soon.'));
    expect(db.count('todos')).toBe(40); // the first batch
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(db.count('todos')).toBe(50));
    expect(O.conn()!.error).toBe('');
    // Only the second batch was sent again.
    expect(db.sql().at(-1)!.filter((s) => s.startsWith('INSERT INTO todos')).length).toBe(10);
  });

  it('waits for the Player when the token is turned down', async () => {
    await O.connect({ url: LIBSQL, token: TOKEN });
    O.initOwnDb();
    vi.useFakeTimers();
    todo('t1');
    db.fail = [401];
    S.save();
    await vi.advanceTimersByTimeAsync(O.DELAY + 10);
    await vi.waitFor(() => expect(O.conn()!.error).toContain('Turso turned down the token'));
    const n = db.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(db.calls.length).toBe(n);
  });

  it('copies only the sections that are on, and takes a section out when it goes off', async () => {
    S.state.debts.d1 = { id: 'd1', who: 'Ana', amount: 5, cur: 'GBP', dir: 'owe', created: T, at: T };
    todo('t1');
    const notes: LifeEvent[] = [{ id: 'manual:n1', source: 'manual', kind: 'note', at: T, title: 'A thought', tier: 2 }];
    O._setNotesReader(async () => notes);
    await O.connect({ url: LIBSQL, token: TOKEN });
    expect(db.count('notes')).toBe(0);
    expect(db.rows('money_owed')).toMatchObject([{ who: 'Ana', direction: 'you owe them' }]);

    O.setSection('money', false);
    O.setSection('notes', true);
    expect(O.conn()!.sections).toEqual(['goals', 'todos', 'events', 'checkins', 'groceries', 'people', 'workouts', 'notes']);
    await O.copyNow();
    expect(db.count('money_owed')).toBe(0);
    expect(db.rows('notes')).toMatchObject([{ id: 'manual:n1', title: 'A thought', source: 'manual' }]);
    expect(db.count('todos')).toBe(1);
  });

  it('Check writes a test row and reads it back; Copy everything now starts the tables again', async () => {
    todo('t1');
    await O.connect({ url: LIBSQL, token: TOKEN });
    await O.check();
    const mark = db.rows('arise_info').find((r) => r.key === 'check')!.value;
    await O.check();
    expect(db.rows('arise_info').find((r) => r.key === 'check')!.value).not.toBe(mark);

    // Something put in the database by hand, and a to-do this device forgot it copied.
    db.db.exec("INSERT INTO todos (id, title) VALUES ('stray', 'Not from Arise')");
    localStorage.removeItem('arise-own-db-copied');
    expect(await O.copyNow({ everything: true })).toBe(1);
    expect(db.rows('todos').map((r) => r.id)).toEqual(['t1']);
    expect(db.sql().at(-2)).toEqual(expect.arrayContaining(['DELETE FROM todos', 'DELETE FROM notes']));

    db.fail = [401];
    await expect(O.check()).rejects.toThrow('Turso turned down the token');
    expect(O.conn()!.error).toContain('Turso turned down the token');
  });

  it('Stop forgets the connection on this device, and the database keeps what it has', async () => {
    todo('t1');
    await O.connect({ url: LIBSQL, token: TOKEN });
    O.initOwnDb();
    O.forget();
    expect(O.isOn()).toBe(false);
    expect(localStorage.getItem('arise-own-db')).toBeNull();
    expect(localStorage.getItem('arise-own-db-copied')).toBeNull();
    expect(db.count('todos')).toBe(1);
    const n = db.calls.length;
    todo('t2');
    S.save();
    await new Promise((r) => setTimeout(r, 50));
    expect(db.calls.length).toBe(n);
  });

  it('keeps the token on this device: not in the synced data, not in a backup', async () => {
    todo('t1');
    S.save();
    await O.connect({ url: LIBSQL, token: TOKEN });
    S.save();
    const secret = TOKEN.split('.')[2];
    expect(JSON.stringify(S.state)).not.toContain(secret);
    expect(S.snapshot()).not.toContain(secret);
    expect(S.snapshot()).not.toContain('turso.io');
    expect(JSON.stringify(S.exportData())).not.toContain(secret);
    expect(JSON.stringify(S.exportData())).not.toContain('turso.io');
    // Only its own key holds it.
    const holders = Object.keys(localStorage).filter((k) => localStorage.getItem(k)!.includes(secret));
    expect(holders).toEqual(['arise-own-db']);
    // A backup or cloud copy can't bring one in either: the state has no place for it.
    const restored = S.clean({ ...JSON.parse(S.snapshot()), ownDb: { url: URL_, token: TOKEN }, settings: { ...S.state.settings, ownDb: TOKEN } });
    expect(JSON.stringify(restored)).not.toContain(secret);
  });
});

describe('your own database: the panel', () => {
  const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
  const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';

  it('says what it is and that it is less private, connects from the form, then shows the sections and buttons', async () => {
    const UI = await import('./own-db-ui.js');
    vi.stubGlobal('fetch', db.fetch);
    O._setNet({});
    todo('t1');
    S.save();
    $('#app')!.innerHTML = UI.panel();
    expect(text('#ownDbPanel .panel-title')).toBe('Your own database Optional Less private');
    expect(text('#ownDbPanel')).toContain('Less private: your data sits in that database as plain text. Anyone with its token can read it, and so can Turso. Your synced copy stays end-to-end encrypted.');
    expect(text('#ownDbPanel')).not.toMatch(/\u2014/);
    expect($('#ownDbPanel a')!.getAttribute('href')).toBe('https://github.com/abyyworld/arise/blob/main/docs/OWN-DATABASE.md');

    const form = $('[data-odb-form="connect"]') as HTMLFormElement;
    (form.querySelector('[name="url"]') as HTMLInputElement).value = LIBSQL;
    (form.querySelector('[name="token"]') as HTMLInputElement).value = TOKEN;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(text('#ownDbPanel .panel-title')).toBe('Your own database Connected Less private'));
    expect(text('#ownDbPanel')).toContain('Copying to arise-sam.aws-eu-west-1.turso.io a few seconds after each change, from this device.');
    expect(text('#ownDbPanel')).toMatch(/Last copied .+: 1 change \(todos 1\)\. 1 row from Arise in your database\./);
    expect(text('#toast')).toBe('Connected. Copied 1 row.');
    const toggles = [...document.querySelectorAll<HTMLElement>('[data-act="odb-sec"]')];
    expect(toggles.map((b) => b.querySelector('b')!.textContent)).toEqual(['Goals and quests', 'To-dos', 'Calendar events', 'Check-ins', 'Money owed', 'Groceries', 'People', 'Workouts and weigh-ins', 'Notes from your days']);
    expect(toggles.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true', 'true', 'true', 'true', 'true', 'true', 'false']);
    expect([...document.querySelectorAll('#ownDbPanel .row button')].map((b) => b.textContent)).toEqual(['Check', 'Copy everything now', 'Stop and forget the connection']);
    // The token is never shown or kept in the page.
    expect(document.body.innerHTML).not.toContain(TOKEN.split('.')[2]);

    // A section off, Check, Copy everything now, then Stop.
    await UI.handleAction('odb-sec', toggles[1]);
    expect($('[data-act="odb-sec"][data-v="todos"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(O.conn()!.sections).not.toContain('todos');
    await UI.handleAction('odb-check');
    expect(text('#toast')).toBe('It works. Arise wrote a test row and read it back.');
    await UI.handleAction('odb-all');
    expect(text('#toast')).toBe('Copied 0 rows.');
    expect(db.count('todos')).toBe(0);
    vi.stubGlobal('confirm', () => true);
    await UI.handleAction('odb-stop');
    expect(O.isOn()).toBe(false);
    expect(text('#ownDbPanel .panel-title')).toBe('Your own database Optional Less private');
    expect(await UI.handleAction('something-else')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('shows what went wrong', async () => {
    const UI = await import('./own-db-ui.js');
    await O.connect({ url: LIBSQL, token: TOKEN });
    $('#app')!.innerHTML = UI.panel();
    db.fail = [401];
    await UI.handleAction('odb-check');
    expect(text('#ownDbPanel [role="alert"]')).toBe('Turso turned down the token. Make a new one with read and write, and connect again.');
  });

  it('is in Setup and connections, and its taps work there', async () => {
    const HUB = await import('./life/connect-hub.js');
    HUB.openStep('connections');
    HUB.renderConnect($('#app')!);
    expect(text('#ownDbPanel .panel-title')).toBe('Your own database Optional Less private');
    await O.connect({ url: LIBSQL, token: TOKEN });
    HUB.renderConnect($('#app')!);
    expect(text('#ownDbPanel .panel-title')).toBe('Your own database Connected Less private');
    const b = $('[data-act="odb-sec"][data-v="goals"]')!;
    expect(await HUB.handleAction('odb-sec', b, {})).toBe(true);
    expect(O.conn()!.sections).not.toContain('goals');
  }, 30_000);

  it('is in Settings, and a tap there turns a section off', async () => {
    // Connected before the app starts, as on a device that set it up earlier.
    await O.connect({ url: LIBSQL, token: TOKEN });
    const saved = { ...localStorage };
    vi.resetModules();
    localStorage.clear();
    for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v as string);
    localStorage.setItem('pit-data-v1', JSON.stringify({ profile: { name: 'Sam', onboarded: true } }));
    document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
    history.replaceState(null, '', '#settings');
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    vi.stubGlobal('fetch', db.fetch);
    await import('./app.js');
    const O2 = await import('./own-db');
    expect(text('#ownDbPanel .panel-title')).toBe('Your own database Connected Less private');
    $('[data-act="odb-sec"][data-v="people"]')!.click();
    await vi.waitFor(() => expect(O2.conn()!.sections).not.toContain('people'));
    await vi.waitFor(() => expect($('[data-act="odb-sec"][data-v="people"]')!.getAttribute('aria-pressed')).toBe('false'));
    vi.unstubAllGlobals();
  }, 60_000);
});
