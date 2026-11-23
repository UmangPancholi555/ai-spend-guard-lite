import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeHarness, seed, T, type Harness } from './helpers';

describe('observability errors', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    const p = h.prisma;
    const L = (o: Parameters<typeof seed.log>[1]) => seed.log(p, { status: 'FAILURE', level: 'ERROR', ...o });
    await L({ ts: T('2025-06-01T10:00:00Z'), errorCategory: 'PROVIDER', errorMessage: 'Provider 500 upstream', message: 'provider failed', operation: 'provider.mock', traceId: 'tr-a', source: 'ACTUAL' });
    await L({ ts: T('2025-06-02T10:00:00Z'), errorCategory: 'TOOL', errorMessage: 'Tool timeout', message: 'tool failed', operation: 'tool.search', traceId: 'tr-b', source: 'SIMULATED' });
    await L({ ts: T('2025-06-03T10:00:00Z'), errorCategory: 'TOOL', errorMessage: 'Tool crashed', message: 'tool failed again', operation: 'tool.search', traceId: 'tr-b', source: 'SIMULATED' });
    await L({ ts: T('2025-06-04T10:00:00Z'), errorCategory: null, errorMessage: 'no category', message: 'weird', operation: 'x' });
    await L({ ts: T('2025-06-05T10:00:00Z'), errorCategory: 'UNKNOWN', errorMessage: 'explicit unknown', message: 'weird2', operation: 'y', status: 'INFO' }); // level ERROR only
    await seed.log(h.prisma, { ts: T('2025-06-06T10:00:00Z'), status: 'SUCCESS', level: 'INFO', message: 'fine' }); // not an error
    await seed.log(h.prisma, { ts: T('2025-06-07T10:00:00Z'), status: 'FAILURE', level: 'WARN', errorCategory: 'DATABASE', message: 'warn-level failure', operation: 'db' }); // FAILURE only
  });
  afterAll(async () => { await h.close(); });
  const get = (u: string) => request(h.app).get(`/api/observability${u}`);

  it('lists only level ERROR / status FAILURE rows, newest first, with pagination', async () => {
    const { body } = await get('/errors');
    expect(body.pagination.total).toBe(6);
    expect(body.data.map((e: { message: string }) => e.message)).toEqual(['warn-level failure', 'weird2', 'weird', 'tool failed again', 'tool failed', 'provider failed']);
    expect(body.data[3]).toMatchObject({ errorCategory: 'TOOL', errorMessage: 'Tool crashed', traceId: 'tr-b', source: 'SIMULATED' });
    const p2 = await get('/errors?pageSize=4&page=2');
    expect(p2.body.data).toHaveLength(2);
    expect(p2.body.pagination).toEqual({ page: 2, pageSize: 4, total: 6, totalPages: 2 });
  });

  it('filters by category, source, traceId, search and date range', async () => {
    expect((await get('/errors?category=TOOL')).body.pagination.total).toBe(2);
    expect((await get('/errors?source=ACTUAL')).body.data.map((e: { message: string }) => e.message)).toContain('provider failed');
    expect((await get('/errors?traceId=tr-b')).body.pagination.total).toBe(2);
    expect((await get('/errors?search=TIMEOUT')).body.data.map((e: { message: string }) => e.message)).toEqual(['tool failed']); // errorMessage, case-insens.
    expect((await get('/errors?search=provider.mock')).body.pagination.total).toBe(1); // operation
    expect((await get('/errors?search=weird')).body.pagination.total).toBe(2); // message
    expect((await get('/errors?from=2025-06-02&to=2025-06-03')).body.pagination.total).toBe(2);
    expect((await get('/errors?category=TOOL&traceId=tr-a')).body.pagination.total).toBe(0);
  });

  it('groups by category (null merged into UNKNOWN), most frequent first, same filters', async () => {
    const { body } = await get('/errors/groups');
    expect(body.data).toEqual([
      { category: 'TOOL', count: 2, lastSeen: '2025-06-03T10:00:00.000Z' },
      { category: 'UNKNOWN', count: 2, lastSeen: '2025-06-05T10:00:00.000Z' },
      { category: 'DATABASE', count: 1, lastSeen: '2025-06-07T10:00:00.000Z' },
      { category: 'PROVIDER', count: 1, lastSeen: '2025-06-01T10:00:00.000Z' },
    ].sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1)));
    const filtered = await get('/errors/groups?source=SIMULATED');
    expect(filtered.body.data).toEqual([{ category: 'TOOL', count: 2, lastSeen: '2025-06-03T10:00:00.000Z' }]);
  });

  it('validates query', async () => {
    for (const u of ['/errors?category=NOPE', '/errors?source=x', '/errors?page=-1', '/errors?from=2025-07-01&to=2025-06-01', '/errors/groups?category=LOGIC', '/errors/groups?from=zzz']) {
      const res = await get(u);
      expect(res.status, u).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('observability event lists', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    const p = h.prisma;
    await seed.memory(p, { createdAt: T('2025-07-01T00:00:00Z'), traceId: 'tr1', phase: 'STARTED', status: 'STARTED', memorySource: 'session-memory', operationId: 'op-1' });
    await seed.memory(p, { createdAt: T('2025-07-02T00:00:00Z'), traceId: 'tr1', phase: 'COMPLETED', operationId: 'op-1', projectId: 'pj1' });
    await seed.memory(p, { createdAt: T('2025-07-03T00:00:00Z'), traceId: 'tr2', phase: 'FAILED', status: 'FAILURE', errorMessage: 'store offline', memorySource: 'vector-store', source: 'ACTUAL' });
    await seed.bus(p, { createdAt: T('2025-07-01T00:00:00Z'), traceId: 'tr1', operationName: 'budget.alert.publish', inputMeta: JSON.stringify({ k: 1 }) });
    await seed.bus(p, { createdAt: T('2025-07-02T00:00:00Z'), traceId: 'tr2', status: 'FAILURE', errorMessage: 'no subscribers', eventName: 'usage.recorded', operationName: 'usage.dispatch', operationType: 'DISPATCH', source: 'SIMULATED' });
    await seed.tool(p, { startedAt: T('2025-07-01T00:00:00Z'), createdAt: T('2025-07-01T00:00:00Z'), traceId: 'tr1', toolName: 'web-search', toolCallId: 'c1', outputMeta: JSON.stringify({ n: 2 }) });
    await seed.tool(p, { startedAt: T('2025-07-02T00:00:00Z'), createdAt: T('2025-07-02T00:00:00Z'), traceId: 'tr2', toolName: 'calculator', toolCallId: 'c2', status: 'FAILURE', errorMessage: 'div by zero', retryCount: 1, maxRetries: 3 });
    await seed.context(p, { createdAt: T('2025-07-01T00:00:00Z'), traceId: 'tr1', contextId: 'ctx-1', operation: 'CREATED' });
    await seed.context(p, { createdAt: T('2025-07-02T00:00:00Z'), traceId: 'tr1', contextId: 'ctx-1', operation: 'UPDATED', version: 2 });
    await seed.context(p, { createdAt: T('2025-07-03T00:00:00Z'), traceId: 'tr2', contextId: 'ctx-2', operation: 'MODIFIED', status: 'FAILURE', errorMessage: 'too large', source: 'ACTUAL' });
  });
  afterAll(async () => { await h.close(); });
  const get = (u: string) => request(h.app).get(`/api/observability/${u}`);
  const ids = (res: { body: { data: Record<string, unknown>[] } }, key: string) => res.body.data.map(d => d[key]);

  it('memory-events: newest first, DTO shape, filters (traceId, status incl. STARTED, source, search, range, projectId)', async () => {
    const all = await get('memory-events');
    expect(all.body.pagination.total).toBe(3);
    expect(ids(all, 'phase')).toEqual(['FAILED', 'COMPLETED', 'STARTED']);
    expect(all.body.data[0]).toMatchObject({ memorySource: 'vector-store', errorMessage: 'store offline', source: 'ACTUAL', createdAt: '2025-07-03T00:00:00.000Z' });
    expect((await get('memory-events?traceId=tr1')).body.pagination.total).toBe(2);
    expect(ids(await get('memory-events?status=STARTED'), 'phase')).toEqual(['STARTED']);
    expect(ids(await get('memory-events?status=FAILURE'), 'phase')).toEqual(['FAILED']);
    expect(ids(await get('memory-events?source=ACTUAL'), 'phase')).toEqual(['FAILED']);
    expect(ids(await get('memory-events?search=VECTOR'), 'phase')).toEqual(['FAILED']);
    expect(ids(await get('memory-events?search=op-1'), 'phase')).toEqual(['COMPLETED', 'STARTED']);
    expect(ids(await get('memory-events?projectId=pj1'), 'phase')).toEqual(['COMPLETED']);
    expect((await get('memory-events?from=2025-07-02&to=2025-07-02')).body.pagination.total).toBe(1);
    expect((await get('memory-events?pageSize=2&page=2')).body.data).toHaveLength(1);
  });

  it('bus-events: filters + parsed inputMeta', async () => {
    const all = await get('bus-events');
    expect(ids(all, 'operationName')).toEqual(['usage.dispatch', 'budget.alert.publish']);
    expect(all.body.data[1].inputMeta).toEqual({ k: 1 });
    expect(ids(await get('bus-events?status=FAILURE'), 'operationType')).toEqual(['DISPATCH']);
    expect(ids(await get('bus-events?source=SIMULATED'), 'operationName')).toEqual(['usage.dispatch']);
    expect(ids(await get('bus-events?search=subscribers'), 'operationName')).toEqual(['usage.dispatch']);
    expect(ids(await get('bus-events?search=usage.recorded'), 'operationName')).toEqual(['usage.dispatch']);
    expect(ids(await get('bus-events?traceId=tr1'), 'operationName')).toEqual(['budget.alert.publish']);
  });

  it('tool-events: filters + retry fields', async () => {
    const all = await get('tool-events');
    expect(ids(all, 'toolName')).toEqual(['calculator', 'web-search']);
    expect(all.body.data[0]).toMatchObject({ retryCount: 1, maxRetries: 3, errorMessage: 'div by zero', status: 'FAILURE' });
    expect(all.body.data[1].outputMeta).toEqual({ n: 2 });
    expect(ids(await get('tool-events?status=SUCCESS'), 'toolName')).toEqual(['web-search']);
    expect(ids(await get('tool-events?search=c2'), 'toolName')).toEqual(['calculator']);
    expect(ids(await get('tool-events?search=WEB'), 'toolName')).toEqual(['web-search']);
    expect(ids(await get('tool-events?traceId=tr2&source=SIMULATED'), 'toolName')).toEqual(['calculator']);
  });

  it('context-events: filters', async () => {
    expect(ids(await get('context-events'), 'operation')).toEqual(['MODIFIED', 'UPDATED', 'CREATED']);
    expect(ids(await get('context-events?status=FAILURE'), 'contextId')).toEqual(['ctx-2']);
    expect(ids(await get('context-events?search=ctx-1'), 'operation')).toEqual(['UPDATED', 'CREATED']);
    expect(ids(await get('context-events?search=updated'), 'operation')).toEqual(['UPDATED']);
    expect(ids(await get('context-events?source=ACTUAL'), 'contextId')).toEqual(['ctx-2']);
    expect((await get('context-events?from=2025-07-02&to=2025-07-03')).body.pagination.total).toBe(2);
  });

  it('validates status per list (STARTED only valid for memory) and generic params', async () => {
    for (const u of ['bus-events?status=STARTED', 'tool-events?status=OK', 'context-events?status=STARTED', 'memory-events?status=DONE', 'memory-events?source=nope', 'tool-events?pageSize=500', 'context-events?from=2025-08-01&to=2025-07-01']) {
      const res = await get(u);
      expect(res.status, u).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
