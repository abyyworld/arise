// Habits that learn, on Me: the one or two things that most often came with the Player's good
// days over the last 8 weeks (lib/habits.ts), how sure that is, and one small habit to try, with
// "Make it a quest" (on a goal they pick, or a new Habits goal) and "Not for me" (put away for
// good). Worked out on this device with no AI (life/habits.ts). It never says one thing causes
// another, only that they came together.

import './styles/habits.css';
import * as S from './store';
import * as G from './lib/goals';
import * as HB from './life/habits';
import { MIN_CHECKINS } from './lib/habits';
import { closeSheet, esc, openSheet, toast } from './ui.js';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const MAX_AGE = 10 * 60000;

let shown = []; // the findings on screen
let gen = 0;
export function forgetHabitsUI() {
  gen++;
  shown = [];
}
S.onReset(forgetHabitsUI);

const head = '<div class="panel-title"><span>Habits that help</span></div>';
const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

export function habitsPanel() {
  return `<section class="panel habits" id="habitsPanel">${inner(HB.peek())}</section>`;
}

function inner(r) {
  if (!r) return `${head}<p class="muted small">Looking at your days…</p>`;
  if (!r.ready) {
    shown = [];
    return `${head}<p class="muted">This needs at least ${MIN_CHECKINS} days with a check-in in the last 8 weeks, so Arise can see which days went well. You have ${days(r.checkins)} so far.</p>`;
  }
  shown = r.findings;
  if (!shown.length) return `${head}<p class="muted">Nothing stands out yet in your last 8 weeks. Something shows here once one thing comes with your good days often enough.</p>`;
  const [top, ...rest] = shown;
  return `${head}
    <div class="habit-top">
      <p class="habit-text">${esc(top.text)}</p>
      <p class="muted small">${esc(top.other)} ${esc(top.sureText)}</p>
      <p class="habit-try"><b>${esc(top.try)}</b></p>
      <div class="row">
        <button class="btn small primary" data-act="habit-quest" data-i="0">Make it a quest</button>
        <button class="btn small ghost" data-act="habit-off" data-i="0">Not for me</button>
      </div>
    </div>
    ${rest.map((f) => `<div class="habit-also"><p class="small">Also: ${esc(f.text)}</p><p class="muted small">${esc(f.other)} ${esc(f.sureText)}</p></div>`).join('')}
    <p class="muted small">From your own last 8 weeks. These came with your good days; that doesn't mean one caused the other.</p>`;
}

export async function fillHabits() {
  const g = gen;
  const el = $('#habitsPanel');
  if (!el) return;
  let r = null;
  try {
    r = await HB.get({ maxAge: MAX_AGE });
  } catch {}
  if (g === gen && el.isConnected) el.innerHTML = inner(r);
}

function redraw() {
  const el = $('#habitsPanel');
  if (el) el.innerHTML = inner(HB.peek());
}

// The goal a new habit quest goes to, picked in the sheet: a goal they have, or a new Habits goal.
function questSheet(f) {
  const goals = S.activeGoals();
  const habits = goals.find((g) => g.category === 'habits');
  const pick = habits?.id || 'new';
  const opt = (id, label) => `<label class="habit-goal"><input type="radio" name="habitGoal" value="${esc(id)}"${id === pick ? ' checked' : ''}> ${esc(label)}</label>`;
  openSheet(`<div class="habit-sheet" data-id="${esc(f.id)}">
    <p class="kicker">Make it a quest</p><h2 class="display sheet-title">${esc(f.quest.title)}</h2>
    <p class="muted small">${esc(G.scheduleText(f.quest.schedule).replace(/^./, (c) => c.toUpperCase()))}. You can change it later on Goals.</p>
    <fieldset class="habit-goals"><legend>Add it to</legend>
      ${goals.map((g) => opt(g.id, g.title)).join('')}
      ${habits ? '' : opt('new', 'A new goal: Habits')}
    </fieldset>
    <div class="row"><button class="btn primary small" data-act="habit-add">Add the quest</button></div>
  </div>`);
}

function addQuest() {
  const sheet = $('.habit-sheet');
  const f = shown.find((x) => x.id === sheet?.dataset.id);
  if (!f) return;
  const to = $('input[name="habitGoal"]:checked')?.value || 'new';
  const quest = { id: G.newId(), title: f.quest.title, schedule: f.quest.schedule, created: S.todayKey() };
  let goal = to === 'new' ? null : S.goalById(to);
  if (goal) goal = S.saveGoal({ ...goal, quests: [...goal.quests, quest] });
  else goal = S.saveGoal({ id: G.newId(), title: 'Habits', category: 'habits', why: '', by: '', created: S.todayKey(), status: 'active', quests: [quest], measures: [], milestones: [] });
  if (!goal) return;
  HB.putAwayHabit(f.id);
  closeSheet();
  toast(`Added to ${goal.title}.`);
  redraw();
}

export function handleAction(act, el) {
  if (act === 'habit-quest') {
    const f = shown[Number(el.dataset.i)];
    if (f) questSheet(f);
    return true;
  }
  if (act === 'habit-off') {
    const f = shown[Number(el.dataset.i)];
    if (f) {
      HB.putAwayHabit(f.id);
      toast("Put away. Arise won't suggest it again.");
      redraw();
    }
    return true;
  }
  if (act === 'habit-add') {
    addQuest();
    return true;
  }
  return false;
}
