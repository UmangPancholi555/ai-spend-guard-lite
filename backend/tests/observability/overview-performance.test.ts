import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeHarness, seed, T, type Harness } from './helpers';

describe('GET /api/observability/overview', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    const p = h.prisma;
    const ts = (d: number) => T(`2025-05-${String(d).padStart(2, '0')}T12:00:00Z`);
    await seed.log(p, { ts: ts(1), status: 'SUCCESS', source: 'ACTUAL', durationMs: 100 });
    await seed.log(p, { ts: ts(2), status: 'SUCCESS', source: 'ACTUAL', durationMs: 200 });
    await seed.log(p, { ts: ts(3), status: 'SUCCESS', source: 'ACTUAL', durationMs: 300 });
    await seed.log(p, { ts: ts(4), status: 'FAILURE', level: 'ERROR', source: 'SIMULATED', durationMs: 400, message: 'boom' });
    await seed.log(p, { ts: ts(5), status: 'SUCCESS', source: 'SIMULATED' }); // no duration
    await seed.log(p, { ts: ts(6), status: 'STARTED', source: 'ACTUAL', durationMs: 50 }); // not an operation
    await seed.log(p, { ts: ts(7), status: 'INFO', level: 'ERROR', message: 'error-level info' }); // not an operation, but an error row
    await seed.log(p, { ts: T('2025-06-05T00:00:00Z'), status: 'SUCCESS', durationMs: 9999 }); // outside range
    await seed.memory(p, { createdAt: ts(1), phase: 'STARTED', status: 'STARTED' });
    await seed.memory(p, { createdAt: ts(1), phase: 'COMPLETED' });
    await seed.memory(p, { createdAt: ts(2), phase: 'FAILED', status: 'FAILURE' });
    await seed.memory(p, { createdAt: T('2025-06-05T00:00:00Z'), phase: 'COMPLETED' });
    await seed.bus(p, { createdAt: ts(1) }); await seed.bus(p, { createdAt: ts(2), status: 'FAILURE' }); await seed.bus(p, { createdAt: T('2025-06-05T00:00:00Z') });
    for (let i = 0; i < 3; i++) await seed.tool(p, { startedAt: ts(3), createdAt: ts(3) });
    for (const op of ['CREATED', 'UPDATED', 'ADDED', 'MODIFIED']) await seed.context(p, { createdAt: ts(4), operation: op });
    for (let i = 1; i <= 12; i++) await seed.trace(p, { startedAt: new Date(Date.parse('2025-05-10T00:00:00Z') + i * 60_000), name: `t${i}` });
    const t = await p.trace.findFirstOrThrow({ where: { name: 't12' } });
    await seed.span(p, t.traceId, { startedAt: T('2025-05-10T00:12:00Z') });
  });
  afterAll(async () => { await h.close(); });

  const get = (qs: string) => request(h.app).get(`/api/observability/overview${qs}`);
  const RANGE = '?from=2025-05-01&to=2025-05-31';

  it('counts operations = ExecutionLog SUCCESS|FAILURE rows only, with source split, average and failure rate', async () => {
    const { body, status } = await get(RANGE);
    expect(status).toBe(200);
    expect(body.data.range).toEqual({ from: '2025-05-01T00:00:00.000Z', to: '2025-05-31T23:59:59.999Z' });
    expect(body.data.totals).toEqual({
      operations: 5, successful: 4, failed: 1, memoryInjections: 2, busOperations: 2, toolCalls: 3, contextUpdates: 4,
      averageDurationMs: 250, failureRate: 0.2,
    });
    expect(body.data.bySource).toEqual({ actual: 3, simulated: 2 });
  });

  it('recentErrors = level ERROR or status FAILURE, newest first; recentTraces capped at 10 with spanCount', async () => {
    const { body } = await get(RANGE);
    expect(body.data.recentErrors.map((e: { message: string }) => e.message)).toEqual(['error-level info', 'boom']);
    expect(body.data.recentTraces).toHaveLength(10);
    expect(body.data.recentTraces[0]).toMatchObject({ name: 't12', spanCount: 1 });
    expect(body.data.recentTraces[1].name).toBe('t11');
  });

  it('range filter is respected (to inclusive, from/to both ISO) and rejects bad ranges', async () => {
    const june = await get('?from=2025-06-05T00:00:00Z&to=2025-06-05T00:00:00Z');
    expect(june.body.data.totals.operations).toBe(1);
    expect(june.body.data.totals.averageDurationMs).toBe(9999);
    expect((await get('?from=2025-06-01&to=2025-05-01')).status).toBe(400);
    const bad = await get('?from=yesterday');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('defaults to the last 7 days', async () => {
    const now = Date.now();
    await seed.log(h.prisma, { ts: new Date(now - 3600_000), status: 'SUCCESS', durationMs: 10, operation: 'recent-op' });
    await seed.log(h.prisma, { ts: new Date(now - 10 * 86_400_000), status: 'SUCCESS', durationMs: 10, operation: 'old-op' });
    const { body } = await get('');
    expect(body.data.totals.operations).toBe(1);
    const span = Date.parse(body.data.range.to) - Date.parse(body.data.range.from);
    expect(span).toBe(7 * 86_400_000);
  });
});

