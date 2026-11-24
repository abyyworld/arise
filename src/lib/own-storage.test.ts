import { describe, expect, it } from 'vitest';
import { cleanOwnStorage, CORS, endpoint, isOn, mergeOwnStorage, readOwnStorage } from './own-storage';

const ACC = '0123456789abcdef0123456789abcdef';
const typed = { account: ` ${ACC.toUpperCase()} `, bucket: 'My-Arise', keyId: 'abcdef0123456789abcd', secret: 'Zy/x+0123456789abcdefghijklmnop' };

describe('your own storage', () => {
  it('takes what was typed, tidied, or says what is wrong', () => {
    expect(readOwnStorage(typed, 5)).toEqual({ account: ACC, bucket: 'my-arise', keyId: typed.keyId, secret: typed.secret, at: 5 });
    expect(readOwnStorage({ ...typed, account: '123' })).toContain('account ID');
    expect(readOwnStorage({ ...typed, bucket: 'a' })).toContain('bucket');
    expect(readOwnStorage({ ...typed, keyId: 'x' })).toContain('access key ID');
    expect(readOwnStorage({ ...typed, secret: 'short' })).toContain('secret');
    expect(endpoint({ account: ACC, bucket: 'my-arise' })).toBe(`https://${ACC}.r2.cloudflarestorage.com/my-arise`);
  });

  it('keeps only a right one, or a removal', () => {
    const s = readOwnStorage(typed, 5);
    expect(cleanOwnStorage(s)).toEqual(s);
    expect(cleanOwnStorage({ ...(s as object), at: 0 })).toBeNull();
    expect(cleanOwnStorage({ ...(s as object), bucket: '../x' })).toBeNull();
    expect(cleanOwnStorage({ off: true, at: 9, secret: 'kept?' })).toEqual({ account: '', bucket: '', keyId: '', secret: '', at: 9, off: true });
    expect(isOn(cleanOwnStorage({ off: true, at: 9 }))).toBe(false);
    expect(isOn(cleanOwnStorage(s))).toBe(true);
  });

  it('merges: the later change wins, a removal too', () => {
    const a = cleanOwnStorage(readOwnStorage(typed, 5))!;
    const off = cleanOwnStorage({ off: true, at: 9 })!;
    expect(mergeOwnStorage(a, off)).toBe(off);
    expect(mergeOwnStorage(off, a)).toBe(off);
    expect(mergeOwnStorage(null, a)).toBe(a);
    expect(mergeOwnStorage(a, null)).toBe(a);
  });

  it("asks the bucket to allow only Arise's addresses and what Arise does", () => {
    expect(CORS[0].AllowedOrigins).toEqual(['https://abyyworld.github.io', 'capacitor://localhost', 'https://localhost']);
    expect(CORS[0].AllowedMethods).toEqual(['GET', 'PUT', 'DELETE']);
  });
});
