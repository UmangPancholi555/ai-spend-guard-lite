import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { seed, T } from '../observability/helpers';

/** Smoke: the real buildApp mounts all three read-side routers under /api (filters keep assertions independent of any request-lifecycle writes). */
describe('read-side routers are mounted in the real app', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await createTestApp();
    await seed.activity(ctx.prisma, { createdAt: T('2025-01-01T00:00:00Z'), type: 'smoke.event', message: 'smoke' });
  });
  afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

  it('GET /api/activity, /api/traces/:id (404), /api/observability/sources', async () => {
    const a = await request(ctx.app).get('/api/activity?type=smoke.event');
    expect(a.status).toBe(200);
    expect(a.body.data).toHaveLength(1);
    const t = await request(ctx.app).get('/api/traces/nope');
    expect(t.status).toBe(404);
    expect(t.body.error.code).toBe('NOT_FOUND');
    const s = await request(ctx.app).get('/api/observability/sources');
    expect(s.status).toBe(200);
    expect(s.body.data).toHaveLength(6);
  });
});
