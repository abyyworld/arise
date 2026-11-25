// "A quick one": short questions from your coach on Today, worked out on the device with no AI,
// from what Arise can see is unclear or stuck. One at a time, each with buttons that do the thing
// straight away (move a late to-do, pause a goal, mark money paid back), or a few words for the
// weekly one. An answered or skipped question is put away on every device (store.ts dismissWarning,
// the same list as the early warnings), so it never asks twice.

export interface Choice {
  label: string;
  act: string; // what it does (everyday-ui.js answer)
  v?: string;
}

export interface Question {
  id: string; // stable: put away under 'q:<id>'
  text: string;
  hint?: string;
  choices: Choice[];
  write?: { placeholder: string; act: string }; // a few words in a box instead
}

export interface QInput {
  today: string; // YYYY-MM-DD
  hour: number; // 0 to 23, local
  weekday: number; // 0 Sunday to 6 Saturday
  monday: string; // this week's Monday
  todos: { id: string; title: string; day?: string; done?: number }[];
  goals: { id: string; title: string; quests: number; lastTick: string | null; created: string }[]; // active ones
  owed: { id: string; who: string; text: string; due?: string }[]; // money owed to them, not settled
  bestTime: string; // '' when not said
  weekBig: number; // to-dos marked as mattering a lot, not done, due this week
  dismissed: Record<string, unknown>;
  loose?: { id: string; text: string; at: number }[]; // loose ends in their notes (lib/loose.ts)
  now?: number;
}

// Getting to know you: one of these on a quiet day, answered in a few words, kept as a note in
// the life log so the coach and the memory learn it.
export const KNOW = [
  'What does a good day look like for you?',
  'Who do you turn to when things get hard?',
  'What drains your energy most?',
  'What are you proudest of this year?',
  'When do you feel most like yourself?',
  'What is one habit you would like to drop?',
  'What would you do with a completely free Saturday?',
  'What do you wish people knew about you?',
  'What are you looking forward to right now?',
  'What is something you keep putting off, and why?',
  'Which people give you energy?',
  'What did you learn the hard way this year?',
];

const addDays = (k: string, n: number) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Every question that fits now, the most useful first.
export function questions(q: QInput): Question[] {
  const out: Question[] = [];
  const seen = (id: string) => q.dismissed[`q:${id}`] != null;
  const add = (x: Question) => {
    if (!seen(x.id)) out.push(x);
  };

  // Monday to Wednesday, if nothing this week is marked as mattering a lot yet.
  if (q.weekday >= 1 && q.weekday <= 3 && q.weekBig === 0)
    add({
      id: `week:${q.monday}`,
      text: 'What are the 3 things that matter most this week?',
      hint: 'One a line. They go on your to-do list for this week, marked as mattering a lot.',
      choices: [],
      write: { placeholder: 'Finish the essay draft\nEmail Eyal\nBook the dentist', act: 'q-week' },
    });

  // Money owed to them, past its day.
  for (const d of q.owed) {
    if (!d.due || d.due >= q.today) continue;
    add({ id: `owed:${d.id}`, text: `Did ${d.who} pay you back?`, hint: d.text, choices: [{ label: 'Yes, paid', act: 'q-paid', v: d.id }, { label: 'Not yet', act: 'q-skip' }] });
  }

  // To-dos 3 or more days late.
  for (const t of q.todos) {
    if (t.done || !t.day || t.day > addDays(q.today, -3)) continue;
    add({
      id: `late:${t.id}:${t.day}`,
      text: `Still want to do "${short(t.title)}"?`,
      hint: `It was due ${t.day}.`,
      choices: [
        { label: 'Today', act: 'q-todo-day', v: `${t.id}|${q.today}` },
        { label: 'Next week', act: 'q-todo-day', v: `${t.id}|${addDays(q.today, 7)}` },
        { label: 'Drop it', act: 'q-todo-drop', v: t.id },
      ],
    });
  }

  // Loose ends in their own notes, a day or more old: did it happen?
  for (const l of q.loose || []) {
    if ((q.now ?? Date.now()) - l.at < 86_400_000) continue;
    add({
      id: `loose:${l.id}`,
      text: `You wrote "${short(l.text, 70)}". Did it happen?`,
      hint: `In your notes, ${new Date(l.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}.`,
      choices: [
        { label: 'Done', act: 'q-loose-done' },
        { label: 'Make it a to-do', act: 'q-loose-todo', v: l.text },
        { label: 'Not a thing', act: 'q-skip' },
      ],
    });
  }

  // A goal with quests and nothing ticked for a week (and older than a week).
  for (const g of q.goals) {
    if (!g.quests || g.created > addDays(q.today, -7)) continue;
    if (g.lastTick && g.lastTick > addDays(q.today, -7)) continue;
    add({
      id: `quiet:${g.id}:${q.monday}`,
      text: `Nothing for "${short(g.title)}" this past week. Still on it?`,
      choices: [
        { label: 'Yes, keep it', act: 'q-skip' },
        { label: 'Pause it', act: 'q-goal-pause', v: g.id },
      ],
    });
  }

  if (!q.bestTime)
    add({
      id: 'best-time',
      text: 'When do you think best?',
      hint: 'Your plan puts hard work in those hours.',
      choices: [
        { label: 'Morning', act: 'q-best', v: 'morning' },
        { label: 'Afternoon', act: 'q-best', v: 'afternoon' },
        { label: 'Evening', act: 'q-best', v: 'evening' },
        { label: 'Not sure', act: 'q-skip' },
      ],
    });

  // Nothing else to ask: one question to get to know them, a new one each day.
  if (!out.length) {
    const day = Math.floor(Date.UTC(+q.today.slice(0, 4), +q.today.slice(5, 7) - 1, +q.today.slice(8, 10)) / 86_400_000);
    const left = KNOW.map((text, i) => ({ text, i })).filter((k) => !seen(`know:${k.i}`));
    if (left.length && !seen(`know-day:${q.today}`)) {
      const k = left[day % left.length];
      add({ id: `know:${k.i}`, text: k.text, hint: 'Getting to know you. A few words is plenty; they stay in your notes.', choices: [], write: { placeholder: 'Write a few words', act: 'q-know' } });
    }
  }

  return out;
}

// The 3 things, from a few lines.
export const threeThings = (text: string) =>
  text
    .split(/\n|;/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
