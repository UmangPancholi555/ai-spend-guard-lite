import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { dummyVerify, hashPassword, isValidUsername, normalizeUsername, validatePassword, verifyPassword } from '../../src/utils/password';

describe('scrypt hashing', () => {
  it('encodes scrypt$N$r$p$salt$hash with N=2^15, r=8, p=1, 16B salt, 64B key', async () => {
    const h = await hashPassword('Correct-Horse-Battery-1');
    const [tag, N, r, p, salt, key] = h.split('$');
    expect(tag).toBe('scrypt');
    expect([N, r, p]).toEqual(['32768', '8', '1']);
    expect(Buffer.from(salt!, 'base64')).toHaveLength(16);
    expect(Buffer.from(key!, 'base64')).toHaveLength(64);
    expect(h).not.toContain('Correct-Horse');
  });

  it('verifies the right password, rejects wrong ones, and salts uniquely', async () => {
    const pw = 'Correct-Horse-Battery-1';
    const [a, b] = await Promise.all([hashPassword(pw), hashPassword(pw)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, pw)).toBe(true);
    expect(await verifyPassword(a, `${pw}x`)).toBe(false);
    expect(await verifyPassword(a, '')).toBe(false);
    expect(await verifyPassword(b, pw)).toBe(true);
  });

  it('treats malformed / tampered hashes as a mismatch without throwing (and bounds cost parameters)', async () => {
    expect(await verifyPassword('', 'x')).toBe(false);
    expect(await verifyPassword('plaintext', 'plaintext')).toBe(false);
    expect(await verifyPassword('scrypt$1$1$1$AAAA$AAAA', 'x')).toBe(false);
    const huge = `scrypt$${2 ** 30}$8$1$${randomBytes(16).toString('base64')}$${randomBytes(64).toString('base64')}`;
    const t = Date.now();
    expect(await verifyPassword(huge, 'x')).toBe(false); // rejected up front, not computed
    expect(Date.now() - t).toBeLessThan(5000);
    expect(await verifyPassword(`bcrypt$32768$8$1$${randomBytes(16).toString('base64')}$${randomBytes(64).toString('base64')}`, 'x')).toBe(false);
  });

  it('dummyVerify costs about the same as a real verify and always returns false', async () => {
    const h = await hashPassword('Correct-Horse-Battery-1');
    await dummyVerify('warm-up');
    const t0 = performance.now(); await verifyPassword(h, 'nope'); const real = performance.now() - t0;
    const t1 = performance.now(); expect(await dummyVerify('nope')).toBe(false); const dummy = performance.now() - t1;
    expect(dummy).toBeGreaterThan(real * 0.3);
    expect(dummy).toBeLessThan(real * 4 + 200);
  });
});

describe('password policy', () => {
  it('requires 12..128 characters', () => {
    expect(validatePassword('Short-1')).toEqual(expect.arrayContaining([expect.stringMatching(/at least 12/)]));
    expect(validatePassword('A'.repeat(11) + '1')).not.toEqual(expect.arrayContaining([expect.stringMatching(/at least 12/)]));
    expect(validatePassword('Tr1cky-Horse-Stapler')).toEqual([]);
    expect(validatePassword('a-Z9'.repeat(32))).toEqual([]); // exactly 128
    expect(validatePassword('a-Z9'.repeat(32) + 'x')).toEqual(expect.arrayContaining([expect.stringMatching(/at most 128/)]));
  });

  it('rejects passwords containing the username (case-insensitive)', () => {
    expect(validatePassword('xxAliceYY-Long-Enough', 'alice')).toEqual(['Password must not contain the username.']);
    expect(validatePassword('Long-Enough-Phrase-9', 'alice')).toEqual([]);
  });

  it.each(['password1234', 'Password123456', 'qwertyuiop12', 'Welcome-12345', 'changeme12345', 'aaaaaaaaaaaa', '123456789012', 'letmein!!!!!!!'])(
    'rejects common password %s', pw => {
      expect(validatePassword(pw)).toContain('Password is too common.');
    },
  );

  it('normalises and validates usernames', () => {
    expect(normalizeUsername('  Alice.B  ')).toBe('alice.b');
    for (const ok of ['abc', 'a.b-c_d', 'u'.repeat(32), 'user01']) expect(isValidUsername(ok)).toBe(true);
    for (const bad of ['ab', 'u'.repeat(33), 'has space', 'Upper', 'ünï', 'semi;colon', 'a/b', '']) expect(isValidUsername(bad)).toBe(false);
  });
});
