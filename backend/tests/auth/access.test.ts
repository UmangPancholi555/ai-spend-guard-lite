import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TestCtx } from '../helpers/testApp';
import { ADMIN, VIEWER, closeAuthApp, createAndLogin, newAuthApp, setupAdmin, type Session } from './helpers';

let ctx: TestCtx;
let admin: Session;
let viewer: Session;

beforeAll(async () => {
  process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000';
  ctx = await newAuthApp();
  admin = await setupAdmin(ctx);
  viewer = await createAndLogin(ctx, admin, VIEWER, 'VIEWER');
});
afterAll(async () => { delete process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE; await closeAuthApp(ctx); });

/** one GET per router family + unknown paths + export downloads */
const PROTECTED_GETS = [
  '/api/dashboard', '/api/projects', '/api/projects/abc', '/api/projects/abc/activity', '/api/projects/abc/memory',
  '/api/providers', '/api/tools', '/api/usage', '/api/usage/filters', '/api/usage/export.csv', '/api/usage/abc',
  '/api/cost/pricing', '/api/budgets', '/api/budgets/utilization', '/api/budget-alerts', '/api/activity',
  '/api/traces', '/api/traces/abc', '/api/background-tasks', '/api/observability/overview', '/api/observability/performance',
  '/api/observability/sources', '/api/observability/errors', '/api/observability/errors/groups', '/api/logs', '/api/logs/abc',
  '/api/export/logs', '/api/export/usage', '/api/settings',
  // unknown paths must not reveal that they do not exist
  '/api/does-not-exist', '/api/auth/does-not-exist', '/api/auth/users', '/api/auth/sessions', '/api/auth/me',
  // routing quirks
  '/api/Projects', '/api/projects/', '/api/AUTH/ME', '/api//projects', '/api/auth/login', '/api/auth/setup', '/api/health/x',
];

describe('unauthenticated callers', () => {
  it.each(PROTECTED_GETS)('GET %s -> 401 UNAUTHENTICATED (never 404/200)', async path => {
    const r = await request(ctx.app).get(path);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['post', '/api/projects'], ['patch', '/api/projects/abc'], ['delete', '/api/projects/abc'], ['post', '/api/providers/requests'],
    ['post', '/api/simulations/seed'], ['post', '/api/budgets'], ['put', '/api/settings'], ['post', '/api/logging/retention/run'],
    ['post', '/api/cost/calculate'], ['post', '/api/nope'], ['post', '/api/auth/logout'], ['post', '/api/auth/password'],
    ['post', '/api/auth/users'], ['delete', '/api/auth/users/abc'],
  ] as const)('%s %s -> 401 (before CSRF/validation)', async (method, path) => {
    const r = await request(ctx.app)[method](path).send({});
    expect(r.status).toBe(401);
  });

  it('public endpoints work without a session: /api/health and /api/auth/status', async () => {
    await request(ctx.app).get('/api/health').expect(200);
    const st = await request(ctx.app).get('/api/auth/status').expect(200);
    expect(st.body.data).toEqual({ authEnabled: true, setupRequired: false, authenticated: false });
  });

  it('401 responses are not cacheable and carry the JSON envelope', async () => {
    const r = await request(ctx.app).get('/api/projects');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-type']).toMatch(/json/);
    expect(Object.keys(r.body)).toEqual(['error']);
  });
});

describe('authenticated access and downloads', () => {
  it('serves normal reads and CSV exports with just the cookie', async () => {
    await admin.agent.get('/api/projects').expect(200);
    const csv = await admin.agent.get('/api/usage/export.csv').expect(200);
    expect(csv.headers['content-type']).toMatch(/csv/);
    expect(csv.headers['cache-control']).toBe('no-store');
  });

  it('still returns 404 for unknown API paths once authenticated', async () => {
    await admin.agent.get('/api/does-not-exist').expect(404);
  });
});

