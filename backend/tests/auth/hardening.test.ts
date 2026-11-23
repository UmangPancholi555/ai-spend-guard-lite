import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import type { TestCtx } from '../helpers/testApp';
import { REPO_ROOT } from '../../src/config';
import { verifyPassword } from '../../src/utils/password';
import { ADMIN, VIEWER, closeAuthApp, cookieValue, createAndLogin, login, newAuthApp, sessionCookie, setupAdmin, type Session } from './helpers';

let ctx: TestCtx;
let admin: Session;
let viewer: Session;
const h = (s: Session) => ({ 'X-CSRF-Token': s.csrf });

beforeAll(async () => {
  process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000';
  ctx = await newAuthApp();
  admin = await setupAdmin(ctx);
  viewer = await createAndLogin(ctx, admin, VIEWER, 'VIEWER');
});
afterAll(async () => { delete process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE; await closeAuthApp(ctx); });

describe('L1: admins cannot reset their OWN password through PATCH /auth/users/:id', () => {
  it('rejects with USE_PASSWORD_ENDPOINT and changes nothing; resetting others still works', async () => {
    const before = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } })).passwordHash;
    const r = await admin.agent.patch(`/api/auth/users/${admin.userId}`).set(h(admin)).send({ password: 'Brand-New-Passphrase-33' }).expect(400);
    expect(r.body.error.code).toBe('USE_PASSWORD_ENDPOINT');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } })).passwordHash).toBe(before);
    await admin.agent.get('/api/auth/me').expect(200);
    // other fields on self are still allowed (unlock is a no-op), and other users' passwords can be reset
    await admin.agent.patch(`/api/auth/users/${admin.userId}`).set(h(admin)).send({ unlock: true }).expect(200);
    await admin.agent.patch(`/api/auth/users/${viewer.userId}`).set(h(admin)).send({ password: 'Reset-Quokka-Ladder-52' }).expect(200);
    await viewer.agent.get('/api/auth/me').expect(401);
    viewer = await login(ctx, { username: VIEWER.username, password: 'Reset-Quokka-Ladder-52' });
  });
});

describe('L4: __Host- cookie prefix when COOKIE_SECURE=true', () => {
  it('uses sg_session (no Secure) by default', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send(ADMIN).expect(200);
    const c = sessionCookie(res)!;
    expect(c).toMatch(/^sg_session=/);
    expect(c).not.toMatch(/Secure/i);
  });

  it('uses __Host-sg_session with Secure, Path=/ and NO Domain when secure; both names are accepted when reading', async () => {
    ctx.deps.config.auth.cookieSecure = true;
    try {
      const res = await request(ctx.app).post('/api/auth/login').send(ADMIN).expect(200);
      const c = sessionCookie(res)!;
      expect(c).toMatch(/^__Host-sg_session=/);
      expect(c).toMatch(/;\s*Secure/i);
      expect(c).toMatch(/;\s*Path=\//);
      expect(c).not.toMatch(/Domain/i);
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Strict/i);
      const token = cookieValue(c);
      await request(ctx.app).get('/api/auth/me').set('Cookie', `__Host-sg_session=${token}`).expect(200);
      await request(ctx.app).get('/api/auth/me').set('Cookie', `sg_session=${token}`).expect(200); // legacy name still readable
      // logout clears the __Host- cookie (and the legacy one)
      const out = await request(ctx.app).post('/api/auth/logout').set('Cookie', `__Host-sg_session=${token}`).set('X-CSRF-Token', res.body.data.csrfToken).expect(200);
      const cleared = (out.headers['set-cookie'] as unknown as string[]).join('\n');
      expect(cleared).toMatch(/__Host-sg_session=;/);
      expect(cleared).toMatch(/sg_session=;/);
    } finally { ctx.deps.config.auth.cookieSecure = false; }
  });

  it('a session issued under one cookie name still authenticates after COOKIE_SECURE is toggled', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send(ADMIN).expect(200);
    const token = cookieValue(sessionCookie(res)!);
    ctx.deps.config.auth.cookieSecure = true;
    try { await request(ctx.app).get('/api/projects').set('Cookie', `sg_session=${token}`).expect(200); }
    finally { ctx.deps.config.auth.cookieSecure = false; }
  });
});

