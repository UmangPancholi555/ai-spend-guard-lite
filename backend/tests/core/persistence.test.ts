import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../../src/app';
import { cleanupTestDir } from '../helpers/testApp';
import { createCoreCtx, insertUsage, type CoreCtx } from './coreHelpers';

describe('restart persistence (projects, usage, dashboard)', () => {
  let ctx: CoreCtx; let ctx2: Awaited<ReturnType<CoreCtx['restart']>> | undefined;
  afterAll(async () => { await ctx2?.close(); await ctx.close(); cleanupTestDir(ctx.dir); });

  it('keeps projects, archive state, usage events and derived stats after the app is restarted on the same DB', async () => {
    ctx = await createCoreCtx();
    const created = (await request(ctx.api).post('/api/projects').send({ name: 'Persist Me', description: 'survives', isTest: true })).body.data;
    const arch = (await request(ctx.api).post('/api/projects').send({ name: 'Persist Archived' })).body.data;
    await request(ctx.api).post(`/api/projects/${arch.id}/archive`);
    await insertUsage(ctx.prisma, { projectId: created.id, costPico: 1_234_567_890_123n, requestId: 'req_persist_1', inputTokens: 11, outputTokens: 22, cachedTokens: 3 });
    await insertUsage(ctx.prisma, { projectId: created.id, costPico: 1n, status: 'FAILURE', requestId: 'req_persist_2' });
    const before = (await request(ctx.api).get(`/api/projects/${created.id}`)).body.data;
    const dashBefore = (await request(ctx.api).get('/api/dashboard?days=7')).body.data;
    expect(before.usage.requests).toBe(2);

    ctx2 = await ctx.restart();
    const app = buildApp(ctx2.deps);

    const after = await request(app).get(`/api/projects/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.data).toEqual(before);
    expect(after.body.data.usage.costUsd).toBe('1.234567890124');

    const list = await request(app).get('/api/projects');
    expect(list.body.data.map((p: { name: string; status: string }) => [p.name, p.status]).sort()).toEqual([
      ['Persist Archived', 'ARCHIVED'], ['Persist Me', 'ACTIVE'],
    ]);

    const usage = await request(app).get('/api/usage?search=req_persist');
    expect(usage.body.pagination.total).toBe(2);
    expect((await request(app).get('/api/usage/req_persist_1')).body.data.costUsd).toBe('1.234567890123');

    const dashAfter = (await request(app).get('/api/dashboard?days=7')).body.data;
    expect(dashAfter.totals).toEqual(dashBefore.totals);
    expect(dashAfter.dailySpend.map((d: { costUsd: string }) => d.costUsd)).toEqual(dashBefore.dailySpend.map((d: { costUsd: string }) => d.costUsd));

    // still writable after restart
    const again = await request(app).post('/api/projects').send({ name: 'persist me' });
    expect(again.status).toBe(409);
    expect((await request(app).delete(`/api/projects/${created.id}`)).status).toBe(204);
    expect(await ctx2.prisma.usageEvent.count({ where: { requestId: { startsWith: 'req_persist' } } })).toBe(0);
  });
});
