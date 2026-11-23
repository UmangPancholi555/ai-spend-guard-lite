import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

describe('AUTH_ENABLED=false keeps the legacy open behaviour', () => {
  it('default test app has auth off', () => { expect(ctx.deps.config.auth.enabled).toBe(false); });

  it('serves protected routes with no cookie and needs no CSRF token', async () => {
    await request(ctx.app).get('/api/projects').expect(200);
    const created = await request(ctx.app).post('/api/projects').send({ name: 'open', isTest: true }).expect(201);
    await request(ctx.app).delete(`/api/projects/${created.body.data.id}`).expect(204);
    await request(ctx.app).get('/api/usage/export.csv').expect(200);
    await request(ctx.app).get('/api/does-not-exist').expect(404); // unknown paths are plain 404s again
  });

  it('/auth/status reports authEnabled=false; every other /auth route is 404 AUTH_DISABLED', async () => {
    const st = await request(ctx.app).get('/api/auth/status').expect(200);
    expect(st.body.data).toEqual({ authEnabled: false, setupRequired: false, authenticated: false });
    for (const [m, p] of [['post', '/api/auth/login'], ['post', '/api/auth/setup'], ['get', '/api/auth/me'], ['get', '/api/auth/users']] as const) {
      const r = await request(ctx.app)[m](p).send({});
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('AUTH_DISABLED');
    }
    expect(await ctx.prisma.user.count()).toBe(0);
  });
});
