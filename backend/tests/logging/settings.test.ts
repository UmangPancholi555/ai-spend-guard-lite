import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { getSettings } from '../../src/modules/logging';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

describe('settings', () => {
  it('returns defaults', async () => {
    const res = await request(ctx.app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ retentionDays: 30, slowOperationMs: 500, captureContentPlaintext: false });
    expect(await getSettings(ctx.prisma)).toEqual(res.body.data);
  });

  it('partial update merges and persists in AppSetting', async () => {
    const r1 = await request(ctx.app).put('/api/settings').send({ retentionDays: 7 });
    expect(r1.status).toBe(200);
    expect(r1.body.data).toEqual({ retentionDays: 7, slowOperationMs: 500, captureContentPlaintext: false });
    const r2 = await request(ctx.app).put('/api/settings').send({ slowOperationMs: 1200, captureContentPlaintext: false });
    expect(r2.body.data).toEqual({ retentionDays: 7, slowOperationMs: 1200, captureContentPlaintext: false });
    const rows = await ctx.prisma.appSetting.findMany();
    expect(Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]))).toEqual({ retentionDays: 7, slowOperationMs: 1200 });
    expect((await request(ctx.app).get('/api/settings')).body.data.retentionDays).toBe(7);
  });

  it('accepts boundary values (0, 3650, 1, 600000)', async () => {
    expect((await request(ctx.app).put('/api/settings').send({ retentionDays: 0, slowOperationMs: 1 })).body.data).toMatchObject({ retentionDays: 0, slowOperationMs: 1 });
    expect((await request(ctx.app).put('/api/settings').send({ retentionDays: 3650, slowOperationMs: 600000 })).body.data).toMatchObject({ retentionDays: 3650, slowOperationMs: 600000 });
  });

  it('rejects invalid values with 400 VALIDATION_ERROR and leaves state unchanged', async () => {
    await request(ctx.app).put('/api/settings').send({ retentionDays: 14, slowOperationMs: 250 });
    const bad = [
      { retentionDays: -1 }, { retentionDays: 3651 }, { retentionDays: 1.5 }, { retentionDays: '10' }, { slowOperationMs: 0 },
      { slowOperationMs: 600001 }, { captureContentPlaintext: true }, { unknownKey: 1 }, { retentionDays: 5, slowOperationMs: 0 },
    ];
    for (const b of bad) {
      const res = await request(ctx.app).put('/api/settings').send(b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await request(ctx.app).get('/api/settings')).body.data).toEqual({ retentionDays: 14, slowOperationMs: 250, captureContentPlaintext: false });
  });

  it('edge cases: non-object bodies, prototype keys, -0, exponent/float-integers, huge numbers, concurrency', async () => {
    await request(ctx.app).put('/api/settings').send({ retentionDays: 30, slowOperationMs: 500 });
    for (const body of ['[]', '"str"', '123', '[{"retentionDays":5}]']) {
      const r = await request(ctx.app).put('/api/settings').set('content-type', 'application/json').send(body);
      expect(r.status, body).toBe(400);
    }
    for (const body of ['{"__proto__":{"retentionDays":1}}', '{"constructor":{"x":1}}', '{"retentionDays":null}', '{"retentionDays":true}', '{"slowOperationMs":"500"}', '{"retentionDays":1e21}', '{"retentionDays":3650.5}', '{"slowOperationMs":-1}', '{"captureContentPlaintext":null}', '{"captureContentPlaintext":0}']) {
      const r = await request(ctx.app).put('/api/settings').set('content-type', 'application/json').send(body);
      expect(r.status, body).toBe(400);
    }
    const bad = await request(ctx.app).put('/api/settings').set('content-type', 'application/json').send('{"retentionDays":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(({} as Record<string, unknown>).retentionDays).toBeUndefined(); // no prototype pollution
    // numbers that are integers in JSON are fine
    expect((await request(ctx.app).put('/api/settings').set('content-type', 'application/json').send('{"retentionDays":1e1,"slowOperationMs":250.0}')).body.data).toMatchObject({ retentionDays: 10, slowOperationMs: 250 });
    expect((await request(ctx.app).put('/api/settings').set('content-type', 'application/json').send('{"retentionDays":-0}')).body.data.retentionDays).toBe(0);
    expect((await ctx.prisma.appSetting.findUniqueOrThrow({ where: { key: 'retentionDays' } })).value).toBe('0');
    // empty and null-ish bodies are a no-op, not an error
    expect((await request(ctx.app).put('/api/settings').send({})).status).toBe(200);
    expect((await request(ctx.app).put('/api/settings')).status).toBe(200);
    // a rejected multi-field update is atomic: nothing partially applied
    const before = (await request(ctx.app).get('/api/settings')).body.data;
    expect((await request(ctx.app).put('/api/settings').send({ retentionDays: 5, slowOperationMs: 0 })).status).toBe(400);
    expect((await request(ctx.app).get('/api/settings')).body.data).toEqual(before);
    // concurrent updates end in a consistent, valid state
    await Promise.all([1, 2, 3, 4, 5, 6].map(n => request(ctx.app).put('/api/settings').send({ retentionDays: n, slowOperationMs: n * 100 })));
    const final = (await request(ctx.app).get('/api/settings')).body.data;
    expect(final.retentionDays).toBeGreaterThanOrEqual(1);
    expect(final.retentionDays).toBeLessThanOrEqual(6);
    expect(final.captureContentPlaintext).toBe(false);
  });

  it('records a settings.updated activity only when something changed', async () => {
    const before = await ctx.prisma.activityEvent.count({ where: { type: 'settings.updated' } });
    await request(ctx.app).put('/api/settings').send({ retentionDays: 99 });
    await request(ctx.app).put('/api/settings').send({ retentionDays: 99 });
    expect(await ctx.prisma.activityEvent.count({ where: { type: 'settings.updated' } })).toBe(before + 1);
  });

  it('ignores corrupt stored values (falls back to defaults) and never reports plaintext capture', async () => {
    await ctx.prisma.appSetting.upsert({ where: { key: 'retentionDays' }, create: { key: 'retentionDays', value: '"junk"' }, update: { value: '"junk"' } });
    await ctx.prisma.appSetting.upsert({ where: { key: 'captureContentPlaintext' }, create: { key: 'captureContentPlaintext', value: 'true' }, update: { value: 'true' } });
    const s = await getSettings(ctx.prisma);
    expect(s.retentionDays).toBe(30);
    expect(s.captureContentPlaintext).toBe(false);
  });

  it('settings survive an app restart', async () => {
    await request(ctx.app).put('/api/settings').send({ retentionDays: 45, slowOperationMs: 333 });
    const c2 = await ctx.restart();
    try {
      const res = await request(c2.app).get('/api/settings');
      expect(res.body.data).toEqual({ retentionDays: 45, slowOperationMs: 333, captureContentPlaintext: false });
    } finally { await c2.close(); }
    ctx = await createTestApp({ dir: ctx.dir });
  });
});
