// Decisions: a choice the Player asked Arise about, the options it laid out with its pick and
// reasons, what they chose and what they expected, and, weeks later, how it went. Synced end-to-end
// encrypted with the rest (since SCHEMA 11).
//
// Like to-dos, each one keeps the time it last changed (`at`); a deleted one stays as a tombstone
// (`gone`) for a while so another device can't bring it back, and two copies merge per decision:
// the later change wins.

export interface Option {
  name: string;
  costs: string; // what it costs: time, money, sleep, people
  gains: string; // what it moves them toward
}

export type Outcome = 'better' | 'expected' | 'worse';

export interface Decision {
  id: string;
  question: string;
  details?: string; // what they added: the options they see, what matters
  options: Option[];
  pick?: string; // the option Arise would pick (its name)
  why?: string; // why, in a few sentences
  unknown?: string; // what Arise doesn't know
  chose?: string; // what they chose: an option's name, or their own words
  expect?: string; // what they expect to happen
  checkOn?: string; // YYYY-MM-DD: when Arise asks how it went
  outcome?: Outcome;
  note?: string; // how it went, in their words
  closed?: number; // when they said how it went
  tier?: 2 | 3; // the most private part of the life log Arise's advice was made from (life/tiers.ts)
  created: number;
  at: number; // when it last changed
  gone?: true;
}
export type Decisions = Record<string, Decision>;

export const MAX_DECISIONS = 300;
const KEEP_GONE = 180 * 86_400_000;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OUTCOMES: readonly Outcome[] = ['better', 'expected', 'worse'];
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max) : '');

export const newDecisionId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function cleanOption(raw: unknown): Option | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = line(r.name, 120);
  if (!name) return null;
  return { name, costs: line(r.costs, 600), gains: line(r.gains, 600) };
}

export function cleanDecision(raw: unknown): Decision | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id) || !isTime(r.at)) return null;
  const created = isTime(r.created) ? r.created : r.at;
  if (r.gone === true) return { id: r.id, question: '', options: [], created, at: r.at, gone: true };
  const question = line(r.question, 600);
  if (!question) return null;
  const out: Decision = { id: r.id, question, options: (Array.isArray(r.options) ? r.options : []).map(cleanOption).filter((o): o is Option => !!o).slice(0, 6), created, at: r.at };
  const text = (k: 'details' | 'pick' | 'why' | 'unknown' | 'chose' | 'expect' | 'note', max: number) => {
    const v = line(r[k], max);
    if (v) out[k] = v;
  };
  text('details', 2000);
  text('pick', 120);
  text('why', 2000);
  text('unknown', 1000);
  text('chose', 200);
  text('expect', 600);
  text('note', 1000);
  if (typeof r.checkOn === 'string' && DAY.test(r.checkOn)) out.checkOn = r.checkOn;
  if (OUTCOMES.includes(r.outcome as Outcome)) out.outcome = r.outcome as Outcome;
  if (isTime(r.closed)) out.closed = r.closed;
  if (r.tier === 2 || r.tier === 3) out.tier = r.tier;
  return out;
}

// Old tombstones go; past the most kept, the oldest changes go first (decisions and deletions each
// on their own). In a fixed order (by id), so the same decisions always save the same.
export function cleanDecisions(raw: unknown, now = Date.now()): Decisions {
  const out: Decision[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const d = cleanDecision(v);
      if (!d || d.id !== k) continue;
      if (d.gone && now - d.at > KEEP_GONE) continue;
      out.push(d);
    }
  }
  const newest = (list: Decision[]) => list.sort((a, b) => b.at - a.at).slice(0, MAX_DECISIONS);
  const kept = [...newest(out.filter((d) => !d.gone)), ...newest(out.filter((d) => d.gone))];
  kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.fromEntries(kept.map((d) => [d.id, d]));
}

export function mergeDecisions(a: Decisions, b: Decisions, now = Date.now()): Decisions {
  const out: Decisions = { ...a };
  for (const [id, d] of Object.entries(b)) if (!out[id] || d.at > out[id].at) out[id] = d;
  return cleanDecisions(out, now);
}

export const liveDecisions = (all: Decisions) =>
  Object.values(all)
    .filter((d) => !d.gone)
    .sort((a, b) => b.created - a.created);

// Saved with a choice, past its check-back day, and nobody said how it went yet.
export const dueBack = (all: Decisions, today: string) => liveDecisions(all).filter((d) => d.chose && d.checkOn && d.checkOn <= today && !d.outcome);

export const OUTCOME_TEXT: Record<Outcome, string> = { better: 'Better than expected', expected: 'About as expected', worse: 'Worse than expected' };

// For the coach: the decisions they made and how they went, so its advice learns what works for
// them. Only the ones whose advice this AI may read (`cap`: a decision made from a more private
// part of the life log stays out).
export function decisionsText(all: Decisions, most = 8, cap = 1): string {
  const list = liveDecisions(all)
    .filter((d) => d.chose && (d.tier || 1) <= cap)
    .slice(0, most);
  if (!list.length) return '';
  const lines = list.map((d) => {
    const when = new Date(d.created).toISOString().slice(0, 10);
    const advice = d.pick ? (d.pick === d.chose ? ' (Arise picked the same)' : ` (Arise picked ${d.pick})`) : '';
    const how = d.outcome ? ` How it went: ${OUTCOME_TEXT[d.outcome].toLowerCase()}${d.note ? `: ${d.note}` : ''}.` : d.checkOn ? ` Not known yet (checking back ${d.checkOn}).` : '';
    return `- ${when}: ${d.question} Chose: ${d.chose}${advice}.${d.expect ? ` Expected: ${d.expect}.` : ''}${how}`;
  });
  return ["## Decisions I made with Arise's help, and how they went (learn from these which advice works for me)", ...lines].join('\n');
}

// Warnings the Player put away (lib/ahead.ts): id -> when. Merged by keeping both; old ones go.
export type Dismissed = Record<string, number>;
const KEEP_DISMISSED = 120 * 86_400_000;
export function cleanDismissed(raw: unknown, now = Date.now()): Dismissed {
  const out: [string, number][] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k.length > 200 || !isTime(v) || now - v > KEEP_DISMISSED) continue;
      out.push([k, v]);
    }
  }
  out.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(out.slice(0, 500).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
export function mergeDismissed(a: Dismissed, b: Dismissed, now = Date.now()): Dismissed {
  const out: Dismissed = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v);
  return cleanDismissed(out, now);
}
