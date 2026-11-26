// Notes and sub-branches under the parts of life (area-notes.ts): adding under an area and inside
// a sub-branch, one note in several areas, key ones first, labels and filters, linked notes,
// notes that grow, how two devices' copies come together, and what the coach gets.

import { describe, expect, it } from 'vitest';
import * as AN from './area-notes';
import { canonical, cleanContent, emptyContent, MEM, mergeContent } from './packs';
import type { LifeAreaNote } from '../lib/validate';

let n = 0;
const mk = (input: AN.NoteInput, day = '2026-11-01', at = 1000 + n): LifeAreaNote => AN.makeNote(input, day, at, `n${(++n).toString(36)}`)!;
const titles = (l: readonly LifeAreaNote[]) => l.map((x) => x.title);

describe('adding under an area', () => {
  it('keeps notes at the top and inside a sub-branch, like Work > Drone EduTrain', () => {
    const branch = mk({ areas: ['work'], title: 'Drone EduTrain', branch: true, from: '2026-01-10' });
    const inside = mk({ areas: ['work'], title: 'First client call', text: 'Went well.', parent: branch.id }, '2026-11-02');
    const top = mk({ areas: ['work'], title: 'Ask for a raise' }, '2026-10-01');
    const list = [branch, inside, top];
    expect(titles(AN.notesIn(list, 'work'))).toEqual(['Drone EduTrain', 'Ask for a raise']);
    expect(titles(AN.notesIn(list, 'work', { parent: branch.id }))).toEqual(['First client call']);
    expect(AN.pathOf(list, inside)).toBe('Work or study > Drone EduTrain');
    expect(AN.branchesFor(list, ['work'], branch.id)).toEqual([]); // never under itself
    expect(AN.branchesFor(list, ['work'])).toEqual([branch]);
    // A sub-branch needs a title; a note needs a title or words.
    expect(AN.makeNote({ areas: ['work'], text: 'x', branch: true }, '2026-11-01', 1)).toBeNull();
    expect(AN.makeNote({ areas: ['work'] }, '2026-11-01', 1)).toBeNull();
    expect(AN.makeNote({ areas: [], title: 'x' }, '2026-11-01', 1)).toBeNull();
    // An end before the start is dropped.
    expect(AN.makeNote({ areas: ['work'], title: 'x', from: '2026-05-01', to: '2026-04-01' }, '2026-11-01', 1)).not.toHaveProperty('to');
  });

  it('shows one note under several areas, and counts it in each', () => {
    const both = mk({ areas: ['work', 'money'], title: 'Pay rise talk' });
    const list = [both, mk({ areas: ['money'], title: 'Savings' })];
    expect(titles(AN.notesIn(list, 'work'))).toEqual(['Pay rise talk']);
    expect(titles(AN.notesIn(list, 'money')).sort()).toEqual(['Pay rise talk', 'Savings']);
    expect(AN.counts(list)).toMatchObject({ work: 1, money: 2, sleep: 0 });
  });

  it('lists key ones first, then the newest', () => {
    const list = [mk({ areas: ['body'], title: 'Old' }, '2026-01-01'), mk({ areas: ['body'], title: 'New' }, '2026-11-01'), mk({ areas: ['body'], title: 'Key but old', key: true }, '2025-06-01')];
    expect(titles(AN.notesIn(list, 'body'))).toEqual(['Key but old', 'New', 'Old']);
  });
});

