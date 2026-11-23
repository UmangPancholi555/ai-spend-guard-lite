import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TestCtx } from '../helpers/testApp';
import { LoginIpLimiter, getAuthCore } from '../../src/modules/auth/core';
import { ADMIN, closeAuthApp, newAuthApp, setupAdmin } from './helpers';

let ctx: TestCtx;
const bad = { password: 'wrong-password-attempt' };
const attempt = (username: string, password: string) => request(ctx.app).post('/api/auth/login').send({ username, password });

beforeAll(async () => {
  process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000'; // keep the IP throttle out of the way for account-lock tests
  ctx = await newAuthApp();
  await setupAdmin(ctx);
});
afterAll(async () => { delete process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE; await closeAuthApp(ctx); });

describe('per-account lockout', () => {
  it('locks after 5 consecutive failures: 5x generic 401, then 429 + Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await attempt('admin', bad.password).expect(401);
      expect(r.body.error.message).toBe('Invalid username or password');
    }
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
    expect(user.failedAttempts).toBe(5);
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    const locked = await attempt('admin', bad.password).expect(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(900);
  });

  it('rejects even the CORRECT password while locked (no oracle during the lock)', async () => {
    const r = await attempt('admin', ADMIN.password).expect(429);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('lock expires: after lockedUntil passes the right password works and counters reset', async () => {
    await ctx.prisma.user.update({ where: { username: 'admin' }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await attempt('admin', ADMIN.password).expect(200);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
    expect(user.failedAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });

  it('after an expired lock the failure counter restarts (not instantly re-locked)', async () => {
    await ctx.prisma.user.update({ where: { username: 'admin' }, data: { failedAttempts: 5, lockedUntil: new Date(Date.now() - 1000) } });
    await attempt('admin', bad.password).expect(401);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
    expect(user.failedAttempts).toBe(1);
    expect(user.lockedUntil).toBeNull();
    await attempt('admin', ADMIN.password).expect(200);
  });

  it('a successful login resets earlier failures (counter is for CONSECUTIVE failures)', async () => {
    for (let i = 0; i < 4; i++) await attempt('admin', bad.password).expect(401);
    await attempt('admin', ADMIN.password).expect(200);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).failedAttempts).toBe(0);
    for (let i = 0; i < 4; i++) await attempt('admin', bad.password).expect(401); // would be 8 total if not reset
    await attempt('admin', ADMIN.password).expect(200);
  });

  it('unknown usernames lock identically (no account-existence signal)', async () => {
    for (let i = 0; i < 5; i++) await attempt('ghost-user', bad.password).expect(401);
    const r = await attempt('ghost-user', bad.password).expect(429);
    expect(r.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('concurrent guesses cannot exceed the lock threshold meaningfully (per-user serialisation)', async () => {
    await ctx.prisma.user.update({ where: { username: 'admin' }, data: { failedAttempts: 0, lockedUntil: null } });
    const rs = await Promise.all(Array.from({ length: 12 }, () => attempt('admin', bad.password)));
    const ok401 = rs.filter(r => r.status === 401).length;
    const ok429 = rs.filter(r => r.status === 429).length;
    expect(ok401).toBe(5);
    expect(ok429).toBe(7);
  });

  it('writes auth.login.failure and auth.login.locked audit events (metadata only)', async () => {
    const types = (await ctx.prisma.activityEvent.findMany({ where: { type: { startsWith: 'auth.login' } } })).map(e => e.type);
    expect(types).toContain('auth.login.failure');
    expect(types).toContain('auth.login.locked');
    expect(types).toContain('auth.login.success');
  });
});

describe('per-IP throttle', () => {
  it('defaults to 10 unsuccessful attempts per minute per IP (window resets, success refunds)', () => {
    const lim = new LoginIpLimiter(10);
    for (let i = 0; i < 10; i++) expect(lim.begin('1.2.3.4').ok).toBe(true);
    const blocked = lim.begin('1.2.3.4');
    expect(blocked.ok).toBe(false);
    expect(lim.begin('5.6.7.8').ok).toBe(true); // other IPs unaffected
    lim.refund('1.2.3.4');
    expect(lim.begin('1.2.3.4').ok).toBe(true);
    delete process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE;
    const fresh = getAuthCore({ ...ctx.deps });
    for (let i = 0; i < 10; i++) expect(fresh.limiter.begin('9.9.9.9').ok).toBe(true);
    expect(fresh.limiter.begin('9.9.9.9').ok).toBe(false);
    process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000';
  });

  it('limits unsuccessful attempts per IP per minute with 429 RATE_LIMITED + Retry-After (limit=4 here)', async () => {
    process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '4';
    const local = await newAuthApp();
    try {
      await setupAdmin(local);
      // distinct usernames so the account lock does not interfere
      for (let i = 0; i < 4; i++) {
        await request(local.app).post('/api/auth/login').send({ username: `user${i}`, password: bad.password }).expect(401);
      }
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
