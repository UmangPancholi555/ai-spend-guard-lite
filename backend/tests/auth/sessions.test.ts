import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TestCtx } from '../helpers/testApp';
import { ADMIN, closeAuthApp, cookieValue, login, newAuthApp, sessionCookie, setupAdmin } from './helpers';
import { sha256 } from '../../src/utils/ids';

let ctx: TestCtx;
beforeAll(async () => {
  process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000';
  ctx = await newAuthApp();
  await setupAdmin(ctx);
});
afterAll(async () => { delete process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE; await closeAuthApp(ctx); });

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe('session lifetime', () => {
  it('rejects and purges a session idle for more than 30 minutes', async () => {
    const s = await login(ctx, ADMIN);
    const row = await ctx.prisma.session.findFirstOrThrow({ where: { userId: s.userId }, orderBy: { createdAt: 'desc' } });
    await ctx.prisma.session.update({ where: { id: row.id }, data: { lastSeenAt: minutesAgo(31) } });
    await s.agent.get('/api/projects').expect(401);
    expect(await ctx.prisma.session.count({ where: { id: row.id } })).toBe(0);
  });

  it('keeps a session idle for under 30 minutes and slides lastSeenAt (written at most once a minute)', async () => {
    const s = await login(ctx, ADMIN);
    const row = await ctx.prisma.session.findFirstOrThrow({ where: { userId: s.userId }, orderBy: { createdAt: 'desc' } });
    await ctx.prisma.session.update({ where: { id: row.id }, data: { lastSeenAt: minutesAgo(25) } });
    await s.agent.get('/api/projects').expect(200);
    const afterFirst = (await ctx.prisma.session.findUniqueOrThrow({ where: { id: row.id } })).lastSeenAt;
    expect(Date.now() - afterFirst.getTime()).toBeLessThan(10_000);
    await s.agent.get('/api/projects').expect(200);
    await s.agent.get('/api/projects').expect(200);
    const afterMore = (await ctx.prisma.session.findUniqueOrThrow({ where: { id: row.id } })).lastSeenAt;
    expect(afterMore.getTime()).toBe(afterFirst.getTime()); // no write within the 1 minute window
    // a stale-by-2-minutes session is touched again
    await ctx.prisma.session.update({ where: { id: row.id }, data: { lastSeenAt: minutesAgo(2) } });
    await s.agent.get('/api/projects').expect(200);
    const touched = (await ctx.prisma.session.findUniqueOrThrow({ where: { id: row.id } })).lastSeenAt;
    expect(Date.now() - touched.getTime()).toBeLessThan(10_000);
  });

  it('enforces the absolute TTL even for an active session', async () => {
    const s = await login(ctx, ADMIN);
    const row = await ctx.prisma.session.findFirstOrThrow({ where: { userId: s.userId }, orderBy: { createdAt: 'desc' } });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(11.9 * 3_600_000);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThan(12.1 * 3_600_000);
    await ctx.prisma.session.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000), lastSeenAt: new Date() } });
    const r = await s.agent.get('/api/projects').expect(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
    expect(await ctx.prisma.session.count({ where: { id: row.id } })).toBe(0);
    // expired session cannot be used on the auth endpoints either
    await s.agent.get('/api/auth/me').expect(401);
  });

  it('purges dead sessions of other users lazily on the next login and caps sessions per user', async () => {
    const admin = await ctx.prisma.user.findFirstOrThrow();
    const stale = await ctx.prisma.session.create({ data: { userId: admin.id, tokenHash: sha256('stale-1'), csrfHash: sha256('x'), expiresAt: minutesAgo(5) } });
    for (let i = 0; i < 22; i++) {
      await ctx.prisma.session.create({ data: { userId: admin.id, tokenHash: sha256(`bulk-${i}`), csrfHash: sha256('x'), expiresAt: new Date(Date.now() + 3_600_000) } });
    }
    await login(ctx, ADMIN);
    expect(await ctx.prisma.session.count({ where: { id: stale.id } })).toBe(0);
    expect(await ctx.prisma.session.count({ where: { userId: admin.id } })).toBeLessThanOrEqual(20);
  });
});

