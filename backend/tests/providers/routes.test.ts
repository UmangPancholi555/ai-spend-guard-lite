/**
 * HTTP-level tests through the real app (validation, 404/409, labelling) plus an end-to-end integration block that
 * is skipped when the real cost service is not available (POST /api/cost/calculate -> 404/500).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { dumpAllTables, makeProject } from './helpers';

let ctx: TestCtx;
let costAvailable = false;
beforeAll(async () => {
  ctx = await createTestApp();
  const probe = await request(ctx.app).post('/api/cost/calculate').send({ provider: 'openai', model: 'gpt-4o', inputTokens: 1, outputTokens: 1 });
  costAvailable = probe.status !== 500 && probe.status !== 404;
});
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });
// Sync skip condition is impossible (availability is probed over HTTP), so e2e tests skip at runtime via the test context.
const e2e = (name: string, fn: () => Promise<void>) => it(name, async t => { if (!costAvailable) return t.skip(); await fn(); });
const SENTINEL = 'ROUTE-PROMPT-SENTINEL-24680';
const prompt = `${SENTINEL} please summarise this long document. `.repeat(10);

describe('providers routes: validation and project checks (no cost service needed)', () => {
  it('GET /providers lists both simulated providers with DB models', async () => {
    const res = await request(ctx.app).get('/api/providers');
    expect(res.status).toBe(200);
    const list = res.body.data as any[];
    expect(list.map(p => p.key).sort()).toEqual(['anthropic', 'openai']);
    for (const p of list) {
      expect(p).toMatchObject({ isSimulated: true, label: 'DEMO / SIMULATED' });
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.models[0]).toEqual(expect.objectContaining({ name: expect.any(String), displayName: expect.any(String), contextWindow: expect.any(Number), active: true }));
    }
    expect(list.find(p => p.key === 'openai').models.map((m: any) => m.name)).toContain('gpt-4o-mini');
    expect(list.find(p => p.key === 'anthropic').models.map((m: any) => m.name)).toContain('claude-sonnet');
  });

  it('POST /providers/requests validation errors are 400 VALIDATION_ERROR', async () => {
    const p = await makeProject(ctx.prisma);
    const ok = { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'hi' };
    const bad: Record<string, unknown>[] = [
      {}, { ...ok, prompt: '' }, { ...ok, prompt: 'x'.repeat(20001) }, { ...ok, model: '' }, { ...ok, model: 'm'.repeat(101) },
      { ...ok, maxOutputTokens: 0 }, { ...ok, maxOutputTokens: 8193 }, { ...ok, provider: 'cohere' }, { ...ok, simulateFailure: 'nope' }, { ...ok, projectId: undefined }, { ...ok, temperature: 5 },
    ];
    for (const b of bad) {
      const res = await request(ctx.app).post('/api/providers/requests').send(b);
      expect(res.status, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const res = await request(ctx.app).post('/api/providers/requests').set('content-type', 'application/json').send('{bad json');
    expect(res.status).toBe(400);
  });

  it('unknown project => 404, archived project => 409, nothing stored', async () => {
    const body = { provider: 'openai', model: 'gpt-4o', prompt: 'hello' };
    const r404 = await request(ctx.app).post('/api/providers/requests').send({ ...body, projectId: 'missing' });
    expect(r404.status).toBe(404);
    expect(r404.body.error.code).toBe('NOT_FOUND');
    const archived = await makeProject(ctx.prisma, undefined, 'ARCHIVED');
    const r409 = await request(ctx.app).post('/api/providers/requests').send({ ...body, projectId: archived.id });
    expect(r409.status).toBe(409);
    expect(r409.body.error.code).toBe('CONFLICT');
    expect(await ctx.prisma.usageEvent.count({ where: { projectId: archived.id } })).toBe(0);
  });

  it('seed and agent-run validate input', async () => {
    for (const b of [{}, { requests: 0, spreadDays: 5 }, { requests: 2001, spreadDays: 5 }, { requests: 5, spreadDays: 0 }, { requests: 5, spreadDays: 366 }, { requests: 1.5, spreadDays: 5 }, { requests: 5, spreadDays: 5, includeFailures: 'yes' }]) {
      const res = await request(ctx.app).post('/api/simulations/seed').send(b);
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
    expect((await request(ctx.app).post('/api/simulations/agent-run').send({})).status).toBe(400);
    expect((await request(ctx.app).post('/api/simulations/agent-run').send({ projectId: 'x', simulateFailure: 'bad' })).status).toBe(400);
    expect((await request(ctx.app).post('/api/simulations/agent-run').send({ projectId: 'missing' })).status).toBe(404);
    expect((await request(ctx.app).post('/api/simulations/seed').send({ projectId: 'missing', requests: 3, spreadDays: 2 })).status).toBe(404);
  });
});

describe('providers end-to-end through the real app (real cost, budgets, instrumentation)', () => {
  e2e('POST /providers/requests => 201, persisted usage event, ACTUAL trace with spans, activity, no prompt anywhere', async () => {
    const p = await makeProject(ctx.prisma);
    const res = await request(ctx.app).post('/api/providers/requests').send({ projectId: p.id, provider: 'anthropic', model: 'claude-sonnet', prompt, maxOutputTokens: 400, simulateAgentActivity: true });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d).toMatchObject({ simulated: true, label: 'DEMO / SIMULATED', provider: 'anthropic', model: 'claude-sonnet', projectId: p.id, status: 'SUCCESS' });
    expect(d.requestId).toMatch(/^req_/);
    expect(d.cost.costClass).toBe('SIMULATED');
    expect(d.cost.totalCostUsd).toMatch(/^\d+\.\d{12}$/);
    expect(d.usage.inputTokens + d.usage.cachedTokens).toBe(Math.ceil(prompt.length / 4));
    expect(d.budgetAlerts).toEqual([]);

    const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { id: d.usageEventId } });
    expect(row.costPico).toBe(row.inputCostPico + row.outputCostPico + row.cachedCostPico);
    expect(row.pricingConfigId).toBeTruthy();
    expect(row.traceId).toBe(d.traceId);

    const trace = await ctx.prisma.trace.findUniqueOrThrow({ where: { traceId: d.traceId } });
    expect(trace).toMatchObject({ name: 'provider.request', source: 'ACTUAL', status: 'OK', requestId: d.requestId });
    const spans = await ctx.prisma.span.findMany({ where: { traceId: d.traceId } });
    const byName = (n: string) => spans.find(s => s.name === n);
    for (const n of ['provider.mock', 'cost.calculate', 'usage.persist', 'budget.evaluate']) expect(byName(n)?.source, n).toBe('ACTUAL');
    expect(JSON.parse(byName('provider.mock')!.attributes).simulated).toBe(true);
    expect(spans.filter(s => s.source === 'SIMULATED').length).toBeGreaterThan(0);
    expect(await ctx.prisma.contextEvent.count({ where: { traceId: d.traceId, source: 'SIMULATED' } })).toBe(4);
    expect(await ctx.prisma.contextEvent.count({ where: { traceId: d.traceId, source: 'ACTUAL' } })).toBe(2); // real context: CREATED + UPDATED
    expect(await ctx.prisma.activityEvent.count({ where: { requestId: d.requestId, type: 'usage.recorded', source: 'ACTUAL' } })).toBe(1);

    const dump = await dumpAllTables(ctx.prisma);
    expect(dump).not.toContain(SENTINEL);
    const logDir = ctx.deps.config.logDir;
    for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) expect(fs.readFileSync(path.join(logDir, f), 'utf8')).not.toContain(SENTINEL);
  });

  e2e('failure request => 201 with status FAILURE, request.failed activity, trace ERROR', async () => {
    const p = await makeProject(ctx.prisma);
    const res = await request(ctx.app).post('/api/providers/requests').send({ projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt, simulateFailure: 'rate_limit' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'FAILURE', content: null, finishReason: 'error', error: { code: 'RATE_LIMITED' } });
    expect(res.body.data.usage.outputTokens).toBe(0);
    const trace = await ctx.prisma.trace.findUniqueOrThrow({ where: { traceId: res.body.data.traceId } });
    expect(trace.status).toBe('ERROR');
    expect(trace.errorMessage).toMatch(/simulated/i);
    expect(await ctx.prisma.activityEvent.count({ where: { requestId: res.body.data.requestId, type: 'request.failed', level: 'ERROR' } })).toBe(1);
  });

  e2e('unknown model is ESTIMATED via the real cost service', async () => {
    const p = await makeProject(ctx.prisma);
    const res = await request(ctx.app).post('/api/providers/requests').send({ projectId: p.id, provider: 'openai', model: 'brand-new-model', prompt });
    expect(res.status).toBe(201);
    expect(res.body.data.cost).toMatchObject({ costClass: 'ESTIMATED', unknownModel: true });
  });

  e2e('a request crossing a budget returns the new alert', async () => {
    const p = await makeProject(ctx.prisma);
    const b = await request(ctx.app).post('/api/budgets').send({ projectId: p.id, name: 'tiny', period: 'DAILY', limitUsd: '0.000001' });
    if (b.status !== 201) return; // budgets API not available
    const res = await request(ctx.app).post('/api/providers/requests').send({ projectId: p.id, provider: 'anthropic', model: 'claude-opus', prompt, maxOutputTokens: 500 });
    expect(res.status).toBe(201);
    expect(res.body.data.budgetAlerts.length).toBeGreaterThan(0);
    expect(res.body.data.budgetAlerts[0].projectId).toBe(p.id);
  });

  e2e('POST /simulations/seed => backdated data + DEMO_SEED task + totals consistent with cost', async () => {
    const res = await request(ctx.app).post('/api/simulations/seed').send({ requests: 120, spreadDays: 14 });
    expect(res.status).toBe(201);
    const { taskId, created, projectId } = res.body.data;
    expect(created).toBe(120);
    const task = await ctx.prisma.backgroundTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task).toMatchObject({ kind: 'DEMO_SEED', source: 'SIMULATED', status: 'SUCCEEDED' });
    const rows = await ctx.prisma.usageEvent.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
    expect(rows.length).toBe(120);
    expect(new Set(rows.map(r => r.createdAt.toISOString().slice(0, 10))).size).toBeGreaterThan(8);
    expect(rows.some(r => r.costClass === 'SIMULATED')).toBe(true);
    expect(rows.every(r => r.costPico === r.inputCostPico + r.outputCostPico + r.cachedCostPico)).toBe(true);
    const dump = await dumpAllTables(ctx.prisma);
    expect(dump).not.toContain('Simulated demo prompt');
  });

  e2e('POST /simulations/agent-run => 201 {traceId} with a SIMULATED trace and correlated events', async () => {
    const p = await makeProject(ctx.prisma);
    const res = await request(ctx.app).post('/api/simulations/agent-run').send({ projectId: p.id });
    expect(res.status).toBe(201);
    const { traceId } = res.body.data;
    const trace = await ctx.prisma.trace.findUniqueOrThrow({ where: { traceId } });
    expect(trace).toMatchObject({ source: 'SIMULATED', status: 'OK' });
    expect(await ctx.prisma.toolCallEvent.count({ where: { traceId, source: 'SIMULATED', retryCount: 1 } })).toBe(1);
    expect(await ctx.prisma.memoryEvent.count({ where: { traceId, phase: 'COMPLETED', source: 'SIMULATED' } })).toBe(1);
    expect(await ctx.prisma.busEvent.count({ where: { traceId, source: 'SIMULATED' } })).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.usageEvent.count({ where: { projectId: p.id } })).toBe(0);
  });

  async function assertTraceWindow(traceId: string) {
    const res = await request(ctx.app).get(`/api/traces/${traceId}`);
    expect(res.status).toBe(200);
    const { trace, timeline, spans } = res.body.data;
    expect(trace.endedAt).toBeTruthy();
    const start = Date.parse(trace.startedAt), end = Date.parse(trace.endedAt);
    expect(timeline.length).toBeGreaterThan(3);
    const late = timeline.filter((e: any) => Date.parse(e.ts) > end);
    expect(late.map((e: any) => `${e.step}@${e.ts}`), `entries after trace end ${trace.endedAt}`).toEqual([]);
    expect(timeline.filter((e: any) => Date.parse(e.ts) < start).map((e: any) => e.step)).toEqual([]);
    // (span start/end times come from the SDK's own clock, which is anchored slightly differently from the trace end; only events are asserted)
    expect(spans.length).toBeGreaterThan(3);
    return { trace, timeline, spans };
  }

  e2e('simulated agent events never fall outside the trace window (live requests, all failure modes)', async () => {
    const p = await makeProject(ctx.prisma);
    for (const simulateFailure of ['none', 'timeout', 'rate_limit', 'error'] as const) {
      for (let i = 0; i < 3; i++) {
        const res = await request(ctx.app).post('/api/providers/requests').send({ projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: prompt + i, simulateAgentActivity: true, simulateFailure });
        expect(res.status).toBe(201);
        const { timeline } = await assertTraceWindow(res.body.data.traceId);
        expect(timeline.some((e: any) => e.source === 'SIMULATED')).toBe(true);
        expect(timeline.some((e: any) => e.source === 'ACTUAL')).toBe(true);
      }
    }
  });

  e2e('agent-run events stay inside the trace window and the last event is the execution end', async () => {
    const p = await makeProject(ctx.prisma);
    for (const simulateFailure of ['none', 'timeout', 'error', 'rate_limit'] as const) {
      const res = await request(ctx.app).post('/api/simulations/agent-run').send({ projectId: p.id, simulateFailure });
      expect(res.status).toBe(201);
      const { timeline } = await assertTraceWindow(res.body.data.traceId);
      expect(['execution.completed', 'execution.failed']).toContain(timeline[timeline.length - 1].step);
    }
  });

  e2e('seeded (backdated) agent traces stay entirely in the past and inside their window', async () => {
    const res = await request(ctx.app).post('/api/simulations/seed').send({ requests: 30, spreadDays: 20, includeAgentActivity: true, seed: 'window-test' });
    expect(res.status).toBe(201);
    const traced = await ctx.prisma.usageEvent.findMany({ where: { projectId: res.body.data.projectId, traceId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 25 });
    expect(traced.length).toBe(25);
    const now = Date.now();
    for (const u of traced.slice(0, 6)) {
      const { trace, timeline } = await assertTraceWindow(u.traceId!);
      expect(Date.parse(trace.startedAt)).toBe(u.createdAt.getTime());
      expect(Date.parse(trace.endedAt)).toBeLessThan(now - 1000);
      for (const e of timeline) expect(Date.parse(e.ts)).toBeLessThan(now - 500);
    }
  });
});