describe('L5: auth audit events are visible to ADMINs only', () => {
  const hasAuth = (rows: Array<{ type?: string; eventType?: string; operation?: string }>) =>
    rows.some(r => r.type?.startsWith('auth.') || r.eventType?.startsWith('activity.auth.') || r.operation?.includes('/api/auth/'));

  beforeAll(async () => {
    await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'definitely-wrong-1' }).expect(401); // failure + request log
    await admin.agent.post('/api/projects').set(h(admin)).send({ name: 'visible-project', isTest: true }).expect(201); // non-auth event
  });

  it('ADMIN sees auth events in /activity, /logs, exports and the dashboard', async () => {
    const act = await admin.agent.get('/api/activity?pageSize=200').expect(200);
    expect(hasAuth(act.body.data)).toBe(true);
    const logs = await admin.agent.get('/api/logs?pageSize=200').expect(200);
    expect(hasAuth(logs.body.data)).toBe(true);
    const dash = await admin.agent.get('/api/dashboard').expect(200);
    expect(dash.body.data.recentActivity.length).toBeGreaterThan(0);
    expect((await admin.agent.get('/api/export/activity?format=jsonl')).text).toContain('auth.login');
    expect((await admin.agent.get('/api/export/logs?format=csv')).text).toContain('activity.auth.');
  });

  it('VIEWER gets the same endpoints WITHOUT any auth event (activity, logs, log detail, exports, dashboard, search)', async () => {
    const act = await viewer.agent.get('/api/activity?pageSize=200').expect(200);
    expect(act.body.data.length).toBeGreaterThan(0);
    expect(hasAuth(act.body.data)).toBe(false);
    expect(act.body.data.some((e: { type: string }) => e.type === 'project.created')).toBe(true);
    // explicit filters cannot be used to reach them either
    const filtered = await viewer.agent.get('/api/activity?type=auth.login.failure').expect(200);
    expect(filtered.body.data).toEqual([]);
    expect(filtered.body.pagination.total).toBe(0);
    expect((await viewer.agent.get('/api/activity?search=auth.login').expect(200)).body.data).toEqual([]);

    const logs = await viewer.agent.get('/api/logs?pageSize=200').expect(200);
    expect(logs.body.data.length).toBeGreaterThan(0);
    expect(hasAuth(logs.body.data)).toBe(false);
    expect((await viewer.agent.get('/api/logs?eventType=activity.auth.*').expect(200)).body.pagination.total).toBe(0);
    expect((await viewer.agent.get('/api/logs?search=/api/auth/').expect(200)).body.pagination.total).toBe(0);

    const authLog = await ctx.prisma.executionLog.findFirstOrThrow({ where: { eventType: { startsWith: 'activity.auth.' } } });
    await admin.agent.get(`/api/logs/${authLog.id}`).expect(200);
    await viewer.agent.get(`/api/logs/${authLog.id}`).expect(404);

    for (const ds of ['activity', 'logs', 'errors']) {
      for (const format of ['jsonl', 'csv']) {
        const ex = await viewer.agent.get(`/api/export/${ds}?format=${format}`).expect(200);
        expect(ex.text, `${ds}.${format}`).not.toMatch(/auth\.(login|setup|logout|user|password)|activity\.auth\.|\/api\/auth\//);
      }
    }
    expect((await viewer.agent.get('/api/export/activity?format=jsonl')).text).toContain('project.created');

    const dash = await viewer.agent.get('/api/dashboard').expect(200);
    expect(hasAuth(dash.body.data.recentActivity)).toBe(false);
  });
});

describe('offline CLI: user:unlock and user:reset-password', () => {
  const cli = path.join(REPO_ROOT, 'backend', 'src', 'modules', 'auth', 'cli.ts');
  const run = (command: string | undefined, extra: Record<string, string>, args: string[] = []) => {
    try {
      const out = execFileSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), [cli, ...(command ? [command] : []), ...args], {
        env: { ...process.env, DATABASE_URL: ctx.databaseUrl, LOG_DIR: ctx.deps.config.logDir, ...extra }, encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT,
      });
      return { code: 0, out };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: `${x.stdout}${x.stderr}` };
    }
  };

  it('unlock clears an active lock and the failure counter', async () => {
    await ctx.prisma.user.update({ where: { id: viewer.userId }, data: { failedAttempts: 14, lockedUntil: new Date(Date.now() + 3_600_000) } });
    const r = run('unlock', { USERNAME: 'viewer' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Unlocked user "viewer"');
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id: viewer.userId } });
    expect(u.failedAttempts).toBe(0);
    expect(u.lockedUntil).toBeNull();
    expect(run('unlock', { USERNAME: 'nobody-at-all' }).code).toBe(1);
  }, 60_000);

  it('reset-password sets a policy-checked password, revokes sessions, never prints it; also via stdin', async () => {
    const pw = 'Offline-Reset-Pelican-29';
    const s2 = await login(ctx, { username: 'viewer', password: 'Reset-Quokka-Ladder-52' });
    const weak = run('reset-password', { USERNAME: 'viewer', NEW_PASSWORD: 'short' });
    expect(weak.code).toBe(1);
    expect(weak.out).not.toContain('short\n');
    const containsName = run('reset-password', { USERNAME: 'viewer', NEW_PASSWORD: 'my-viewer-passphrase-1' });
    expect(containsName.code).toBe(1);
    const ok = run('reset-password', { USERNAME: 'viewer', NEW_PASSWORD: pw });
    expect(ok.code).toBe(0);
    expect(ok.out).not.toContain(pw);
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id: viewer.userId } });
    expect(await verifyPassword(u.passwordHash, pw)).toBe(true);
    await s2.agent.get('/api/auth/me').expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'viewer', password: pw }).expect(200);
    expect(run('reset-password', { USERNAME: 'viewer' }).code).toBe(1); // missing NEW_PASSWORD
    expect(run('frobnicate', { USERNAME: 'viewer' }).code).toBe(1);
    const events = await ctx.prisma.activityEvent.findMany({ where: { type: 'auth.user.updated' } });
    const cliEvent = events.map(e => JSON.parse(e.metadata)).find(m => m.via === 'cli');
    expect(cliEvent).toBeTruthy();
    expect(JSON.stringify(events)).not.toContain(pw);
  }, 90_000);
});

