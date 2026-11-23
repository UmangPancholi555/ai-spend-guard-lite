import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TestCtx } from '../helpers/testApp';
import { ADMIN, VIEWER, closeAuthApp, createAndLogin, login, newAuthApp, setupAdmin, type Session } from './helpers';

let ctx: TestCtx;
let admin: Session;
const h = (s: Session) => ({ 'X-CSRF-Token': s.csrf });

beforeAll(async () => {
  process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000';
  ctx = await newAuthApp();
  admin = await setupAdmin(ctx);
});
afterAll(async () => { delete process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE; await closeAuthApp(ctx); });

describe('admin user management', () => {
  it('creates users (lowercased), never returns hashes, rejects duplicates and weak input', async () => {
    const r = await admin.agent.post('/api/auth/users').set(h(admin)).send({ username: 'Carol.Dev', password: 'Maple-Syrup-Rocket-31', role: 'VIEWER' }).expect(201);
    expect(r.body.data).toMatchObject({ username: 'carol.dev', role: 'VIEWER' });
    expect(JSON.stringify(r.body)).not.toMatch(/scrypt|passwordHash/);
    await admin.agent.post('/api/auth/users').set(h(admin)).send({ username: 'carol.dev', password: 'Maple-Syrup-Rocket-31', role: 'VIEWER' }).expect(409);
    await admin.agent.post('/api/auth/users').set(h(admin)).send({ username: 'x', password: 'Maple-Syrup-Rocket-31', role: 'VIEWER' }).expect(400);
    await admin.agent.post('/api/auth/users').set(h(admin)).send({ username: 'bad name!', password: 'Maple-Syrup-Rocket-31', role: 'VIEWER' }).expect(400);
    await admin.agent.post('/api/auth/users').set(h(admin)).send({ username: 'dave', password: 'weak', role: 'VIEWER' }).expect(400);
    await admin.agent.post('/api/auth/users').set(h(admin)).send({ username: 'dave', password: 'Maple-Syrup-Rocket-31', role: 'ROOT' }).expect(400);
    await admin.agent.post('/api/auth/users').set(h(admin)).send({ username: 'dave', password: 'dave-is-my-password-1', role: 'VIEWER' }).expect(400);
  });

  it('lists users with lock state and session counts (ADMIN only)', async () => {
    const r = await admin.agent.get('/api/auth/users').expect(200);
    const usernames = r.body.data.map((u: { username: string }) => u.username);
    expect(usernames).toEqual(expect.arrayContaining(['admin', 'carol.dev']));
    const me = r.body.data.find((u: { username: string }) => u.username === 'admin');
    expect(me).toMatchObject({ role: 'ADMIN', locked: false, failedAttempts: 0 });
    expect(me.activeSessions).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.body)).not.toMatch(/scrypt|passwordHash|tokenHash/);
  });

  it('role changes take effect immediately on live sessions', async () => {
    const eve = await createAndLogin(ctx, admin, { username: 'eve', password: 'Quartz-Heron-Window-72' }, 'ADMIN');
    await eve.agent.post('/api/projects').set(h(eve)).send({ name: 'by-eve', isTest: true }).expect(201);
    await admin.agent.patch(`/api/auth/users/${eve.userId}`).set(h(admin)).send({ role: 'VIEWER' }).expect(200);
    await eve.agent.post('/api/projects').set(h(eve)).send({ name: 'by-eve-2', isTest: true }).expect(403);
    await eve.agent.get('/api/projects').expect(200);
    await admin.agent.patch(`/api/auth/users/${eve.userId}`).set(h(admin)).send({ role: 'ADMIN' }).expect(200);
    await eve.agent.post('/api/projects').set(h(eve)).send({ name: 'by-eve-3', isTest: true }).expect(201);
  });

  it('password reset revokes every session of the target and unlocks the account', async () => {
    const frank = await createAndLogin(ctx, admin, { username: 'frank', password: 'Cobalt-Meadow-Tractor-19' }, 'VIEWER');
    const frank2 = await login(ctx, { username: 'frank', password: 'Cobalt-Meadow-Tractor-19' });
    await ctx.prisma.user.update({ where: { id: frank.userId }, data: { failedAttempts: 5, lockedUntil: new Date(Date.now() + 600_000) } });
    const listed = await admin.agent.get('/api/auth/users').expect(200);
    expect(listed.body.data.find((u: { username: string }) => u.username === 'frank').locked).toBe(true);
    await admin.agent.patch(`/api/auth/users/${frank.userId}`).set(h(admin)).send({ password: 'frank-reset-pass-1' }).expect(400); // contains username
    await admin.agent.patch(`/api/auth/users/${frank.userId}`).set(h(admin)).send({ password: 'Reset-Gazelle-Anchor-64' }).expect(200);
    await frank.agent.get('/api/auth/me').expect(401);
    await frank2.agent.get('/api/auth/me').expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'frank', password: 'Cobalt-Meadow-Tractor-19' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'frank', password: 'Reset-Gazelle-Anchor-64' }).expect(200);
  });

  it('unlock clears a lock without touching the password; empty patch is a 400', async () => {
    const gina = await createAndLogin(ctx, admin, { username: 'gina', password: 'Indigo-Falcon-Pebble-27' }, 'VIEWER');
    await ctx.prisma.user.update({ where: { id: gina.userId }, data: { failedAttempts: 5, lockedUntil: new Date(Date.now() + 600_000) } });
    await request(ctx.app).post('/api/auth/login').send({ username: 'gina', password: 'Indigo-Falcon-Pebble-27' }).expect(429);
    await admin.agent.patch(`/api/auth/users/${gina.userId}`).set(h(admin)).send({ unlock: true }).expect(200);
    await request(ctx.app).post('/api/auth/login').send({ username: 'gina', password: 'Indigo-Falcon-Pebble-27' }).expect(200);
    await admin.agent.patch(`/api/auth/users/${gina.userId}`).set(h(admin)).send({}).expect(400);
    await admin.agent.patch('/api/auth/users/nope').set(h(admin)).send({ unlock: true }).expect(404);
  });

  it('deleting a user removes their sessions; unknown id is 404', async () => {
    const hank = await createAndLogin(ctx, admin, { username: 'hank', password: 'Velvet-Orchid-Lantern-93' }, 'VIEWER');
    await admin.agent.delete(`/api/auth/users/${hank.userId}`).set(h(admin)).expect(204);
    await hank.agent.get('/api/auth/me').expect(401);
    expect(await ctx.prisma.session.count({ where: { userId: hank.userId } })).toBe(0);
    await admin.agent.delete(`/api/auth/users/${hank.userId}`).set(h(admin)).expect(404);
  });
});

