/**
 * Password hashing + policy.
 *  - scrypt (N=2^15, r=8, p=1, 16B random salt, 64B key), encoded `scrypt$N$r$p$saltB64$hashB64`.
 *  - verification is constant-time (timingSafeEqual); parameters are read from the stored string so they can be raised later,
 *    but are bounded so a tampered DB row cannot trigger unbounded CPU/memory use.
 *  - `dummyVerify` burns the same work for unknown usernames (no user-enumeration timing signal).
 */
import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export const SCRYPT_N = 1 << 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}
const maxmemFor = (N: number, r: number) => 128 * N * r * 2 + 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: maxmemFor(SCRYPT_N, SCRYPT_R) });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

interface Parsed { N: number; r: number; p: number; salt: Buffer; key: Buffer }
function parseHash(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 1 << 14 || N > 1 << 20 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[4]!, 'base64'); const key = Buffer.from(parts[5]!, 'base64');
  if (salt.length < 8 || key.length < 16 || key.length > 128) return null;
  return { N, r, p, salt, key };
}

/** true iff `password` matches `stored`. Never throws (malformed hash => false after burning default-cost work). */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) { await dummyVerify(password); return false; }
  try {
    const key = await scryptAsync(password, parsed.salt, parsed.key.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: maxmemFor(parsed.N, parsed.r) });
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  } catch { return false; }
}

let dummyHash: Promise<string> | undefined;
/** Same cost as a real verify; always resolves false. Use for unknown usernames. */
export async function dummyVerify(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  const h = parseHash(await dummyHash)!;
  try { await scryptAsync(password, h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem: maxmemFor(h.N, h.r) }); } catch { /* ignore */ }
  return false;
}

// ----------------------------------------------------------------------------- policy
const COMMON = new Set([
  'password', 'passw0rd', 'letmein', 'welcome', 'admin', 'administrator', 'qwerty', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm',
  'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'abc123', 'trustno1', 'sunshine', 'princess', 'master',
  'changeme', 'changemenow', 'secret', 'default', 'login', 'whatever', 'freedom', 'superman', 'starwars', 'shadow',
  'spendguard', 'aispendguard', 'spendguardlite', 'aispendguardlite', 'correcthorsebatterystaple',
  'qwertyuiopasdf', 'qwertyuiopasdfghjkl', 'abcdefghijkl', 'abcdefghijklmnop',
]);

/** Returns human-readable problems (empty array = acceptable). */
export function validatePassword(password: string, username?: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN) problems.push(`Password must be at least ${PASSWORD_MIN} characters.`);
  if (password.length > PASSWORD_MAX) problems.push(`Password must be at most ${PASSWORD_MAX} characters.`);
  const lower = password.toLowerCase();
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) problems.push('Password must not contain the username.');
  const norm = lower.replace(/[^a-z0-9]/g, '');
  const base = norm.replace(/\d+$/, '');
  const digitsOnly = /^\d+$/.test(norm);
  const sequential = digitsOnly && '01234567890123456789'.includes(norm.slice(0, 10));
  if (COMMON.has(norm) || COMMON.has(base) || /^(.)\1+$/.test(password) || sequential) problems.push('Password is too common.');
  return problems;
}

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
export function normalizeUsername(raw: string): string { return raw.trim().toLowerCase(); }
export function isValidUsername(normalized: string): boolean { return USERNAME_RE.test(normalized); }
