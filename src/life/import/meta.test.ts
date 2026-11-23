import { describe, expect, it } from 'vitest';
import { parseMeta, profileNames } from './meta';
import { onePart } from './chat';
import { classify, detect, importFile } from './index';
import { fileOf, input, patchZip, run, titles, wellFormed, zipBlob, zipBytes } from '../../test/life-fixtures';
import type { LifeEvent } from '../types';

const at = (d: number, h = 12, m = 0) => Date.UTC(2024, 0, d, h, m);
// Meta writes each UTF-8 byte as its own character, escaped.
const moj = (s: string) => String.fromCharCode(...new TextEncoder().encode(s));
const metaJson = (v: unknown) => JSON.stringify(v, null, 2).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const m = (who: string, ms: number, content?: string, extra: Record<string, unknown> = {}) => ({ sender_name: moj(who), timestamp_ms: ms, ...(content === undefined ? {} : { content: moj(content) }), is_geoblocked_for_viewer: false, ...extra });
const thread = (people: string[], title: string, messages: unknown[], path: string) => metaJson({ participants: people.map((p) => ({ name: moj(p) })), messages, title: moj(title), is_still_participant: true, thread_path: path });

// Instagram: one chat in two files (newest first), and a group.
const anna1 = thread(['Renée Example', 'Sam Tester'], 'Renée Example', [m('Sam Tester', at(14, 9), 'Morning ☀️'), m('Renée Example', at(13, 20), 'See you 😀')], 'inbox/reneeexample_123');
const anna2 = thread(['Renée Example', 'Sam Tester'], 'Renée Example', [m('Sam Tester', at(13, 12, 30), undefined, { photos: [{ uri: 'x.jpg' }] }), m('Renée Example', at(13, 12), 'Café later?')], 'inbox/reneeexample_123');
const group = thread(['Ben Sample', 'Cleo Demo', 'Sam Tester'], 'Climbing', [m('Cleo Demo', at(15), 'Who is in?'), m('Ben Sample', at(15, 11), 'Cleo joined the group.', { type: 'Subscribe' })], 'inbox/climbing_456');
const profile = metaJson({ profile_user: [{ string_map_data: { Name: { value: moj('Sam Tester') }, Username: { value: 'sam.tester' } } }] });

const insta = {
  'your_instagram_activity/messages/inbox/reneeexample_123/message_1.json': anna1,
  'your_instagram_activity/messages/inbox/reneeexample_123/message_2.json': anna2,
  'your_instagram_activity/messages/inbox/climbing_456/message_1.json': group,
  'your_instagram_activity/messages/inbox/climbing_456/photos/1.jpg': new Uint8Array([0xff, 0xd8]),
  'personal_information/personal_information/personal_information.json': profile,
  'your_instagram_activity/likes/liked_posts.json': '{"likes_media_likes": []}',
};

function collect() {
  const got: LifeEvent[] = [];
  return { got, onEvents: (b: LifeEvent[]) => void got.push(...b) };
}

