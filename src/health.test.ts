// System health (health.ts): whether each server answers, sent nothing of the person's, and the
// summary in plain words.

import { describe, expect, it, vi } from 'vitest';
import * as H from './health';

describe('system health', () => {
  it('counts any answer from a server, and no answer as not there', async () => {
    const ok = vi.fn(async () => new Response('nope', { status: 404 }));
    expect(await H.answers('https://x.example', ok as unknown as typeof fetch)).toBe(true);
    const sent = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(sent[1]).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(sent[1].body).toBeUndefined();
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await H.answers('https://x.example', down as unknown as typeof fetch)).toBe(false);
    const slow = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
    expect(await H.answers('https://x.example', slow as unknown as typeof fetch, 10)).toBe(false);
  });

  it('runs every check, keeps their order, and says what needs a look', async () => {
    const seen: string[] = [];
    const out = await H.runAll(
      [
        H.serverProbe('a', 'Sync', 'https://a.example', 'Why it matters.', (async () => new Response('')) as unknown as typeof fetch),
        H.serverProbe('b', 'Reminders', '', 'Why it matters.'),
        { id: 'c', name: 'Storage', run: async () => Promise.reject(new Error('Your bucket said no.')) },
        H.serverProbe('d', 'AI', 'https://d.example', 'Use the AI on this device.', (async () => Promise.reject(new Error('down'))) as unknown as typeof fetch),
      ],
      (r) => seen.push(r.id),
    );
    expect(out.map((r) => [r.id, r.state])).toEqual([
      ['a', 'ok'],
      ['b', 'off'],
      ['c', 'bad'],
      ['d', 'bad'],
    ]);
    expect(out[2].text).toBe('Your bucket said no.');
    expect(out[3].text).toBe("Doesn't answer right now. Use the AI on this device.");
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(H.summary(out)).toBe('2 parts need a look: Storage, AI.');
    expect(H.summary(out.slice(0, 2))).toBe('Everything that is set up is working.');
  });

  it('says how long ago in plain words', () => {
    const now = 1_000_000_000_000;
    expect(H.ago(0, now)).toBe('never');
    expect(H.ago(now - 30_000, now)).toBe('just now');
    expect(H.ago(now - 15 * 60_000, now)).toBe('15 minutes ago');
    expect(H.ago(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(H.ago(now - 3 * 86_400_000, now)).toBe('3 days ago');
  });
});