describe('labels and filters', () => {
  const branch = mk({ areas: ['work'], title: 'Drone EduTrain', branch: true });
  const list = [
    branch,
    mk({ areas: ['work'], title: 'Pitch deck', labels: ['Clients', 'drafts'], parent: branch.id }, '2026-03-01'),
    mk({ areas: ['work'], title: 'Team offsite', labels: ['team'], from: '2026-06-01', to: '2026-06-03' }, '2026-05-01'),
    mk({ areas: ['work'], title: 'Board meeting', key: true }, '2026-09-01'),
  ];

  it('lists the labels in use, and filters by label (looking inside sub-branches too)', () => {
    expect(AN.labelsIn(list, 'work')).toEqual(['Clients', 'drafts', 'team']);
    expect(titles(AN.notesIn(list, 'work', { filter: { label: 'clients' } }))).toEqual(['Pitch deck']);
  });

  it('filters by type', () => {
    expect(titles(AN.notesIn(list, 'work', { filter: { type: 'branches' } }))).toEqual(['Drone EduTrain']);
    expect(titles(AN.notesIn(list, 'work', { filter: { type: 'key' } }))).toEqual(['Board meeting']);
    expect(titles(AN.notesIn(list, 'work', { filter: { type: 'notes' } }))).toEqual(['Board meeting', 'Team offsite', 'Pitch deck']);
  });

  it('filters by dates: the days a note covers or was written on', () => {
    expect(titles(AN.notesIn(list, 'work', { filter: { from: '2026-06-02', to: '2026-06-30' } }))).toEqual(['Team offsite']);
    expect(titles(AN.notesIn(list, 'work', { filter: { from: '2026-08-01' } }))).toEqual(['Board meeting', 'Drone EduTrain']);
    expect(titles(AN.notesIn(list, 'work', { filter: { to: '2026-03-31', type: 'notes' } }))).toEqual(['Pitch deck']);
  });
});

describe('linked notes', () => {
  it('shows a link on both notes, and takes it off both', () => {
    const a = mk({ areas: ['people'], title: 'Dinner with Dana' });
    const b = mk({ areas: ['fun'], title: 'Concert tickets' });
    let list = [a, b];
    const put = (changed: LifeAreaNote[]) => (list = list.map((x) => changed.find((c) => c.id === x.id) || x));
    put(AN.linkNotes(list, a.id, b.id, 5000));
    expect(titles(AN.linked(list, a.id))).toEqual(['Concert tickets']);
    expect(titles(AN.linked(list, b.id))).toEqual(['Dinner with Dana']);
    expect(AN.linkNotes(list, a.id, b.id, 6000)).toEqual([]); // already linked
    expect(AN.linkNotes(list, a.id, a.id, 6000)).toEqual([]);
    expect(titles(AN.notesIn(list, 'fun', { filter: { type: 'linked' } }))).toEqual(['Concert tickets']);
    put(AN.unlinkNotes(list, b.id, a.id, 7000)); // from the other side
    expect(AN.linked(list, a.id)).toEqual([]);
    expect(AN.linked(list, b.id)).toEqual([]);
    // A deleted note isn't shown as linked.
    put(AN.linkNotes(list, a.id, b.id, 8000));
    put([AN.tombstone(b.id, 9000)]);
    expect(AN.linked(list, a.id)).toEqual([]);
  });
});

describe('notes that grow', () => {
  it('finds the earlier note in the same sub-branch, and keeps both dates when it grows', () => {
    const branch = mk({ areas: ['work'], title: 'Drone EduTrain', branch: true });
    const first = mk({ areas: ['work'], title: 'Client: Hila', text: 'Wants a demo.', parent: branch.id }, '2026-10-01');
    const older = mk({ areas: ['work'], title: 'Kickoff', parent: branch.id }, '2026-09-01');
    const list = [branch, first, older];
    expect(AN.earlierInBranch(list, branch.id)?.id).toBe(first.id);
    expect(AN.earlierInBranch(list, undefined)).toBeNull();
    const grown = AN.grow(first, 'Demo booked for Tuesday.', '2026-11-20', 9000)!;
    expect(grown.more).toEqual([{ day: '2026-11-20', text: 'Demo booked for Tuesday.' }]);
    expect(AN.daysOf(grown)).toEqual(['2026-10-01', '2026-11-20']);
    expect(AN.lastDay(grown)).toBe('2026-11-20');
    expect(AN.noteText(grown)).toBe('Client: Hila\nWants a demo.\nDemo booked for Tuesday.');
    // A grown note counts as written on both days for the date filter.
    expect(titles(AN.notesIn([branch, grown], 'work', { filter: { from: '2026-11-01', type: 'notes' } }))).toEqual(['Client: Hila']);
  });
});