describe('GET /api/observability/performance', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    const p = h.prisma;
    // 20 REQUEST ops, durations 10..200; 10 on day 1, 10 on day 2; the 200ms one failed
    for (let i = 1; i <= 20; i++) {
      await seed.log(p, {
        ts: T(i <= 10 ? '2025-04-01T10:15:00Z' : '2025-04-02T09:00:00Z'), category: 'REQUEST', operation: 'GET /api/x', durationMs: i * 10,
        status: i === 20 ? 'FAILURE' : 'SUCCESS',
      });
    }
    await seed.log(p, { ts: T('2025-04-02T11:00:00Z'), category: 'TOOL', operation: 'tool.search', durationMs: 600 });
    await seed.log(p, { ts: T('2025-04-02T11:30:00Z'), category: 'TOOL', operation: 'tool.search', durationMs: 500, status: 'FAILURE' });
    await seed.log(p, { ts: T('2025-04-02T12:00:00Z'), category: 'TOOL', operation: 'tool.search', durationMs: 9999, status: 'STARTED' }); // ignored
    await seed.log(p, { ts: T('2025-04-02T12:00:00Z'), category: 'SYSTEM', operation: 'no-duration' }); // counted, no duration
    for (const d of [100, 200, 300, 400]) await seed.tool(p, { startedAt: T('2025-04-02T00:00:00Z'), createdAt: T('2025-04-02T00:00:00Z'), durationMs: d });
    await seed.tool(p, { startedAt: T('2025-04-02T00:00:00Z'), createdAt: T('2025-04-02T00:00:00Z') }); // no duration -> excluded
    await seed.memory(p, { createdAt: T('2025-04-02T00:00:00Z'), phase: 'COMPLETED', durationMs: 50 });
    await seed.memory(p, { createdAt: T('2025-04-02T00:00:00Z'), phase: 'FAILED', status: 'FAILURE', durationMs: 150 });
    await seed.memory(p, { createdAt: T('2025-04-02T00:00:00Z'), phase: 'STARTED', status: 'STARTED', durationMs: 999 }); // excluded
    await seed.trace(p, { startedAt: T('2025-04-01T00:00:00Z'), durationMs: 1000, endedAt: T('2025-04-01T00:00:01Z') });
    await seed.trace(p, { startedAt: T('2025-04-02T00:00:00Z'), durationMs: 3000, endedAt: T('2025-04-02T00:00:03Z') });
    await seed.trace(p, { startedAt: T('2025-04-02T00:00:00Z'), status: 'RUNNING' }); // excluded
    await seed.trace(p, { startedAt: T('2025-03-01T00:00:00Z'), durationMs: 99999 }); // out of range
  });
  afterAll(async () => { await h.close(); });

  const get = (qs: string) => request(h.app).get(`/api/observability/performance${qs}`);
  const RANGE = 'from=2025-04-01&to=2025-04-03';

  it('computes avg/p95 per latency family from raw rows', async () => {
    const { body, status } = await get(`?${RANGE}&bucket=day`);
    expect(status).toBe(200);
    const d = body.data;
    expect(d.requestLatency).toEqual({ avgMs: 105, p95Ms: 190, count: 20 }); // nearest-rank p95 of 10..200
    expect(d.toolLatency).toEqual({ avgMs: 250, p95Ms: 400, count: 4 });
    expect(d.memoryInjectionLatency).toEqual({ avgMs: 100, p95Ms: 150, count: 2 });
    expect(d.averageExecutionMs).toBe(2000);
    expect(d.failureRate).toBe(0.087); // 2 failures / 23 operations (STARTED row excluded)
  });

  it('reports operation counts per category and per-operation stats', async () => {
    const d = (await get(`?${RANGE}&bucket=day`)).body.data;
    expect(d.operationCounts).toEqual([
      { category: 'REQUEST', count: 20, failures: 1 }, { category: 'TOOL', count: 2, failures: 1 }, { category: 'SYSTEM', count: 1, failures: 0 },
    ]);
    expect(d.operations[0]).toEqual({ operation: 'GET /api/x', category: 'REQUEST', count: 20, failures: 1, avgMs: 105, p95Ms: 190, maxMs: 200 });
    expect(d.operations.find((o: { operation: string }) => o.operation === 'tool.search')).toEqual({ operation: 'tool.search', category: 'TOOL', count: 2, failures: 1, avgMs: 550, p95Ms: 600, maxMs: 600 });
    expect(d.operations.find((o: { operation: string }) => o.operation === 'no-duration')).toMatchObject({ count: 1, avgMs: 0, p95Ms: 0, maxMs: 0 });
  });

  it('slow operations use default 500ms threshold (strictly greater) then AppSetting slowOperationMs', async () => {
    let d = (await get(`?${RANGE}`)).body.data;
    expect(d.slowThresholdMs).toBe(500);
    expect(d.slowOperations.map((o: { durationMs: number }) => o.durationMs)).toEqual([600]); // exactly 500 is NOT slow; STARTED 9999 ignored
    await h.prisma.appSetting.upsert({
      where: { key: 'settings' }, create: { key: 'settings', value: JSON.stringify({ retentionDays: 30, slowOperationMs: 150, captureContentPlaintext: false }) },
      update: { value: JSON.stringify({ retentionDays: 30, slowOperationMs: 150, captureContentPlaintext: false }) },
    });
    d = (await get(`?${RANGE}`)).body.data;
    expect(d.slowThresholdMs).toBe(150);
    expect(d.slowOperations.map((o: { durationMs: number }) => o.durationMs)).toEqual([600, 500, 200, 190, 180, 170, 160]);
    expect(d.slowOperations[0]).toMatchObject({ operation: 'tool.search', category: 'TOOL' });
    // corrupt setting falls back to default
    await h.prisma.appSetting.update({ where: { key: 'settings' }, data: { value: '{not json' } });
    expect((await get(`?${RANGE}`)).body.data.slowThresholdMs).toBe(500);
  });

  it('builds a zero-filled day series and an hour series', async () => {
    const day = (await get(`?${RANGE}&bucket=day`)).body.data.durationSeries;
    expect(day).toEqual([
      { bucket: '2025-04-01T00:00:00.000Z', avgMs: 55, count: 10 },
      { bucket: '2025-04-02T00:00:00.000Z', avgMs: 220.83, count: 12 }, // (110..200 = 1550, +600 +500) / 12
      { bucket: '2025-04-03T00:00:00.000Z', avgMs: 0, count: 0 },
    ]);
    const hour = (await get('?from=2025-04-01T00:00:00Z&to=2025-04-01T12:00:00Z&bucket=hour')).body.data.durationSeries;
    expect(hour).toHaveLength(13);
    expect(hour[10]).toEqual({ bucket: '2025-04-01T10:00:00.000Z', avgMs: 55, count: 10 });
    expect(hour.filter((b: { count: number }) => b.count > 0)).toHaveLength(1);
    // default bucket: hour for a <=48h window, day otherwise
    expect((await get('?from=2025-04-01T00:00:00Z&to=2025-04-01T05:00:00Z')).body.data.durationSeries).toHaveLength(6);
    expect((await get(`?${RANGE}`)).body.data.durationSeries).toHaveLength(3);
  });

  it('validates bucket and range', async () => {
    for (const qs of ['?bucket=week', '?from=nope', '?from=2025-05-01&to=2025-04-01']) {
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
