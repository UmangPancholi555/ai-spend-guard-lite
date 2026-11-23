import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TestCtx } from '../helpers/testApp';
import { ADMIN, closeAuthApp, cookieValue, newAuthApp, sessionCookie, setupAdmin } from './helpers';
import { sha256 } from '../../src/utils/ids';

let ctx: TestCtx;
beforeAll(async () => { ctx = await newAuthApp(); });
afterAll(async () => { await closeAuthApp(ctx); });

describe('first-run setup', () => {
  it('status reports setupRequired before any user exists and is public', async () => {
    const res = await request(ctx.app).get('/api/auth/status').expect(200);
    expect(res.body.data).toEqual({ authEnabled: true, setupRequired: true, authenticated: false });
  });

  it('rejects weak setup input without creating anything', async () => {
    await request(ctx.app).post('/api/auth/setup').send({ username: 'ad', password: ADMIN.password }).expect(400);
    await request(ctx.app).post('/api/auth/setup').send({ username: 'admin', password: 'short' }).expect(400);
    await request(ctx.app).post('/api/auth/setup').send({ username: 'admin', password: 'xxadminxx-long-enough' }).expect(400);
    await request(ctx.app).post('/api/auth/setup').send({}).expect(400);
    expect(await ctx.prisma.user.count()).toBe(0);
  });

  it('is race-safe: concurrent setup calls create exactly one admin (others 409)', async () => {
    const results = await Promise.all(
      ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map(u => request(ctx.app).post('/api/auth/setup').send({ username: u, password: 'Sup3r-Secret-Phrase-Zq81' })),
    );
    const codes = results.map(r => r.status).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409]);
    expect(await ctx.prisma.user.count()).toBe(1);
    const user = await ctx.prisma.user.findFirstOrThrow();
    expect(user.role).toBe('ADMIN');
    // winner is logged in
    const winner = results.find(r => r.status === 201)!;
    expect(sessionCookie(winner)).toBeTruthy();
    expect(winner.body.data.user.role).toBe('ADMIN');
  });

  it('refuses setup once a user exists', async () => {
    const res = await request(ctx.app).post('/api/auth/setup').send({ username: 'another', password: 'Valid-Pangolin-Passw0rd' }).expect(409);
    expect(res.body.error.code).toBe('SETUP_COMPLETE');
  });
});