describe('two devices', () => {
  const at = (x: number) => x;
  it('takes the newest of each note, a deletion wins a tie, and "Delete everything" takes what was before it', () => {
    const a = mk({ areas: ['work'], title: 'v1' }, '2026-11-01', at(100));
    const a2 = AN.editNote(a, { title: 'v2' }, at(200))!;
    const b = mk({ areas: ['fun'], title: 'b' }, '2026-11-01', at(100));
    const c = mk({ areas: ['fun'], title: 'c' }, '2026-11-01', at(300));
    const here = [a, b, c];
    const there = [a2, AN.tombstone(b.id, at(100))];
    const out = AN.mergeNotes(here, there, 1000);
    expect(out.map((x) => [x.id, x.title, !!x.gone])).toEqual([
      [a.id, 'v2', false],
      [b.id, '', true],
      [c.id, 'c', false],
    ]);
    // The same either way round.
    expect(AN.mergeNotes(there, here, 1000)).toEqual(out);
    // A wipe of everything at 250 takes a and b, not c (written after it).
    expect(AN.mergeNotes(here, there, 1000, [{ at: 250, what: 'all' }]).map((x) => x.title)).toEqual(['c']);
    // "Forget what Arise learned" leaves the Player's notes.
    expect(AN.mergeNotes(here, there, 1000, [{ at: 250, what: 'memory' }])).toHaveLength(3);
    // Tombstones go after 400 days.
    expect(AN.mergeNotes(out, [], 100 + 401 * 864e5).map((x) => x.id)).toEqual([a.id, c.id]);
  });

  it('travel in the memory pack, and a pack without them looks as it did', () => {
    const plain = { ...emptyContent(), facts: [] };
    expect(canonical(MEM, plain)).toBe(JSON.stringify({ v: 1, k: MEM, tombs: {}, facts: [], prefs: { paused: false, at: 0 }, wipes: [] }));
    const note = mk({ areas: ['work', 'money'], title: 'Raise', labels: ['pay'], key: true });
    const back = cleanContent(MEM, JSON.parse(canonical(MEM, { ...emptyContent(), notes: [note] })));
    expect(back.notes).toEqual([note]);
    const merged = mergeContent(MEM, { ...emptyContent(), notes: [note] }, emptyContent(), { now: 2000 });
    expect(merged.notes).toEqual([note]);
  });
});

describe('for the coach', () => {
  it('gives key notes first, with where they sit, and only to an AI that may read notes', () => {
    const branch = mk({ areas: ['work'], title: 'Drone EduTrain', branch: true, from: '2026-01-10' });
    const list = [mk({ areas: ['fun'], title: 'Guitar', text: 'Practise scales.' }, '2026-11-10'), branch, mk({ areas: ['work'], title: 'Launch in March', key: true, parent: branch.id }, '2026-01-01')];
    const { text, tier } = AN.coachSection(list, 2, 2000);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^## Their life areas/);
    expect(lines[1]).toBe('- [key] Work or study > Drone EduTrain: Launch in March');
    expect(text).toContain('- Fun and rest: Guitar: Practise scales.');
    expect(text).toContain('- Work or study: Drone EduTrain (a part of it) (2026-01-10 to now)');
    expect(tier).toBe(2);
    expect(AN.coachSection(list, 1, 2000)).toEqual({ text: '', tier: 1 });
    // Within the room it's given: the key one stays.
    expect(AN.coachSection(list, 3, lines[0].length + lines[1].length + 5).text.split('\n')).toEqual([lines[0], lines[1]]);
  });
});
