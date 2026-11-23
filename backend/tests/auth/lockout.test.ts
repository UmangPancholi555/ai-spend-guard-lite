import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { TestCtx } from '../helpers/testApp';
import { LoginIpLimiter, getAuthCore, globalDelayMs, AttemptTracker } from '../../src/modules/auth/core';
import { ADMIN, closeAuthApp, newAuthApp, setupAdmin } from './helpers';

/**
 * Lockout design (no schema change):
 *  - 5 consecutive failures from one (username, IP) pair lock THAT pair for 15 min (in memory) - an attacker cannot lock the real user out elsewhere.
 *  - a global per-username ceiling (10 failures from any IPs) starts a progressive delay (15s, 30s, ... max 15 min, persisted in
 *    User.failedAttempts/lockedUntil); IPs that previously logged in successfully are exempt from the global delay.
 *  - real and unknown usernames follow identical rules; counters decay after 15 idle minutes.
 *  - offline recovery: `npm run user:unlock` / `user:reset-password`.
 * Tests use `trust proxy` + X-Forwarded-For to simulate distinct client IPs.
 */
let ctx: TestCtx;
const bad = 'wrong-password-attempt';
const attempt = (username: string, password: string, ip?: string) => {
  const r = request(ctx.app).post('/api/auth/login');
  if (ip) r.set('X-Forwarded-For', ip);
  return r.send({ username, password });
};
const KNOWN_IP = '198.51.100.7';
const ipN = (n: number) => `203.0.113.${n}`;

