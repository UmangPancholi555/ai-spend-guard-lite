import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';

let ctx: TestCtx;
const D = (s: string) => new Date(s);
let traceA: string;

beforeAll(async () => {
  ctx = await createTestApp();
  const i = ctx.deps.instr;
  const at = (s: string) => ({ at: D(s) } as object);
  traceA = 'a'.repeat(32);
  await i.recordMemory({ source: 'SIMULATED', phase: 'STARTED', memorySource: 'mem-alpha', category: 'c', itemCount: 1, estimatedTokens: 1, payloadBytes: 1, traceId: traceA, ...at('2026-02-01T10:00:00Z') });
  await i.recordMemory({ source: 'SIMULATED', phase: 'FAILED', memorySource: 'mem-alpha', category: 'c', itemCount: 1, estimatedTokens: 1, payloadBytes: 1, traceId: traceA, errorMessage: 'bad', ...at('2026-02-02T10:00:00Z') });
  await i.recordBus({ source: 'ACTUAL', operationName: 'budget.publish', operationType: 'PUBLISH', eventName: 'e', success: true, ...at('2026-02-03T10:00:00Z') });
  await i.recordTool({ source: 'SIMULATED', toolName: 'search.web', toolCallId: 'c1', startedAt: D('2026-02-04T09:59:59Z'), endedAt: D('2026-02-04T10:00:00Z'), success: true, traceId: traceA });
  await i.recordContext({ source: 'SIMULATED', contextId: 'ctx-zeta', operation: 'UPDATED', contextSource: 's', sizeBytes: 1, estimatedTokens: 1, version: 2, ...at('2026-02-05T10:00:00Z') });
  await i.recordError({ source: 'ACTUAL', category: 'DATABASE', operation: 'db.write', error: new Error('boom'), ...at('2026-02-06T10:00:00Z') });
  await i.recordActivity({ type: 'project.created', message: 'Project created', source: 'ACTUAL', ...at('2026-02-07T10:00:00Z') });
});
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const get = (q: string) => request(ctx.app).get(`/api/logs${q}`);

describe('GET /logs', () => {
  it('lists newest first with pagination envelope', async () => {
    const res = await get('?pageSize=3');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 1, pageSize: 3, total: 7, totalPages: 3 });
    const ts = res.body.data.map((l: any) => l.ts);
    expect(ts).toEqual([...ts].sort().reverse());
    expect(res.body.data[0].eventType).toBe('activity.project.created');
    const p3 = await get('?pageSize=3&page=3');
    expect(p3.body.data).toHaveLength(1);
  });

  it('filters by eventType (exact, list and prefix*)', async () => {
    expect((await get('?eventType=bus.operation')).body.data).toHaveLength(1);
    expect((await get('?eventType=bus.operation,error')).body.data).toHaveLength(2);
    const prefix = await get('?eventType=memory.injection.*');
    expect(prefix.body.data.map((l: any) => l.eventType).sort()).toEqual(['memory.injection.failed', 'memory.injection.started']);
  });

  it('filters by status, level, category, source, traceId', async () => {
    expect((await get('?status=FAILURE')).body.data.map((l: any) => l.eventType).sort()).toEqual(['error', 'memory.injection.failed']);
    expect((await get('?level=ERROR')).body.pagination.total).toBe(2);
    expect((await get('?category=TOOL')).body.data).toHaveLength(1);
    expect((await get('?source=ACTUAL')).body.pagination.total).toBe(3);
    expect((await get(`?traceId=${traceA}`)).body.pagination.total).toBe(3);
  });

  it('filters by date range with inclusive `to` and date-only to', async () => {
    const r = await get('?from=2026-02-02T00:00:00Z&to=2026-02-04T10:00:00Z');
    expect(r.body.data.map((l: any) => l.eventType).sort()).toEqual(['bus.operation', 'memory.injection.failed', 'tool.call.completed']);
    const dateOnly = await get('?from=2026-02-06&to=2026-02-06');
    expect(dateOnly.body.data.map((l: any) => l.eventType)).toEqual(['error']);
  });

  it('searches by operation name (case-insensitive substring)', async () => {
    expect((await get('?search=MEM-alpha')).body.pagination.total).toBe(2);
    expect((await get('?search=ctx-zeta')).body.data[0].eventType).toBe('context.updated');
    expect((await get('?search=search.web')).body.data[0].operation).toBe('search.web');
    expect((await get('?search=nothing-matches')).body.data).toHaveLength(0);
  });

  it('treats empty params as absent and rejects invalid ones with 400', async () => {
    expect((await get('?search=&status=')).body.pagination.total).toBe(7);
    expect((await get('?status=BOGUS')).status).toBe(400);
    expect((await get('?from=not-a-date')).status).toBe(400);
    expect((await get('?pageSize=500')).status).toBe(400);
  });

  it('GET /logs/:id returns the DTO or 404', async () => {
    const list = await get('?eventType=error');
    const id = list.body.data[0].id;
    const one = await request(ctx.app).get(`/api/logs/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ id, errorCategory: 'DATABASE', errorMessage: 'boom', source: 'ACTUAL' });
    expect(one.body.data.stack).toContain('boom');
    const missing = await request(ctx.app).get('/api/logs/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });
});
