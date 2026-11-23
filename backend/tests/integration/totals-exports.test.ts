import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDir, createTestApp } from '../helpers/testApp';
import { api, Ctx, expectedPico, listAll, mkProject, parseCsv, pay, picoToUsd, usdToPico } from './helpers';

let ctx: Ctx;
let pa: { id: string; name: string }; let pb: { id: string; name: string };
beforeAll(async () => {
  ctx = await createTestApp();
  pa = await mkProject(ctx, 'totals-a'); pb = await mkProject(ctx, 'totals-b');
  const models: [string, string][] = [['openai', 'gpt-4o'], ['openai', 'gpt-4o-mini'], ['anthropic', 'claude-sonnet'], ['anthropic', 'claude-haiku'], ['openai', 'mystery-model']];
  let i = 0;
  for (const [provider, model] of models) {
    for (const proj of [pa, pb]) await pay(ctx, { projectId: proj.id, provider, model, prompt: `totals prompt ${i++} `.repeat(15) });
  }
  await pay(ctx, { projectId: pa.id, simulateFailure: 'error', prompt: 'totals fail 1' });
  await pay(ctx, { projectId: pb.id, simulateFailure: 'timeout', prompt: 'totals fail 2' });
  await pay(ctx, { projectId: pb.id, simulateFailure: 'rate_limit', prompt: 'totals fail 3' });
  // backdated demo data through the same pipeline
  const seed = await api(ctx).post('/api/simulations/seed').send({ projectId: pa.id, requests: 20, spreadDays: 10, includeFailures: true });
  expect(seed.status, JSON.stringify(seed.body)).toBeLessThan(300);
  // an alert + agent activity so every export dataset has rows
  const b = await api(ctx).post('/api/budgets').send({ projectId: pb.id, name: 'tiny', period: 'DAILY', limitUsd: '0.000000000001' });
  expect(b.status).toBe(201);
  await pay(ctx, { projectId: pb.id, prompt: 'agent activity prompt', simulateAgentActivity: true });
  await pay(ctx, { projectId: pb.id, prompt: 'agent activity fail', simulateAgentActivity: true, simulateFailure: 'error' });
  await api(ctx).post('/api/simulations/agent-run').send({ projectId: pb.id, simulateFailure: 'timeout' }).expect(201);
}, 120_000);
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

describe('dashboard totals == usage rows == usage CSV', () => {
  it('agree to the last pico-USD', async () => {
    const usage = await listAll<any>(ctx, '/api/usage');
    expect(usage.length).toBeGreaterThanOrEqual(30);
    const sumUsage = usage.reduce((s, u) => s + usdToPico(u.costUsd), 0n);
    const dbSum = (await ctx.prisma.usageEvent.findMany({ select: { costPico: true } })).reduce((s, r) => s + r.costPico, 0n);
    expect(sumUsage).toBe(dbSum);

    const dash = (await api(ctx).get('/api/dashboard?days=30')).body.data;
    expect(dash.simulated).toBe(true);
    expect(dash.label).toBe('DEMO / SIMULATED');
    expect(usdToPico(dash.totals.spendUsd)).toBe(sumUsage);
    expect(dash.totals.requests).toBe(usage.length);
    expect(dash.totals.successes + dash.totals.failures).toBe(usage.length);
    expect(dash.totals.failures).toBe(usage.filter(u => u.status === 'FAILURE').length);
    expect(dash.totals.inputTokens).toBe(usage.reduce((s, u) => s + u.inputTokens, 0));
    expect(dash.totals.outputTokens).toBe(usage.reduce((s, u) => s + u.outputTokens, 0));
    expect(dash.totals.cachedTokens).toBe(usage.reduce((s, u) => s + u.cachedTokens, 0));
    expect(dash.totals.successRate).toBeCloseTo(dash.totals.successes / dash.totals.requests, 6);

    // breakdowns & daily series sum to the totals
    const sumBy = (rows: any[]) => rows.reduce((s, r) => s + usdToPico(r.costUsd), 0n);
    expect(sumBy(dash.providerBreakdown)).toBe(sumUsage);
    expect(sumBy(dash.modelBreakdown)).toBe(sumUsage);
    expect(sumBy(dash.dailySpend)).toBe(sumUsage);
    expect(dash.providerBreakdown.reduce((s: number, r: any) => s + r.requests, 0)).toBe(usage.length);
    expect(dash.dailySpend.reduce((s: number, r: any) => s + r.requests, 0)).toBe(usage.length);
    expect(dash.dailySpend.reduce((s: number, r: any) => s + r.failures, 0)).toBe(dash.totals.failures);
    expect(dash.dailySpend).toHaveLength(30); // zero-filled
    expect(dash.dailySpend.every((d: any) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))).toBe(true);

    // CSV
    const csvRes = await api(ctx).get('/api/usage/export.csv').buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', c => (d += c)); res.on('end', () => cb(null, d)); });
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers['content-type']).toMatch(/text\/csv/);
    expect(csvRes.headers['content-disposition']).toMatch(/attachment; filename="usage-export-.*\.csv"/);
    const rows = parseCsv(csvRes.body as string).filter(r => r.length > 1);
    const [header, ...data] = rows;
    expect(header).toEqual(['request_id', 'created_at', 'project_id', 'project_name', 'provider', 'model', 'status', 'error_code', 'input_tokens',
      'output_tokens', 'cached_tokens', 'cost_usd', 'cost_class', 'pricing_version', 'duration_ms', 'trace_id', 'simulated']);
    expect(data).toHaveLength(usage.length);
    const costIdx = header.indexOf('cost_usd');
    expect(data.reduce((s, r) => s + usdToPico(r[costIdx]), 0n)).toBe(sumUsage);
    expect(new Set(data.map(r => r[0]))).toEqual(new Set(usage.map(u => u.requestId)));
    expect(data.every(r => r.length === header.length)).toBe(true);

    // filtered CSV == filtered list
    const failList = await listAll<any>(ctx, '/api/usage?status=FAILURE');
    const failCsv = await api(ctx).get('/api/usage/export.csv?status=FAILURE');
    const failRows = parseCsv(failCsv.text).filter(r => r.length > 1).slice(1);
    expect(failRows).toHaveLength(failList.length);
    expect(failRows.every(r => r[header.indexOf('status')] === 'FAILURE')).toBe(true);

    // per-project dashboard
    const dA = (await api(ctx).get(`/api/dashboard?days=30&projectId=${pa.id}`)).body.data;
    const aSum = usage.filter(u => u.projectId === pa.id).reduce((s, u) => s + usdToPico(u.costUsd), 0n);
    expect(usdToPico(dA.totals.spendUsd)).toBe(aSum);
    // project list usage summary agrees too
    const pr = (await api(ctx).get(`/api/projects/${pa.id}`)).body.data;
    expect(usdToPico(pr.usage.costUsd)).toBe(aSum);
    expect(pr.usage.requests).toBe(usage.filter(u => u.projectId === pa.id).length);
  });

  it('every usage row cost equals tokens x catalog price (oracle recomputation)', async () => {
    const usage = await listAll<any>(ctx, '/api/usage');
    const keyOf = (u: any) => (u.costClass === 'ESTIMATED' ? '*/*' : `${u.provider}/${u.model}`);
    for (const u of usage) {
      // gpt-4o-mini has v1 (2024) and v2 (2025): backdated seed rows are all after 2025-01-01 => v2 oracle
      expect(usdToPico(u.costUsd), u.requestId).toBe(expectedPico(keyOf(u), u).total);
    }
    expect(usage.some(u => u.costClass === 'ESTIMATED')).toBe(true);
    expect(usage.every(u => u.simulated === true && u.label === 'DEMO / SIMULATED')).toBe(true);
  });
});

