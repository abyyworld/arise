// @vitest-environment jsdom
// On screen: an area's page in What Arise knows (area-ui.js), with "Add here", sub-branches, the
// same note in two areas, key ones first, labels and filters, "These go together" and "Add to the
// earlier note?"; and the flags on each fact (know-ui.js).

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));
vi.setConfig({ testTimeout: 20_000 });

const SHEET = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main>';
const sheet = () => document.querySelector('.sheet-body')?.textContent?.replace(/\s+/g, ' ').trim() || '';
const el = (data: Record<string, string> = {}) => ({ dataset: data }) as unknown as HTMLElement;
const items = () => [...document.querySelectorAll('#areaItems [data-note] .fact-text')].map((x) => x.textContent?.trim());
const val = (id: string, v: string) => ((document.getElementById(id) as HTMLInputElement).value = v);

beforeEach(() => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  document.body.innerHTML = SHEET;
  vi.stubGlobal('confirm', () => true);
});

async function load() {
  const M = await import('./memory');
  const LIFE = await import('./screens.js');
  const UI = await import('./area-ui.js');
  await M.load();
  return { M, LIFE, UI };
}

async function add(LIFE: { handleAction: (a: string, e: HTMLElement) => Promise<unknown> }, f: { title?: string; text?: string; branch?: boolean; labels?: string; key?: boolean; also?: string; from?: string; to?: string }) {
  await LIFE.handleAction('area-add', el());
  if (f.branch) await LIFE.handleAction('area-kind', el({ v: 'branch' }));
  val('areaTitle', f.title || '');
  val('areaText', f.text || '');
  if (f.labels) val('areaLabels', f.labels);
  if (f.from) val('areaFrom', f.from);
  if (f.to) val('areaTo', f.to);
  if (f.key) (document.getElementById('areaKey') as HTMLInputElement).checked = true;
  if (f.also) (document.querySelector(`input[name="areaPick"][value="${f.also}"]`) as HTMLInputElement).checked = true;
  await LIFE.handleAction('area-save', el());
}

describe("an area's page", () => {
  it('adds notes and a sub-branch, shows key ones first, one note in two areas, and filters', async () => {
    const { M, LIFE } = await load();
    document.getElementById('app')!.innerHTML = '<div id="knowAreaList"></div>';
    await LIFE.handleAction('area-open', el({ area: 'work' }));
    expect(sheet()).toContain('Work or study');
    expect(sheet()).toContain('Nothing here yet');

    await add(LIFE, { title: 'Drone EduTrain', branch: true, from: '2026-01-10' });
    await add(LIFE, { title: 'Ask for a raise', also: 'money', labels: 'pay, talks' });
    await add(LIFE, { title: 'Board meeting', key: true });
    expect(items()[0]).toContain('Board meeting');
    expect(items()).toHaveLength(3);
    expect(sheet()).toContain('Also in Money');

    // Inside the sub-branch.
    const branch = M.areaNotes().find((n) => n.branch)!;
    await LIFE.handleAction('area-in', el({ id: branch.id }));
    expect(sheet()).toContain('Work or study > Drone EduTrain');
    await add(LIFE, { title: 'Client: Hila', text: 'Wants a demo.' });
    expect(items()).toEqual(['Client: Hila']);
    expect(M.areaNotes().find((n) => n.title === 'Client: Hila')?.parent).toBe(branch.id);

    // A second note in the same sub-branch: "Add to the earlier note?"
    await add(LIFE, { text: 'Demo booked for Tuesday.' });
    expect(sheet()).toContain('Add to the earlier note?');
    expect(sheet()).toContain('Client: Hila');
    await LIFE.handleAction('area-grow', el());
    const grown = M.areaNotes().find((n) => n.title === 'Client: Hila')!;
    expect(grown.more).toEqual([{ day: grown.day, text: 'Demo booked for Tuesday.' }]);
    expect(M.areaNotes()).toHaveLength(4);
    expect(sheet()).toContain('added to');

    // The note in Money too.
    await LIFE.handleAction('area-open', el({ area: 'money' }));
    expect(items()).toEqual(['Ask for a raise']);

    // Filters: label, type.
    await LIFE.handleAction('area-open', el({ area: 'work' }));
    await LIFE.handleAction('area-label', el({ v: 'pay' }));
    expect(items()).toEqual(['Ask for a raise']);
    await LIFE.handleAction('area-clear', el());
    await LIFE.handleAction('area-type', el({ v: 'branches' }));
    expect(items()).toEqual(['Drone EduTrain']);
    await LIFE.handleAction('area-type', el({ v: 'notes' }));
    expect(items().length).toBe(3); // looks inside the sub-branch too
    await LIFE.handleAction('area-clear', el());
    val('areaF', '2026-01-01');
    val('areaT', '2026-01-31');
    await LIFE.handleAction('area-dates', el());
    expect(items()).toEqual(['Drone EduTrain']);
    await LIFE.handleAction('area-clear', el());

    // Mark as key, from the list.
    const raise = M.areaNotes().find((n) => n.title === 'Ask for a raise')!;
    await LIFE.handleAction('area-key', el({ id: raise.id }));
    expect(M.areaNotes().find((n) => n.id === raise.id)?.key).toBe(true);
  });

  it('with the search model on, offers to add to a close note elsewhere in the area, and keeps it separate when asked', async () => {
    const { M, LIFE } = await load();
    const model = await import('./embed/model');
    localStorage.setItem('arise-meaning', JSON.stringify({ on: true, at: 1 }));
    // A stand-in model: texts about the gym point one way, the rest another.
    model._setEmbedder({ embed: async (texts) => texts.map((t) => Float32Array.from(/gym|workout/i.test(t) ? [1, 0] : [0, 1])) });
    await LIFE.handleAction('area-open', el({ area: 'body' }));
    await add(LIFE, { title: 'Gym plan', text: 'Three times a week.' });
    await add(LIFE, { text: 'Workout went well, legs day.' });
    expect(sheet()).toContain('Add to the earlier note?');
    await LIFE.handleAction('area-apart', el());
    expect(M.areaNotes()).toHaveLength(2);
    await add(LIFE, { title: 'Dentist', text: 'Check-up in May.' });
    expect(sheet()).not.toContain('Add to the earlier note?');
    expect(M.areaNotes()).toHaveLength(3);
    model._setEmbedder(null);
  });

  it('links two notes and shows the link on both', async () => {
    const { M, LIFE } = await load();
    await LIFE.handleAction('area-open', el({ area: 'people' }));
    await add(LIFE, { title: 'Dinner with Dana' });
    await LIFE.handleAction('area-open', el({ area: 'fun' }));
    await add(LIFE, { title: 'Concert tickets' });
    const [a, b] = ['Dinner with Dana', 'Concert tickets'].map((t) => M.areaNotes().find((n) => n.title === t)!);
    await LIFE.handleAction('area-link', el({ id: a.id }));
    expect(sheet()).toContain('Concert tickets');
    await LIFE.handleAction('area-link-to', el({ a: a.id, b: b.id }));
    expect(sheet()).toContain('Linked. Tap to unlink');
    await LIFE.handleAction('area-open', el({ area: 'fun' }));
    expect(sheet()).toContain('Goes with: Dinner with Dana');
    await LIFE.handleAction('area-open', el({ area: 'people' }));
    expect(sheet()).toContain('Goes with: Concert tickets');
    await LIFE.handleAction('area-unlink', el({ a: b.id, b: a.id }));
    await LIFE.handleAction('area-open', el({ area: 'people' }));
    expect(sheet()).not.toContain('Goes with');
  });
});

