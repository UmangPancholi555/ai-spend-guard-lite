import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { executeMockRequest } from '../../src/modules/providers';
import { emitSimulatedAgentActivity } from '../../src/modules/providers/simulator/agentActivity';
import { sha256 } from '../../src/utils/ids';
import { parseJson } from '../../src/utils/serialize';
import type { AppDeps } from '../../src/contracts/services';
import type { BudgetAlertDto } from '../../../shared/types';
import { fakeBudgets, fakeCost, makeProject, recordingInstr, dumpAllTables, type RecordingInstr, type FakeBudgets } from './helpers';

let ctx: TestCtx;
let instr: RecordingInstr;
let budgets: FakeBudgets;
let deps: AppDeps;
let projectId: string;
const SENTINEL = 'PIPELINE-PROMPT-SENTINEL-98765';
const prompt = `Please analyse this. ${SENTINEL} `.repeat(15); // > 200 chars

beforeAll(async () => {
  ctx = await createTestApp();
  projectId = (await makeProject(ctx.prisma)).id;
});
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

function fresh(alerts: BudgetAlertDto[] = []) {
  instr = recordingInstr();
  budgets = fakeBudgets(alerts);
  deps = { ...ctx.deps, instr, cost: fakeCost(), budgets };
}
const req = (over: Record<string, unknown> = {}) => ({ projectId, provider: 'openai' as const, model: 'gpt-4o-mini', prompt, ...over });

describe('executeMockRequest: instrumentation order and trace shape', () => {
  it('success path calls instr in the contract order', async () => {
    fresh();
    const res = await executeMockRequest(deps, req(), { latency: false });
    expect(res.status).toBe('SUCCESS');
    expect(instr.names()).toEqual([
      'startTrace',
      // real context manager: CREATED v1
      'span.start:context.created', 'recordContext', 'span.end:context.created',
      // real tool calls (preflight)
      'span.start:tool.pricing.lookup', 'recordTool', 'recordTool', 'span.end:tool.pricing.lookup',
      'span.start:tool.budget.status', 'recordTool', 'recordTool', 'span.end:tool.budget.status',
      'span.start:provider.mock', 'span.end:provider.mock',
      'span.start:context.updated', 'recordContext', 'span.end:context.updated',
      'span.start:cost.calculate', 'span.end:cost.calculate',
      'span.start:usage.persist', 'span.end:usage.persist',
      // real event bus: publish usage.recorded -> activity subscriber
      'span.start:bus.publish', 'recordActivity:usage.recorded', 'recordBus', 'recordBus', 'span.end:bus.publish',
      // budget evaluation = bus request to the budget engine
      'span.start:budget.evaluate', 'span.start:bus.request', 'recordBus', 'span.end:bus.request', 'span.end:budget.evaluate',
      'trace.end',
    ]);
    expect(instr.traces[0]).toMatchObject({ name: 'provider.request', source: 'ACTUAL', projectId, requestId: res.requestId, ended: true });
    expect(instr.traces[0]!.endError).toBeUndefined();
    const prov = instr.spans.find(s => s.name === 'provider.mock')!;
    expect(prov.kind).toBe('PROVIDER');
    expect(prov.attributes.simulated).toBe(true);
    expect(prov.source).toBe('ACTUAL');
    expect(instr.spans.filter(s => ['provider.mock', 'cost.calculate', 'usage.persist', 'budget.evaluate'].includes(s.name)).map(s => s.kind)).toEqual(['PROVIDER', 'COST', 'INTERNAL', 'BUDGET']);
    expect(instr.spans.filter(s => s.kind === 'TOOL').map(s => s.name)).toEqual(['tool.pricing.lookup', 'tool.budget.status']);
    expect(res.traceId).toBe(instr.traces[0]!.traceId);
  });

  it('failure path records error + request.failed activity and ends the trace with error info', async () => {
    fresh();
    const res = await executeMockRequest(deps, req({ simulateFailure: 'timeout' }), { latency: false });
    expect(res.status).toBe('FAILURE');
    const names = instr.names();
    const order = ['span.end:provider.mock', 'recordError', 'span.start:context.updated', 'span.start:cost.calculate', 'span.start:usage.persist', 'recordActivity:request.failed', 'span.start:budget.evaluate', 'trace.end'];
    expect(order.map(n => names.indexOf(n)).every((i, k, arr) => i >= 0 && (k === 0 || i > arr[k - 1]!))).toBe(true);
    expect(instr.spans.find(s => s.name === 'provider.mock')!.error).toMatchObject({ category: 'TIMEOUT' });
    const end = instr.calls.find(c => c.fn === 'trace.end')!;
    expect(end.error).toBe(true);
    expect((end.errorInfo as any).message).toMatch(/simulated/i);
    expect(typeof (end.errorInfo as any).stack).toBe('string');
    const act = instr.calls.find(c => c.fn === 'recordActivity') as any;
    expect(act.level).toBe('ERROR');
    expect(act.source).toBe('ACTUAL');
  });

  it('passes traceId and the budget.evaluate spanId plus `at` to budgets.evaluateAfterUsage; returns alerts', async () => {
    const alert = { id: 'a1', budgetId: 'b1', budgetName: 'B', projectId, projectName: 'P', period: 'DAILY', threshold: 50, periodStart: '', periodEnd: '', spendUsd: '0.000000000000', limitUsd: '1.000000000000', percent: 50, createdAt: '' } as BudgetAlertDto;
    fresh([alert]);
    const at = new Date('2026-01-15T10:00:00.000Z');
    const res = await executeMockRequest(deps, req(), { latency: false, createdAt: at });
    expect(budgets.calls).toHaveLength(1);
    const call = budgets.calls[0]!;
    expect(call.projectId).toBe(projectId);
    expect(call.traceId).toBe(res.traceId);
    expect(call.spanId).toBe(instr.spans.find(s => s.name === 'budget.evaluate')!.spanId);
    expect(call.at.toISOString()).toBe(at.toISOString());
    expect(res.budgetAlerts).toEqual([alert]);
  });

  it('cost is calculated `at` the event time with inputTokens (non-cached), outputTokens, cachedTokens', async () => {
    fresh();
    const at = new Date('2026-02-01T00:00:00.000Z');
    const res = await executeMockRequest(deps, req(), { latency: false, createdAt: at });
    const call = (deps.cost as ReturnType<typeof fakeCost>).calls.find((c: any) => c.outputTokens > 0 || c.inputTokens > 0) as any; // (the first call is the pricing.lookup tool, 0 tokens)
    expect(call).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, cachedTokens: res.usage.cachedTokens, at: at.toISOString() });
  });
});

