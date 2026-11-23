// LinkedIn: messages.csv from "Get a copy of your data" (Settings, Data privacy), with columns
//   CONVERSATION ID, CONVERSATION TITLE, FROM, SENDER PROFILE URL, TO, RECIPIENT PROFILE URLS,
//   DATE ("2024-01-13 21:15:04 UTC"), SUBJECT, CONTENT, FOLDER, …
// The columns are found by their names. Who the Player is: the one person in every conversation.
// Spam and drafts are left out.

import type { LifeEvent } from '../types';
import { ChatDays, listNames, utcText, type Parts } from './chat';
import { CsvRows } from './text-stream';

// The first line of LinkedIn's messages.csv.
export const isLinkedInMessages = (firstLine: string): boolean => {
  const l = firstLine.replace(/^﻿/, '').toLowerCase();
  return l.includes('conversation id') && /(^|,)"?from"?(,|$)/.test(l) && l.includes('content') && l.includes('date');
};

// Some messages are written in HTML: keep the words.
const words = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// TO can hold more than one name.
const namesIn = (s: string | undefined) => (s ?? '').split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);

export async function* parseLinkedIn(parts: Parts): AsyncGenerator<LifeEvent[]> {
  const days = new ChatDays('linkedin', 'LinkedIn');
  const titles = new Map<string, string>();
  const people = new Map<string, Set<string>>(); // conversation → everyone in it
  for await (const input of parts) {
    const rows = new CsvRows(',');
    let col: Record<string, number> | null = null;
    const take = (r: string[]) => {
      if (!col) {
        col = {};
        r.forEach((c, i) => (col![c.replace(/^﻿/, '').trim().toLowerCase()] = i));
        return;
      }
      const get = (k: string) => (col![k] !== undefined ? (r[col![k]] ?? '').trim() : '');
      if (get('folder').toUpperCase() === 'SPAM' || /^(yes|true)$/i.test(get('is message draft'))) return;
      const key = get('conversation id');
      const from = get('from');
      if (!key) return;
      const title = get('conversation title');
      if (title) titles.set(key, title);
      let set = people.get(key);
      if (!set) people.set(key, (set = new Set()));
      for (const p of [from, ...namesIn(get('to'))]) if (p) set.add(p);
      days.add(key, { at: utcText(get('date')), who: from, text: words(get('content')) });
    };
    for await (const c of input.text) for (const r of rows.push(c)) take(r);
    for (const r of rows.end()) take(r);
  }
  // The Player: the one name in every conversation (when there's more than one to go by).
  let me = '';
  const all = [...people.values()].filter((s) => s.size);
  if (all.length >= 2) {
    const inAll = [...all[0]].filter((p) => all.every((s) => s.has(p)));
    if (inAll.length === 1) me = inAll[0];
  }
  const isMe = (who: string) => !!me && who === me;
  const nameOf = (key: string) => titles.get(key) || listNames([...(people.get(key) ?? [])].filter((p) => !isMe(p))) || 'someone';
  yield* days.events({ chat: nameOf, me: me ? isMe : undefined });
}
