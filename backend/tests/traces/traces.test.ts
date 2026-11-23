import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeHarness, seed, T, type Harness } from '../observability/helpers';

const B = Date.parse('2025-03-10T12:00:00.000Z');
const at = (offsetMs: number) => new Date(B + offsetMs);
type Entry = { ts: string; step: string; status: string; source: string; refKind: string; refId: string | null; errorMessage: string | null; durationMs: number | null; spanId: string | null; label: string; details: Record<string, unknown> };

describe('traces API', () => {
  let h: Harness;
  let projId: string;
  let failedTraceId: string, okTraceId: string, runningTraceId: string;
  const spans: Record<string, string> = {};

  beforeAll(async () => {
    h = await makeHarness();
    const p = h.prisma;
    projId = (await seed.project(p, 'Agents')).id;

    // ---- failed SIMULATED agent run with every event type ----
    const t = await seed.trace(p, { name: 'agent.run', status: 'ERROR', source: 'SIMULATED', projectId: projId, requestId: 'req_fail', startedAt: at(0), endedAt: at(2000), durationMs: 2000, errorMessage: 'tool exploded' });
    failedTraceId = t.traceId;
    const mk = async (key: string, o: Parameters<typeof seed.span>[2]) => { spans[key] = (await seed.span(p, failedTraceId, o)).spanId; return spans[key]; };
    await mk('root', { name: 'agent.run', kind: 'REQUEST', startedAt: at(0), endedAt: at(2000), durationMs: 2000, status: 'ERROR', source: 'SIMULATED', errorMessage: 'tool exploded' });
    const base = { parentSpanId: spans.root, source: 'SIMULATED' };
    await mk('ctx', { ...base, name: 'context.init', kind: 'CONTEXT', startedAt: at(100), endedAt: at(110), durationMs: 10 });
    await mk('mem', { ...base, name: 'memory.inject', kind: 'MEMORY', startedAt: at(200), endedAt: at(400), durationMs: 200 });
    await mk('orphanMem', { ...base, name: 'memory.lookup', kind: 'MEMORY', startedAt: at(250), endedAt: at(260), durationMs: 10 });
    await mk('bus', { ...base, name: 'bus.publish', kind: 'BUS', startedAt: at(500), endedAt: at(520), durationMs: 20, source: 'ACTUAL' });
    await mk('toolA', { ...base, name: 'tool.search', kind: 'TOOL', startedAt: at(600), endedAt: at(1100), durationMs: 500, status: 'ERROR', errorMessage: 'tool exploded' });
    await mk('toolB', { ...base, name: 'tool.search', kind: 'TOOL', startedAt: at(1200), endedAt: at(1700), durationMs: 500 });
    await mk('cost', { ...base, name: 'cost.calculate', kind: 'COST', startedAt: at(1750), endedAt: at(1755), durationMs: 5, source: 'ACTUAL' });
    await mk('prov', { ...base, name: 'provider.mock', kind: 'PROVIDER', startedAt: at(1300), endedAt: at(1800), durationMs: 500 });

    await seed.context(p, { traceId: failedTraceId, spanId: spans.ctx, createdAt: at(100), operation: 'CREATED', contextSource: 'agent-ctx' });
    const op = 'mop_x1';
    await seed.memory(p, { traceId: failedTraceId, spanId: spans.mem, createdAt: at(200), operationId: op, phase: 'STARTED', status: 'STARTED' });
    await seed.memory(p, { traceId: failedTraceId, spanId: spans.mem, createdAt: at(400), operationId: op, phase: 'COMPLETED', status: 'SUCCESS', durationMs: 200, itemCount: 4, estimatedTokens: 99 });
    await seed.bus(p, { traceId: failedTraceId, spanId: spans.bus, createdAt: at(500), durationMs: 20, source: 'ACTUAL' });
    await seed.tool(p, { traceId: failedTraceId, spanId: spans.toolA, toolCallId: 'call-A', startedAt: at(600), endedAt: at(1100), durationMs: 500, status: 'FAILURE', errorMessage: 'tool exploded', maxRetries: 2 });
    await seed.tool(p, { traceId: failedTraceId, spanId: spans.toolB, toolCallId: 'call-B', startedAt: at(1200), endedAt: at(1700), durationMs: 500, retryCount: 1, maxRetries: 2 });

    // mirror logs (all must be deduped) + 1 unrelated log (must stay)
    const L = (o: Parameters<typeof seed.log>[1]) => seed.log(p, { traceId: failedTraceId, source: 'SIMULATED', ...o });
    await L({ ts: at(0), eventType: 'request.started', category: 'REQUEST', status: 'STARTED' });
    await L({ ts: at(100), eventType: 'context.updated', category: 'CONTEXT', spanId: spans.ctx, attributes: JSON.stringify({ contextId: (await p.contextEvent.findFirstOrThrow({ where: { traceId: failedTraceId } })).contextId }) });
    await L({ ts: at(200), eventType: 'memory.injection.started', category: 'MEMORY', status: 'STARTED', attributes: JSON.stringify({ operationId: op }) });
    await L({ ts: at(400), eventType: 'memory.injection.completed', category: 'MEMORY', spanId: spans.mem }); // no key -> span fallback
    await L({ ts: at(500), eventType: 'bus.operation', category: 'BUS', spanId: spans.bus, source: 'ACTUAL' });
    await L({ ts: at(600), eventType: 'tool.call.initiated', category: 'TOOL', status: 'STARTED', attributes: JSON.stringify({ toolCallId: 'call-A' }) });
    await L({ ts: at(1100), eventType: 'tool.call.failed', category: 'TOOL', status: 'FAILURE', level: 'ERROR', errorMessage: 'tool exploded', attributes: JSON.stringify({ toolCallId: 'call-A' }) });
    await L({ ts: at(1101), eventType: 'error', category: 'ERROR', status: 'FAILURE', level: 'ERROR', spanId: spans.toolA, errorMessage: 'tool exploded', errorCategory: 'TOOL' });
    await L({ ts: at(1700), eventType: 'tool.call.completed', category: 'TOOL', attributes: JSON.stringify({ toolCallId: 'call-B' }) });
    await L({ ts: at(1760), eventType: 'budget.evaluated', category: 'BUDGET', operation: 'budget.evaluate', message: 'Budgets evaluated', source: 'ACTUAL' });
    await L({ ts: at(2000), eventType: 'request.failed', category: 'REQUEST', status: 'FAILURE', level: 'ERROR', errorMessage: 'tool exploded' });

    // ---- OK ACTUAL trace + RUNNING trace ----
    const ok = await seed.trace(p, { name: 'provider.request', source: 'ACTUAL', projectId: projId, requestId: 'req_ok', startedAt: at(-86_400_000), endedAt: at(-86_400_000 + 300), durationMs: 300 });
    okTraceId = ok.traceId;
    await seed.span(p, okTraceId, { name: 'provider.request', kind: 'REQUEST', startedAt: at(-86_400_000), endedAt: at(-86_400_000 + 300), durationMs: 300 });
    const run = await seed.trace(p, { name: 'long.job', status: 'RUNNING', source: 'SIMULATED', startedAt: at(-2 * 86_400_000) });
    runningTraceId = run.traceId;
    await seed.task(p, { name: 'seed', kind: 'DEMO_SEED', source: 'SIMULATED', status: 'SUCCEEDED', createdAt: at(-1000), result: JSON.stringify({ created: 5 }) });
    await seed.task(p, { name: 'retention', kind: 'RETENTION_SWEEP', status: 'FAILED', errorMessage: 'disk', createdAt: at(-2000) });
    await seed.task(p, { name: 'budget', kind: 'BUDGET_EVALUATION', status: 'RUNNING', createdAt: at(-3000) });
  });
  afterAll(async () => { await h.close(); });

  const get = (u: string) => request(h.app).get(`/api${u}`);

  describe('GET /traces', () => {
    it('lists newest first with spanCount', async () => {
      const res = await get('/traces');
      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(3);
      expect(res.body.data.map((t: { traceId: string }) => t.traceId)).toEqual([failedTraceId, okTraceId, runningTraceId]);
      const failed = res.body.data[0];
      expect(failed.spanCount).toBe(9);
      expect(failed).toMatchObject({ name: 'agent.run', status: 'ERROR', source: 'SIMULATED', requestId: 'req_fail', projectId: projId, durationMs: 2000, errorMessage: 'tool exploded' });
      expect(res.body.data[1].spanCount).toBe(1);
      expect(res.body.data[2]).toMatchObject({ spanCount: 0, endedAt: null, durationMs: null });
    });
    it('filters by status, source, projectId', async () => {
      expect((await get('/traces?status=ERROR')).body.data).toHaveLength(1);
      expect((await get('/traces?status=RUNNING')).body.data[0].traceId).toBe(runningTraceId);
      expect((await get('/traces?source=ACTUAL')).body.data.map((t: { traceId: string }) => t.traceId)).toEqual([okTraceId]);
      expect((await get(`/traces?projectId=${projId}`)).body.pagination.total).toBe(2);
    });
    it('search matches name, traceId and requestId', async () => {
      expect((await get('/traces?search=provider.req')).body.data.map((t: { traceId: string }) => t.traceId)).toEqual([okTraceId]);
      expect((await get(`/traces?search=${failedTraceId.slice(0, 12)}`)).body.data.map((t: { traceId: string }) => t.traceId)).toEqual([failedTraceId]);
      expect((await get('/traces?search=req_ok')).body.data).toHaveLength(1);
      expect((await get('/traces?search=zzzz')).body.data).toHaveLength(0);
    });
    it('date range on startedAt is inclusive and paginates', async () => {
      expect((await get(`/traces?from=${at(0).toISOString()}&to=${at(0).toISOString()}`)).body.data.map((t: { traceId: string }) => t.traceId)).toEqual([failedTraceId]);
      expect((await get('/traces?to=2025-03-09')).body.pagination.total).toBe(2); // whole day 03-09 incl. OK trace
      const p = await get('/traces?pageSize=2&page=2');
      expect(p.body.data).toHaveLength(1);
      expect(p.body.pagination).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    });
    it('rejects invalid input with 400', async () => {
      for (const qs of ['?status=DONE', '?source=x', '?pageSize=0', '?from=bad']) {
        const res = await get(`/traces${qs}`);
        expect(res.status, qs).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('GET /traces/:traceId', () => {
    let detail: { trace: Record<string, unknown>; spans: { spanId: string; parentSpanId: string | null }[]; timeline: Entry[] };
    beforeAll(async () => { detail = (await get(`/traces/${failedTraceId}`)).body.data; });

    it('returns trace, flat spans with parentSpanId', () => {
      expect(detail.trace.traceId).toBe(failedTraceId);
      expect(detail.trace.spanCount).toBe(9);
      expect(detail.spans).toHaveLength(9);
      expect(detail.spans.filter(s => s.parentSpanId === null)).toHaveLength(1);
      expect(detail.spans.filter(s => s.parentSpanId === spans.root)).toHaveLength(8);
    });

    it('timeline has the expected steps in chronological order (deduped)', () => {
      expect(detail.timeline.map(e => `${e.ts.slice(17, 23)} ${e.step}`)).toEqual([
        '00.000 execution.started',
        '00.100 context.initialized',
        '00.200 memory.injection.started',
        '00.250 span', // orphan MEMORY span with no typed event stays visible
        '00.400 memory.injection.completed',
        '00.500 bus.operation',
        '00.600 tool.call.initiated',
        '01.100 tool.call.failed',
        '01.200 tool.call.initiated',
        '01.700 tool.call.completed',
        '01.750 span', // cost.calculate
        '01.760 other', // budget log is kept
        '01.800 response.generated',
        '02.000 execution.failed',
      ]);
      const ts = detail.timeline.map(e => Date.parse(e.ts));
      expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    });

    it('does not duplicate spans that are merged into typed events nor mirror logs', () => {
      const spanRows = detail.timeline.filter(e => e.refKind === 'span' && e.step === 'span').map(e => e.spanId);
      expect(spanRows.sort()).toEqual([spans.orphanMem, spans.cost].sort());
      expect(detail.timeline.filter(e => e.refKind === 'log').map(e => e.details.eventType)).toEqual(['budget.evaluated']);
      // merged span info enriches the typed entry
      const memDone = detail.timeline.find(e => e.step === 'memory.injection.completed')!;
      expect(memDone.details).toMatchObject({ spanName: 'memory.inject', spanKind: 'MEMORY', itemCount: 4, estimatedTokens: 99 });
      expect(memDone.durationMs).toBe(200);
      expect(memDone.refKind).toBe('memory');
    });

    it('highlights failures with FAILURE status + errorMessage and labels sources', () => {
      const failed = detail.timeline.filter(e => e.status === 'FAILURE');
      expect(failed.map(e => e.step).sort()).toEqual(['execution.failed', 'tool.call.failed']);
      for (const f of failed) expect(f.errorMessage).toBe('tool exploded');
      const toolFail = detail.timeline.find(e => e.step === 'tool.call.failed')!;
      expect(toolFail.label).toContain('attempt 1/3');
      expect(toolFail.durationMs).toBe(500);
      expect(detail.timeline.find(e => e.step === 'bus.operation')!.source).toBe('ACTUAL');
      expect(detail.timeline.find(e => e.step === 'memory.injection.completed')!.source).toBe('SIMULATED');
      expect(detail.timeline.find(e => e.step === 'span' && e.details.name === 'cost.calculate')!.source).toBe('ACTUAL');
      for (const e of detail.timeline) expect(['ACTUAL', 'SIMULATED']).toContain(e.source);
      // non-failures never carry an error message
      expect(detail.timeline.filter(e => e.status !== 'FAILURE').every(e => e.errorMessage === null)).toBe(true);
    });

    it('retry call B is a second tool row with its own attempt label', () => {
      const completed = detail.timeline.find(e => e.step === 'tool.call.completed')!;
      expect(completed.label).toContain('attempt 2/3');
      expect(completed.details).toMatchObject({ toolCallId: 'call-B', retryCount: 1 });
    });

    it('OK trace -> execution.completed SUCCESS; RUNNING trace has no end entry', async () => {
      const ok = (await get(`/traces/${okTraceId}`)).body.data;
      expect(ok.timeline.map((e: Entry) => e.step)).toEqual(['execution.started', 'execution.completed']);
      expect(ok.timeline[1]).toMatchObject({ status: 'SUCCESS', durationMs: 300, source: 'ACTUAL' });
      const run = (await get(`/traces/${runningTraceId}`)).body.data;
      expect(run.timeline.map((e: Entry) => e.step)).toEqual(['execution.started']);
      expect(run.spans).toEqual([]);
    });

    it('404 for unknown traceId', async () => {
      const res = await get('/traces/doesnotexist');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /background-tasks', () => {
    it('lists newest first with parsed result', async () => {
      const res = await get('/background-tasks');
      expect(res.status).toBe(200);
      expect(res.body.data.map((t: { name: string }) => t.name)).toEqual(['seed', 'retention', 'budget']);
      expect(res.body.data[0].result).toEqual({ created: 5 });
      expect(res.body.pagination.total).toBe(3);
    });
    it('filters by status/kind/source and paginates', async () => {
      expect((await get('/background-tasks?status=FAILED')).body.data.map((t: { name: string }) => t.name)).toEqual(['retention']);
      expect((await get('/background-tasks?kind=DEMO_SEED')).body.data).toHaveLength(1);
      expect((await get('/background-tasks?source=SIMULATED')).body.data).toHaveLength(1);
      const p = await get('/background-tasks?pageSize=2&page=2');
      expect(p.body.data).toHaveLength(1);
      expect(p.body.pagination.totalPages).toBe(2);
    });
    it('validates', async () => {
      expect((await get('/background-tasks?status=NOPE')).status).toBe(400);
      expect((await get('/background-tasks?kind=NOPE')).body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

describe('traces API on empty DB', () => {
  let h: Harness;
  beforeAll(async () => { h = await makeHarness(); });
  afterAll(async () => { await h.close(); });
  it('returns empty lists', async () => {
    expect((await request(h.app).get('/api/traces')).body).toEqual({ data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } });
    expect((await request(h.app).get('/api/background-tasks')).body.data).toEqual([]);
  });
});
