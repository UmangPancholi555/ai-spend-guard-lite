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