describe('executeMockRequest: persistence', () => {
  it('persists a complete UsageEvent with BigInt pico costs, hash, metadata, labels', async () => {
    fresh();
    const res = await executeMockRequest(deps, req({ temperature: 0.3, maxOutputTokens: 500 }), { latency: false });
    const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { id: res.usageEventId } });
    expect(row.requestId).toBe(res.requestId);
    expect(res.requestId).toMatch(/^req_[0-9a-f]{32}$/);
    expect(row).toMatchObject({ projectId, providerKey: 'openai', modelName: 'gpt-4o-mini', status: 'SUCCESS', errorCode: null, simulated: true, costClass: 'SIMULATED', traceId: res.traceId, promptChars: prompt.length, promptHash: sha256(prompt) });
    expect(row.inputTokens).toBe(res.usage.inputTokens);
    expect(row.outputTokens).toBe(res.usage.outputTokens);
    expect(row.cachedTokens).toBe(res.usage.cachedTokens);
    expect(row.durationMs).toBe(res.durationMs);
    expect(row.responseText).toBe(res.content);
    expect(typeof row.costPico).toBe('bigint');
    expect(row.costPico).toBe(row.inputCostPico + row.outputCostPico + row.cachedCostPico);
    expect(row.pricingVersion).toBe(2);
    // gpt-4o-mini v2: 0.12 in / 0.5 out / 0.06 cached per MTok => pico = tokens * micro-price
    expect(row.inputCostPico).toBe(BigInt(row.inputTokens) * 120_000n);
    expect(row.outputCostPico).toBe(BigInt(row.outputTokens) * 500_000n);
    expect(row.cachedCostPico).toBe(BigInt(row.cachedTokens) * 60_000n);
    const meta = parseJson<Record<string, any>>(row.metadata);
    expect(meta).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', temperature: 0.3, maxOutputTokens: 500, simulatedFailure: 'none', simulated: true, label: 'DEMO / SIMULATED' });
    expect(meta.responseId).toMatch(/^chatcmpl-/);
    expect(typeof meta.mockSeed).toBe('number');
    expect(meta.apiVersion).toBeTruthy();
    expect(meta.totalPromptTokens).toBe(row.inputTokens + row.cachedTokens);
    expect(meta.tokenConvention).toMatch(/non-cached/);
    // response breakdown mirrors persisted money
    expect(res.cost.totalCostUsd).toMatch(/^\d+\.\d{12}$/);
    expect((res.cost as any).totalCostPico).toBeUndefined();
  });

  it('every response is labelled simulated', async () => {
    fresh();
    for (const failure of ['none', 'error', 'timeout', 'rate_limit'] as const) {
      const res = await executeMockRequest(deps, req({ simulateFailure: failure, provider: 'anthropic', model: 'claude-haiku' }), { latency: false });
      expect(res.simulated).toBe(true);
      expect(res.label).toBe('DEMO / SIMULATED');
    }
  });

  it('is deterministic: same request => same content/tokens/cache/finishReason/duration, but unique requestIds', async () => {
    fresh();
    const a = await executeMockRequest(deps, req(), { latency: false });
    const b = await executeMockRequest(deps, req(), { latency: false });
    expect(b.requestId).not.toBe(a.requestId);
    expect(b.usageEventId).not.toBe(a.usageEventId);
    for (const k of ['content', 'finishReason', 'usage', 'durationMs'] as const) expect(b[k]).toEqual(a[k]);
    const c = await executeMockRequest(deps, req({ prompt: prompt + ' different' }), { latency: false });
    expect(c.content).not.toBe(a.content);
  });

  it('generates unique requestIds across many requests', async () => {
    fresh();
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) ids.add((await executeMockRequest(deps, req({ prompt: `p${i}` }), { latency: false, trace: false })).requestId);
    expect(ids.size).toBe(25);
  });

  it('failure modes persist FAILURE rows with error code, input consumed, output 0, null content', async () => {
    fresh();
    const expected = { error: 'PROVIDER_ERROR', timeout: 'PROVIDER_TIMEOUT', rate_limit: 'RATE_LIMITED' } as const;
    for (const mode of ['error', 'timeout', 'rate_limit'] as const) {
      const res = await executeMockRequest(deps, req({ simulateFailure: mode }), { latency: false });
      expect(res.status).toBe('FAILURE');
      expect(res.error?.code).toBe(expected[mode]);
      expect(res.error?.message).toMatch(/simulated/i);
      expect(res.content).toBeNull();
      expect(res.finishReason).toBe('error');
      expect(res.usage.outputTokens).toBe(0);
      expect(res.usage.inputTokens + res.usage.cachedTokens).toBeGreaterThan(0);
      const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { id: res.usageEventId } });
      expect(row).toMatchObject({ status: 'FAILURE', errorCode: expected[mode], outputTokens: 0, responseText: null });
      expect(row.errorMessage).toMatch(/simulated/i);
      expect(row.outputCostPico).toBe(0n);
      expect(row.inputCostPico + row.cachedCostPico).toBe(row.costPico);
    }
  });

  it('unknown model is accepted and priced as ESTIMATED', async () => {
    fresh();
    const res = await executeMockRequest(deps, req({ model: 'some-future-model' }), { latency: false });
    expect(res.status).toBe('SUCCESS');
    expect(res.cost.costClass).toBe('ESTIMATED');
    expect(res.cost.unknownModel).toBe(true);
    const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { id: res.usageEventId } });
    expect(row.costClass).toBe('ESTIMATED');
  });

  it('explicit createdAt is written to the UsageEvent (backdating)', async () => {
    fresh();
    const at = new Date(Date.now() - 20 * 86_400_000);
    const res = await executeMockRequest(deps, req(), { latency: false, createdAt: at });
    const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { id: res.usageEventId } });
    expect(row.createdAt.toISOString()).toBe(at.toISOString());
  });

  it('prompt text is never persisted anywhere (usage row, DB-wide grep, recorded instr payloads)', async () => {
    fresh();
    const res = await executeMockRequest(deps, req({ simulateAgentActivity: true }), { latency: false });
    await executeMockRequest(deps, req({ simulateFailure: 'error' }), { latency: false });
    const dump = await dumpAllTables(ctx.prisma);
    expect(dump).not.toContain(SENTINEL);
    expect(dump).toContain(sha256(prompt)); // only the hash
    expect(JSON.stringify(instr.calls)).not.toContain(SENTINEL);
    expect(res.content).not.toContain(SENTINEL);
  });

  it('emits usage.recorded activity metadata without prompt content', async () => {
    fresh();
    await executeMockRequest(deps, req(), { latency: false });
    const act = instr.calls.find(c => c.fn === 'recordActivity') as any;
    expect(act.type).toBe('usage.recorded');
    expect(act.source).toBe('ACTUAL');
    expect(act.requestId).toMatch(/^req_/);
    expect(act.traceId).toBeTruthy();
    expect(act.metadata.simulated).toBe(true);
  });
});