describe('safety rails', () => {
  it('an admin cannot delete themself', async () => {
    const r = await admin.agent.delete(`/api/auth/users/${admin.userId}`).set(h(admin)).expect(409);
    expect(r.body.error.code).toBe('CANNOT_DELETE_SELF');
  });

  it('the last ADMIN cannot be demoted', async () => {
    const solo = await newAuthApp();
    try {
      const a = await setupAdmin(solo);
      const r = await a.agent.patch(`/api/auth/users/${a.userId}`).set(h(a)).send({ role: 'VIEWER' }).expect(409);
      expect(r.body.error.code).toBe('LAST_ADMIN');
      expect((await solo.prisma.user.findUniqueOrThrow({ where: { id: a.userId } })).role).toBe('ADMIN');
    } finally { await closeAuthApp(solo); }
  });

  it('two admins demoting each other concurrently cannot leave zero admins', async () => {
    const duo = await newAuthApp();
    try {
      const a = await setupAdmin(duo);
      const b = await createAndLogin(duo, a, { username: 'second-admin', password: 'Tundra-Fox-Compass-58' }, 'ADMIN');
      const [r1, r2] = await Promise.all([
        a.agent.patch(`/api/auth/users/${b.userId}`).set(h(a)).send({ role: 'VIEWER' }),
        b.agent.patch(`/api/auth/users/${a.userId}`).set(h(b)).send({ role: 'VIEWER' }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      expect(await duo.prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);
    } finally { await closeAuthApp(duo); }
  });

  it('a VIEWER cannot manage users or sessions of others', async () => {
    const v = await createAndLogin(ctx, admin, { ...VIEWER, username: 'vee' }, 'VIEWER');
    await v.agent.get('/api/auth/users').expect(403);
    await v.agent.delete(`/api/auth/users/${admin.userId}`).set(h(v)).expect(403);
    await v.agent.patch(`/api/auth/users/${admin.userId}`).set(h(v)).send({ role: 'VIEWER' }).expect(403);
    await v.agent.get('/api/projects').expect(200);
    // admin still intact
    await request(ctx.app).post('/api/auth/login').send(ADMIN).expect(200);
  });
});