beforeAll(async () => {
  process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000'; // keep the IP throttle out of the way for lock tests
  ctx = await newAuthApp();
  ctx.app.set('trust proxy', true);
  await setupAdmin(ctx);
  await attempt('admin', ADMIN.password, KNOWN_IP).expect(200); // KNOWN_IP is now a "previously successful" address
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { delete process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE; await closeAuthApp(ctx); });

describe('per (username, IP) lock', { timeout: 120_000 }, () => {
  it('locks after 5 consecutive failures: 5x generic 401, then 429 + Retry-After (even for the right password)', async () => {
    const ip = ipN(1);
    for (let i = 0; i < 5; i++) {
      const r = await attempt('admin', bad, ip).expect(401);
      expect(r.body.error.message).toBe('Invalid username or password');
    }
    const locked = await attempt('admin', bad, ip).expect(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(900);
    const right = await attempt('admin', ADMIN.password, ip).expect(429);
    expect(right.headers['set-cookie']).toBeUndefined();
  });

  it('does NOT lock the real user out from another address (no username-lockout DoS)', async () => {
    // ipN(1) is still locked from the previous test
    await attempt('admin', ADMIN.password, ipN(1)).expect(429);
    await attempt('admin', ADMIN.password, ipN(2)).expect(200);
    await attempt('admin', ADMIN.password, KNOWN_IP).expect(200);
  });

  it('the lock expires after 15 minutes and the failure counter restarts', async () => {
    const ip = ipN(3);
    for (let i = 0; i < 5; i++) await attempt('admin', bad, ip).expect(401);
    await attempt('admin', ADMIN.password, ip).expect(429);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1000);
    await attempt('admin', bad, ip).expect(401); // not instantly re-locked: counter restarted at 1
    await attempt('admin', ADMIN.password, ip).expect(200);
  });

  it('failures decay when idle for 15 minutes (4 old + 4 new failures never lock)', async () => {
    const ip = ipN(4);
    for (let i = 0; i < 4; i++) await attempt('admin', bad, ip).expect(401);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    for (let i = 0; i < 4; i++) await attempt('admin', bad, ip).expect(401);
    await attempt('admin', ADMIN.password, ip).expect(200);
  });

  it('a successful login resets the pair counter (counter is for CONSECUTIVE failures)', async () => {
    const ip = ipN(5);
    for (let i = 0; i < 4; i++) await attempt('admin', bad, ip).expect(401);
    await attempt('admin', ADMIN.password, ip).expect(200);
    for (let i = 0; i < 4; i++) await attempt('admin', bad, ip).expect(401);
    await attempt('admin', ADMIN.password, ip).expect(200);
  });

  it('concurrent guesses from one pair cannot exceed the threshold (per-user serialisation)', async () => {
    const ip = ipN(6);
    const rs = await Promise.all(Array.from({ length: 12 }, () => attempt('admin', bad, ip)));
    expect(rs.filter(r => r.status === 401)).toHaveLength(5);
    expect(rs.filter(r => r.status === 429)).toHaveLength(7);
  });

  it('writes auth.login.failure / locked / success audit events (metadata only)', async () => {
    const types = new Set((await ctx.prisma.activityEvent.findMany({ where: { type: { startsWith: 'auth.login' } } })).map(e => e.type));
    for (const t of ['auth.login.failure', 'auth.login.locked', 'auth.login.success']) expect(types).toContain(t);
  });
});

describe('global per-username ceiling (progressive delay, trusted IPs exempt)', { timeout: 120_000 }, () => {
  it('math: below 10 failures no delay, then 15s doubling, capped at 15 minutes', () => {
    expect(globalDelayMs(9)).toBe(0);
    expect(globalDelayMs(10)).toBe(15_000);
    expect(globalDelayMs(11)).toBe(30_000);
    expect(globalDelayMs(12)).toBe(60_000);
    expect(globalDelayMs(40)).toBe(15 * 60_000);
  });

  let victim = 'victim';
  const VICTIM_PW = 'Walnut-Elephant-Marble-47';
  it('a distributed attack (10 failures from 10 IPs) delays untrusted IPs progressively, but the owner from a known IP still gets in', async () => {
    const admin = await request(ctx.app).post('/api/auth/login').set('X-Forwarded-For', KNOWN_IP).send(ADMIN).expect(200);
    await request(ctx.app).post('/api/auth/users').set('X-Forwarded-For', KNOWN_IP)
      .set('Cookie', admin.headers['set-cookie']!).set('X-CSRF-Token', admin.body.data.csrfToken)
      .send({ username: victim, password: VICTIM_PW, role: 'VIEWER' }).expect(201);
    await attempt(victim, VICTIM_PW, ipN(50)).expect(200); // ipN(50) becomes a known address of the victim
    for (let i = 0; i < 10; i++) await attempt(victim, bad, ipN(100 + i)).expect(401);

    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { username: victim } });
    expect(row.failedAttempts).toBe(10);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // brand new address, even with the right password: delayed (429 + Retry-After about 15s)
    const delayed = await attempt(victim, VICTIM_PW, ipN(200)).expect(429);
    expect(delayed.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(delayed.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(delayed.headers['retry-after'])).toBeLessThanOrEqual(15);
    // the real user from a previously successful address is NOT locked out
    await attempt(victim, VICTIM_PW, ipN(50)).expect(200);
    // ... and that success cleared the global counter
    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { username: victim } });
    expect(after.failedAttempts).toBe(0);
    expect(after.lockedUntil).toBeNull();
    await attempt(victim, VICTIM_PW, ipN(200)).expect(200);
  });

  it('delay doubles with every further failure; a known IP bypasses the global delay but not its own pair lock', async () => {
    victim = 'victim';
    for (let i = 0; i < 10; i++) await attempt(victim, bad, ipN(120 + i)).expect(401);
    await attempt(victim, bad, ipN(140)).expect(429); // delayed: untrusted attempts during the delay are not even evaluated
    let row = await ctx.prisma.user.findUniqueOrThrow({ where: { username: victim } });
    expect(row.failedAttempts).toBe(10);
    // the known address keeps being evaluated; each further failure doubles the delay for everyone else
    await attempt(victim, bad, ipN(50)).expect(401);
    row = await ctx.prisma.user.findUniqueOrThrow({ where: { username: victim } });
    expect(row.failedAttempts).toBe(11);
    const ms = row.lockedUntil!.getTime() - Date.now();
    expect(ms).toBeGreaterThan(20_000); expect(ms).toBeLessThanOrEqual(30_000); // 30s for the 11th
    for (let i = 0; i < 4; i++) await attempt(victim, bad, ipN(50)).expect(401);
    row = await ctx.prisma.user.findUniqueOrThrow({ where: { username: victim } });
    expect(row.failedAttempts).toBe(15);
    expect(row.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(400_000); // 15s * 2^5 = 480s
    await attempt(victim, VICTIM_PW, ipN(50)).expect(429); // 5 failures from this very pair: pair lock applies even to the trusted address
    await attempt(victim, VICTIM_PW, ipN(220)).expect(429); // and a fresh address is delayed
  });

  it('real-user counters decay when idle for 15 minutes (updatedAt based), lock included', async () => {
    await ctx.prisma.user.update({ where: { username: victim }, data: { failedAttempts: 12, lockedUntil: new Date(Date.now() + 600_000) } });
    await attempt(victim, VICTIM_PW, ipN(210)).expect(429);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await attempt(victim, VICTIM_PW, ipN(211)).expect(200);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { username: victim } })).failedAttempts).toBe(0);
  });

  it('unknown usernames behave identically: same status sequence, same locks, same decay', async () => {
    const seq = async (name: string, ips: string[]) => {
      const out: number[] = [];
      for (const ip of ips) out.push((await attempt(name, bad, ip)).status);
      return out;
    };
    // pair lock: 5x401 then 429
    expect(await seq('ghost-a', Array(6).fill(ipN(30)))).toEqual(await seq('admin', Array(6).fill(ipN(31))));
    // global: 10 distinct IPs of failures, then the next fresh IP is delayed
    const ghostIps = Array.from({ length: 11 }, (_, i) => ipN(60 + i));
    const ghost = await seq('ghost-b', ghostIps);
    expect(ghost.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(ghost[10]).toBe(429);
    const real = await ctx.prisma.user.create({ data: { username: 'twin', passwordHash: 'scrypt$x', role: 'VIEWER' } });
    const twin = await seq('twin', ghostIps.map((_, i) => ipN(80 + i)));
    expect(twin).toEqual(ghost);
    await ctx.prisma.user.delete({ where: { id: real.id } });
    // decay
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect((await attempt('ghost-b', bad, ipN(90))).status).toBe(401);
  });
});

