// @vitest-environment jsdom
// Voice notes in a text box: Talk, the time and Stop, then the words in the box to fix before
// saving. With a fake microphone and a fake model (no real model is downloaded).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ui.js', () => ({
  esc: (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  toast: vi.fn(),
}));

import * as UI from '../ui.js';
import * as V from './voice-ui.js';

const toast = UI.toast as unknown as ReturnType<typeof vi.fn>;
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const tap = (act: string) => V.handleAction(act, $(`[data-act="${act}"]`));
const box = () => $('#box') as HTMLTextAreaElement;

let rec: { seconds: () => number; stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
let heard: { audio: Float32Array; language?: string }[];
let says: string;
let attach: ReturnType<typeof vi.fn>;
let inputs: number;

function setUp(over: Record<string, unknown> = {}) {
  V._setDeps({
    canRun: () => true,
    downloaded: async () => true,
    toDownload: async () => 41 * 1048576,
    start: async () => rec,
    samples: async () => new Float32Array(16000),
    transcriber: async () => ({
      transcribe: async (audio: Float32Array, opts?: { language?: string }) => {
        heard.push({ audio, language: opts?.language });
        return { text: says, language: 'en' };
      },
    }),
    attach,
    ...over,
  });
  document.body.innerHTML = `<form><textarea id="box" maxlength="2000"></textarea><input id="file" type="file"><div id="slot">${V.micButton('box', 'file')}</div></form>`;
  box().addEventListener('input', () => inputs++);
}

beforeEach(() => {
  localStorage.clear();
  toast.mockClear();
  rec = { seconds: () => 3, stop: vi.fn(async () => new Blob(['sound'], { type: 'audio/webm' })), cancel: vi.fn() };
  heard = [];
  says = 'Buy milk and eggs';
  attach = vi.fn(() => true);
  inputs = 0;
  setUp();
});
afterEach(() => {
  // Anything left listening stops.
  if ($('[data-act="voice-cancel"]')) tap('voice-cancel');
  V._setDeps(null);
});

describe('talking into the box', () => {
  it('records with the time and Stop, then puts the words in the box for fixing', async () => {
    expect($('[data-act="voice-mic"]')?.textContent).toContain('Talk');
    expect(tap('voice-mic')).toBe(true);
    await vi.waitFor(() => expect($('[data-act="voice-stop"]')).not.toBeNull());
    expect($('.voice-rec')?.textContent).toContain('0:03');
    tap('voice-stop');
    await vi.waitFor(() => expect(box().value).toBe('Buy milk and eggs'));
    expect(rec.stop).toHaveBeenCalled();
    expect(heard[0].audio.length).toBe(16000);
    expect(heard[0].language).toBe('auto');
    // The box is told, so it works out what it is (a grocery list, here), and nothing is saved yet.
    expect(inputs).toBe(1);
    expect(document.activeElement).toBe(box());
    await vi.waitFor(() => expect($('[data-act="voice-mic"]')).not.toBeNull());
    expect(attach).not.toHaveBeenCalled();
  });

  it('adds to what is already written', async () => {
    box().value = 'Note: ';
    tap('voice-mic');
    await vi.waitFor(() => expect($('[data-act="voice-stop"]')).not.toBeNull());
    tap('voice-stop');
    await vi.waitFor(() => expect(box().value).toBe('Note: Buy milk and eggs'));
  });

  it('listens for the language picked in the settings', async () => {
    localStorage.setItem('arise-voice', JSON.stringify({ on: true, lang: 'uz' }));
    tap('voice-mic');
    await vi.waitFor(() => expect($('[data-act="voice-stop"]')).not.toBeNull());
    tap('voice-stop');
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0].language).toBe('uz');
  });

  it('keeps the recording with the note only when that is turned on', async () => {
    localStorage.setItem('arise-voice', JSON.stringify({ on: true, keep: true }));
    tap('voice-mic');
    await vi.waitFor(() => expect($('[data-act="voice-stop"]')).not.toBeNull());
    tap('voice-stop');
    await vi.waitFor(() => expect(attach).toHaveBeenCalled());
    const [id, file] = attach.mock.calls[0] as [string, File];
    expect(id).toBe('file');
    expect(file.name).toMatch(/^Voice note \d{4}-\d\d-\d\d \d\d\.\d\d\.webm$/);
    expect(file.type).toBe('audio/webm');
  });

  it("says so when it heard no words, and leaves the box alone", async () => {
    says = '';
    box().value = 'mine';
    tap('voice-mic');
    await vi.waitFor(() => expect($('[data-act="voice-stop"]')).not.toBeNull());
    tap('voice-stop');
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("didn't hear any words")));
    expect(box().value).toBe('mine');
  });

  it('can be cancelled, and nothing is written', async () => {
    tap('voice-mic');
    await vi.waitFor(() => expect($('[data-act="voice-cancel"]')).not.toBeNull());
    tap('voice-cancel');
    expect(rec.cancel).toHaveBeenCalled();
    expect($('[data-act="voice-mic"]')).not.toBeNull();
    expect(heard).toHaveLength(0);
  });

  it('stops the microphone when the box goes away (its sheet was closed)', async () => {
    vi.useFakeTimers();
    try {
      tap('voice-mic');
      await vi.waitFor(() => expect($('[data-act="voice-stop"]')).not.toBeNull());
      $('#slot')!.remove();
      vi.advanceTimersByTime(600);
      expect(rec.cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says plainly when the microphone is refused', async () => {
    setUp({
      start: async () => {
        throw new Error("Arise can't use the microphone.");
      },
    });
    tap('voice-mic');
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Arise can't use the microphone."));
    expect($('[data-act="voice-mic"]')).not.toBeNull();
  });
});

