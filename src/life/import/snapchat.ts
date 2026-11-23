// Snapchat: "My Data" (Settings, My Data) with JSON ticked, a zip with json/chat_history.json
// (chat_history.json at the top in older ones). Newer exports list each chat under its friend's
// username, or a group's id:
//   { "anna_b": [ { "From": "anna_b", "Media Type": "TEXT", "Created": "2024-01-13 21:15:04 UTC",
//                   "Content": "hi", "Conversation Title": null, "IsSender": false } ] }
// Older ones split them by direction:
//   { "Received Saved Chat History": [ { "From": "anna_b", "Media Type": "TEXT", "Created": "…", "Text": "hi" } ],
//     "Sent Saved Chat History": [ { "To": "anna_b", … } ] }
// Snaps and other media count as messages; only text is kept for the detail.

import type { LifeEvent } from '../types';
import { ChatDays, isObj, utcText, type Parts } from './chat';
import { jsonPaths, type Seg } from './json-paths';
import { num } from './util';

export const SNAPCHAT = /(?:^|\/)chat_history\.json$/i;
const ME = '\u0000me';
const OLD = /^(sent|received) (saved |unsaved )?chat history$/i;

const want = (path: readonly Seg[]) => path.length === 2 && typeof path[1] === 'number';

function timeOf(m: Record<string, unknown>): number {
  const t = utcText(m.Created);
  if (Number.isFinite(t)) return t;
  const n = num(m['Created(microseconds)']);
  return Number.isFinite(n) ? (n > 1e14 ? n / 1000 : n) : NaN;
}

export async function* parseSnapchat(parts: Parts): AsyncGenerator<LifeEvent[]> {
  const days = new ChatDays('snapchat', 'Snapchat');
  const titles = new Map<string, string>();
  for await (const input of parts) {
    for await (const hits of jsonPaths(input.text, want)) {
      for (const { path, value } of hits) {
        if (!isObj(value)) continue;
        const list = String(path[0]);
        const old = list.match(OLD);
        let key: string;
        let who: string;
        if (old) {
          const sent = old[1].toLowerCase() === 'sent';
          key = String((sent ? value.To : value.From) ?? '').trim();
          who = sent ? ME : key;
        } else {
          key = list;
          who = value.IsSender === true ? ME : String(value.From ?? '').trim();
          const title = value['Conversation Title'];
          if (typeof title === 'string' && title.trim()) titles.set(key, title.trim());
        }
        if (!key) continue;
        const text = value.Content ?? value.Text;
        days.add(key, { at: timeOf(value), who, text: typeof text === 'string' ? text : '' });
      }
    }
  }
  yield* days.events({ chat: (key) => titles.get(key) ?? key, me: (who) => who === ME });
}
