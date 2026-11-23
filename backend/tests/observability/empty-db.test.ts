import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeHarness, type Harness } from './helpers';

function assertFinite(v: unknown, path = '$'): void {
  if (typeof v === 'number') expect(Number.isFinite(v), `${path} is not finite`).toBe(true);
  else if (Array.isArray(v)) v.forEach((x, i) => assertFinite(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertFinite(x, `${path}.${k}`);
}

describe('observability on an empty database', () => {
  let h: Harness;
  beforeAll(async () => { h = await makeHarness(); });
  afterAll(async () => { await h.close(); });
  const get = (u: string) => request(h.app).get(`/api/observability/${u}`);

  it('overview returns zeros, no NaN, empty lists', async () => {
    const { body, status } = await get('overview');
    expect(status).toBe(200);
    expect(body.data.totals).toEqual({ operations: 0, successful: 0, failed: 0, memoryInjections: 0, busOperations: 0, toolCalls: 0, contextUpdates: 0, averageDurationMs: 0, failureRate: 0 });
    expect(body.data.bySource).toEqual({ actual: 0, simulated: 0 });
    expect(body.data.recentErrors).toEqual([]);
    expect(body.data.recentTraces).toEqual([]);
    assertFinite(body.data);
  });

  it('performance returns zeros, default threshold and a zero-filled series', async () => {
    const { body, status } = await get('performance');
    expect(status).toBe(200);
    const d = body.data;
    expect(d.slowThresholdMs).toBe(500);
    expect(d.averageExecutionMs).toBe(0);
    for (const k of ['requestLatency', 'toolLatency', 'memoryInjectionLatency']) expect(d[k]).toEqual({ avgMs: 0, p95Ms: 0, count: 0 });
    expect(d.failureRate).toBe(0);
    expect([d.operationCounts, d.operations, d.slowOperations]).toEqual([[], [], []]);
    expect(d.durationSeries).toHaveLength(8); // 7 days -> day buckets, spanning 8 UTC dates
    expect(d.durationSeries.every((b: { count: number; avgMs: number }) => b.count === 0 && b.avgMs === 0)).toBe(true);
    assertFinite(d);
  });

  it('errors, groups and event lists are empty', async () => {
    expect((await get('errors')).body).toEqual({ data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } });
    expect((await get('errors/groups')).body).toEqual({ data: [] });
    for (const l of ['memory-events', 'bus-events', 'tool-events', 'context-events']) {
      expect((await get(l)).body, l).toEqual({ data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } });
    }
  });
});
