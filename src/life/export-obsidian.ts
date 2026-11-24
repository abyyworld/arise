// Your life log as an Obsidian vault: a zip of Markdown files, made on this device. One file per
// day ("Days/2024-01-02.md") with that day's journal and everything in it; each note with words
// in it gets its own file ("Notes/2024-01-02 Trip ideas.md"), linked from its day with
// [[wikilinks]]. Every file starts with front matter (date and type), so Obsidian can sort and
// search them.

import { strToU8, zipSync } from 'fflate';
import type { LifeEvent, LifeSource } from './types';
import { SOURCE_NAMES } from './tiers';
import { dayKey } from './dates';

export interface VaultOptions {
  journals?: Map<string, string>; // day → its journal
  summaries?: Map<string, string>; // day → its summary
  made?: Date; // when the export was made (for the read-me note)
}

export const VAULT = 'Arise';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// The day an event belongs to: the one it says (a day's steps), else its time on this device.
export function dayOfEvent(e: LifeEvent): string {
  const d = e.meta?.day;
  return typeof d === 'string' && DAY_RE.test(d) ? d : dayKey(e.at);
}

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => {
  const t = new Date(ms);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
};

// A value in front matter, quoted when it needs to be.
function yaml(v: string | number | boolean): string {
  if (typeof v !== 'string') return String(v);
  return /^[\p{L}\p{N} _.,/()-]+$/u.test(v) && !/^\s|\s$/.test(v) && !/^(true|false|null|yes|no|~|-)$/i.test(v) ? v : JSON.stringify(v);
}

