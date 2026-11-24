import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupTestDir, createTestApp } from '../helpers/testApp';
import { api, Ctx, listAll, logFiles, mkProject, pay, picoToUsd, readJsonl } from './helpers';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) cleanupTestDir(d); });

async function snapshot(ctx: Ctx) {
  const get = async (u: string) => (await api(ctx).get(u)).body.data;
  const projects = await listAll(ctx, '/api/projects?includeTest=true');
  const usage = await listAll(ctx, '/api/usage');
  const traces = await listAll(ctx, '/api/traces');
  const traceDetails: Record<string, unknown> = {};
  for (const t of traces) traceDetails[t.traceId] = await get(`/api/traces/${t.traceId}`);
  return {
    projects, usage, traces, traceDetails,
    budgets: await get('/api/budgets'),
    alerts: await listAll(ctx, '/api/budget-alerts'),
    logs: await listAll(ctx, '/api/logs'),
    activity: await listAll(ctx, '/api/activity'),
    tasks: await listAll(ctx, '/api/background-tasks'),
    settings: await get('/api/settings'),
    pricing: await get('/api/cost/pricing?history=true'),
    memory: await listAll(ctx, '/api/observability/memory-events'),
    tools: await listAll(ctx, '/api/observability/tool-events'),
    dashboard: { ...(await get('/api/dashboard?days=30')) },
  };
}

