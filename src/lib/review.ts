// Your week in review: on Sunday afternoon and Monday morning, Today looks back at the week that's
// ending (Monday to Sunday) and ahead to the next, worked out on the device with no AI. What got
// done, how the quests went, sleep and mood if Arise has them, and one thing to try next week.

export interface ReviewInput {
  monday: string; // the week looked back on
  todosDone: string[]; // titles done that week
  todosLate: number; // still open, due before the week ended
  quests: { title: string; done: number; due: number }[]; // that week
  workouts: number;
  milestones: string[]; // milestones done that week
  sleep: number[]; // minutes a night, the nights Arise knows
  mood: number[]; // 1 to 5 from check-ins
  energy: number[];
  focusMin: number; // time in work and study apps and sites, if known
  nextDeadlines: { title: string; due: string }[]; // next week's milestones and big to-dos
  nextEvents: number; // events on the calendar next week
}

export interface Review {
  title: string;
  wins: string[];
  numbers: string[];
  try: string; // one thing for next week
  ahead: string[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const hm = (min: number) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
};
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export function review(r: ReviewInput): Review {
  const wins: string[] = [];
  if (r.todosDone.length) wins.push(`${n(r.todosDone.length, 'to-do')} done${r.todosDone.length <= 3 ? `: ${r.todosDone.join(', ')}` : `, like ${r.todosDone.slice(0, 2).join(' and ')}`}.`);
  for (const m of r.milestones.slice(0, 3)) wins.push(`Milestone reached: ${m}.`);
  const best = r.quests.filter((q) => q.due && q.done >= q.due).map((q) => q.title);
  if (best.length) wins.push(`Every time this week: ${best.slice(0, 3).join(', ')}.`);
  if (r.workouts) wins.push(`${n(r.workouts, 'workout')}.`);
  if (!wins.length) wins.push('A quiet week. That counts too.');

  const numbers: string[] = [];
  const due = r.quests.reduce((a, q) => a + q.due, 0);
  const done = r.quests.reduce((a, q) => a + Math.min(q.done, q.due), 0);
  if (due) numbers.push(`Quests: ${done} of ${due} (${Math.round((done / due) * 100)}%).`);
  if (r.sleep.length >= 3) numbers.push(`Sleep: ${hm(avg(r.sleep))} a night on average.`);
  if (r.mood.length >= 2) numbers.push(`Mood: ${avg(r.mood).toFixed(1)} out of 5${r.energy.length >= 2 ? `, energy ${avg(r.energy).toFixed(1)}` : ''}.`);
  if (r.focusMin >= 60) numbers.push(`Focused work: ${hm(r.focusMin)}.`);
  if (r.todosLate) numbers.push(`${n(r.todosLate, 'to-do')} still late.`);

  // One thing to try: the weakest spot, said kindly.
  let tryNext = 'Keep the same rhythm next week, and pick the 3 things that matter on Monday.';
  const weakest = r.quests.filter((q) => q.due >= 2).sort((a, b) => a.done / a.due - b.done / b.due)[0];
  if (r.sleep.length >= 3 && avg(r.sleep) < 6.5 * 60) tryNext = 'Sleep was short. Try a fixed bedtime on weeknights, even 30 minutes earlier helps.';
  else if (weakest && weakest.done / weakest.due < 0.5) tryNext = `"${weakest.title}" happened ${weakest.done} of ${weakest.due} times. Make it smaller, or move it to the time of day that works best for you.`;
  else if (r.todosLate >= 3) tryNext = `${r.todosLate} to-dos are late. Pick the one that matters, and drop or move the rest.`;

  const ahead: string[] = [];
  if (r.nextEvents) ahead.push(`${n(r.nextEvents, 'event')} on your calendar.`);
  for (const d of r.nextDeadlines.slice(0, 3)) ahead.push(`Due ${d.due}: ${d.title}.`);
  if (!ahead.length) ahead.push('Nothing fixed yet. A good week to get ahead.');

  return { title: 'Your week', wins, numbers, try: tryNext, ahead };
}
