// Which tabs show (Settings, Tabs). Coach and Goals are off the tab bar unless turned on, on this
// device: their screens stay, opened from Me (moreCard) and from Today.

import { esc, icon } from './ui.js';

const KEY = 'arise-tabs-shown';
export const OPTIONAL = [
  ['goals', 'Goals', 'Your goals, quests, milestones and the workout plan.'],
  ['coach', 'Coach', 'Chat with your coach, Help me decide, Write it my way.'],
];

export function shown() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => OPTIONAL.some(([id]) => id === x)) : [];
  } catch {
    return [];
  }
}
export const isShown = (id) => !OPTIONAL.some(([x]) => x === id) || shown().includes(id);

export function setShown(id, on) {
  const next = new Set(shown());
  if (on) next.add(id);
  else next.delete(id);
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {}
}

export function settingsHTML() {
  return `<section class="panel" id="tabsPanel"><div class="panel-title">${icon('settings')}<span>Tabs</span></div>
    <p class="muted small">Show these on the tab bar. Off, they're still in Me, under More of Arise. For this device only.</p>
    ${OPTIONAL.map(([id, label, what]) => `<label class="check"><input type="checkbox" data-tab-shown="${id}" ${isShown(id) ? 'checked' : ''}> ${esc(label)} <span class="muted small">· ${esc(what)}</span></label>`).join('')}
  </section>`;
}

// On Me: the screens whose tabs are off.
export function moreCard() {
  const off = OPTIONAL.filter(([id]) => !isShown(id));
  if (!off.length) return '';
  return `<section class="panel more-card"><h2 class="panel-title">${icon('arise')}<span>More of Arise</span></h2>
    <div class="row wrap">${off.map(([id, label]) => `<button class="btn small" data-act="nav" data-v="${id}">${icon(id === 'goals' ? 'target' : 'chat')} ${esc(label)}</button>`).join('')}</div>
  </section>`;
}