describe('login / logout', () => {
  const creds = { username: 'sam', password: 'Moonlit-Bicycle-Orchard7' };

  beforeAll(async () => {
    // the previous describe's race winner is the only user: reset DB users for a deterministic fixture
    await ctx.prisma.user.deleteMany();
    await setupAdmin(ctx, { username: creds.username, password: creds.password });
  });

  it('login succeeds, returns user + csrf token, never the hash', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ username: ' SAM ', password: creds.password }).expect(200);
    expect(res.body.data.user).toMatchObject({ username: 'sam', role: 'ADMIN' });
    expect(res.body.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/scrypt\$|passwordHash/);
  });

  it('wrong password and unknown user produce the identical generic 401', async () => {
    const wrong = await request(ctx.app).post('/api/auth/login').send({ username: 'sam', password: 'definitely-not-it-123' }).expect(401);
    const unknown = await request(ctx.app).post('/api/auth/login').send({ username: 'nobody-here', password: 'definitely-not-it-123' }).expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.message).toBe('Invalid username or password');
    expect(sessionCookie(wrong)).toBeUndefined();
    expect(sessionCookie(unknown)).toBeUndefined();
  });

  it('sets a hardened cookie (HttpOnly, SameSite=Strict, Path=/, Max-Age = ttl, no Secure when disabled)', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send(creds).expect(200);
    const c = sessionCookie(res)!;
    expect(c).toBeTruthy();
    expect(c).toMatch(/;\s*HttpOnly/i);
    expect(c).toMatch(/;\s*SameSite=Strict/i);
    expect(c).toMatch(/;\s*Path=\//);
    expect(c).toMatch(new RegExp(`;\\s*Max-Age=${12 * 3600}\\b`));
    expect(c).not.toMatch(/;\s*Secure/i);
    expect(cookieValue(c)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('adds Secure when COOKIE_SECURE is on', async () => {
    ctx.deps.config.auth.cookieSecure = true;
    try {
      const res = await request(ctx.app).post('/api/auth/login').send(creds).expect(200);
      expect(sessionCookie(res)).toMatch(/;\s*Secure/i);
    } finally { ctx.deps.config.auth.cookieSecure = false; }
  });

  it('stores only sha256(token) - the raw token and CSRF token never reach the DB', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send(creds).expect(200);
    const token = cookieValue(sessionCookie(res)!);
    const csrf = res.body.data.csrfToken as string;
    const rows = await ctx.prisma.session.findMany();
    const hashes = rows.flatMap(r => [r.tokenHash, r.csrfHash]);
    expect(rows.some(r => r.tokenHash === sha256(token))).toBe(true);
    expect(rows.some(r => r.csrfHash === sha256(csrf))).toBe(true);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(csrf);
    expect(hashes.every(h => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'sam' } });
    expect(user.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(user.passwordHash).not.toContain(creds.password);
  });

  it('rotates: logging in again never reuses the session token and kills the presented one', async () => {
    const agent = request.agent(ctx.app);
    const a = await agent.post('/api/auth/login').send(creds).expect(200);
    const tokenA = cookieValue(sessionCookie(a)!);
    const b = await agent.post('/api/auth/login').send(creds).expect(200);
    const tokenB = cookieValue(sessionCookie(b)!);
    expect(tokenB).not.toBe(tokenA);
    expect(await ctx.prisma.session.count({ where: { tokenHash: sha256(tokenA) } })).toBe(0);
    expect(await ctx.prisma.session.count({ where: { tokenHash: sha256(tokenB) } })).toBe(1);
    // the old token no longer authenticates
    await request(ctx.app).get('/api/auth/me').set('Cookie', `sg_session=${tokenA}`).expect(401);
    await agent.get('/api/auth/me').expect(200);
  });

  it('/auth/me returns the same stable csrf token for a session', async () => {
    const agent = request.agent(ctx.app);
    const l = await agent.post('/api/auth/login').send(creds).expect(200);
    const m1 = await agent.get('/api/auth/me').expect(200);
    const m2 = await agent.get('/api/auth/me').expect(200);
    expect(m1.body.data.csrfToken).toBe(l.body.data.csrfToken);
    expect(m2.body.data.csrfToken).toBe(l.body.data.csrfToken);
    const st = await agent.get('/api/auth/status').expect(200);
    expect(st.body.data).toMatchObject({ authEnabled: true, setupRequired: false, authenticated: true, user: { username: 'sam' } });
  });

  it('logout invalidates the session server-side and clears the cookie', async () => {
    const agent = request.agent(ctx.app);
    const l = await agent.post('/api/auth/login').send(creds).expect(200);
    const token = cookieValue(sessionCookie(l)!);
    const out = await agent.post('/api/auth/logout').set('X-CSRF-Token', l.body.data.csrfToken).expect(200);
    expect(sessionCookie(out)).toMatch(/sg_session=;/);
    expect(await ctx.prisma.session.count({ where: { tokenHash: sha256(token) } })).toBe(0);
    // replaying the old cookie fails
    await request(ctx.app).get('/api/projects').set('Cookie', `sg_session=${token}`).expect(401);
    await agent.get('/api/projects').expect(401);
  });

  it('rejects malformed login bodies with 400 and junk cookies with 401', async () => {
    await request(ctx.app).post('/api/auth/login').send({ username: 'sam' }).expect(400);
    await request(ctx.app).post('/api/auth/login').send({}).expect(400);
    await request(ctx.app).get('/api/projects').set('Cookie', 'sg_session=garbage').expect(401);
    await request(ctx.app).get('/api/projects').set('Cookie', `sg_session=${'A'.repeat(43)}`).expect(401);
  });
});
