// The coach's separate chats (lib/chats.ts): names, the list, and how two copies combine, an older
// app's copy (which drops each message's chat id) included.

import { describe, expect, it } from 'vitest';
import { FIRST, chatOf, gone, inChat, lastChat, listChats, mergeChatNames, titleFrom, usedLabel, type ChatMsg } from './chats';
import { merge, type CloudCopy } from './merge';
import { cleanState, type Settings } from './validate';

const DEFAULTS: Settings = { restBig: 120, restSmall: 60, sound: true, vibrate: true, name: '', remindAt: '07:00', aiDaily: true, template: 'ab', perWeek: 5, notify: false, evening: true, eveningAt: '20:30', aiProvider: '', aiModel: '', aiBase: '', aiEngine: '', bar: 'home', dayOff: true, privateModel: '', freeModel: '', look: 'auto', checkin: true, checkinAt: '21:30', recap: true, recapAt: '', notifyDetails: false, journalVoice: 'first', nudges: 2, quietFrom: '22:00', quietTo: '08:00', bestTime: '', currency: '', voice: '', briefAt: '' };
const NOW = Date.UTC(2026, 10, 25, 12);
const copy = (raw: Record<string, unknown> = {}): CloudCopy => {
  const { active: _a, updatedAt: _u, ...rest } = cleanState(raw, DEFAULTS);
  return rest;
};
// What an app from before chats keeps of a copy: every message, without its chat id, and no names.
const olderApp = (c: CloudCopy): CloudCopy => ({ ...c, ai: { ...c.ai, chat: c.ai.chat.map(({ c: _c, ...m }) => m), chatNames: {} } });
const q = (text: string, at: number, c?: string): ChatMsg => ({ role: 'user', text, at, ...(c ? { c } : {}) });
const a = (text: string, at: number, c?: string): ChatMsg => ({ role: 'assistant', text, at, ...(c ? { c } : {}) });
const texts = (msgs: ChatMsg[]) => msgs.map((m) => m.text);

describe('chats', () => {
  it('names a chat from its first question, cut short at a word', () => {
    expect(titleFrom('How do I sleep better?')).toBe('How do I sleep better?');
    expect(titleFrom('\n  Ask me how I am   doing.\nMore lines here.')).toBe('Ask me how I am doing.');
    expect(titleFrom('I have been feeling tired every afternoon this week and I do not know why')).toBe('I have been feeling tired every afternoon this…');
    expect(titleFrom('')).toBe('');
  });

  it('lists every chat, the one used last first, with its name, count and tier', () => {
    const msgs = [
      q('From before chats', NOW - 9000),
      a('Old answer', NOW - 8900),
      q('Knee hurts after runs', NOW - 5000, 'k1'),
      a('Rest it.', NOW - 4900, 'k1'),
      { ...a('Made from the life log', NOW - 4800, 'k1'), tier: 3 as const },
      q('Money this month', NOW - 7000, 'm1'),
    ];
    const list = listChats(msgs, { m1: { title: 'Budget', at: NOW } });
    expect(list.map((c) => [c.id, c.title, c.named, c.count, c.tier, c.at])).toEqual([
      ['k1', 'Knee hurts after runs', false, 3, 3, NOW - 4800],
      ['m1', 'Budget', true, 1, 1, NOW - 7000],
      [FIRST, 'From before chats', false, 2, 1, NOW - 8900],
    ]);
    expect(lastChat(msgs)).toBe('k1');
    expect(lastChat([])).toBeNull();
    // An empty name goes back to the one from the first question.
    expect(listChats(msgs, { m1: { title: '', at: NOW } }).find((c) => c.id === 'm1')!.title).toBe('Money this month');
  });

  it('keeps the first chat without ids, as an app from before chats has it', () => {
    expect(inChat(q('hi', 1), FIRST)).toEqual(q('hi', 1));
    expect(inChat(q('hi', 1), 'k1')).toEqual(q('hi', 1, 'k1'));
    expect(chatOf(q('hi', 1))).toBe(FIRST);
  });

  it('says when a chat was last used in plain words', () => {
    const now = new Date(2026, 10, 25, 15, 0).getTime();
    expect(usedLabel(now - 30_000, now)).toBe('just now');
    expect(usedLabel(now - 12 * 60_000, now)).toBe('12 minutes ago');
    expect(usedLabel(new Date(2026, 10, 25, 9, 5).getTime(), now)).toBe('today at 09:05');
    expect(usedLabel(new Date(2026, 10, 24, 22, 0).getTime(), now)).toBe('yesterday');
    expect(usedLabel(new Date(2026, 10, 23, 8, 0).getTime(), now)).toBe('on Monday');
    expect(usedLabel(new Date(2026, 9, 2, 8, 0).getTime(), now)).toBe('2 Oct');
    expect(usedLabel(new Date(2025, 9, 2, 8, 0).getTime(), now)).toBe('2 Oct 2025');
  });

  it('keeps each chat id and name through a restart, sync or backup, and drops bad ones', () => {
    const c = copy({
      ai: {
        chat: [q('a', 1, 'k1'), q('b', 2, FIRST), q('c', 3, '<b>bad</b>'), q('d', 4, 'cleared')],
        chatNames: { k1: { title: '  My   knee ', at: 5 }, 'no good!': { title: 'x', at: 5 }, m1: { title: 3, at: 5 }, n1: { title: 'x' } },
      },
    });
    expect(c.ai.chat).toEqual([q('a', 1, 'k1'), q('b', 2), q('c', 3), q('d', 4)]);
    expect(c.ai.chatNames).toEqual({ k1: { title: 'My knee', at: 5 } });
  });
});