describe('Instagram and Messenger', () => {
  it('reads every chat of an Instagram export as one part, with proper names and text', async () => {
    const d = await detect(fileOf([zipBlob(insta)], 'instagram-sam.tester-2024-01-20.zip'));
    expect(d.found.map((f) => [f.kind, f.label, f.path])).toEqual([['instagram', 'Instagram messages', 'your_instagram_activity/messages']]);
    expect(d.found[0].parts![0]).toBe('personal_information/personal_information/personal_information.json');
    expect(d.found[0].parts!.length).toBe(4);
    const c = collect();
    const r = await importFile(fileOf([zipBlob(insta)], 'instagram-sam.tester-2024-01-20.zip'), { detection: d, onEvents: c.onEvents });
    expect(r.labels).toEqual(['Instagram messages']);
    const events = c.got;
    expect(events.every(wellFormed)).toBe(true);
    expect(titles(events)).toEqual(['Chatted with Renée Example on Instagram: 3 messages', 'Chatted with Renée Example on Instagram: 1 message', 'Chatted with Climbing on Instagram: 1 message']);
    // The day spread over both files is one event, its messages in order, the photo counted.
    expect(events[0]).toMatchObject({ source: 'instagram', kind: 'message', tier: 3, at: at(13, 12), end: at(13, 20), meta: { chat: 'Renée Example', sent: 1, received: 2 } });
    expect(events[0].detail).toBe('Renée Example: Café later? · Renée Example: See you 😀');
    expect(events[1].detail).toBe('You: Morning ☀️');
  });

  it('reads an older Facebook export, works out who the Player is, and counts calls', async () => {
    const files = {
      'messages/inbox/anna_1/message_1.json': thread(['Anna Example', 'Sam Tester'], 'Anna Example', [m('Anna Example', at(3, 10), 'Hi'), m('Sam Tester', at(3, 9), '', { type: 'Call', call_duration: 125 })], 'inbox/anna_1'),
      'messages/archived_threads/ben_2/message_1.json': thread(['Ben Sample', 'Sam Tester'], 'Ben Sample', [m('Ben Sample', at(4), 'Yo')], 'archived_threads/ben_2'),
      'messages/e2ee_cutover/anna_9/message_1.json': thread(['Anna Example', 'Sam Tester'], 'Anna Example', [m('Sam Tester', at(5), 'Encrypted now')], 'e2ee_cutover/anna_9'),
      'messages/message_requests/spam_3/message_1.json': thread(['Spammer', 'Sam Tester'], 'Spammer', [m('Spammer', at(6), 'Buy')], 'message_requests/spam_3'),
      'profile_information/profile_information.json': metaJson({ profile_v2: { name: { full_name: moj('Sam Tester') } } }),
    };
    const d = await detect(fileOf([zipBlob(files)], 'facebook-samtester-2024.zip'));
    expect(d.found.map((f) => f.kind)).toEqual(['messenger']);
    const c = collect();
    await importFile(fileOf([zipBlob(files)], 'facebook-samtester-2024.zip'), { detection: d, onEvents: c.onEvents });
    expect(titles(c.got)).toEqual(['Chatted with Anna Example on Messenger: 1 message', 'Chatted with Ben Sample on Messenger: 1 message', 'Chatted with Anna Example on Messenger: 1 message', 'Called Anna Example on Messenger (2 min)']);
    expect(c.got[2].meta).toMatchObject({ sent: 1, received: 0 });
    expect(c.got[3]).toMatchObject({ kind: 'call', tier: 3, value: 125, meta: { direction: 'out' } });
  });

  it('works out the Player without a profile file: the one person in every chat, or the one a chat isn’t named after', async () => {
    async function* two() {
      yield input('messages/inbox/a_1/message_1.json', thread(['Anna Example', 'Sam Tester'], 'Anna Example', [m('Sam Tester', at(3), 'Hi')], 'inbox/a_1'));
      yield input('messages/inbox/b_2/message_1.json', thread(['Ben Sample', 'Sam Tester'], 'Ben Sample', [m('Sam Tester', at(4), 'Hey')], 'inbox/b_2'));
    }
    const a = await run(parseMeta(two(), 'messenger'));
    expect(a.events.map((e) => e.meta?.sent)).toEqual([1, 1]);
    const one = await run(parseMeta(onePart(input('message_1.json', thread(['Anna Example', 'Sam Tester'], 'Anna Example', [m('Sam Tester', at(3), 'Hi')], 'inbox/a_1'))), 'messenger'));
    expect(one.events[0].detail).toBe('You: Hi');
    // A group of three with no other chats: nobody to tell, so no "You", and no counts of who sent.
    const unsure = await run(parseMeta(onePart(input('message_1.json', group)), 'instagram'));
    expect(unsure.events[0].meta?.sent).toBeUndefined();
    expect(unsure.events[0].detail).toBe('Cleo Demo: Who is in?');
  });

  it('finds a chat file on its own, and the profile names', () => {
    expect(classify('message_1.json', anna1, false)).toBe('messenger');
    expect(classify('instagram/message_1.json', anna1, false)).toBe('instagram');
    expect(classify('message_1.json', anna1, true)).toBeNull();
    expect(profileNames(JSON.parse(profile))).toEqual(['Sam Tester', 'sam.tester']);
  });

  it('keeps the other chats when one file is damaged, and says so', async () => {
    const bytes = patchZip(zipBytes(insta), 'your_instagram_activity/messages/inbox/climbing_456/message_1.json', { packed: 20 });
    const c = collect();
    const r = await importFile(fileOf([bytes], 'instagram.zip'), { onEvents: c.onEvents });
    expect(r.failed).toEqual(['Instagram messages']);
    expect(titles(c.got)).toEqual(['Chatted with Renée Example on Instagram: 3 messages', 'Chatted with Renée Example on Instagram: 1 message']);
  });

  it('gives the same ids from a second export of the same chats', async () => {
    const a = collect();
    const b = collect();
    await importFile(fileOf([zipBlob(insta)], 'one.zip'), { onEvents: a.onEvents });
    const later = { ...insta, 'your_instagram_activity/messages/inbox/reneeexample_123/message_1.json': thread(['Renée Example', 'Sam Tester'], 'Renée Example', [m('Renée Example', at(16), 'New'), m('Sam Tester', at(14, 9), 'Morning ☀️'), m('Renée Example', at(13, 20), 'See you 😀')], 'inbox/reneeexample_123') };
    await importFile(fileOf([zipBlob(later)], 'two.zip'), { onEvents: b.onEvents });
    const ids = new Set(b.got.map((e) => e.id));
    expect(a.got.every((e) => ids.has(e.id))).toBe(true);
    expect(b.got.length).toBe(a.got.length + 1);
  });
});