function front(fields: Record<string, string | number | boolean | string[] | undefined>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}:`, ...v.map((x) => `  - ${yaml(x)}`));
    } else lines.push(`${k}: ${yaml(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

// A file name Obsidian (and every computer) accepts, without the characters links can't hold.
export function safeName(s: string, max = 80): string {
  const t = s
    .replace(/[\\/:*?"<>|#^[\]{}\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, max)
    .trim();
  return t || 'Note';
}

// One line of text for a list, with nothing Markdown would read as a link or a heading.
const line = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\[\[|\]\]/g, '')
    .trim();

const sourceName = (e: LifeEvent) => {
  const app = e.meta?.app;
  return typeof app === 'string' && app ? app : (SOURCE_NAMES[e.source as LifeSource] ?? e.source);
};

const allDay = (e: LifeEvent) => typeof e.meta?.day === 'string' || (!!e.end && e.end - e.at >= 20 * 3600_000);

const DATE_TITLE = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayTitle = (day: string) => {
  try {
    return DATE_TITLE.format(new Date(`${day}T12:00:00Z`));
  } catch {
    return day;
  }
};

// Every file of the vault, by its path in the zip. Pure: the same events give the same files.
export function obsidianFiles(events: readonly LifeEvent[], opts: VaultOptions = {}): Record<string, string> {
  const files: Record<string, string> = {};
  const byDay = new Map<string, LifeEvent[]>();
  for (const e of events) {
    if (!e || !Number.isFinite(e.at)) continue;
    const d = dayOfEvent(e);
    let list = byDay.get(d);
    if (!list) byDay.set(d, (list = []));
    list.push(e);
  }
  for (const d of [...(opts.journals?.keys() ?? []), ...(opts.summaries?.keys() ?? [])]) if (DAY_RE.test(d) && !byDay.has(d)) byDay.set(d, []);
  const days = [...byDay.keys()].sort();
  const used = new Set<string>(days.map((d) => d.toLowerCase()));
  for (const day of days) {
    const list = byDay.get(day)!.sort((a, b) => Number(!allDay(a)) - Number(!allDay(b)) || a.at - b.at || (a.id < b.id ? -1 : 1));
    const rows: string[] = [];
    for (const e of list) {
      const when = allDay(e) ? '' : `${clock(e.at)} `;
      const from = ` (${sourceName(e)})`;
      if (e.kind === 'note' && e.detail?.trim()) {
        // Its own file, linked from the day.
        let name = safeName(`${day} ${e.title}`);
        for (let i = 2; used.has(name.toLowerCase()); i++) name = safeName(`${day} ${e.title}`, 74) + ` ${i}`;
        used.add(name.toLowerCase());
        const tags = typeof e.meta?.tags === 'string' ? e.meta.tags.split(/\s*,\s*/).map((t) => t.replace(/\s+/g, '-')).filter(Boolean) : [];
        const folder = typeof e.meta?.folder === 'string' ? e.meta.folder : undefined;
        files[`${VAULT}/Notes/${name}.md`] =
          front({ date: day, time: allDay(e) ? undefined : clock(e.at), type: 'note', source: sourceName(e), folder, tags }) + `\n# ${line(e.title)}\n\n${e.detail.trim()}\n\nFrom [[${day}]]\n`;
        rows.push(`- ${when}[[${name}|${line(e.title)}]]${from}`);
      } else {
        const detail = e.detail?.trim() ? `: ${line(e.detail).slice(0, 300)}` : '';
        rows.push(`- ${when}${line(e.title)}${detail}${from}`);
      }
    }
    const parts = [front({ date: day, type: 'day', events: list.length }), `# ${dayTitle(day)}\n`];
    const journal = opts.journals?.get(day)?.trim();
    if (journal) parts.push(`## Journal\n\n${journal}\n`);
    const summary = opts.summaries?.get(day)?.trim();
    if (summary) parts.push(`## Summary\n\n${summary}\n`);
    if (rows.length) parts.push(`## Your day\n\n${rows.join('\n')}\n`);
    files[`${VAULT}/Days/${day}.md`] = parts.join('\n');
  }
  const made = opts.made ?? new Date();
  files[`${VAULT}/Read me.md`] =
    front({ date: dayKey(made.getTime()), type: 'about' }) +
    '\n' +
    `# Your life log from Arise\n\nMade on ${dayTitle(dayKey(made.getTime()))}: ${days.length} ${days.length === 1 ? 'day' : 'days'} and ${events.length} ${events.length === 1 ? 'thing' : 'things'} in them.\n\n` +
    'Each day is in Days, named by its date. Notes with words in them are in Notes, linked from their day.\n\n' +
    'Open this folder in Obsidian as a vault, or copy it into the vault you have. Nothing here is synced or shared by Arise.\n';
  return files;
}

// The vault as a zip.
export function obsidianZip(events: readonly LifeEvent[], opts: VaultOptions = {}): Uint8Array {
  const files = obsidianFiles(events, opts);
  const made = opts.made ?? new Date();
  const data: Record<string, [Uint8Array, { level: 6; mtime: Date }]> = {};
  for (const [path, text] of Object.entries(files)) data[path] = [strToU8(text), { level: 6, mtime: made }];
  return zipSync(data);
}

export const zipName = (made = new Date()) => `Arise life log ${dayKey(made.getTime())}.zip`;

// ---------- from the life log on this device

type Summary = { kind: string; key: string; text: string };
type LogModule = { exportAll?: () => Promise<{ events: LifeEvent[]; summaries: Summary[] }> };
const logs = import.meta.glob<LogModule>('./log.ts');

// The life log as a zip, ready to save. null when this build has no life log.
export async function exportVault(made = new Date()): Promise<{ name: string; bytes: Uint8Array; days: number } | null> {
  const load = logs['./log.ts'];
  const m = load ? await load() : null;
  if (!m?.exportAll) return null;
  const all = await m.exportAll();
  const journals = new Map<string, string>();
  const summaries = new Map<string, string>();
  for (const s of all.summaries) {
    if (s.kind === 'journal') journals.set(s.key, s.text);
    else if (s.kind === 'day') summaries.set(s.key, s.text);
  }
  const days = new Set(all.events.map(dayOfEvent)).size;
  return { name: zipName(made), bytes: obsidianZip(all.events, { journals, summaries, made }), days };
}
