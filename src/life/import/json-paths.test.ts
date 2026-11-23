import { describe, expect, it } from 'vitest';
import { JsonPaths, type JsonHit, type Seg } from './json-paths';
import { pieces } from '../../test/life-fixtures';
import { unmojibake, utcText } from './chat';

async function all(text: string, want: (p: readonly Seg[]) => boolean, size: number | 'random' = 'random'): Promise<JsonHit[]> {
  const r = new JsonPaths(want);
  const out: JsonHit[] = [];
  for await (const s of pieces(text, size)) out.push(...r.push(s));
  out.push(...r.end());
  return out;
}

const doc = JSON.stringify({
  about: 'Here is the data: { not [ a "path" }',
  me: { id: 42, name: 'Sam "the" Tester' },
  chats: {
    about: 'x',
    list: [
      { name: 'Anna', id: 1, messages: [{ id: 1, text: ['Hi ', { type: 'bold', text: '}]' }] }, { id: 2, text: 'b\\"c' }] },
      { name: null, id: 2, messages: [] },
    ],
  },
  'say "hi"': [1, 2.5e3, true],
});

describe('JsonPaths', () => {
  it('finds values by where they are, however the text is cut', async () => {
    const want = (p: readonly Seg[]) => (p[0] === 'chats' && p[1] === 'list' && (p[3] === 'name' || p[3] === 'id' || (p[3] === 'messages' && p.length === 5))) || (p.length === 1 && p[0] === 'me');
    for (const size of [1, 2, 3, 7, 'random'] as const) {
      const hits = await all(doc, want, size);
      expect(hits.map((h) => [h.path.join('/'), h.value])).toEqual([
        ['me', { id: 42, name: 'Sam "the" Tester' }],
        ['chats/list/0/name', 'Anna'],
        ['chats/list/0/id', 1],
        ['chats/list/0/messages/0', { id: 1, text: ['Hi ', { type: 'bold', text: '}]' }] }],
        ['chats/list/0/messages/1', { id: 2, text: 'b\\"c' }],
        ['chats/list/1/name', null],
        ['chats/list/1/id', 2],
      ]);
    }
  });

  it('reads keys with escapes, numbers at the very end, and skips what comes before the JSON', async () => {
    const hits = await all(doc, (p) => p.length === 2 && p[0] === 'say "hi"');
    expect(hits.map((h) => h.value)).toEqual([1, 2500, true]);
    expect((await all('7', () => true)).length).toBe(0);
    const x = await all('window.YTD.direct_messages.part0 = [ { "a": 1 }, { "a": 22 } ]', (p) => p.length === 2 && p[1] === 'a', 1);
    expect(x.map((h) => h.value)).toEqual([1, 22]);
    const end = await all('{"n": 12', (p) => p[0] === 'n', 1);
    expect(end.map((h) => h.value)).toEqual([12]);
  });

  it('skips a broken value and goes on', async () => {
    const r = new JsonPaths((p) => p.length === 1);
    const hits = r.push('[{"a": tru}, {"a": 2}]');
    expect(hits.map((h) => h.value)).toEqual([{ a: 2 }]);
    expect(r.broken).toBe(1);
  });
});

describe('chat helpers', () => {
  it('puts back the text Meta writes a byte at a time', () => {
    expect(unmojibake('RenÃ©e')).toBe('Renée');
    expect(unmojibake('ð\u009f\u0098\u0080 hi')).toBe('😀 hi');
    expect(unmojibake('Plain text')).toBe('Plain text');
    expect(unmojibake('Renée')).toBe('Renée'); // already fine: not valid as bytes, left alone
    expect(unmojibake('日本')).toBe('日本');
  });

  it('reads the UTC times the exports write', () => {
    const t = Date.UTC(2024, 0, 13, 21, 15, 4);
    expect(utcText('2024-01-13 21:15:04')).toBe(t);
    expect(utcText('2024-01-13 21:15:04 UTC')).toBe(t);
    expect(utcText('2024-01-13T21:15:04Z')).toBe(t);
    expect(utcText('2024-01-13 23:15:04.123000+02:00')).toBe(t + 123);
    expect(utcText('yesterday')).toBeNaN();
  });
});