describe('L9: client IP normalisation (IPv6 /64, IPv4-mapped) for throttle, locks, session.ip and audit', () => {
  const bad = 'wrong-password-attempt';
  const post = (app: TestCtx['app'], ip: string, username: string, password: string) =>
    request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ username, password });

  it('two IPv6 addresses in the same /64 share one throttle bucket; another /64 and IPv4 are independent', async () => {
    process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '2';
    const local = await newAuthApp();
    try {
      local.app.set('trust proxy', true);
      await setupAdmin(local);
      await post(local.app, '2001:db8:1:2::1', 'u1', bad).expect(401);
      await post(local.app, '2001:db8:1:2:ffff:abcd:0:9', 'u2', bad).expect(401);
      const third = await post(local.app, '2001:0db8:0001:0002:1111:2222:3333:4444', 'u3', bad).expect(429); // same /64, different spelling
      expect(third.body.error.code).toBe('RATE_LIMITED');
      await post(local.app, '2001:db8:1:3::1', 'u4', bad).expect(401); // different /64
      await post(local.app, '203.0.113.9', 'u5', bad).expect(401);
    } finally { await closeAuthApp(local); process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000'; }
  });

  it('IPv4-mapped IPv6 shares the bucket of the plain IPv4 address', async () => {
    process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '2';
    const local = await newAuthApp();
    try {
      local.app.set('trust proxy', true);
      await setupAdmin(local);
      await post(local.app, '198.51.100.9', 'u1', bad).expect(401);
      await post(local.app, '::ffff:198.51.100.9', 'u2', bad).expect(401);
      await post(local.app, '198.51.100.9', 'u3', bad).expect(429);
    } finally { await closeAuthApp(local); process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000'; }
  });

  it('the (username, IP) lock also spans a /64: rotating addresses inside it does not reset the counter', async () => {
    const local = await newAuthApp();
    try {
      local.app.set('trust proxy', true);
      await setupAdmin(local);
      for (let i = 0; i < 5; i++) await post(local.app, `2001:db8:9:9:${i}::${i + 1}`, 'admin', bad).expect(401);
      await post(local.app, '2001:db8:9:9:aaaa::1', 'admin', ADMIN.password).expect(429);
      await post(local.app, '2001:db8:9:8::1', 'admin', ADMIN.password).expect(200); // other /64 unaffected
    } finally { await closeAuthApp(local); }
  });

  it('stores and logs the normalized key (session.ip and audit metadata), never the raw address', async () => {
    const local = await newAuthApp();
    try {
      local.app.set('trust proxy', true);
      await setupAdmin(local);
      await post(local.app, '2001:db8:aa:bb:cc:dd:ee:ff', 'admin', ADMIN.password).expect(200);
      await post(local.app, '::ffff:192.0.2.55', 'admin', ADMIN.password).expect(200);
      const ips = (await local.prisma.session.findMany()).map(s => s.ip);
      expect(ips).toContain('2001:db8:aa:bb::/64');
      expect(ips).toContain('192.0.2.55');
      const events = JSON.stringify(await local.prisma.activityEvent.findMany({ where: { type: 'auth.login.success' } }));
      expect(events).toContain('2001:db8:aa:bb::/64');
      expect(events).not.toContain('cc:dd:ee:ff');
      expect(events).not.toContain('::ffff:');
    } finally { await closeAuthApp(local); }
  });
});
