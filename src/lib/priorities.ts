// What matters, and when: the next 14 days in four boxes, worked out on the device with no AI.
//   Do now: matters a lot and due within 2 days (or late).
//   Plan ahead: matters a lot, due later (or with no day).
//   Keep it light: due soon, but small.
//   Can wait: the rest.
// What "matters a lot" means: a to-do marked so, a goal's milestone, money you owe with a day to
// pay it back, or words like exam, deadline, interview, rent or doctor. Pure: src/ahead.ts gathers
// the items, and the same items always give the same boxes.

export interface Item {
  id: string;
  title: string;
  kind: 'todo' | 'event' | 'milestone' | 'debt';
  day?: string; // YYYY-MM-DD it's due or happens
  big?: boolean; // marked as mattering a lot
  note?: string; // shown under it ("For Learn Spanish")
}

export type Box = 'now' | 'plan' | 'light' | 'wait';
export interface Grid {
  now: Item[];
  plan: Item[];
  light: Item[];
  wait: Item[];
}

export const HORIZON = 14;
const SOON = 2;
const BIG_WORDS = /\b(exams?|tests?|deadlines?|due|interviews?|submit|submission|essays?|dissertation|thesis|presentations?|rent|bills?|tax|taxes|invoice|doctor|dentist|hospital|gp|appointment|flights?|court|applications?|apply|contract|payment|pay back|repay|mortgage|loan|insurance|passport|offer)\b/i;

const addDays = (k: string, n: number) => {
  const [y, m, d] = k.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};

export const matters = (it: Item) => !!it.big || it.kind === 'milestone' || it.kind === 'debt' || BIG_WORDS.test(it.title);

export function boxOf(it: Item, today: string): Box {
  const soon = !!it.day && it.day <= addDays(today, SOON);
  const big = matters(it);
  if (big) return soon ? 'now' : 'plan';
  return soon ? 'light' : 'wait';
}

// Only what's late, within the next 14 days, or has no day (events need a day).
export function grid(items: readonly Item[], today: string): Grid {
  const last = addDays(today, HORIZON);
  const out: Grid = { now: [], plan: [], light: [], wait: [] };
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (it.day && it.day > last) continue;
    if (it.kind === 'event' && (!it.day || it.day < today)) continue;
    out[boxOf(it, today)].push(it);
  }
  const order = (a: Item, b: Item) => (a.day || '9999').localeCompare(b.day || '9999') || a.title.localeCompare(b.title);
  for (const k of Object.keys(out) as Box[]) out[k].sort(order);
  return out;
}

export const BOXES: { key: Box; title: string; hint: string }[] = [
  { key: 'now', title: 'Do now', hint: 'Matters a lot, and due within 2 days.' },
  { key: 'plan', title: 'Plan ahead', hint: 'Matters a lot, with time to spare. Give it a slot.' },
  { key: 'light', title: 'Keep it light', hint: 'Due soon, but small. Do it quickly or hand it off.' },
  { key: 'wait', title: 'Can wait', hint: 'Fine to leave for now.' },
];