describe('CSRF', () => {
  it('rejects state-changing requests without X-CSRF-Token (403 CSRF_INVALID)', async () => {
    const r = await admin.agent.post('/api/projects').send({ name: 'no-csrf', isTest: true }).expect(403);
    expect(r.body.error.code).toBe('CSRF_INVALID');
    expect(await ctx.prisma.project.count({ where: { name: 'no-csrf' } })).toBe(0);
  });

  it('rejects a wrong token, an empty token and a token from another session', async () => {
    await admin.agent.post('/api/projects').set('X-CSRF-Token', 'wrong').send({ name: 'bad-csrf', isTest: true }).expect(403);
    await admin.agent.post('/api/projects').set('X-CSRF-Token', '').send({ name: 'bad-csrf', isTest: true }).expect(403);
    await admin.agent.post('/api/projects').set('X-CSRF-Token', viewer.csrf).send({ name: 'bad-csrf', isTest: true }).expect(403);
    expect(await ctx.prisma.project.count({ where: { name: 'bad-csrf' } })).toBe(0);
  });

  it('accepts the correct token for POST / PATCH / DELETE; GET never needs one', async () => {
    const h = { 'X-CSRF-Token': admin.csrf };
    const created = await admin.agent.post('/api/projects').set(h).send({ name: 'csrf-ok', isTest: true }).expect(201);
    const id = created.body.data.id;
    await admin.agent.patch(`/api/projects/${id}`).send({ name: 'renamed' }).expect(403);
    await admin.agent.patch(`/api/projects/${id}`).set(h).send({ name: 'renamed' }).expect(200);
    await admin.agent.delete(`/api/projects/${id}`).expect(403);
    await admin.agent.delete(`/api/projects/${id}`).set(h).expect(204);
    await admin.agent.get('/api/projects').expect(200);
  });

  it('a cross-site Origin is still rejected by the existing origin guard even with a valid token', async () => {
    await admin.agent.post('/api/projects').set('Origin', 'https://evil.example').set('X-CSRF-Token', admin.csrf).send({ name: 'evil', isTest: true }).expect(403);
  });

  it('login and setup are exempt from the CSRF header', async () => {
    await request(ctx.app).post('/api/auth/login').send(ADMIN).expect(200);
  });
});

describe('VIEWER is read-only', () => {
  it('can read everything an admin can read', async () => {
    await viewer.agent.get('/api/projects').expect(200);
    await viewer.agent.get('/api/usage/export.csv').expect(200);
    const me = await viewer.agent.get('/api/auth/me').expect(200);
    expect(me.body.data.user.role).toBe('VIEWER');
  });

  it.each([
    ['post', '/api/projects', { name: 'v', isTest: true }], ['put', '/api/settings', { retentionDays: 5 }],
    ['post', '/api/providers/requests', {}], ['delete', '/api/projects/abc', undefined], ['patch', '/api/budgets/abc', {}],
    ['post', '/api/logging/retention/run', {}],
  ] as const)('%s %s -> 403 FORBIDDEN even with a valid CSRF token', async (method, path, body) => {
    const r = await viewer.agent[method](path).set('X-CSRF-Token', viewer.csrf).send(body ?? {});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('is blocked from user management but may use pure calculators, change its password and log out', async () => {
    const h = { 'X-CSRF-Token': viewer.csrf };
    await viewer.agent.get('/api/auth/users').expect(403);
    await viewer.agent.post('/api/auth/users').set(h).send({ username: 'x1', password: 'Zebra-Quartz-Pencil-88', role: 'ADMIN' }).expect(403);
    const calc = await viewer.agent.post('/api/cost/calculate').set(h).send({ provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 10 });
    expect(calc.status).not.toBe(403);
    expect(calc.status).not.toBe(401);
    await viewer.agent.post('/api/auth/password').set(h).send({ currentPassword: VIEWER.password, newPassword: 'Blue-Marmot-Staircase-55' }).expect(200);
    await viewer.agent.post('/api/auth/logout').set(h).expect(200);
  });
});
