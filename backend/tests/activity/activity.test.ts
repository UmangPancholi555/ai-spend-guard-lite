import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeHarness, seed, T, type Harness } from '../observability/helpers';

describe('GET /api/activity', () => {
  let h: Harness;
  let projA: string, projB: string;
  beforeAll(async () => {
    h = await makeHarness();
    const a = await seed.project(h.prisma, 'Alpha'); const b = await seed.project(h.prisma, 'Beta');
    projA = a.id; projB = b.id;
    const p = h.prisma;
    await seed.activity(p, { createdAt: T('2025-03-01T10:00:00Z'), type: 'project.created', message: 'Project Alpha created', projectId: projA });
    await seed.activity(p, { createdAt: T('2025-03-02T10:00:00Z'), type: 'usage.recorded', message: 'Recorded 120 tokens', projectId: projA, traceId: 'tr1', requestId: 'req_1', metadata: JSON.stringify({ tokens: 120 }) });
    await seed.activity(p, { createdAt: T('2025-03-03T10:00:00Z'), type: 'request.failed', level: 'ERROR', message: 'Provider timeout', projectId: projB, traceId: 'tr2' });
    await seed.activity(p, { createdAt: T('2025-03-04T10:00:00Z'), type: 'budget.alert', level: 'WARN', message: 'Budget 80% reached', projectId: projB, source: 'SIMULATED' });
    await seed.activity(p, { createdAt: T('2025-03-05T23:59:59.500Z'), type: 'usage.recorded', message: 'Late event no project' });
  });
  afterAll(async () => { await h.close(); });

  const get = (qs = '') => request(h.app).get(`/api/activity${qs}`);

  it('lists newest first with pagination envelope and projectName', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 25, total: 5, totalPages: 1 });
    expect(res.body.data.map((e: { message: string }) => e.message)[0]).toBe('Late event no project');
    const alpha = res.body.data.find((e: { type: string; projectId: string }) => e.type === 'project.created');
    expect(alpha.projectName).toBe('Alpha');
    expect(res.body.data[0].projectName).toBeNull();
    const usage = res.body.data.find((e: { requestId: string | null }) => e.requestId === 'req_1');
    expect(usage.metadata).toEqual({ tokens: 120 });
    expect(usage.createdAt).toBe('2025-03-02T10:00:00.000Z');
  });

  it('paginates', async () => {
    const p1 = await get('?pageSize=2&page=1');
    const p3 = await get('?pageSize=2&page=3');
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.pagination).toEqual({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
    expect(p3.body.data).toHaveLength(1);
    expect(p3.body.data[0].type).toBe('project.created');
    const beyond = await get('?pageSize=2&page=9');
    expect(beyond.body.data).toEqual([]);
  });

  it('filters by type (single and comma list), level, source, projectId, traceId', async () => {
    expect((await get('?type=usage.recorded')).body.pagination.total).toBe(2);
    expect((await get('?type=project.created,budget.alert')).body.pagination.total).toBe(2);
    expect((await get('?level=ERROR')).body.data.map((e: { type: string }) => e.type)).toEqual(['request.failed']);
    expect((await get('?source=SIMULATED')).body.data.map((e: { type: string }) => e.type)).toEqual(['budget.alert']);
    expect((await get(`?projectId=${projB}`)).body.pagination.total).toBe(2);
    expect((await get('?traceId=tr2')).body.data).toHaveLength(1);
  });

  it('search matches message or type, case-insensitively', async () => {
    expect((await get('?search=timeout')).body.data.map((e: { type: string }) => e.type)).toEqual(['request.failed']);
    expect((await get('?search=BUDGET')).body.data.map((e: { type: string }) => e.type)).toEqual(['budget.alert']); // via type and message
    expect((await get('?search=project.created')).body.pagination.total).toBe(1); // via type
    expect((await get('?search=nomatchxyz')).body.pagination.total).toBe(0);
  });

  it('date range is inclusive; date-only `to` covers the whole UTC day', async () => {
    expect((await get('?from=2025-03-02T10:00:00Z&to=2025-03-03T10:00:00Z')).body.pagination.total).toBe(2); // both bounds inclusive
    expect((await get('?from=2025-03-05&to=2025-03-05')).body.data.map((e: { message: string }) => e.message)).toEqual(['Late event no project']);
    expect((await get('?to=2025-03-01')).body.pagination.total).toBe(1);
    expect((await get('?from=2025-03-06')).body.pagination.total).toBe(0);
  });

  it('combines filters and ignores empty params', async () => {
    const res = await get(`?projectId=${projB}&level=WARN&type=&search=`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].type).toBe('budget.alert');
  });

  it('returns 400 VALIDATION_ERROR envelope on bad input', async () => {
    for (const qs of ['?level=FATAL', '?source=REAL', '?page=0', '?pageSize=201', '?pageSize=abc', '?from=notadate', '?from=2025-03-05&to=2025-03-01']) {
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(res.body.error.details)).toBe(true);
    }
  });
});

describe('GET /api/activity on empty DB', () => {
  let h: Harness;
  beforeAll(async () => { h = await makeHarness(); });
  afterAll(async () => { await h.close(); });
  it('returns an empty list with sane pagination', async () => {
    const res = await request(h.app).get('/api/activity');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } });
  });
});