describe('flags on What Arise knows', () => {
  it('shows and sets "Never send to an AI", "Check again on", "Imported, not confirmed", and asks which is right', async () => {
    const { M, LIFE } = await load();
    const root = document.getElementById('app')!;
    const a = (await M.addFact('You drink coffee.'))!;
    const b = (await M.addFact("You don't drink coffee."))!;
    LIFE.renderKnows(root);
    await new Promise((r) => setTimeout(r, 50));
    expect(root.textContent).toContain('Your life areas');
    expect(root.textContent).toContain('These two disagree');
    const row = () => root.querySelector(`[data-fact="${a.id}"]`)!;
    expect(row().textContent).toContain('Never send to an AI');

    await LIFE.handleAction('know-noai', el({ id: a.id, on: 'true' }));
    expect(M.isHeld(a.id)).toBe(true);
    LIFE.renderKnows(root);
    expect(row().textContent).toContain('Never sent to an AI');
    expect(row().textContent).toContain('Let AIs read it');

    await LIFE.handleAction('know-check', el({ id: a.id }));
    expect(sheet()).toContain('Check again on');
    val('knowCheck', '2027-02-01');
    await LIFE.handleAction('know-check-save', el({ id: a.id }));
    expect(M.flagOf(a.id)?.check).toBe('2027-02-01');
    LIFE.renderKnows(root);
    expect(row().textContent).toMatch(/Check again on (1 Feb 2027|Feb 1, 2027)/); // (in the device's own way of writing dates)

    // Which is right?
    await LIFE.handleAction('know-clash', el({ i: '0' }));
    expect(sheet()).toContain('Which is right?');
    await LIFE.handleAction('know-right', el({ a: b.id, b: a.id }));
    expect(M.allFacts().map((f) => f.text)).toEqual(["You don't drink coffee."]);

    // The one picked as right counts as confirmed.
    expect(M.isUnconfirmed({ ...M.allFacts()[0], imp: true as const })).toBe(false);
  });

  it('shows "Imported, not confirmed" with "It\'s right"', async () => {
    const { M, LIFE } = await load();
    const db = await (await import('./db')).open();
    const f = { id: 'fimp1', text: 'You talk to Sam most days.', since: '2026-10-01', from: 'ai', tier: 3, sources: ['2026-10-01'], at: Date.now(), imp: true };
    const tx = db.transaction('facts', 'readwrite');
    tx.objectStore('facts').put(f);
    await new Promise((r) => (tx.oncomplete = r));
    await M.reload();
    const root = document.getElementById('app')!;
    LIFE.renderKnows(root);
    const row = () => root.querySelector('[data-fact="fimp1"]')!;
    expect(row().textContent).toContain('Imported, not confirmed');
    expect(row().querySelector('[data-act="know-ok"]')?.textContent).toBe("It's right");
    await LIFE.handleAction('know-ok', el({ id: 'fimp1' }));
    LIFE.renderKnows(root);
    expect(row().textContent).not.toContain('Imported, not confirmed');
  });
});