describe('exports', () => {
  const datasets: Record<string, string> = {
    activity: '/api/activity', traces: '/api/traces', logs: '/api/logs', errors: '/api/observability/errors', memory: '/api/observability/memory-events',
    bus: '/api/observability/bus-events', tools: '/api/observability/tool-events', context: '/api/observability/context-events',
    alerts: '/api/budget-alerts', tasks: '/api/background-tasks',
  };
  for (const [name, listUrl] of Object.entries(datasets)) {
    it(`dataset ${name}: JSONL parses line-by-line & CSV is rectangular; counts equal the list endpoint`, async () => {
      const total = (await api(ctx).get(`${listUrl}?pageSize=1`)).body.pagination.total;
      expect(total, `${name} should have rows`).toBeGreaterThan(0);

      const jsonl = await api(ctx).get(`/api/export/${name}?format=jsonl`);
      expect(jsonl.status).toBe(200);
      expect(jsonl.headers['content-type']).toMatch(/ndjson|jsonl|json/);
      expect(jsonl.headers['content-disposition']).toMatch(new RegExp(`attachment; filename="spendguard-${name}-.*\\.jsonl"`));
      const lines = jsonl.text.split('\n').filter(l => l.trim() !== '');
      const objs = lines.map(l => JSON.parse(l));
      expect(objs.length).toBe(total);
      expect(jsonl.text.endsWith('\n')).toBe(true);

      const csv = await api(ctx).get(`/api/export/${name}?format=csv`);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      const rows = parseCsv(csv.text).filter(r => r.length > 0);
      const [header, ...data] = rows;
      expect(data.length).toBe(total);
      expect(data.every(r => r.length === header.length)).toBe(true);
      // CSV header keys are present in JSONL objects
      for (const h of header) expect(Object.keys(objs[0]), `${name}.${h}`).toContain(h);
    });
  }

  it('default format is jsonl; filters apply; unknown dataset/format rejected', async () => {
    const def = await api(ctx).get('/api/export/logs');
    expect(def.status).toBe(200);
    expect(def.headers['content-disposition']).toMatch(/\.jsonl"/);
    const failures = await api(ctx).get('/api/export/logs?status=FAILURE&format=jsonl');
    const objs = failures.text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(objs.length).toBeGreaterThan(0);
    expect(objs.every(o => o.status === 'FAILURE')).toBe(true);
    const simOnly = await api(ctx).get('/api/export/tools?source=SIMULATED');
    expect(simOnly.text.split('\n').filter(Boolean).every(l => JSON.parse(l).source === 'SIMULATED')).toBe(true);
    expect((await api(ctx).get('/api/export/nope')).status).toBe(404);
    expect((await api(ctx).get('/api/export/__proto__')).status).toBe(404);
    expect((await api(ctx).get('/api/export/logs?format=xml')).status).toBe(400);
    expect((await api(ctx).get('/api/export/logs?level=BOGUS')).status).toBe(400);
  });

  it('CSV formula injection is neutralised in usage and dataset exports', async () => {
    const evil = ['=HYPERLINK("http://evil.example","x")', '+SUM(1+1)', '-2+3', '@cmd'];
    for (const [i, n] of evil.entries()) {
      const p = await mkProject(ctx, n);
      await pay(ctx, { projectId: p.id, prompt: `inj ${i}` });
    }
    const usageCsv = await api(ctx).get('/api/usage/export.csv');
    const rows = parseCsv(usageCsv.text).filter(r => r.length > 1);
    const nameIdx = rows[0].indexOf('project_name');
    for (const n of evil) {
      const cell = rows.slice(1).map(r => r[nameIdx]).find(c => c.includes(n.slice(1)));
      expect(cell, n).toBeTruthy();
      expect(cell![0], `cell for ${n}: ${cell}`).toBe("'");
    }
    // no cell anywhere starts with a formula trigger (numbers like -5 excepted)
    for (const url of ['/api/usage/export.csv', '/api/export/activity?format=csv', '/api/export/alerts?format=csv', '/api/export/traces?format=csv']) {
      const t = (await api(ctx).get(url)).text;
      for (const r of parseCsv(t).slice(1)) for (const c of r) {
        if (/^[=+\-@\t\r]/.test(c)) expect(Number.isNaN(Number(c)), `${url}: dangerous cell ${JSON.stringify(c)}`).toBe(false);
      }
    }
    const act = (await api(ctx).get('/api/export/activity?format=csv')).text;
    expect(act).toContain(`'=HYPERLINK`);
  });
});

describe('retention sweep', () => {
  it('deletes only rows older than retentionDays, tracks a RETENTION_SWEEP task, keeps usage', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    const usageBefore = await ctx.prisma.usageEvent.count();
    await ctx.prisma.executionLog.create({ data: { ts: old, level: 'INFO', eventType: 'old.event', category: 'SYSTEM', operation: 'old-op', status: 'INFO', source: 'ACTUAL', message: 'old' } });
    await ctx.prisma.memoryEvent.create({ data: { operationId: 'old', phase: 'COMPLETED', status: 'SUCCESS', source: 'SIMULATED', memorySource: 's', category: 'c', itemCount: 1, estimatedTokens: 1, payloadBytes: 1, createdAt: old } });
    await ctx.prisma.trace.create({ data: { traceId: 'f'.repeat(32), name: 'old.trace', status: 'OK', source: 'SIMULATED', startedAt: old, endedAt: old, durationMs: 1 } });
    const recentLogs = await ctx.prisma.executionLog.count({ where: { ts: { gte: new Date(Date.now() - 86_400_000) } } });

    expect((await api(ctx).put('/api/settings').send({ retentionDays: 30 })).status).toBe(200);
    const run = await api(ctx).post('/api/logging/retention/run');
    expect(run.status).toBe(200);
    expect(run.body.data.kind).toBe('RETENTION_SWEEP');
    expect(run.body.data.status).toBe('SUCCEEDED');
    expect(run.body.data.source).toBe('ACTUAL');
    expect(await ctx.prisma.executionLog.count({ where: { operation: 'old-op' } })).toBe(0);
    expect(await ctx.prisma.memoryEvent.count({ where: { operationId: 'old' } })).toBe(0);
    expect(await ctx.prisma.trace.count({ where: { name: 'old.trace' } })).toBe(0);
    expect(await ctx.prisma.executionLog.count({ where: { ts: { gte: new Date(Date.now() - 86_400_000) } } })).toBeGreaterThanOrEqual(recentLogs);
    expect(await ctx.prisma.usageEvent.count()).toBe(usageBefore); // usage is billing data, never swept
    const tasks = await listAll<any>(ctx, '/api/background-tasks?kind=RETENTION_SWEEP');
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    // retentionDays = 0 keeps everything
    await ctx.prisma.executionLog.create({ data: { ts: old, level: 'INFO', eventType: 'old.event', category: 'SYSTEM', operation: 'old-op2', status: 'INFO', source: 'ACTUAL', message: 'old' } });
    await api(ctx).put('/api/settings').send({ retentionDays: 0 });
    await api(ctx).post('/api/logging/retention/run').expect(200);
    expect(await ctx.prisma.executionLog.count({ where: { operation: 'old-op2' } })).toBe(1);
  });
});

describe('sanity of expected helper', () => {
  it('picoToUsd is 12dp', () => expect(picoToUsd(1n)).toBe('0.000000000001'));
});
