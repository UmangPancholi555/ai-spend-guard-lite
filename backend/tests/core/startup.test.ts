import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTestDir } from '../helpers/testApp';

describe('application startup', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  afterAll(async () => { await ctx?.close(); if (ctx) cleanupTestDir(ctx.dir); });

  it('boots with migrated SQLite, seeded catalog and healthy /api/health', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.simulated).toBe(true);
    expect(await ctx.prisma.provider.count()).toBe(2);
    expect(await ctx.prisma.pricingConfig.count()).toBeGreaterThan(5);
  });

  it('returns JSON 404 envelope for unknown API routes', async () => {
    const res = await request(ctx.app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