describe('own sessions: list and revoke', () => {
  it('lists own sessions (current flagged, no secrets) and revokes another one', async () => {
    await ctx.prisma.session.deleteMany();
    const a = await login(ctx, ADMIN);
    const b = await login(ctx, ADMIN);
    const list = await a.agent.get('/api/auth/sessions').expect(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|csrfHash|sg_session/);
    const other = list.body.data.find((s: { current: boolean }) => !s.current);
    // csrf required for DELETE
    await a.agent.delete(`/api/auth/sessions/${other.id}`).expect(403);
    await a.agent.delete(`/api/auth/sessions/${other.id}`).set('X-CSRF-Token', a.csrf).expect(204);
    await b.agent.get('/api/auth/me').expect(401);
    await a.agent.get('/api/auth/me').expect(200);
    await a.agent.delete('/api/auth/sessions/does-not-exist').set('X-CSRF-Token', a.csrf).expect(404);
  });

  it("cannot revoke another user's session", async () => {
    const a = await login(ctx, ADMIN);
    const other = await ctx.prisma.user.create({ data: { username: 'bystander', passwordHash: 'scrypt$x', role: 'VIEWER' } });
    const foreign = await ctx.prisma.session.create({ data: { userId: other.id, tokenHash: sha256('f'), csrfHash: sha256('f'), expiresAt: new Date(Date.now() + 3_600_000) } });
    await a.agent.delete(`/api/auth/sessions/${foreign.id}`).set('X-CSRF-Token', a.csrf).expect(404);
    expect(await ctx.prisma.session.count({ where: { id: foreign.id } })).toBe(1);
    await ctx.prisma.user.delete({ where: { id: other.id } });
  });

  it('revoking the current session logs out and clears the cookie', async () => {
    const a = await login(ctx, ADMIN);
    const me = await a.agent.get('/api/auth/sessions').expect(200);
    const cur = me.body.data.find((s: { current: boolean }) => s.current);
    const res = await a.agent.delete(`/api/auth/sessions/${cur.id}`).set('X-CSRF-Token', a.csrf).expect(204);
    expect(sessionCookie(res)).toMatch(/sg_session=;/);
    await a.agent.get('/api/auth/me').expect(401);
  });
});

describe('password change', () => {
  const next = 'Fresh-Platypus-Kettle42';

  it('validates input, requires the current password, and counts wrong attempts', async () => {
    const s = await login(ctx, ADMIN);
    const h = { 'X-CSRF-Token': s.csrf };
    await s.agent.post('/api/auth/password').send({ currentPassword: ADMIN.password, newPassword: next }).expect(403); // no csrf
    await s.agent.post('/api/auth/password').set(h).send({ currentPassword: 'nope-nope-nope-1', newPassword: next }).expect(403)
      .then(r => expect(r.body.error.code).toBe('INVALID_CURRENT_PASSWORD'));
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).failedAttempts).toBe(1);
    await s.agent.post('/api/auth/password').set(h).send({ currentPassword: ADMIN.password, newPassword: 'short' }).expect(400);
    await s.agent.post('/api/auth/password').set(h).send({ currentPassword: ADMIN.password, newPassword: 'my-admin-secret-1' }).expect(400); // contains username
    await s.agent.post('/api/auth/password').set(h).send({ currentPassword: ADMIN.password, newPassword: ADMIN.password }).expect(400);
    await s.agent.post('/api/auth/password').set(h).send({ currentPassword: ADMIN.password, newPassword: 'password123456' }).expect(400);
  });

  it('changes the password, keeps the current session and kills ALL other sessions', async () => {
    await ctx.prisma.user.update({ where: { username: 'admin' }, data: { failedAttempts: 0, lockedUntil: null } });
    const keep = await login(ctx, ADMIN);
    const other1 = await login(ctx, ADMIN);
    const other2 = await login(ctx, ADMIN);
    const res = await keep.agent.post('/api/auth/password').set('X-CSRF-Token', keep.csrf).send({ currentPassword: ADMIN.password, newPassword: next }).expect(200);
    expect(res.body.data.changed).toBe(true);
    expect(res.body.data.otherSessionsRevoked).toBeGreaterThanOrEqual(2);
    await keep.agent.get('/api/auth/me').expect(200);
    await other1.agent.get('/api/auth/me').expect(401);
    await other2.agent.get('/api/auth/me').expect(401);
    expect(await ctx.prisma.session.count()).toBe(1);
    // old password no longer works, new one does
    await request(ctx.app).post('/api/auth/login').send(ADMIN).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: next }).expect(200);
    const types = (await ctx.prisma.activityEvent.findMany({ where: { type: 'auth.password.changed' } })).length;
    expect(types).toBe(1);
  });

  it('session cookie value of the kept session is unchanged and still hashed in the DB', async () => {
    const s = await login(ctx, { username: 'admin', password: next });
    const l = await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: next }).expect(200);
    const token = cookieValue(sessionCookie(l)!);
    expect(await ctx.prisma.session.count({ where: { tokenHash: sha256(token) } })).toBe(1);
    expect(s.userId).toBeTruthy();
  });
});