describe('AttemptTracker / limiter units', () => {
  it('tracker: lock, expiry, idle decay and progressive mode', () => {
    const t = new AttemptTracker(3, 1000, 5000);
    expect([t.fail('k', 0), t.fail('k', 1), t.fail('k', 2)]).toEqual([false, false, true]);
    expect(t.lockedFor('k', 10)).toBeGreaterThan(0);
    expect(t.lockedFor('k', 2000)).toBe(0); // lock expired -> entry reset
    expect(t.fail('k', 2001)).toBe(false);
    expect(t.lockedFor('idle', 0)).toBe(0);
    t.fail('idle', 0); t.fail('idle', 1);
    expect(t.fail('idle', 6000)).toBe(false); // decayed before the 3rd failure
  });

  it('IP limiter defaults to 10 unsuccessful attempts per minute per IP (success refunds)', () => {
    const lim = new LoginIpLimiter(10);
    for (let i = 0; i < 10; i++) expect(lim.begin('1.2.3.4').ok).toBe(true);
    expect(lim.begin('1.2.3.4').ok).toBe(false);
    expect(lim.begin('5.6.7.8').ok).toBe(true);
    lim.refund('1.2.3.4');
    expect(lim.begin('1.2.3.4').ok).toBe(true);
    delete process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE;
    const fresh = getAuthCore({ ...ctx.deps });
    for (let i = 0; i < 10; i++) expect(fresh.limiter.begin('9.9.9.9').ok).toBe(true);
    expect(fresh.limiter.begin('9.9.9.9').ok).toBe(false);
    process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000';
  });
});

describe('per-IP throttle (HTTP)', { timeout: 120_000 }, () => {
  it('limits unsuccessful attempts per IP per minute with 429 RATE_LIMITED + Retry-After (limit=4 here)', async () => {
    process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '4';
    const local = await newAuthApp();
    try {
      await setupAdmin(local);
      for (let i = 0; i < 4; i++) await request(local.app).post('/api/auth/login').send({ username: `user${i}`, password: bad }).expect(401);
      const r = await request(local.app).post('/api/auth/login').send({ username: 'admin', password: ADMIN.password }).expect(429);
      expect(r.body.error.code).toBe('RATE_LIMITED');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
    } finally { await closeAuthApp(local); process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000'; }
  });

  it('successful logins do not consume the failure budget', async () => {
    process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '3';
    const local = await newAuthApp();
    try {
      await setupAdmin(local);
      for (let i = 0; i < 8; i++) await request(local.app).post('/api/auth/login').send(ADMIN).expect(200);
    } finally { await closeAuthApp(local); process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000'; }
  });
});
