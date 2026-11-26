// How well Arise knows you, worked out on the device with no AI (pure, so it's tested on its own;
// the screen is life/knows-you-ui.js):
//   - how often its first guess is right, week by week: of what Arise wrote (facts it learned,
//     days it summed up, day stories), how much the Player had to put right with "Not quite? Fix
//     it" or "This isn't right" (life/fixes.ts). A corrected fact becomes the Player's own and a
//     fixed event was Arise's reading of the day, so each correction counts as something it wrote;
//   - what it would like to learn next: the gaps, in plain words, each with where to fill it.
// Nothing here is synced or sent anywhere.

export interface WrittenFact {
  from: 'ai' | 'you';
  since: string; // YYYY-MM-DD, the day it was learned
}
export interface WrittenSummary {
  kind: string; // 'day' | 'journal' count; week and month roll-ups don't show on their own
  key: string; // the day it's about
  edited?: boolean; // rewritten by the Player: no longer Arise's guess
}
export interface Correction {
  id: string;
  at: number;
}

export interface Week {
  monday: string;
  wrote: number;
  fixed: number;
  rate: number | null; // 0 to 1, null with nothing written
}

const DAY = 86_400_000;
const utc = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (k: string, n: number) => keyOf(utc(k) + n * DAY);
export const mondayOf = (k: string) => addDays(k, -((new Date(utc(k)).getUTCDay() + 6) % 7));
const localDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The last `weeks` weeks, oldest first, this week last.
export function hitWeeks({ facts, summaries, fixes, today, weeks = 8, dayOf = localDay }: { facts: readonly WrittenFact[]; summaries: readonly WrittenSummary[]; fixes: readonly Correction[]; today: string; weeks?: number; dayOf?: (t: number) => string }): Week[] {
  const out: Week[] = [];
  const first = addDays(mondayOf(today), -7 * (weeks - 1));
  for (let i = 0; i < weeks; i++) out.push({ monday: addDays(first, 7 * i), wrote: 0, fixed: 0, rate: null });
  const at = (k: string) => {
    if (!k || k < first || k > addDays(out[out.length - 1].monday, 6)) return null;
    return out[Math.floor((utc(k) - utc(first)) / (7 * DAY))] || null;
  };
  for (const f of facts) {
    const w = f.from === 'ai' ? at(f.since) : null;
    if (w) w.wrote++;
  }
  for (const s of summaries) {
    const w = (s.kind === 'day' || s.kind === 'journal') && !s.edited ? at(s.key) : null;
    if (w) w.wrote++;
  }
  for (const c of fixes) {
    const w = at(dayOf(c.at));
    if (w) {
      w.wrote++;
      w.fixed++;
    }
  }
  for (const w of out) w.rate = w.wrote ? (w.wrote - w.fixed) / w.wrote : null;
  return out;
}

// The last 4 weeks together: right first time, as a whole percentage, or null with nothing written.
export function hitRate(weeks: readonly Week[], last = 4): { wrote: number; fixed: number; percent: number | null } {
  const ws = weeks.slice(-last);
  const wrote = ws.reduce((a, w) => a + w.wrote, 0);
  const fixed = ws.reduce((a, w) => a + w.fixed, 0);
  return { wrote, fixed, percent: wrote ? Math.round(((wrote - fixed) / wrote) * 100) : null };
}

// ---------- what it would like to learn next

export interface GapInput {
  values: readonly string[]; // what matters most, from the life check-in
  bestTime: string; // '' when not said
  checkins: number; // daily check-ins in the last 30 days
  people: readonly string[]; // the names of people seen in calls and messages
  quiet: readonly { id: string; label: string; help?: string }[]; // parts of life with not enough to go on
}

export interface Gap {
  id: 'values' | 'best-time' | 'checkins' | 'names' | 'areas';
  text: string;
  hint?: string;
}

// A name that's only a number, an email address or a handle.
export const noName = (name: string) => {
  const n = String(name || '').trim();
  return !n || /^[+\d\s().-]+$/.test(n) || /@/.test(n) || !/\p{L}/u.test(n);
};

export const FEW_CHECKINS = 4; // in 30 days

// The gaps, the most useful first.
export function learnNext(g: GapInput): Gap[] {
  const out: Gap[] = [];
  if (!g.values.length) out.push({ id: 'values', text: 'What matters most to you.', hint: 'Pick up to 3 in your life check-in.' });
  if (!g.bestTime) out.push({ id: 'best-time', text: 'When you think best.', hint: 'Your plan puts hard work in those hours.' });
  if (g.checkins < FEW_CHECKINS) out.push({ id: 'checkins', text: 'How your days feel.', hint: g.checkins ? `${g.checkins} check-in${g.checkins === 1 ? '' : 's'} in the last 30 days. One a week is plenty.` : 'No check-ins in the last 30 days. One a week is plenty.' });
  const unnamed = g.people.filter(noName).length;
  if (unnamed) out.push({ id: 'names', text: `Who ${unnamed === 1 ? '1 person is' : `${unnamed} people are`} in your calls and messages.`, hint: `${unnamed === 1 ? 'It shows' : 'They show'} as a number or handle. Add a name in People.` });
  if (g.quiet.length) {
    // (Some names have "and" in them, so more than one is a list.)
    const text = g.quiet.length === 1 ? `More about your ${g.quiet[0].label.toLowerCase()}.` : `More about these parts of your life: ${g.quiet.map((a) => a.label).join(' · ')}.`;
    out.push({ id: 'areas', text, hint: g.quiet.length === 1 && g.quiet[0].help ? g.quiet[0].help : 'Nothing in your log says much about these yet. A short note now and then is enough.' });
  }
  return out;
}
