import { describe, expect, it } from 'vitest';
import { htmlText, htmlTime, listGemini, parseGemini } from './gemini';
import { input, run, wellFormed } from '../../test/life-fixtures';
import { dayOf } from './util';

const iso = (d: number, h = 12, m = 0) => new Date(Date.UTC(2024, 10, d, h, m)).toISOString();
const rec = (title: string, time: string, answer = true) => ({
  header: 'Gemini Apps',
  title,
  time,
  products: ['Gemini Apps'],
  activityControls: ['Gemini Apps Activity'],
  ...(answer ? { safeHtmlItem: [{ html: '<p>An answer.</p>' }] } : {}),
});

// Newest first, as Takeout writes it.
const geminiJson = JSON.stringify([
  rec('Prompted what should I cook tonight?', iso(4, 12, 30)),
  rec('Gave feedback: Good response', iso(4, 12, 31), false),
  rec('Prompted any quick vegetarian ideas?', iso(3, 12, 10)),
  rec('Prompted what should I cook tonight?', iso(3, 12, 0)),
  rec('Used an Assistant feature', iso(3, 13), false),
]);

describe('Gemini', () => {
  it('puts each day’s questions together as one chat, without the answers or other activity', async () => {
    const { events } = await run(parseGemini(input('Takeout/My Activity/Gemini Apps/MyActivity.json', geminiJson)));
    expect(events.every(wellFormed)).toBe(true);
    const day3 = dayOf(Date.UTC(2024, 10, 3, 12));
    const day4 = dayOf(Date.UTC(2024, 10, 4, 12));
    expect(events.map((e) => [e.title, e.value, e.meta?.conv, e.detail])).toEqual([
      ['Chatted with Gemini: what should I cook tonight?', 4, `day:${day3}`, '4 messages, 2 from you. You asked: what should I cook tonight? · any quick vegetarian ideas?'],
      ['Chatted with Gemini: what should I cook tonight?', 2, `day:${day4}`, '2 messages, 1 from you. You asked: what should I cook tonight?'],
    ]);
    expect(events[0]).toMatchObject({ source: 'gemini', kind: 'message', tier: 3, at: Date.UTC(2024, 10, 3, 12), end: Date.UTC(2024, 10, 3, 12, 10) });
    expect(events.map((e) => e.detail).join(' ')).not.toContain('An answer');
    expect((await listGemini(input('MyActivity.json', geminiJson))).map((c) => c.id)).toEqual([`day:${day4}`, `day:${day3}`]);
    const only = await run(parseGemini(input('MyActivity.json', geminiJson), [`day:${day4}`]));
    expect(only.events.map((e) => e.meta?.conv)).toEqual([`day:${day4}`]);
  });

  it('takes every record as a question when the titles aren’t in English', async () => {
    const de = JSON.stringify([rec('Prompt eingegeben: Was koche ich heute?', iso(5))]);
    const { events } = await run(parseGemini(input('MyActivity.json', de)));
    expect(events.map((e) => e.detail)).toEqual(['2 messages, 1 from you. You asked: Prompt eingegeben: Was koche ich heute?']);
  });

  it('reads the HTML version of My Activity', async () => {
    const cell = (body: string) =>
      `<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid"><div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">${body}</div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div><div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>&emsp;Gemini Apps<br></div></div></div>`;
    const html = `<html><head><title>My Activity</title><style>.mdl-grid{}</style></head><body><div class="mdl-grid">${cell('Prompted&nbsp;what is a &quot;tempo&quot; run?<br>Nov 3, 2024, 7:15:22 PM CET<br><p>An answer.</p>')}${cell('Prompted&nbsp;how long should it be?<br>3 Nov 2024, 19:20:00 GMT<br>')}${cell('Gave feedback<br>Nov 3, 2024, 7:30:00 PM CET<br>')}</div></body></html>`;
    for (const size of [5, 64, 'random'] as const) {
      const { events } = await run(parseGemini(input('Takeout/My Activity/Gemini Apps/MyActivity.html', html, size)));
      expect(events.map((e) => [e.title, e.at, e.value, e.detail])).toEqual([
        ['Chatted with Gemini: what is a "tempo" run?', new Date(2024, 10, 3, 19, 15, 22).getTime(), 3, '3 messages, 2 from you. You asked: what is a "tempo" run? · how long should it be?'],
      ]);
    }
  });

  it('reads the times and text of the HTML', () => {
    expect(htmlTime('Nov 3, 2024, 7:15:22 PM CET')).toBe(new Date(2024, 10, 3, 19, 15, 22).getTime());
    expect(htmlTime('Nov 3, 2024, 12:05:00 AM GMT')).toBe(new Date(2024, 10, 3, 0, 5, 0).getTime());
    expect(htmlTime('3 Nov 2024, 07:15:22 GMT')).toBe(new Date(2024, 10, 3, 7, 15, 22).getTime());
    expect(htmlTime('Sept 30, 2024, 1:00:00 PM BST')).toBe(new Date(2024, 8, 30, 13, 0, 0).getTime());
    expect(htmlTime('yesterday')).toBeNaN();
    expect(htmlText('a&nbsp;<b>b</b>&amp;c&#39;d&#x41;')).toBe('a  b &c\'dA');
  });
});
