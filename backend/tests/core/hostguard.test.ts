import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTestDir } from '../helpers/testApp';

describe('Host header guard (DNS rebinding)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  afterAll(async () => { await ctx?.close(); if (ctx) cleanupTestDir(ctx.dir); });
  it('rejects foreign Host headers with 421 and allows localhost variants', async () => {
    ctx = await createTestApp();
    expect((await request(ctx.app).get('/api/health').set('Host', 'evil.example.com')).status).toBe(421);
    expect((await request(ctx.app).get('/api/health').set('Host', 'localhost:4000')).status).toBe(200);
    expect((await request(ctx.app).get('/api/health').set('Host', '127.0.0.1:5173')).status).toBe(200);
    expect((await request(ctx.app).get('/api/health').set('Host', '[::1]:4000')).status).toBe(200);
  });
});
