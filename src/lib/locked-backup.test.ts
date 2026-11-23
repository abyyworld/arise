import { describe, expect, it } from 'vitest';
import { deriveBackupKey, fits, isLocked, lock, unlock } from './locked-backup';

// Fewer rounds than the real 600,000, so the tests run quickly (the file says how many).
const ITER = 100_000;
const PW = 'a long backup password';
const backup = JSON.stringify({ app: 'physical-improvement-tracker', sessions: [{ id: 's1' }], logs: { '2026-11-01': { t: 'my secret journal entry' } } });

describe('a locked backup', () => {
  it('opens with the backup password, and shows nothing of the backup', async () => {
    const k = await deriveBackupKey(PW, undefined, ITER);
    const text = await lock(k, backup);
    const file = JSON.parse(text);
    expect(Object.keys(file).sort()).toEqual(['arise', 'ct', 'iter', 'iv', 'salt', 'v']);
    expect(file).toMatchObject({ arise: 'locked-backup', v: 1, iter: ITER });
    expect(text).not.toContain('secret journal');
    expect(text).not.toContain('sessions');
    expect(text).not.toContain(PW);
    expect(isLocked(file)).toBe(true);
    expect(await unlock(file, PW)).toBe(backup);
    // The key kept on the device opens it too, without the password.
    expect(fits(k, file)).toBe(true);
    expect(await unlock(file, k)).toBe(backup);
  });

  it("doesn't open with another password, or with a key made for another file", async () => {
    const file = JSON.parse(await lock(await deriveBackupKey(PW, undefined, ITER), backup));
    await expect(unlock(file, 'not the password')).rejects.toMatchObject({ code: 'wrong-key' });
    const other = await deriveBackupKey(PW, undefined, ITER); // another salt
    expect(fits(other, file)).toBe(false);
    expect(fits(null, file)).toBe(false);
  });

  it('says so plainly when the file is broken or changed', async () => {
    const file = JSON.parse(await lock(await deriveBackupKey(PW, undefined, ITER), backup));
    await expect(unlock({ ...file, iter: 5 }, PW)).rejects.toMatchObject({ code: 'bad-data' });
    await expect(unlock({ ...file, v: 2 }, PW)).rejects.toMatchObject({ code: 'bad-data' });
    await expect(unlock({ ...file, ct: 'not base64!' }, PW)).rejects.toMatchObject({ code: 'bad-data' });
    // Changed by someone: it no longer opens.
    const ct = `${file.ct[0] === 'A' ? 'B' : 'A'}${file.ct.slice(1)}`;
    await expect(unlock({ ...file, ct }, PW)).rejects.toMatchObject({ code: 'wrong-key' });
  });

  it('tells a plain backup from a locked one', () => {
    expect(isLocked(JSON.parse(backup))).toBe(false);
    expect(isLocked(null)).toBe(false);
    expect(isLocked('locked-backup')).toBe(false);
  });
});
