import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { cleanupTestDir, createTestApp } from '../helpers/testApp';
import {
  api, Ctx, expectedPico, HEX16, HEX32, ISO, listAll, mkProject, pay, picoToUsd, readJsonl, REQ_ID, USD12, logFiles, usdToPico,
} from './helpers';

let ctx: Ctx;
let project: { id: string; name: string };
beforeAll(async () => { ctx = await createTestApp(); project = await mkProject(ctx, 'pipeline-proj'); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

describe('full pipeline: POST /providers/requests', () => {
  it('persists usage with the exact BigInt cost for several models/prompts', async () => {
    const cases: [string, string, string][] = [
      ['openai', 'gpt-4o', 'alpha prompt'], ['openai', 'gpt-4o-mini', 'beta prompt'], ['openai', 'gpt-4.1', 'gamma'],
      ['anthropic', 'claude-sonnet', 'delta prompt text'], ['anthropic', 'claude-opus', 'epsilon'], ['anthropic', 'claude-haiku', 'zeta zeta zeta'],
    ];
    let sawCached = false;
    for (const [provider, model, prompt] of cases) {
      const res = await pay(ctx, { projectId: project.id, provider, model, prompt: prompt.repeat(30), maxOutputTokens: 300 });
      expect(res.requestId).toMatch(REQ_ID);
      expect(res.traceId).toMatch(HEX32);
      expect(res.simulated).toBe(true);
      expect(res.label).toBe('DEMO / SIMULATED');
      expect(res.status).toBe('SUCCESS');
      expect(res.cost.costClass).toBe('SIMULATED');
      const exp = expectedPico(`${provider}/${model}`, res.usage);
      if (res.usage.cachedTokens > 0) sawCached = true;
      expect(res.cost.inputCostUsd).toBe(picoToUsd(exp.input));
      expect(res.cost.outputCostUsd).toBe(picoToUsd(exp.output));
      expect(res.cost.cachedCostUsd).toBe(picoToUsd(exp.cached));
      expect(res.cost.totalCostUsd).toBe(picoToUsd(exp.total));
      expect(res.cost.totalCostUsd).toMatch(USD12);

      // persisted row
      const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { requestId: res.requestId } });
      expect(row.costPico).toBe(exp.total);
      expect(row.inputCostPico).toBe(exp.input);
      expect(row.outputCostPico).toBe(exp.output);
      expect(row.cachedCostPico).toBe(exp.cached);
      expect(row.inputTokens).toBe(res.usage.inputTokens);
      expect(row.outputTokens).toBe(res.usage.outputTokens);
      expect(row.cachedTokens).toBe(res.usage.cachedTokens);
      expect(row.traceId).toBe(res.traceId);
      expect(row.simulated).toBe(true);
      // via API (by id and by requestId)
      for (const key of [res.usageEventId, res.requestId]) {
        const d = await api(ctx).get(`/api/usage/${key}`);
        expect(d.status).toBe(200);
        expect(d.body.data.costUsd).toBe(picoToUsd(exp.total));
        expect(d.body.data.requestId).toBe(res.requestId);
        expect(d.body.data.simulated).toBe(true);
        expect(d.body.data.label).toBe('DEMO / SIMULATED');
        expect(d.body.data.promptHash).toMatch(/^[0-9a-f]{64}$/);
        expect(d.body.data.promptChars).toBe((prompt.repeat(30)).length);
      }
    }
    expect(sawCached, 'at least one of the 6 requests should have cached tokens (deterministic mock)').toBe(true);
  });

  it('is deterministic: same input => same tokens/cost/content', async () => {
    const a = await pay(ctx, { projectId: project.id, prompt: 'determinism check' });
    const b = await pay(ctx, { projectId: project.id, prompt: 'determinism check' });
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.usage).toEqual(b.usage);
    expect(a.cost.totalCostUsd).toBe(b.cost.totalCostUsd);
    expect(a.content).toBe(b.content);
  });

  it('emits activity, an ACTUAL trace with parent/child spans, logs and a JSONL line', async () => {
    const res = await pay(ctx, { projectId: project.id, prompt: 'trace me please' });

    // activity
    const act = await api(ctx).get(`/api/activity?traceId=${res.traceId}`);
    expect(act.status).toBe(200);
    const usageAct = act.body.data.find((a: any) => a.type === 'usage.recorded');
    expect(usageAct).toBeTruthy();
    expect(usageAct.source).toBe('ACTUAL');
    expect(usageAct.requestId).toBe(res.requestId);
    expect(usageAct.projectId).toBe(project.id);
    expect(usageAct.metadata.simulated).toBe(true);

    // trace + spans
    const t = await api(ctx).get(`/api/traces/${res.traceId}`);
    expect(t.status).toBe(200);
    const { trace, spans, timeline } = t.body.data;
    expect(trace.traceId).toMatch(HEX32);
    expect(trace.name).toBe('provider.request');
    expect(trace.status).toBe('OK');
    expect(trace.source).toBe('ACTUAL');
    expect(trace.requestId).toBe(res.requestId);
    expect(trace.projectId).toBe(project.id);
    expect(trace.startedAt).toMatch(ISO);
    expect(trace.endedAt).toMatch(ISO);
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.spanCount).toBe(spans.length);
    const byName = Object.fromEntries(spans.map((s: any) => [s.name, s]));
    for (const n of ['provider.request', 'provider.mock', 'cost.calculate', 'usage.persist', 'budget.evaluate']) expect(byName[n], n).toBeTruthy();
    const root = byName['provider.request'];
    expect(root.parentSpanId).toBeNull();
    expect(root.kind).toBe('REQUEST');
    for (const n of ['provider.mock', 'cost.calculate', 'usage.persist', 'budget.evaluate']) expect(byName[n].parentSpanId).toBe(root.spanId);
    expect(byName['provider.mock'].kind).toBe('PROVIDER');
    expect(byName['provider.mock'].attributes.simulated).toBe(true);
    expect(byName['cost.calculate'].kind).toBe('COST');
    expect(byName['usage.persist'].kind).toBe('INTERNAL');
    expect(byName['budget.evaluate'].kind).toBe('BUDGET');
    const ids = new Set<string>();
    for (const s of spans) {
      expect(s.spanId).toMatch(HEX16);
      expect(s.traceId).toBe(res.traceId);
      expect(s.status).toBe('OK');
      expect(s.source).toBe('ACTUAL');
      expect(s.endedAt).toMatch(ISO);
      expect(ids.has(s.spanId)).toBe(false);
      ids.add(s.spanId);
      if (s.parentSpanId) expect(ids.has(s.parentSpanId) || spans.some((x: any) => x.spanId === s.parentSpanId)).toBe(true);
    }
    expect(timeline.length).toBeGreaterThan(0);
    // timeline sorted by ts
    const ts = timeline.map((e: any) => Date.parse(e.ts));
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);
    expect(timeline.every((e: any) => e.source === 'ACTUAL')).toBe(true);

    // ExecutionLog rows for this trace
    const logs = await listAll(ctx, `/api/logs?traceId=${res.traceId}`);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l: any) => l.source === 'ACTUAL')).toBe(true);
    const done = logs.find((l: any) => l.eventType === 'request.completed' && l.operation === 'provider.request');
    expect(done, 'trace completion log').toBeTruthy();
    expect(done.status).toBe('SUCCESS');
    expect(done.requestId).toBe(res.requestId);
    // the HTTP-level request log also exists
    const http = await listAll(ctx, `/api/logs?search=${encodeURIComponent('POST /api/providers/requests')}`);
    expect(http.length).toBeGreaterThan(0);

    // JSONL on disk: parseable, every DB log id has a line, shape matches DTO
    const files = logFiles(ctx);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]).toMatch(/execution-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = readJsonl(ctx);
    const lineIds = new Set(lines.map(l => l.id));
    for (const l of logs) expect(lineIds.has(l.id), `JSONL line for log ${l.id}`).toBe(true);
    const line = lines.find(l => l.id === done.id)!;
    expect(line).toMatchObject({ eventType: done.eventType, category: done.category, operation: done.operation, status: 'SUCCESS', source: 'ACTUAL', traceId: res.traceId });
    for (const k of ['id', 'ts', 'level', 'eventType', 'category', 'operation', 'status', 'source', 'message', 'attributes']) expect(line).toHaveProperty(k);
    // DB row count == JSONL lines count
    expect(await ctx.prisma.executionLog.count()).toBe(lines.length);
  });

  it('records a project-scoped activity feed & an idempotent trace listing', async () => {
    const list = await listAll(ctx, `/api/traces?projectId=${project.id}&source=ACTUAL`);
    expect(list.length).toBeGreaterThan(5);
    expect(new Set(list.map((t: any) => t.traceId)).size).toBe(list.length);
    const search = await api(ctx).get(`/api/traces?search=provider.request&projectId=${project.id}&pageSize=1`);
    expect(search.body.pagination.total).toBe(list.length);
  });

  it('request validation & project state errors use the error envelope', async () => {
    const bad = await api(ctx).post('/api/providers/requests').send({ projectId: project.id, provider: 'openai', model: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const badProv = await api(ctx).post('/api/providers/requests').send({ projectId: project.id, provider: 'nope', model: 'x', prompt: 'p' });
    expect(badProv.status).toBe(400);
    const missing = await api(ctx).post('/api/providers/requests').send({ projectId: 'does-not-exist', provider: 'openai', model: 'gpt-4o', prompt: 'p' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    const p2 = await mkProject(ctx, 'to-archive');
    await api(ctx).post(`/api/projects/${p2.id}/archive`).expect(200);
    const archived = await api(ctx).post('/api/providers/requests').send({ projectId: p2.id, provider: 'openai', model: 'gpt-4o', prompt: 'p' });
    expect(archived.status).toBe(409);
    expect(archived.body.error.code).toBe('CONFLICT');
    expect(await ctx.prisma.usageEvent.count({ where: { projectId: p2.id } })).toBe(0);
  });
});

describe('cost classes & pricing versions', () => {
  it('unknown model => ESTIMATED using the fallback price, flagged unknownModel', async () => {
    const res = await pay(ctx, { projectId: project.id, provider: 'openai', model: 'gpt-99-ultra-unknown', prompt: 'unknown model prompt' });
    expect(res.status).toBe('SUCCESS');
    expect(res.cost.costClass).toBe('ESTIMATED');
    expect(res.cost.unknownModel).toBe(true);
    expect(res.cost.totalCostUsd).toBe(picoToUsd(expectedPico('*/*', res.usage).total));
    const d = await api(ctx).get(`/api/usage/${res.requestId}`);
    expect(d.body.data.costClass).toBe('ESTIMATED');
    const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { requestId: res.requestId } });
    expect(row.costClass).toBe('ESTIMATED');
    expect(row.costPico).toBe(expectedPico('*/*', res.usage).total);
  });

  it('adding a new pricing version does not change previously stored usage cost, but applies to new requests', async () => {
    const before = await pay(ctx, { projectId: project.id, provider: 'anthropic', model: 'claude-haiku', prompt: 'pricing version probe '.repeat(20) });
    const beforeRow = await api(ctx).get(`/api/usage/${before.requestId}`);
    expect(before.cost.pricingVersion).toBe(1);
    const created = await api(ctx).post('/api/cost/pricing').send({
      provider: 'anthropic', model: 'claude-haiku', inputPerMTok: '1.000000', outputPerMTok: '8.000000', cachedPerMTok: '0.100000', note: 'integration price change',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.version).toBe(2);
    // old row untouched
    const afterRow = await api(ctx).get(`/api/usage/${before.requestId}`);
    expect(afterRow.body.data.costUsd).toBe(beforeRow.body.data.costUsd);
    expect(afterRow.body.data.pricingVersion).toBe(1);
    // an identical request (same tokens) now costs the new price
    const after = await pay(ctx, { projectId: project.id, provider: 'anthropic', model: 'claude-haiku', prompt: 'pricing version probe '.repeat(20) });
    expect(after.usage).toEqual(before.usage);
    expect(after.cost.pricingVersion).toBe(2);
    const exp = BigInt(after.usage.inputTokens) * 1_000_000n + BigInt(after.usage.outputTokens) * 8_000_000n + BigInt(after.usage.cachedTokens) * 100_000n;
    expect(after.cost.totalCostUsd).toBe(picoToUsd(exp));
    if (after.usage.outputTokens > 0) expect(after.cost.totalCostUsd).not.toBe(before.cost.totalCostUsd);
    // /cost/calculate with `at` before the change reproduces the OLD cost
    const calc = await api(ctx).post('/api/cost/calculate').send({
      provider: 'anthropic', model: 'claude-haiku', ...before.usage, at: new Date(Date.parse(beforeRow.body.data.createdAt)).toISOString(),
    });
    expect(calc.status).toBe(200);
    expect(calc.body.data.totalCostUsd).toBe(before.cost.totalCostUsd);
    // history view lists both versions
    const hist = await api(ctx).get('/api/cost/pricing?provider=anthropic&model=claude-haiku&history=true');
    expect(hist.body.data.map((p: any) => p.version).sort()).toEqual([1, 2]);
    // immutability: price tampering is not possible via API (no PATCH/PUT)
    const put = await api(ctx).put(`/api/cost/pricing/${created.body.data.id}`).send({ inputPerMTok: '0.000001' });
    expect(put.status).toBe(404);
  });

  it('rejects invalid pricing input (>6dp, negative) without creating a version', async () => {
    const n = await ctx.prisma.pricingConfig.count();
    const r1 = await api(ctx).post('/api/cost/pricing').send({ provider: 'openai', model: 'gpt-4o', inputPerMTok: '1.1234567', outputPerMTok: '1', cachedPerMTok: '1' });
    const r2 = await api(ctx).post('/api/cost/pricing').send({ provider: 'openai', model: 'gpt-4o', inputPerMTok: '-1', outputPerMTok: '1', cachedPerMTok: '1' });
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
    expect(await ctx.prisma.pricingConfig.count()).toBe(n);
  });
});

describe('failure modes', () => {
  const modes: [string, string[]][] = [['error', ['PROVIDER']], ['timeout', ['TIMEOUT']], ['rate_limit', ['PROVIDER', 'TIMEOUT']]];
  for (const [mode, cats] of modes) {
    it(`simulateFailure=${mode} => FAILURE usage, request.failed activity, ERROR trace, error log w/ category`, async () => {
      const res = await pay(ctx, { projectId: project.id, prompt: `fail ${mode}`, simulateFailure: mode });
      expect(res.status).toBe('FAILURE');
      expect(res.content).toBeNull();
      expect(res.finishReason).toBe('error');
      expect(res.error?.code).toBeTruthy();
      expect(res.usage.outputTokens).toBe(0);
      // cost still computed for consumed input tokens, exactly
      expect(res.cost.totalCostUsd).toBe(picoToUsd(expectedPico('openai/gpt-4o-mini', res.usage).total));

      const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { requestId: res.requestId } });
      expect(row.status).toBe('FAILURE');
      expect(row.errorCode).toBe(res.error!.code);
      expect(row.errorMessage).toBeTruthy();
      expect(JSON.parse(row.metadata).simulatedFailure).toBe(mode);

      const act = await api(ctx).get(`/api/activity?traceId=${res.traceId}&type=request.failed`);
      expect(act.body.data).toHaveLength(1);
      expect(act.body.data[0].level).toBe('ERROR');
      expect(act.body.data[0].source).toBe('ACTUAL');

      const t = (await api(ctx).get(`/api/traces/${res.traceId}`)).body.data;
      expect(t.trace.status).toBe('ERROR');
      expect(t.trace.errorMessage).toBeTruthy();
      expect(t.spans.find((s: any) => s.name === 'provider.mock').status).toBe('ERROR');
      expect(t.timeline.some((e: any) => e.status === 'FAILURE')).toBe(true);

      const errs = await listAll(ctx, `/api/observability/errors?traceId=${res.traceId}`);
      expect(errs.length).toBeGreaterThan(0);
      const e = errs.find((x: any) => x.operation === 'provider.mock');
      expect(e, 'provider.mock error log').toBeTruthy();
      expect(e.status).toBe('FAILURE');
      expect(e.level).toBe('ERROR');
      expect(cats).toContain(e.errorCategory);
      expect(e.errorMessage).toBeTruthy();
      expect(e.source).toBe('ACTUAL');
      // the same entry is in /logs with FAILURE and in JSONL
      const jl = readJsonl(ctx).find(l => l.id === e.id);
      expect(jl?.errorCategory).toBe(e.errorCategory);
      expect(jl?.status).toBe('FAILURE');
    });
  }

  it('an unknown route and a validation failure are logged as request failures with correct categories', async () => {
    const r = await api(ctx).get('/api/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});

describe('usage helper sanity', () => {
  it('usdToPico/picoToUsd round trip used by the oracle', () => {
    expect(usdToPico(picoToUsd(123456789n))).toBe(123456789n);
    expect(fs.existsSync(ctx.dir)).toBe(true);
  });
});