describe('before the model is here', () => {
  it('offers the download with its size, and Talk works once it is done', async () => {
    let done = false;
    const download = vi.fn(async ({ onProgress }: { onProgress: (p: { got: number; total: number }) => void }) => {
      onProgress({ got: 10, total: 100 });
      done = true;
    });
    setUp({ downloaded: async () => done, download });
    tap('voice-mic');
    await vi.waitFor(() => expect($('#voice-box')?.textContent).toContain('download about 41 MB once, kept on this device'));
    expect($('#voice-box')?.classList.contains('wide')).toBe(true);
    tap('voice-get');
    await vi.waitFor(() => expect($('[data-act="voice-mic"]')).not.toBeNull());
    expect(download).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Voice notes are on. Tap Talk and speak.');
    tap('voice-mic');
    await vi.waitFor(() => expect($('[data-act="voice-stop"]')).not.toBeNull());
  });

  it('shows why a download failed, and offers it again', async () => {
    setUp({
      downloaded: async () => false,
      download: async () => {
        throw new Error("The voice model couldn't be downloaded.");
      },
    });
    tap('voice-mic');
    await vi.waitFor(() => expect($('[data-act="voice-get"]')).not.toBeNull());
    tap('voice-get');
    await vi.waitFor(() => expect($('#voice-box')?.textContent).toContain("couldn't be downloaded"));
    expect($('[data-act="voice-get"]')).not.toBeNull();
    tap('voice-close');
    expect($('[data-act="voice-mic"]')).not.toBeNull();
  });

  it("says so on a device that can't run it", async () => {
    setUp({ canRun: () => false });
    tap('voice-mic');
    await vi.waitFor(() => expect($('#voice-box')?.textContent).toContain("can't work on this device"));
    expect(V.panel()).toContain("can't work on this device");
  });
});

describe('the settings', () => {
  it('picks the language and keeping the recording, off to start with', () => {
    localStorage.setItem('arise-voice', JSON.stringify({ on: true, at: 1 }));
    document.body.innerHTML = V.panel();
    expect($('#voicePanel')?.textContent).toContain('Whisper tiny');
    const lang = $('#voiceLang') as HTMLSelectElement;
    expect(lang.value).toBe('auto');
    expect([...lang.options].map((o) => o.value)).toEqual(expect.arrayContaining(['en', 'uz', 'ru']));
    lang.value = 'ru';
    lang.dispatchEvent(new Event('change', { bubbles: true }));
    expect(JSON.parse(localStorage.getItem('arise-voice')!).lang).toBe('ru');
    expect($('[data-act="voice-keep"]')?.getAttribute('aria-pressed')).toBe('false');
    tap('voice-keep');
    expect($('[data-act="voice-keep"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});
