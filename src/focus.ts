// Focus: a timed block of work, started from the plan (a quest, a to-do, a milestone) or on its
// own. Kept on this device so a reload or a closed tab doesn't lose it; its end comes as a
// notification through the plan's path (native.js useNudges, todo-alerts.js on the web). When it
// ends, the quest can be ticked or the to-do marked done, and the time goes in the life log.

const KEY = 'arise-focus';

export interface Focus {
  title: string;
  task?: string; // the plan's task id: 'q:<quest>', 't:<todo>', 'm:<milestone>', 'w:<day>'
  start: number;
  min: number;
  paused?: number; // when it was paused
  away?: number; // milliseconds spent paused before
}

export function current(): Focus | null {
  try {
    const f = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!f || typeof f.title !== 'string' || !(f.start > 0) || !(f.min > 0 && f.min <= 240)) return null;
    return f;
  } catch {
    return null;
  }
}
function put(f: Focus | null) {
  try {
    if (f) localStorage.setItem(KEY, JSON.stringify(f));
    else localStorage.removeItem(KEY);
  } catch {}
}

export function start(title: string, min: number, task?: string, now = Date.now()): Focus {
  const f: Focus = { title: title.slice(0, 120) || 'Focus', min: Math.max(5, Math.min(240, Math.round(min))), start: now, ...(task ? { task } : {}) };
  put(f);
  return f;
}

// When it ends (later while paused).
export const endsAt = (f: Focus, now = Date.now()) => f.start + f.min * 60_000 + (f.away || 0) + (f.paused ? now - f.paused : 0);
export const left = (f: Focus, now = Date.now()) => Math.max(0, endsAt(f, now) - now);
export const done = (f: Focus, now = Date.now()) => !f.paused && left(f, now) === 0;

export function pause(now = Date.now()) {
  const f = current();
  if (!f || f.paused) return f;
  f.paused = now;
  put(f);
  return f;
}
export function resume(now = Date.now()) {
  const f = current();
  if (!f || !f.paused) return f;
  f.away = (f.away || 0) + (now - f.paused);
  delete f.paused;
  put(f);
  return f;
}
// Stopped: how many minutes it ran.
export function stop(now = Date.now()): { f: Focus; ran: number } | null {
  const f = current();
  if (!f) return null;
  put(null);
  const ran = Math.round(Math.min(f.min * 60_000, (f.paused || now) - f.start - (f.away || 0)) / 60_000);
  return { f, ran: Math.max(0, ran) };
}

export const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Its end, as a notification (plain words: it only says the time is up).
export function nudges(now = Date.now()) {
  const f = current();
  if (!f || f.paused) return [];
  const at = endsAt(f, now);
  return at > now ? [{ at, title: 'Focus time is up', body: `Your ${f.min} minutes are up. Take a short break.`, tag: `focus-${f.start}` }] : [];
}
