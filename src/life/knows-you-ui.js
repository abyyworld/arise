// "How well Arise knows you" on What Arise knows (the sums are lib/knows-you.ts): how often its
// first guess is right, what it would like to learn next, and how many quick questions are left
// today (at most 6: lib/questions.ts). Worked out on this device; nothing is sent.

import * as S from '../store';
import { esc, fmt, toast } from '../ui.js';
import * as M from './memory';
import * as INS from './insight';
import * as PEOPLE from '../people';
import { readFixes } from './fix-store';
import { hasCheckin } from '../lib/life-check';
import { hitRate, hitWeeks, learnNext } from '../lib/knows-you';
import { DAILY_QUESTIONS, questionsLeft } from '../lib/questions';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const WEEKS = 4;

export const panel = () => `<section class="panel" id="kyPanel">
    <div class="panel-title"><span>How well Arise knows you</span></div>
    <div id="kyBody"><p class="muted small">Reading…</p></div>
  </section>`;

// What goes into the sums, gathered from the store, the memory and the life log.
export async function gather(now = Date.now()) {
  const today = S.todayKey();
  const from = S.addDays(today, -7 * 8);
  let facts = [];
  let summaries = [];
  try {
    await M.load();
    facts = M.allFacts();
    summaries = M.daySummaries();
    for (let k = from; k <= today; k = S.addDays(k, 1)) {
      const j = M.journalFor(k);
      if (j) summaries.push(j);
    }
  } catch {}
  const fixes = await readFixes();
  let quiet = [];
  try {
    const ins = await INS.get({ maxAge: 10 * 60_000 });
    quiet = (ins?.areas || []).filter((a) => a.score == null && !a.fixed).map((a) => ({ id: a.id, label: a.label, help: a.help }));
  } catch {}
  let people = [];
  try {
    await PEOPLE.refresh();
    people = PEOPLE.shown(now).map((r) => r.name);
  } catch {}
  const st = S.state;
  const month = S.addDays(today, -29);
  return {
    weeks: hitWeeks({ facts, summaries, fixes, today, weeks: 8 }),
    gaps: learnNext({
      values: st.profile?.life?.values || [],
      bestTime: st.settings.bestTime || st.profile?.time || '',
      checkins: Object.entries(st.logs).filter(([d, l]) => d >= month && d <= today && hasCheckin(l)).length,
      people,
      quiet,
    }),
    left: questionsLeft(st.dismissed, S.parseKey(today).getTime()),
  };
}

const GAP_ACTS = {
  values: () => '<button class="link" data-act="life-checkin">Do the life check-in</button>',
  'best-time': () => ['morning', 'afternoon', 'evening'].map((v) => `<button class="link" data-act="knowsyou-best" data-v="${v}">${v[0].toUpperCase()}${v.slice(1)}</button>`).join(''),
  names: () => '<button class="link" data-act="nav" data-v="people">Open People</button>',
};

export function bodyHTML({ weeks, gaps, left }) {
  const r = hitRate(weeks, WEEKS);
  const recent = weeks.slice(-WEEKS).filter((w) => w.wrote);
  const rate = r.percent == null
    ? '<p class="small">Nothing to go on yet. Once Arise has learned from a few of your days, this shows how often it gets things right first time.</p>'
    : `<p><b>${r.percent}% right first time</b> in the last 4 weeks.</p>
      <p class="muted small">${r.wrote} written, ${r.fixed} fixed by you. That counts facts it learned, days it summed up and day stories.</p>
      <ul class="ky-weeks small">${recent.map((w) => `<li><span>Week of ${esc(fmt(w.monday, { day: 'numeric', month: 'short' }))}</span><span class="muted">${w.wrote} written, ${w.fixed} fixed</span></li>`).join('')}</ul>`;
  const learn = gaps.length
    ? `<ul class="fact-list">${gaps.map((g) => `<li class="fact" data-gap="${esc(g.id)}"><p class="fact-text">${esc(g.text)}</p>${g.hint ? `<p class="muted small">${esc(g.hint)}</p>` : ''}${GAP_ACTS[g.id] ? `<div class="fact-acts">${GAP_ACTS[g.id]()}</div>` : ''}</li>`).join('')}</ul>`
    : '<p class="muted small">Nothing obvious. It keeps learning from your days.</p>';
  return `${rate}
    <p class="label">What it would like to learn next</p>
    ${learn}
    <p class="muted small" id="kyLeft">Quick questions left today: ${left} of ${DAILY_QUESTIONS}. It never asks more than that.</p>`;
}

let token = 0;
export async function fill() {
  const mine = ++token;
  let data;
  try {
    data = await gather();
  } catch {
    return;
  }
  const el = $('#kyBody');
  if (mine === token && el) el.innerHTML = bodyHTML(data);
}

export function handleAction(act, el) {
  if (act !== 'knowsyou-best') return false;
  const v = el?.dataset?.v;
  if (!['morning', 'afternoon', 'evening'].includes(v)) return true;
  S.state.settings.bestTime = v;
  S.save();
  toast('Saved. Your plan uses it from now on.');
  void fill();
  return true;
}
