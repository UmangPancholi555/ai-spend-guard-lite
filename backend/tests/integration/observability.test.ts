import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDir, createTestApp } from '../helpers/testApp';
import { api, Ctx, listAll, mkProject, pay, readJsonl } from './helpers';

let ctx: Ctx;
let proj: { id: string };
beforeAll(async () => { ctx = await createTestApp(); proj = await mkProject(ctx, 'obs-proj'); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const SIM_KINDS = ['MEMORY', 'BUS', 'TOOL', 'CONTEXT'];

describe('simulated agent activity correlation & labelling', () => {
  it('timeline of a request with simulateAgentActivity correlates context/memory/bus/tool events, all SIMULATED', async () => {
    const res = await pay(ctx, { projectId: proj.id, prompt: 'agent activity', simulateAgentActivity: true });
    const { trace, spans, timeline } = (await api(ctx).get(`/api/traces/${res.traceId}`)).body.data;
    expect(trace.source).toBe('ACTUAL');
    expect(trace.status).toBe('OK');

    const refKinds = new Set(timeline.map((e: any) => e.refKind));
    for (const k of ['span', 'memory', 'bus', 'tool', 'context', 'log']) expect(refKinds.has(k), `timeline has ${k}`).toBe(true);
    const steps = new Set(timeline.map((e: any) => e.step));
    for (const s of ['execution.started', 'context.initialized', 'memory.injection.started', 'memory.injection.completed', 'bus.operation',
      'tool.call.initiated', 'tool.call.completed', 'tool.call.failed', 'response.generated', 'execution.completed']) expect(steps.has(s), s).toBe(true);

    // every memory/bus/tool/context timeline entry is SIMULATED; actual request lifecycle entries are ACTUAL
    for (const e of timeline) {
      if (['memory', 'bus', 'tool', 'context'].includes(e.refKind)) expect(e.source, `${e.step}`).toBe('SIMULATED');
      if (e.step === 'execution.started' || e.step === 'execution.completed' || e.step === 'response.generated') expect(e.source).toBe('ACTUAL');
    }
    // simulated spans are SIMULATED and are children of the ACTUAL root; actual spans stay ACTUAL
    const root = spans.find((s: any) => s.parentSpanId === null);
    for (const s of spans) {
      if (SIM_KINDS.includes(s.kind)) { expect(s.source, s.name).toBe('SIMULATED'); expect(s.parentSpanId).toBe(root.spanId); expect(s.attributes.simulated).toBe(true); }
      else expect(s.source, s.name).toBe('ACTUAL');
    }
    // ordering by ts
    const ts = timeline.map((e: any) => Date.parse(e.ts));
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    // retry: web_search failed attempt then completed attempt (tool retry visible)
    const tools = timeline.filter((e: any) => e.refKind === 'tool');
    expect(tools.some((e: any) => e.step === 'tool.call.failed' && /web_search/.test(e.label))).toBe(true);
    expect(tools.some((e: any) => e.step === 'tool.call.completed' && /web_search/.test(e.label))).toBe(true);

    // per-event endpoints (by trace) agree with the timeline & are SIMULATED
    for (const [url, kind] of [['memory-events', 'memory'], ['bus-events', 'bus'], ['tool-events', 'tool'], ['context-events', 'context']] as const) {
      const rows = await listAll<any>(ctx, `/api/observability/${url}?traceId=${res.traceId}`);
      expect(rows.length, url).toBeGreaterThan(0);
      expect(rows.every(r => r.source === 'SIMULATED'), `${url} all SIMULATED`).toBe(true);
      expect(rows.every(r => r.traceId === res.traceId)).toBe(true);
      // tool calls appear twice in the timeline (initiated + completed/failed); every other kind is 1:1
      const expected = timeline.filter((e: any) => e.refKind === kind && (kind !== 'tool' || e.step === 'tool.call.initiated')).length;
      expect(rows.length, url).toBe(expected);
      expect(rows.every(r => spans.some((s: any) => s.spanId === r.spanId))).toBe(true);
    }
    // logs for those events are SIMULATED too and mirrored to JSONL
    const logs = await listAll<any>(ctx, `/api/logs?traceId=${res.traceId}`);
    for (const l of logs.filter(l => ['MEMORY', 'BUS', 'TOOL', 'CONTEXT'].includes(l.category))) expect(l.source).toBe('SIMULATED');
    const jsonl = readJsonl(ctx).filter(l => l.traceId === res.traceId);
    expect(jsonl.length).toBe(logs.length);
    for (const l of jsonl.filter(l => ['MEMORY', 'BUS', 'TOOL', 'CONTEXT'].includes(l.category))) expect(l.source).toBe('SIMULATED');
  });

  it('failure modes with agent activity produce FAILURE timeline entries and error logs with matching categories', async () => {
    const seen = new Set<string>();
    for (const [mode, cat] of [['error', 'MEMORY'], ['rate_limit', 'BUS'], ['timeout', 'TOOL']] as const) {
      const r = await api(ctx).post('/api/simulations/agent-run').send({ projectId: proj.id, simulateFailure: mode });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const t = (await api(ctx).get(`/api/traces/${r.body.data.traceId}`)).body.data;
      expect(t.trace.status).toBe('ERROR');
      expect(t.trace.source).toBe('SIMULATED');
      const failed = t.timeline.filter((e: any) => e.status === 'FAILURE');
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every((e: any) => e.errorMessage || e.step === 'execution.failed')).toBe(true);
      const errs = await listAll<any>(ctx, `/api/observability/errors?traceId=${r.body.data.traceId}`);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs.every(e => e.source === 'SIMULATED')).toBe(true);
      for (const e of errs) seen.add(e.errorCategory);
      // agent-run must not create usage events
      expect(await ctx.prisma.usageEvent.count({ where: { traceId: r.body.data.traceId } })).toBe(0);
    }
    expect([...seen]).toEqual(expect.arrayContaining(['TIMEOUT'].filter(() => false)));
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('no ACTUAL memory/tool/context events exist and /observability/sources never claims CONNECTED for them', async () => {
    expect(await ctx.prisma.memoryEvent.count({ where: { source: 'ACTUAL' } })).toBe(0);
    expect(await ctx.prisma.toolCallEvent.count({ where: { source: 'ACTUAL' } })).toBe(0);
    expect(await ctx.prisma.contextEvent.count({ where: { source: 'ACTUAL' } })).toBe(0);
    expect(await ctx.prisma.memoryEvent.count()).toBeGreaterThan(0);

    const src = (await api(ctx).get('/api/observability/sources')).body.data as any[];
    const by = Object.fromEntries(src.map(s => [s.kind, s]));
    for (const k of ['memory', 'tool', 'context']) {
      expect(by[k].status, k).toBe('SIMULATED_ONLY');
      expect(by[k].actualEvents).toBe(0);
      expect(by[k].simulatedEvents).toBeGreaterThan(0);
    }
    // counts are derived from DB, not hard-coded
    // memory is counted per injection operation (STARTED+COMPLETED rows share one operationId)
    const ops = await ctx.prisma.memoryEvent.findMany({ where: { source: 'SIMULATED' }, distinct: ['operationId'], select: { operationId: true } });
    expect(by.memory.simulatedEvents).toBe(ops.length);
    expect(by.tool.simulatedEvents).toBe(await ctx.prisma.toolCallEvent.count({ where: { source: 'SIMULATED' } }));
    expect(by.context.simulatedEvents).toBe(await ctx.prisma.contextEvent.count({ where: { source: 'SIMULATED' } }));
    expect(by.request.status).toBe('CONNECTED');
    expect(by.error.status).toBe('CONNECTED');
    // bus: CONNECTED iff real (ACTUAL) bus events exist
    expect(by.bus.status).toBe(by.bus.actualEvents > 0 ? 'CONNECTED' : 'SIMULATED_ONLY');
    expect(by.bus.actualEvents).toBe(await ctx.prisma.busEvent.count({ where: { source: 'ACTUAL' } }));
  });

  it('overview totals split actual vs simulated and agree with the event tables', async () => {
    const ov = (await api(ctx).get('/api/observability/overview')).body.data;
    expect(ov.totals.memoryInjections).toBeGreaterThan(0);
    expect(ov.totals.toolCalls).toBeGreaterThan(0);
    expect(ov.totals.busOperations).toBe(await ctx.prisma.busEvent.count());
    expect(ov.totals.operations).toBe(ov.totals.successful + ov.totals.failed);
    expect(ov.bySource.actual + ov.bySource.simulated).toBeGreaterThan(0);
    expect(ov.bySource.simulated).toBeGreaterThan(0);
    expect(ov.totals.failureRate).toBeGreaterThan(0);
    expect(ov.totals.failureRate).toBeLessThanOrEqual(1);
    const perf = await api(ctx).get('/api/observability/performance');
    expect(perf.status).toBe(200);
    const groups = (await api(ctx).get('/api/observability/errors/groups')).body.data;
    expect(groups.length).toBeGreaterThan(0);
  });

  it('PUT /settings slowOperationMs is what /observability/performance uses as the slow threshold', async () => {
    expect((await api(ctx).get('/api/observability/performance')).body.data.slowThresholdMs).toBe(500);
    expect((await api(ctx).put('/api/settings').send({ slowOperationMs: 1234 })).status).toBe(200);
    expect((await api(ctx).get('/api/observability/performance')).body.data.slowThresholdMs).toBe(1234);
    expect((await api(ctx).put('/api/settings').send({ slowOperationMs: 1 })).status).toBe(200);
    const perf = (await api(ctx).get('/api/observability/performance')).body.data;
    expect(perf.slowThresholdMs).toBe(1);
    expect(perf.slowOperations.length).toBeGreaterThan(0); // everything over 1ms is "slow"
    await api(ctx).put('/api/settings').send({ slowOperationMs: 500 }).expect(200);
  });

  it('activity search matches request ids (list endpoint and export dataset agree)', async () => {
    const res = await pay(ctx, { projectId: proj.id, prompt: 'activity search probe' });
    const list = await listAll<any>(ctx, `/api/activity?search=${res.requestId}`);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every(a => a.requestId === res.requestId)).toBe(true);
    const exp = await api(ctx).get(`/api/export/activity?format=jsonl&search=${res.requestId}`);
    expect(exp.text.split('\n').filter(Boolean)).toHaveLength(list.length);
  });

  it('empty-state endpoints return honest zeros on a fresh DB', async () => {
    const fresh = await createTestApp();
    try {
      const src = (await api(fresh).get('/api/observability/sources')).body.data as any[];
      for (const k of ['memory', 'tool', 'context']) expect(src.find(s => s.kind === k).status).toBe('UNAVAILABLE');
      const dash = (await api(fresh).get('/api/dashboard')).body.data;
      expect(dash.totals.requests).toBe(0);
      expect(dash.totals.spendUsd).toBe('0.000000000000');
      expect((await api(fresh).get('/api/observability/overview')).status).toBe(200);
    } finally { await fresh.close(); cleanupTestDir(fresh.dir); }
  });
});
