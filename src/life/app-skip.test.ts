// @vitest-environment jsdom
// Apps Arise never reads (app-skip.ts): the groups like the extension's (banking and money, health,
// passwords), matched by id or a word in the id or name, the Player's own picks, the apps seen, and
// the events from Android and the Mac helper left out.

import { beforeEach, describe, expect, it } from 'vitest';
import * as APPS from './app-skip';
import type { LifeEvent } from './types';

beforeEach(() => localStorage.clear());

describe('the groups', () => {
  it('knows banks, health apps and password managers by id, with everything under it', () => {
    expect(APPS.groupOf('com.chase.sig.android')).toBe('money');
    expect(APPS.groupOf('com.paypal.android.p2pmobile.beta')).toBe('money');
    expect(APPS.groupOf('epic.mychart.android')).toBe('health');
    expect(APPS.groupOf('com.x8bit.bitwarden')).toBe('passwords');
    expect(APPS.groupOf('com.1password.1password')).toBe('passwords');
    expect(APPS.groupOf('com.whatsapp')).toBeNull();
    expect(APPS.groupOf('com.spotify.music', 'Spotify')).toBeNull();
  });

  it('knows one that isn\'t listed by a word in its id or its name', () => {
    expect(APPS.groupOf('uz.kapitalbank.mobile')).toBe('money');
    expect(APPS.groupOf('com.example.app', 'Bank of Somewhere')).toBe('money');
    expect(APPS.groupOf('com.example.vault', 'Passwords Plus')).toBe('passwords');
    expect(APPS.groupOf('org.cityhospital.patients')).toBe('health');
    // Not from a short start like "uk".
    expect(APPS.groupOf('uk.co.example')).toBeNull();
  });

  it('starts with every group on, and the Player can turn one off', () => {
    const skip = APPS.cleanSkip({});
    expect(skip).toEqual({ groups: { money: true, health: true, passwords: true }, own: [] });
    expect(APPS.skipped('com.chase.sig.android', 'Chase', skip)).toBe(true);
    const off = APPS.cleanSkip({ groups: { money: false } });
    expect(APPS.skipped('com.chase.sig.android', 'Chase', off)).toBe(false);
    expect(APPS.skipped('com.x8bit.bitwarden', 'Bitwarden', off)).toBe(true);
  });

  it("leaves out the Player's own picks", () => {
    const skip = APPS.cleanSkip({ own: ['com.instagram.android', 'not an id!', 'com.instagram.android'] });
    expect(skip.own).toEqual(['com.instagram.android']);
    expect(APPS.skipped('com.instagram.android', 'Instagram', skip)).toBe(true);
    expect(APPS.skipped('com.instagram.android.lite', 'Instagram Lite', skip)).toBe(true);
    expect(APPS.skipped('com.instagramx', 'Other', skip)).toBe(false);
    expect(APPS.skipped('', '', skip)).toBe(false);
  });

  it("hands the phone's recorders one plain list", () => {
    const list = APPS.nativeList(APPS.cleanSkip({ groups: { health: false, passwords: false }, own: ['com.mine.app'] }));
    expect(list.apps).toContain('com.chase.sig.android');
    expect(list.apps).toContain('com.mine.app');
    expect(list.apps).not.toContain('epic.mychart.android');
    expect(list.words).toContain('bank');
    expect(list.words).not.toContain('password');
  });
});

describe('the apps seen', () => {
  it('keeps each once, with its newest name', () => {
    const seen = APPS.addSeen([{ id: 'com.a', name: 'A' }], [{ id: 'com.b', name: 'B' }, { id: 'com.a', name: 'A two' }, { id: 'bad id', name: 'x' }]);
    expect(seen).toEqual([
      { id: 'com.b', name: 'B' },
      { id: 'com.a', name: 'A two' },
    ]);
    expect(APPS.cleanSeen([{ id: 'com.c' }, 7])).toEqual([{ id: 'com.c', name: 'com.c' }]);
  });
});

describe('the events', () => {
  const ev = (o: Partial<LifeEvent>): LifeEvent => ({ id: `x:${Math.random()}`, source: 'android', kind: 'notification', at: 1, title: 't', tier: 3, ...o });

  it('leaves out Android notifications and app use from apps never read, and notes the apps seen', () => {
    APPS.save('android', { skip: APPS.cleanSkip({ own: ['com.instagram.android'] }), seen: [] });
    const list = [
      ev({ meta: { pkg: 'com.instagram.android', app: 'Instagram' } }),
      ev({ kind: 'app', meta: { pkg: 'com.chase.sig.android', app: 'Chase' } }),
      ev({ meta: { pkg: 'com.whatsapp', app: 'WhatsApp' } }),
      ev({ kind: 'call', meta: {} }),
    ];
    const kept = APPS.filterEvents('android', list);
    expect(kept.map((e) => e.meta?.pkg ?? e.kind)).toEqual(['com.whatsapp', 'call']);
    expect(APPS.load('android').seen.map((a) => a.name)).toEqual(['Instagram', 'Chase', 'WhatsApp']);
    expect(APPS.load('mac').seen).toEqual([]);
  });

  it("leaves out the Mac helper's, by bundle id and the name in the title", () => {
    const mac = (title: string, app: string, kind: LifeEvent['kind'] = 'notification') => ev({ source: 'mac', kind, title, meta: { app } });
    const kept = APPS.filterEvents('mac', [mac('Notification from 1Password', 'com.1password.1password'), mac('Used Example Bank for 5 min', 'com.example.money', 'app'), mac('Notification from Slack', 'com.tinyspeck.slackmacgap')]);
    expect(kept.map((e) => e.title)).toEqual(['Notification from Slack']);
    expect(APPS.load('mac').seen.map((a) => a.name)).toEqual(['1Password', 'Example Bank', 'Slack']);
  });
});
