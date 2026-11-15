// @vitest-environment jsdom
// Your files: Arise's backups (and the browser extension) in a synced folder of the Player's own,
// like their Filen folder, written by the browser; the newest 7 kept.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

// A folder in memory, with what browsers give for a picked folder.
class Dir {
  files = new Map<string, unknown>();
  dirs = new Map<string, Dir>();
  perm = 'granted';
  constructor(public name: string) {}
  async getDirectoryHandle(n: string, o?: { create?: boolean }) {
    if (!this.dirs.has(n)) {
      if (!o?.create) throw new Error('missing');
      this.dirs.set(n, new Dir(n));
    }
    return this.dirs.get(n)!;
  }
  failWrites = false;
  aborted = 0;
  async getFileHandle(n: string) {
    return {
      createWritable: async () => ({
        write: async (d: unknown) => {
          if (this.failWrites) throw new Error('Not enough space.');
          this.files.set(n, d);
        },
        close: async () => {},
        abort: async () => void this.aborted++,
      }),
    };
  }
  async *entries() {
    for (const k of [...this.files.keys(), ...this.dirs.keys()]) yield [k, null];
  }
  async removeEntry(n: string) {
    this.files.delete(n);
  }
  async queryPermission() {
    return this.perm;
  }
  async requestPermission() {
    this.perm = 'granted';
    return this.perm;
  }
}

let held: Dir | null = null;
async function load() {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, todos: { a: { id: 'a', title: 'Call mum', created: 1, at: 1 } } }));
  const F = await import('./files-folder.js');
  held = null;
  F._useStore({ get: async () => held, put: async (h: Dir) => void (held = h), drop: async () => void (held = null) });
  return F;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 15, 10));
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

describe('your files', () => {
  it('works where the browser can be given a folder', async () => {
    const F = await load();
    expect(F.supported()).toBe(false);
    (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = async () => new Dir('Filen');
    expect(F.supported()).toBe(true);
  });

  it("backs up into Arise/backups once picked, then once a day, keeping the newest 7", async () => {
    const F = await load();
    const filen = new Dir('Filen');
    (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = async () => filen;
    expect(await F.pick()).toBe(true);
    const backups = filen.dirs.get('Arise')!.dirs.get('backups')!;
    expect([...backups.files.keys()]).toEqual(['arise-backup-2026-11-15.json']);
    const saved = JSON.parse(backups.files.get('arise-backup-2026-11-15.json') as string);
    expect(saved.todos.a.title).toBe('Call mum');
    expect(F.state()).toMatchObject({ name: 'Filen', last: Date.now(), error: '' });

    // Not again the same day; the next day, yes.
    expect(await F.backupIfDue()).toBe(false);
    for (let d = 1; d <= 9; d++) backups.files.set(`arise-backup-2026-10-${String(d).padStart(2, '0')}.json`, '{}');
    vi.setSystemTime(new Date(2026, 10, 16, 11));
    expect(await F.backupIfDue()).toBe(true);
    expect([...backups.files.keys()].sort().at(-1)).toBe('arise-backup-2026-11-16.json');
    expect(backups.files.size).toBe(7);
    expect(backups.files.has('arise-backup-2026-11-15.json')).toBe(true);
  });

  it('waits for a tap when the browser asks for permission again', async () => {
    const F = await load();
    const filen = new Dir('Filen');
    (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = async () => filen;
    await F.pick();
    filen.perm = 'prompt';
    expect(await F.access()).toBe('prompt');
    vi.setSystemTime(new Date(2026, 10, 17, 9));
    expect(await F.backupIfDue()).toBe(false);
    expect(F.state().error).toBe(F.PAUSED); // said, so it doesn't stop quietly
    expect(await F.backupNow({ ask: true })).toBe(true); // a tap asks
    expect(F.state().error).toBe('');
    filen.perm = 'denied';
    expect(await F.access(true)).toBe('denied');
    await expect(F.backupNow({ ask: true })).rejects.toThrow('blocked');
  });

  it('puts the browser extension there for the other computers, and stops when asked', async () => {
    const F = await load();
    const filen = new Dir('Filen');
    (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = async () => filen;
    await F.pick();
    const zip = new Blob(['zip']);
    expect(await F.saveExtension(async () => new Response(zip))).toBe(true);
    expect(filen.dirs.get('Arise')!.files.has('arise-extension-chrome.zip')).toBe(true);
    await expect(F.saveExtension(async () => new Response('', { status: 404 }))).rejects.toThrow("isn't on this copy");
    await F.forget();
    expect(F.state().name).toBe('');
    expect(await F.access()).toBe('none');
  });

  it('says when the folder is full, and leaves no half-written file', async () => {
    const F = await load();
    const filen = new Dir('Filen');
    (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = async () => filen;
    await F.pick();
    const backups = filen.dirs.get('Arise')!.dirs.get('backups')!;
    backups.failWrites = true;
    vi.setSystemTime(new Date(2026, 10, 18, 9));
    expect(await F.backupIfDue()).toBe(false);
    expect(F.state().error).toBe('Not enough space.');
    expect(backups.aborted).toBe(1);
  });

  it('keeps the newest backups by name', async () => {
    const F = await load();
    expect(F.oldBackups(['arise-backup-2026-01-01.json', 'notes.txt', 'arise-backup-2026-01-03.json', 'arise-backup-2026-01-02.json'], 2)).toEqual(['arise-backup-2026-01-01.json']);
  });
});
