import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { executeMockRequest } from '../../src/modules/providers';
import { ToolExecutor, TransientToolError, type ToolDef } from '../../src/modules/runtime';
import { ToolExecutionError, describeInput, isTransient } from '../../src/modules/runtime/tools';
import { recordingInstr } from '../providers/helpers';
import { allJsonl, dumpTables, makeProject, until } from './helpers';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });
const api = () => request(ctx.app);

describe('tool registry + invoke endpoint (real local tools)', () => {
  it('GET /tools lists the real tools with parameter descriptors', async () => {
    const r = await api().get('/api/tools');
    expect(r.status).toBe(200);
    const names = r.body.data.map((t: any) => t.name);
    expect(names).toEqual(['budget.status', 'pricing.lookup', 'usage.summary']);
    const pricing = r.body.data.find((t: any) => t.name === 'pricing.lookup');
    expect(pricing).toMatchObject({ source: 'ACTUAL', maxRetries: 2 });
    expect(pricing.params.map((p: any) => p.name)).toEqual(['provider', 'model']);
  });

  it('pricing.lookup reads PricingConfig through the cost service (known + unknown model)', async () => {
    const r = await api().post('/api/tools/pricing.lookup/invoke').send({ input: { provider: 'openai', model: 'gpt-4o' } });
    expect(r.status).toBe(200);
    expect(r.body.data.output).toMatchObject({ inputPerMTok: '2.500000', outputPerMTok: '10.000000', cachedPerMTok: '1.250000', costClass: 'SIMULATED', unknownModel: false });
    expect(r.body.data.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.body.data.toolCallId).toMatch(/^call_/);
    expect(r.body.data.attempts).toBe(1);
    const u = await api().post('/api/tools/pricing.lookup/invoke').send({ input: { provider: 'openai', model: 'who-knows' } });
    expect(u.body.data.output).toMatchObject({ costClass: 'ESTIMATED', unknownModel: true });
  });

  it('invoke runs in its OWN ACTUAL trace with a TOOL span and ACTUAL tool events (INITIATED + COMPLETED)', async () => {
    const p = await makeProject(ctx.prisma);
    const r = await api().post('/api/tools/usage.summary/invoke').send({ input: { projectId: p.id, days: 3 } });
    expect(r.status).toBe(200);
    expect(r.body.data.output).toMatchObject({ projectId: p.id, days: 3, requests: 0, costUsd: '0.000000000000' });
    const { traceId, toolCallId } = r.body.data;
    const trace = await ctx.prisma.trace.findUniqueOrThrow({ where: { traceId } });
    expect(trace).toMatchObject({ name: 'tool.invoke', source: 'ACTUAL', status: 'OK', projectId: p.id });
    const spans = await ctx.prisma.span.findMany({ where: { traceId } });
    expect(spans.find(s => s.kind === 'TOOL')).toMatchObject({ name: 'tool.usage.summary', source: 'ACTUAL', status: 'OK' });
    const ev = await ctx.prisma.toolCallEvent.findMany({ where: { toolCallId } });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ toolName: 'usage.summary', status: 'SUCCESS', source: 'ACTUAL', retryCount: 0, maxRetries: 2, traceId });
    expect(ev[0]!.durationMs).not.toBeNull();
    const logs = await ctx.prisma.executionLog.findMany({ where: { traceId, category: 'TOOL' }, orderBy: { ts: 'asc' } });
    expect(logs.map(l => l.eventType)).toEqual(['tool.call.initiated', 'tool.call.completed']);
    // the HTTP log line joins to the trace
    const http = await until(() => ctx.prisma.executionLog.findFirst({ where: { category: 'REQUEST', traceId, operation: { startsWith: 'POST ' } } }));
    expect(http.operation).toMatch(/POST .*tools.*invoke/);
  });

  it('budget.status reports current utilization of the project + global budgets', async () => {
    const p = await makeProject(ctx.prisma);
    await ctx.prisma.budget.create({ data: { projectId: p.id, name: 'tiny', period: 'DAILY', limitPico: 1_000_000n } });
    await executeMockRequest(ctx.deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'hello there' }, { latency: false });
    const r = await api().post('/api/tools/budget.status/invoke').send({ input: { projectId: p.id } });
    expect(r.body.data.output).toMatchObject({ projectId: p.id, count: 1, overLimit: true });
    expect(r.body.data.output.budgets[0]).toMatchObject({ name: 'tiny', period: 'DAILY', scope: 'project', highestThresholdReached: 100 });
    expect(r.body.data.output.highestPercent).toBeGreaterThanOrEqual(100);
  });

  it('invalid input => 400 (never retried) and a FAILURE tool event; unknown tool => 404', async () => {
    const bad = await api().post('/api/tools/pricing.lookup/invoke').send({ input: { provider: '' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const ev = await ctx.prisma.toolCallEvent.findFirstOrThrow({ where: { toolName: 'pricing.lookup', status: 'FAILURE' }, orderBy: { createdAt: 'desc' } });
    expect(ev).toMatchObject({ source: 'ACTUAL', retryCount: 0 });
    expect(ev.errorMessage).toMatch(/Invalid input/);
    expect((await api().post('/api/tools/nope/invoke').send({ input: {} })).status).toBe(404);
    expect((await api().post('/api/tools/pricing.lookup/invoke').send({ input: 'x' })).status).toBe(400);
    const failedTrace = await ctx.prisma.trace.findFirstOrThrow({ where: { name: 'tool.invoke', status: 'ERROR' } });
    expect(failedTrace.errorMessage).toMatch(/Invalid input/);
  });

  it('inputMeta / outputMeta never contain parameter VALUES (names, types, sizes, hash only) - DB, logs and JSONL', async () => {
    const SENT = 'TOOL-VALUE-SENTINEL-31337';
    const r = await api().post('/api/tools/pricing.lookup/invoke').send({ input: { provider: 'openai', model: SENT } });
    expect(r.status).toBe(200);
    const ev = await ctx.prisma.toolCallEvent.findFirstOrThrow({ where: { toolCallId: r.body.data.toolCallId } });
    const meta = JSON.parse(ev.inputMeta);
    expect(meta.paramNames).toEqual(['model', 'provider']);
    expect(meta.paramTypes).toEqual({ model: 'string', provider: 'string' });
    expect(meta.paramSizes).toEqual({ model: SENT.length, provider: 6 });
    expect(meta.inputHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.parse(ev.outputMeta)).toMatchObject({ status: 'ok' });
    expect(await dumpTables(ctx.prisma, ['ProjectMemoryItem'])).not.toContain(SENT); // (the model name is also not persisted in events/logs/spans)
    expect(allJsonl(ctx)).not.toContain(SENT);
  });
});

describe('ToolExecutor retries and failures', () => {
  const flaky = (failures: number, error: () => Error = () => new TransientToolError('upstream blip')): ToolDef<{ q: string }> & { calls: number } => {
    const def = {
      name: 'test.flaky', description: 'flaky', params: [], schema: z.object({ q: z.string() }), calls: 0,
      async run() { def.calls++; if (def.calls <= failures) throw error(); return { ok: true }; },
    };
    return def;
  };
  const exec = () => { const instr = recordingInstr(); return { instr, ex: new ToolExecutor(instr, { prisma: ctx.prisma, cost: ctx.deps.cost }, []) }; };

  it('retries transient errors with bounded backoff (maxRetries 2): same toolCallId, retryCount 0,1,2', async () => {
    const { instr, ex } = exec();
    const tool = flaky(2); ex.register(tool);
    const t0 = Date.now();
    const r = await ex.execute('test.flaky', { q: 'SECRET-Q' });
    expect(r).toMatchObject({ output: { ok: true }, attempts: 3 });
    expect(Date.now() - t0).toBeLessThan(1000); // backoff 20ms + 40ms
    const done = instr.calls.filter(c => c.fn === 'recordTool' && c.phase === 'COMPLETED') as any[];
    expect(done.map(d => [d.retryCount, d.success])).toEqual([[0, false], [1, false], [2, true]]);
    expect(new Set(done.map(d => d.toolCallId)).size).toBe(1);
    expect(done.every(d => d.source === 'ACTUAL' && d.maxRetries === 2)).toBe(true);
    expect(instr.calls.filter(c => c.fn === 'recordTool' && c.phase === 'INITIATED')).toHaveLength(1);
    expect(JSON.stringify(instr.calls)).not.toContain('SECRET-Q');
  });

  it('gives up after maxRetries: ToolExecutionError (502) with attempts, final failure recorded', async () => {
    const { instr, ex } = exec();
    const tool = flaky(99); ex.register(tool);
    const err = await ex.execute('test.flaky', { q: 'x' }).catch(e => e);
    expect(err).toBeInstanceOf(ToolExecutionError);
    expect(err).toMatchObject({ status: 502, code: 'TOOL_FAILED', attempts: 3 });
    expect(tool.calls).toBe(3);
    const done = instr.calls.filter(c => c.fn === 'recordTool' && c.phase === 'COMPLETED') as any[];
    expect(done.map(d => d.success)).toEqual([false, false, false]);
    expect(done[2].outputMeta).toMatchObject({ status: 'error', willRetry: false, attempts: 3 });
  });

  it('non-transient errors are not retried', async () => {
    const { instr, ex } = exec();
    const tool = flaky(99, () => new Error('bad thing')); ex.register(tool);
    const err = await ex.execute('test.flaky', { q: 'x' }).catch(e => e);
    expect(err).toMatchObject({ attempts: 1 });
    expect(tool.calls).toBe(1);
    expect(instr.calls.filter(c => c.fn === 'recordTool' && c.phase === 'COMPLETED')).toHaveLength(1);
  });

  it('transient detection (explicit flag + sqlite/timeouts) and input description helper', () => {
    expect(isTransient(new TransientToolError('x'))).toBe(true);
    expect(isTransient(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
    expect(isTransient(new Error('ECONNRESET'))).toBe(true);
    expect(isTransient(new Error('plain'))).toBe(false);
    const m = describeInput({ b: 'abc', a: [1, 2, 3], n: 5 });
    expect(m.paramNames).toEqual(['a', 'b', 'n']);
    expect(m.paramTypes).toEqual({ a: 'array', b: 'string', n: 'number' });
    expect(m.paramSizes).toEqual({ a: 3, b: 3, n: 1 });
    expect(describeInput({ b: 'abc', a: [1, 2, 3], n: 5 }).inputHash).toBe(m.inputHash);
    expect(describeInput({ b: 'abd', a: [1, 2, 3], n: 5 }).inputHash).not.toBe(m.inputHash);
  });
});

describe('pipeline tool calls (real)', () => {
  it('a provider request really invokes pricing.lookup and budget.status as ACTUAL tool calls under the request trace', async () => {
    const p = await makeProject(ctx.prisma);
    const r = await executeMockRequest(ctx.deps, { projectId: p.id, provider: 'anthropic', model: 'claude-sonnet', prompt: 'hello pipeline' }, { latency: false });
    expect(r.tools!.map(t => [t.name, t.status, t.attempts])).toEqual([['pricing.lookup', 'SUCCESS', 1], ['budget.status', 'SUCCESS', 1]]);
    const ev = await ctx.prisma.toolCallEvent.findMany({ where: { traceId: r.traceId }, orderBy: { createdAt: 'asc' } });
    expect(ev.map(e => e.toolName).sort()).toEqual(['budget.status', 'pricing.lookup']);
    expect(ev.every(e => e.source === 'ACTUAL' && e.status === 'SUCCESS' && e.requestId === r.requestId && e.projectId === p.id)).toBe(true);
    const spans = await ctx.prisma.span.findMany({ where: { traceId: r.traceId, kind: 'TOOL' } });
    expect(spans.map(s => s.name).sort()).toEqual(['tool.budget.status', 'tool.pricing.lookup']);
    expect(spans.every(s => s.source === 'ACTUAL' && s.status === 'OK')).toBe(true);
    expect(r.budgetPreflight).toEqual({ status: 'OK', budgets: 0, highestPercent: 0, overLimit: false });
    const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { id: r.usageEventId } });
    const meta = JSON.parse(row.metadata);
    expect(meta.budgetPreflight).toMatchObject({ status: 'OK' });
    expect(meta.pricingPreflight).toMatchObject({ costClass: 'SIMULATED', unknownModel: false });
    expect(meta.tools.map((t: any) => t.name)).toEqual(['pricing.lookup', 'budget.status']);
    // pricing preflight agrees with the version the request was actually billed at
    expect(meta.pricingPreflight.pricingVersion).toBe(row.pricingVersion);
  });

  it('budget preflight reflects an exceeded budget but never blocks the request', async () => {
    const p = await makeProject(ctx.prisma);
    await ctx.prisma.budget.create({ data: { projectId: p.id, name: 'zero-ish', period: 'DAILY', limitPico: 1n } });
    await executeMockRequest(ctx.deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'first' }, { latency: false });
    const r = await executeMockRequest(ctx.deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'second' }, { latency: false });
    expect(r.status).toBe('SUCCESS');
    expect(r.budgetPreflight).toMatchObject({ status: 'OK', budgets: 1, overLimit: true });
    expect(r.budgetPreflight!.highestPercent).toBeGreaterThanOrEqual(100);
  });

  it('a failing tool is recorded (FAILURE, ACTUAL) but never blocks the request', async () => {
    const p = await makeProject(ctx.prisma);
    // cost service that fails ONLY for the zero-token pricing.lookup call
    const deps = { ...ctx.deps, cost: { calculate: async (i: any) => { if (i.inputTokens === 0 && i.outputTokens === 0) throw new Error('pricing backend down'); return ctx.deps.cost.calculate(i); } } };
    const r = await executeMockRequest(deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'still works' }, { latency: false });
    expect(r.status).toBe('SUCCESS');
    expect(r.tools!.find(t => t.name === 'pricing.lookup')).toMatchObject({ status: 'FAILURE', attempts: 1 });
    expect(r.tools!.find(t => t.name === 'budget.status')).toMatchObject({ status: 'SUCCESS' });
    const ev = await ctx.prisma.toolCallEvent.findFirstOrThrow({ where: { traceId: r.traceId, toolName: 'pricing.lookup' } });
    expect(ev).toMatchObject({ status: 'FAILURE', source: 'ACTUAL' });
    expect(ev.errorMessage).toMatch(/pricing backend down/);
    const span = await ctx.prisma.span.findFirstOrThrow({ where: { traceId: r.traceId, name: 'tool.pricing.lookup' } });
    expect(span.status).toBe('ERROR');
    const trace = await ctx.prisma.trace.findUniqueOrThrow({ where: { traceId: r.traceId } });
    expect(trace.status).toBe('OK'); // the request itself succeeded
  });
});