describe('executeMockRequest: project checks and validation', () => {
  it('unknown project => 404 and nothing recorded', async () => {
    fresh();
    await expect(executeMockRequest(deps, req({ projectId: 'does-not-exist' }), { latency: false })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(instr.calls).toHaveLength(0);
  });
  it('archived project => 409 and no usage event', async () => {
    fresh();
    const archived = await makeProject(ctx.prisma, 'archived-one', 'ARCHIVED');
    await expect(executeMockRequest(deps, req({ projectId: archived.id }), { latency: false })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(await ctx.prisma.usageEvent.count({ where: { projectId: archived.id } })).toBe(0);
    expect(instr.calls).toHaveLength(0);
  });
  it('validates input with zod (400)', async () => {
    fresh();
    const bad = [
      req({ prompt: '' }), req({ prompt: 'x'.repeat(20001) }), req({ model: '' }), req({ model: 'm'.repeat(101) }),
      req({ maxOutputTokens: 0 }), req({ maxOutputTokens: 8193 }), req({ maxOutputTokens: 1.5 }), req({ provider: 'gemini' }), req({ simulateFailure: 'boom' }),
    ];
    for (const b of bad) await expect(executeMockRequest(deps, b as any, { latency: false })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    // boundaries are accepted
    await expect(executeMockRequest(deps, req({ prompt: 'x'.repeat(20000), maxOutputTokens: 8192, model: 'm'.repeat(100) }), { latency: false, trace: false })).resolves.toMatchObject({ status: 'SUCCESS' });
  });
  it('a cost-service failure ends the trace with an error and surfaces', async () => {
    fresh();
    deps = { ...deps, cost: { calculate: async () => { throw new Error('cost boom'); } } };
    await expect(executeMockRequest(deps, req(), { latency: false })).rejects.toThrow('cost boom');
    expect(instr.traces[0]!.ended).toBe(true);
    expect(instr.traces[0]!.endError).toBeTruthy();
    expect(instr.spans.find(s => s.name === 'cost.calculate')!.error).toBeTruthy();
  });
});

describe('simulated agent activity', () => {
  it('simulateAgentActivity emits SIMULATED context/memory/bus/tool events correlated to the trace', async () => {
    fresh();
    const res = await executeMockRequest(deps, req({ simulateAgentActivity: true }), { latency: false });
    const calls = instr.calls.filter(c => c.source === 'SIMULATED' || !['recordContext', 'recordMemory', 'recordBus', 'recordTool'].includes(c.fn as string));
    const ctxs = calls.filter(c => c.fn === 'recordContext') as any[];
    expect(ctxs.map(c => c.operation)).toEqual(['CREATED', 'UPDATED', 'ADDED', 'MODIFIED']);
    expect(ctxs.map(c => c.version)).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < ctxs.length; i++) expect(ctxs[i].sizeBytes).toBeGreaterThan(ctxs[i - 1].sizeBytes);
    const mems = calls.filter(c => c.fn === 'recordMemory') as any[];
    expect(mems.map(m => m.phase)).toEqual(['STARTED', expect.stringMatching(/COMPLETED|FAILED/)]);
    expect(mems[1].operationId).toBeTruthy();
    expect(calls.filter(c => c.fn === 'recordBus').length).toBeGreaterThanOrEqual(1);
    const tools = calls.filter(c => c.fn === 'recordTool' && c.phase === 'COMPLETED') as any[];
    expect(tools.map(t => t.toolName)).toEqual(expect.arrayContaining(['web_search', 'read_file']));
    const search = tools.filter(t => t.toolName === 'web_search');
    expect(search[0]).toMatchObject({ success: false, retryCount: 0 });
    expect(search[1]).toMatchObject({ success: true, retryCount: 1 });
    expect(search[0].toolCallId).toBe(search[1].toolCallId);
    const events = calls.filter(c => ['recordContext', 'recordMemory', 'recordBus', 'recordTool'].includes(c.fn as string)) as any[];
    const rootChildren = new Set(instr.spans.filter(s => s.name === 'provider.mock').map(s => s.parentSpanId));
    for (const e of events) {
      expect(e.source).toBe('SIMULATED');
      expect(e.traceId).toBe(res.traceId);
      expect(e.projectId).toBe(projectId);
      expect(e.requestId).toBe(res.requestId);
      const sp = instr.spans.find(s => s.spanId === e.spanId)!;
      expect(sp.source).toBe('SIMULATED');
      expect(sp.attributes.simulated).toBe(true);
      expect(rootChildren.has(sp.parentSpanId)).toBe(true);
    }
    // the request lifecycle spans stay ACTUAL
    expect(instr.spans.filter(s => ['provider.mock', 'cost.calculate', 'usage.persist', 'budget.evaluate'].includes(s.name)).every(s => s.source === 'ACTUAL')).toBe(true);
    // agent activity comes after budget.evaluate and before trace.end
    const names = instr.names();
    const simStart = instr.spans.findIndex(sp => sp.source === 'SIMULATED');
    expect(simStart).toBeGreaterThan(instr.spans.findIndex(sp => sp.name === 'budget.evaluate'));
    expect(names[names.length - 1]).toBe('trace.end');
  });

  it('does not emit agent activity by default and never puts content-like keys in event metadata', async () => {
    fresh();
    await executeMockRequest(deps, req(), { latency: false });
    expect(instr.calls.some(c => c.source === 'SIMULATED')).toBe(false);
    expect(instr.spans.some(sp => sp.source === 'SIMULATED')).toBe(false);
    fresh();
    await executeMockRequest(deps, req({ simulateAgentActivity: true }), { latency: false });
    const blob = JSON.stringify(instr.calls.filter(c => c.source === 'SIMULATED' && ['recordContext', 'recordMemory', 'recordBus', 'recordTool'].includes(c.fn as string)));
    expect(blob).not.toMatch(/"(content|prompt|text|body|message)":/);
  });

  it('forced error failure fails the memory injection; timeout fails the tool; rate_limit fails the bus op', async () => {
    for (const [failure, check] of [
      ['error', (c: any) => c.fn === 'recordMemory' && c.phase === 'FAILED'],
      ['timeout', (c: any) => c.fn === 'recordTool' && c.phase === 'COMPLETED' && c.success === false && c.retryCount === 1],
      ['rate_limit', (c: any) => c.fn === 'recordBus' && c.success === false],
    ] as const) {
      const i = recordingInstr();
      const trace = await i.startTrace({ name: 'x', source: 'SIMULATED' });
      const summary = await emitSimulatedAgentActivity(i, { trace, parentSpan: trace.rootSpan, projectId, requestId: 'req_x', seed: 7, failure, forceFailure: true });
      expect(summary.failed).toBe(true);
      expect(i.calls.some(check as any)).toBe(true);
    }
    const i = recordingInstr();
    const trace = await i.startTrace({ name: 'x', source: 'SIMULATED' });
    const ok = await emitSimulatedAgentActivity(i, { trace, parentSpan: trace.rootSpan, projectId, requestId: 'req_x', seed: 7, failure: 'none' });
    expect(ok.failed).toBe(false);
    expect(ok).toMatchObject({ contextEvents: 4, memoryEvents: 2, busEvents: 2, toolCalls: 3 });
  });

  it('agent activity is deterministic for a seed', async () => {
    const run = async () => {
      const i = recordingInstr();
      const trace = await i.startTrace({ name: 'x', source: 'SIMULATED' });
      await emitSimulatedAgentActivity(i, { trace, parentSpan: trace.rootSpan, projectId, requestId: 'req_x', seed: 99, failure: 'none' });
      return i.calls.filter(c => c.fn === 'recordContext').map(c => [c.sizeBytes, c.version]);
    };
    expect(await run()).toEqual(await run());
  });
});