describe('chats on two devices', () => {
  it('keeps every chat from both, and the later name', () => {
    const phone = copy({ ai: { chat: [q('p1', NOW - 50, 'k1'), q('both', NOW - 40, 'k1')], chatNames: { k1: { title: 'Knee', at: NOW - 30 } } } });
    const laptop = copy({ ai: { chat: [q('both', NOW - 40, 'k1'), q('l1', NOW - 20, 'm1')], chatNames: { k1: { title: 'My knee', at: NOW - 10 } } } });
    for (const m of [merge(phone, 1, laptop, 2, NOW), merge(laptop, 1, phone, 2, NOW)]) {
      expect(texts(m.ai.chat)).toEqual(['p1', 'both', 'l1']);
      expect(m.ai.chatNames).toEqual({ k1: { title: 'My knee', at: NOW - 10 } });
    }
  });

  it("doesn't bring back a chat deleted on one device, and keeps what the other wrote in it after", () => {
    const phone = copy({ ai: { chat: [q('keep', NOW - 90, 'm1')] }, stamps: { chat: { k1: -(NOW - 50) } } });
    const laptop = copy({
      ai: { chat: [q('old knee', NOW - 80, 'k1'), a('rest it', NOW - 70, 'k1'), q('keep', NOW - 90, 'm1'), q('written after', NOW - 10, 'k1')], chatNames: { k1: { title: 'Knee', at: NOW - 60 } } },
    });
    for (const m of [merge(phone, 1, laptop, 2, NOW), merge(laptop, 2, phone, 1, NOW)]) {
      expect(texts(m.ai.chat)).toEqual(['keep', 'written after']);
      expect(m.ai.chatNames).toEqual({});
    }
  });

  it('forgets every chat on every device, and one that was offline brings none of them back', () => {
    const before = [q('first chat', NOW - 900), q('knee', NOW - 800, 'k1'), a('rest', NOW - 790, 'k1'), q('money', NOW - 700, 'm1')];
    // The phone forgot them all; the laptop was offline, still had them, renamed one and wrote more.
    const phone = copy({ ai: { chat: [q('new on the phone', NOW - 100, 'n1')] }, stamps: { chat: { cleared: NOW - 500 } } });
    const laptop = copy({ ai: { chat: [...before, q('laptop, after', NOW - 50, 'k1')], chatNames: { m1: { title: 'Money', at: NOW - 600 } } } });
    for (const m of [merge(phone, 1, laptop, 2, NOW), merge(laptop, 2, phone, 1, NOW)]) {
      expect(texts(m.ai.chat)).toEqual(['new on the phone', 'laptop, after']);
      expect(m.ai.chatNames).toEqual({});
      expect(m.stamps.chat.cleared).toBe(NOW - 500);
    }
  });

  it("joins an older app's copy (no chat ids) back into the chats it came from", () => {
    const now = copy({ ai: { chat: [q('before chats', NOW - 900), q('knee', NOW - 800, 'k1'), { ...a('rest', NOW - 790, 'k1'), tier: 3 }], chatNames: { k1: { title: 'Knee', at: NOW - 700 } } } });
    // The same messages from an app that drops the ids, plus one it wrote itself.
    const older = olderApp(copy({ ai: { chat: [...now.ai.chat, q('from the older app', NOW - 100)] } }));
    expect(older.ai.chat.some((m) => m.c)).toBe(false);
    for (const m of [merge(now, 1, older, 2, NOW), merge(older, 1, now, 2, NOW)]) {
      expect(m.ai.chat.map((x) => [x.text, chatOf(x), x.tier])).toEqual([
        ['before chats', FIRST, undefined],
        ['knee', 'k1', undefined],
        ['rest', 'k1', 3], // its tier stays too
        ['from the older app', FIRST, undefined],
      ]);
      expect(m.ai.chatNames).toEqual({ k1: { title: 'Knee', at: NOW - 700 } });
    }
    // A chat deleted here goes from the older app's copy too, once the ids are joined.
    const deleted = { ...now, stamps: { ...now.stamps, chat: { k1: -(NOW - 600) } } };
    expect(texts(merge(deleted, 1, older, 2, NOW).ai.chat)).toEqual(['before chats', 'from the older app']);
  });

  it("deletes the chat from before chats on a device that still has the older app's copy of it", () => {
    // The phone deleted the one long chat from before chats; the laptop still has it, from before it updated.
    const phone = copy({ ai: { chat: [q('new', NOW - 100, 'n1')] }, stamps: { chat: { [FIRST]: -(NOW - 500) } } });
    const laptop = olderApp(copy({ ai: { chat: [q('old 1', NOW - 900), a('old 2', NOW - 890), q('later, on the laptop', NOW - 50)] } }));
    expect(gone(phone.stamps, laptop.ai.chat[0])).toBe(true);
    for (const m of [merge(phone, 1, laptop, 2, NOW), merge(laptop, 2, phone, 1, NOW)]) {
      expect(m.ai.chat.map((x) => [x.text, chatOf(x)])).toEqual([
        ['new', 'n1'],
        ['later, on the laptop', FIRST],
      ]);
    }
  });

  it('keeps the names of both unless the chat went after them', () => {
    const stamps = { chat: { k1: -(NOW - 50), cleared: NOW - 500 } };
    expect(mergeChatNames({ k1: { title: 'Knee', at: NOW - 60 }, m1: { title: 'Money', at: NOW - 600 } }, { n1: { title: 'New', at: NOW - 10 }, k1: { title: 'After', at: NOW - 40 } }, stamps)).toEqual({
      k1: { title: 'After', at: NOW - 40 },
      n1: { title: 'New', at: NOW - 10 },
    });
  });
});
