// The morning brief: your day in a few lines, at the time you pick (Settings, Your plan and next
// steps). Worked out on the device with no AI: what's on your calendar, your to-dos, deadlines
// coming up, quests, money you owe and groceries. The phone apps plan it as a notification; the
// web app shows it while open; Today shows it as a card in the morning (src/brief.ts gathers it).
// On the lock screen it's plain ("Your day: 3 events, 4 to-dos") unless details are on.

export interface BriefInput {
  day: string; // YYYY-MM-DD
  events: { start: number; title: string; allDay: boolean }[]; // that day, in time order
  todos: { title: string; late: boolean; time?: string }[]; // due that day or late, not done
  deadlines: { title: string; due: string; goal: string }[]; // milestones within 7 days
  quests: number; // due that day
  owe: { text: string; due: string }[]; // money they owe, due by that day
  groceries: number; // to buy
}

export interface Brief {
  lines: string[]; // for the card
  title: string; // for a notification
  body: string; // with details
  plain: string; // for the lock screen without details
}

const hm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export function brief(b: BriefInput): Brief {
  const lines: string[] = [];
  if (b.events.length) {
    const timed = b.events.filter((e) => !e.allDay);
    const first = timed[0] || b.events[0];
    lines.push(`${n(b.events.length, 'event')}. ${first.allDay ? 'All day' : `First at ${hm(first.start)}`}: ${first.title}.`);
  }
  const late = b.todos.filter((t) => t.late).length;
  if (b.todos.length) lines.push(`${n(b.todos.length, 'to-do')}${late ? `, ${late} late` : ''}: ${b.todos.slice(0, 3).map((t) => t.title).join(', ')}${b.todos.length > 3 ? '...' : ''}.`);
  if (b.quests) lines.push(`${n(b.quests, 'quest')} for your goals.`);
  for (const d of b.deadlines.slice(0, 2)) lines.push(`${d.due === b.day ? 'Due today' : `Due ${d.due}`}: ${d.title} (${d.goal}).`);
  for (const o of b.owe.slice(0, 2)) lines.push(`${o.due < b.day ? 'Was due' : 'Due today'}: ${o.text}.`);
  if (b.groceries) lines.push(`${n(b.groceries, 'thing')} on your grocery list.`);
  if (!lines.length) lines.push('Nothing planned. A good day to get ahead on a goal.');
  const counts = [b.events.length ? n(b.events.length, 'event') : '', b.todos.length ? n(b.todos.length, 'to-do') : '', b.deadlines.length ? n(b.deadlines.length, 'deadline') : ''].filter(Boolean);
  return {
    lines,
    title: 'Your morning brief',
    body: lines.slice(0, 4).join(' '),
    plain: counts.length ? `Your day: ${counts.join(', ')}.` : 'Your day is clear so far.',
  };
}