describe('restart persistence (new PrismaClient + deps + app on the same files)', () => {
  it('restores projects, usage, budgets, alerts, traces, spans, logs, settings, tasks; JSONL preserved & appended', async () => {
    let ctx = await createTestApp();
    dirs.push(ctx.dir);
    const p = await mkProject(ctx, 'persist-proj');
    const archived = await mkProject(ctx, 'persist-archived');
    await api(ctx).post(`/api/projects/${archived.id}/archive`).expect(200);
    const probe = await pay(ctx, { projectId: p.id, prompt: 'persist probe', model: 'gpt-4o' });
    const c = BigInt(probe.cost.totalCostUsd.replace('.', '').replace(/^0+(?=\d)/, ''));
    expect(c > 0n).toBe(true);
    await api(ctx).post('/api/budgets').send({ projectId: p.id, name: 'persist-budget', period: 'MONTHLY', limitUsd: picoToUsd(c * 3n) }).expect(201);
    for (let i = 0; i < 4; i++) await pay(ctx, { projectId: p.id, prompt: 'persist probe', model: 'gpt-4o', simulateAgentActivity: i % 2 === 0 });
    await pay(ctx, { projectId: p.id, prompt: 'persist fail', simulateFailure: 'timeout' });
    await api(ctx).post('/api/simulations/seed').send({ projectId: p.id, requests: 8, spreadDays: 5, includeFailures: true, includeAgentActivity: true }).expect(r => { if (r.status >= 300) throw new Error(JSON.stringify(r.body)); });
    await api(ctx).put('/api/settings').send({ retentionDays: 45, slowOperationMs: 777 }).expect(200);
    await api(ctx).post('/api/cost/pricing').send({ provider: 'openai', model: 'gpt-4o', inputPerMTok: '3.000000', outputPerMTok: '11.000000', cachedPerMTok: '1.500000' }).expect(201);
    await api(ctx).post('/api/logging/retention/run').expect(200);

    const before = await snapshot(ctx);
    expect(before.usage.length).toBeGreaterThanOrEqual(13);
    expect(before.alerts.length).toBeGreaterThanOrEqual(1);
    expect(before.tasks.length).toBeGreaterThanOrEqual(2);
    const jsonlBefore = readJsonl(ctx);
    const filesBefore = logFiles(ctx);
    const sizeBefore = filesBefore.map(f => fs.statSync(f).size);
    const rowCountsBefore = {
      spans: await ctx.prisma.span.count(), logs: await ctx.prisma.executionLog.count(), providers: await ctx.prisma.provider.count(),
      models: await ctx.prisma.model.count(), pricing: await ctx.prisma.pricingConfig.count(),
    };

    ctx = await ctx.restart();
    expect(ctx.dir).toBe(dirs[0]);

    // everything that was visible before is still visible (the restart itself may add a few request logs for the snapshot reads,
    // so compare the stable entities exactly and logs/activity as supersets)
    const after = await snapshot(ctx);
    expect(after.projects).toEqual(before.projects);
    expect(after.usage).toEqual(before.usage);
    expect(after.budgets).toEqual(before.budgets);
    expect(after.alerts).toEqual(before.alerts);
    expect(after.traces).toEqual(before.traces);
    expect(after.traceDetails).toEqual(before.traceDetails);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.settings).toEqual({ retentionDays: 45, slowOperationMs: 777, captureContentPlaintext: false });
    expect(after.settings).toEqual(before.settings);
    expect(after.pricing).toEqual(before.pricing);
    expect(after.memory).toEqual(before.memory);
    expect(after.tools).toEqual(before.tools);
    expect(after.dashboard.totals).toEqual(before.dashboard.totals);
    expect(after.dashboard.providerBreakdown).toEqual(before.dashboard.providerBreakdown);
    expect(after.dashboard.dailySpend).toEqual(before.dashboard.dailySpend);
    const ids = new Set(after.logs.map((l: any) => l.id));
    for (const l of before.logs) expect(ids.has(l.id), `log ${l.id} survived restart`).toBe(true);
    const aIds = new Set(after.activity.map((l: any) => l.id));
    for (const l of before.activity) expect(aIds.has(l.id)).toBe(true);

    // catalog seeding is idempotent across restarts
    expect(await ctx.prisma.span.count()).toBe(rowCountsBefore.spans);
    expect(await ctx.prisma.provider.count()).toBe(rowCountsBefore.providers);
    expect(await ctx.prisma.model.count()).toBe(rowCountsBefore.models);
    expect(await ctx.prisma.pricingConfig.count()).toBe(rowCountsBefore.pricing);

    // JSONL file preserved: old lines byte-identical prefix, same files
    const filesAfter = logFiles(ctx);
    expect(filesAfter).toEqual(expect.arrayContaining(filesBefore));
    filesBefore.forEach((f, i) => expect(fs.statSync(f).size).toBeGreaterThanOrEqual(sizeBefore[i]));
    const jsonlAfter = readJsonl(ctx);
    expect(jsonlAfter.slice(0, jsonlBefore.length)).toEqual(jsonlBefore);

    // the restarted app keeps working and does NOT duplicate budget alerts that already exist
    const alertsBefore = await ctx.prisma.budgetAlert.count();
    const r = await pay(ctx, { projectId: p.id, prompt: 'after restart', model: 'gpt-4o' });
    expect(r.status).toBe('SUCCESS');
    expect(r.budgetAlerts.length).toBeLessThanOrEqual(3);
    const total = await ctx.prisma.budgetAlert.count();
    const dups = await ctx.prisma.budgetAlert.groupBy({ by: ['budgetId', 'periodStart', 'threshold'], _count: true });
    expect(dups.every(d => d._count === 1)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(alertsBefore);
    expect(readJsonl(ctx).length).toBeGreaterThan(jsonlBefore.length);
    // archived stays archived; new requests still rejected
    expect((await api(ctx).get(`/api/projects/${archived.id}`)).body.data.status).toBe('ARCHIVED');
    expect((await api(ctx).post('/api/providers/requests').send({ projectId: archived.id, provider: 'openai', model: 'gpt-4o', prompt: 'x' })).status).toBe(409);
    await ctx.close();
  }, 120_000);

  it('a second restart in a row is stable too and JSONL keeps one line per DB log row written by the app', async () => {
    let ctx = await createTestApp();
    dirs.push(ctx.dir);
    const p = await mkProject(ctx, 'twice');
    await pay(ctx, { projectId: p.id, prompt: 'one' });
    ctx = await ctx.restart();
    await pay(ctx, { projectId: p.id, prompt: 'two' });
    ctx = await ctx.restart();
    await pay(ctx, { projectId: p.id, prompt: 'three' });
    expect(await ctx.prisma.usageEvent.count()).toBe(3);
    // the request log is written from res 'finish' without being awaited: let it reach DB and JSONL before comparing
    await ctx.deps.instr.flush();
    const lines = readJsonl(ctx);
    expect(await ctx.prisma.executionLog.count()).toBe(lines.length);
    expect(new Set(lines.map(l => l.id)).size).toBe(lines.length);
    // every line is a complete JSON object (no torn writes)
    for (const f of logFiles(ctx)) {
      const txt = fs.readFileSync(f, 'utf8');
      expect(txt.endsWith('\n')).toBe(true);
      for (const l of txt.split('\n').filter(Boolean)) expect(() => JSON.parse(l)).not.toThrow();
    }
    await ctx.close();
  }, 120_000);

  it('removing the JSONL files does not break exports (SQLite is the source of truth)', async () => {
    const ctx = await createTestApp();
    dirs.push(ctx.dir);
    const p = await mkProject(ctx, 'sot');
    await pay(ctx, { projectId: p.id, prompt: 'x' });
    for (const f of logFiles(ctx)) fs.rmSync(f);
    const ex = await api(ctx).get('/api/export/logs?format=jsonl');
    expect(ex.status).toBe(200);
    expect(ex.text.split('\n').filter(Boolean).length).toBe(await ctx.prisma.executionLog.count());
    // app keeps logging (re-creates the file) even if the file vanished
    const r = await api(ctx).post('/api/providers/requests').send({ projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'again' });
    expect(r.status).toBe(201);
    expect(path.basename(logFiles(ctx)[0] ?? '')).toMatch(/^execution-/);
    await ctx.close();
  }, 60_000);
});
