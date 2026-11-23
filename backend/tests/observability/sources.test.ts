import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeHarness, seed, T, type Harness } from './helpers';

type Src = { id: string; kind: string; status: string; actualEvents: number; simulatedEvents: number; lastEventAt: string | null; notes: string };

describe('GET /api/observability/sources (instrumentation honesty)', () => {
  let h: Harness;
  beforeAll(async () => { h = await makeHarness(); });
  afterAll(async () => { await h.close(); });
  const get = async () => {
    const res = await request(h.app).get('/api/observability/sources');
    expect(res.status).toBe(200);
    const by = Object.fromEntries((res.body.data as Src[]).map(s => [s.kind, s]));
    return { list: res.body.data as Src[], by };
  };

  it('empty DB: memory/tool/context/bus UNAVAILABLE, request/error CONNECTED with zero counts', async () => {
    const { list, by } = await get();
    expect(list.map(s => s.kind)).toEqual(['request', 'memory', 'bus', 'tool', 'context', 'error']);
    for (const k of ['memory', 'bus', 'tool', 'context']) expect(by[k].status, k).toBe('UNAVAILABLE');
    for (const k of ['request', 'error']) expect(by[k].status, k).toBe('CONNECTED');
    for (const s of list) expect(s).toMatchObject({ actualEvents: 0, simulatedEvents: 0, lastEventAt: null });
  });

  it('simulated-only data: memory/tool/context SIMULATED_ONLY, bus SIMULATED_ONLY; counts from the DB', async () => {
    const p = h.prisma;
    await seed.memory(p, { createdAt: T('2025-01-01T00:00:00Z'), phase: 'STARTED', status: 'STARTED' }); // not counted (injection = COMPLETED|FAILED)
    await seed.memory(p, { createdAt: T('2025-01-02T00:00:00Z'), phase: 'COMPLETED' });
    await seed.memory(p, { createdAt: T('2025-01-03T00:00:00Z'), phase: 'FAILED', status: 'FAILURE' });
    await seed.tool(p, { startedAt: T('2025-01-04T00:00:00Z'), createdAt: T('2025-01-04T00:00:00Z') });
    await seed.tool(p, { startedAt: T('2025-01-05T00:00:00Z'), createdAt: T('2025-01-05T00:00:00Z') });
    await seed.context(p, { createdAt: T('2025-01-06T00:00:00Z') });
    await seed.bus(p, { createdAt: T('2025-01-07T00:00:00Z'), source: 'SIMULATED' });
    const { by } = await get();
    expect(by.memory).toMatchObject({ status: 'SIMULATED_ONLY', actualEvents: 0, simulatedEvents: 2, lastEventAt: '2025-01-03T00:00:00.000Z' });
    expect(by.tool).toMatchObject({ status: 'SIMULATED_ONLY', actualEvents: 0, simulatedEvents: 2, lastEventAt: '2025-01-05T00:00:00.000Z' });
    expect(by.context).toMatchObject({ status: 'SIMULATED_ONLY', simulatedEvents: 1 });
    expect(by.bus).toMatchObject({ status: 'SIMULATED_ONLY', actualEvents: 0, simulatedEvents: 1 });
  });

  it('ACTUAL bus rows make bus CONNECTED; request/error counts split by source', async () => {
    const p = h.prisma;
    await seed.bus(p, { createdAt: T('2025-02-01T00:00:00Z'), source: 'ACTUAL' });
    await seed.log(p, { ts: T('2025-02-02T00:00:00Z'), category: 'REQUEST', source: 'ACTUAL' });
    await seed.log(p, { ts: T('2025-02-03T00:00:00Z'), category: 'PROVIDER', source: 'ACTUAL' });
    await seed.log(p, { ts: T('2025-02-04T00:00:00Z'), category: 'REQUEST', source: 'SIMULATED' });
    await seed.log(p, { ts: T('2025-02-05T00:00:00Z'), category: 'TOOL', status: 'FAILURE', level: 'ERROR', source: 'ACTUAL' }); // error, not request
    await seed.log(p, { ts: T('2025-02-06T00:00:00Z'), category: 'ERROR', status: 'FAILURE', level: 'ERROR', source: 'SIMULATED' });
    const { by } = await get();
    expect(by.bus).toMatchObject({ status: 'CONNECTED', actualEvents: 1, simulatedEvents: 1 });
    expect(by.request).toMatchObject({ status: 'CONNECTED', actualEvents: 2, simulatedEvents: 1, lastEventAt: '2025-02-04T00:00:00.000Z' });
    expect(by.error).toMatchObject({ status: 'CONNECTED', actualEvents: 1, simulatedEvents: 1, lastEventAt: '2025-02-06T00:00:00.000Z' });
  });

  it('NEVER reports memory/tool/context as CONNECTED, even if rows are mislabelled ACTUAL (they are flagged instead)', async () => {
    const p = h.prisma;
    await seed.memory(p, { createdAt: T('2025-03-01T00:00:00Z'), source: 'ACTUAL' });
    await seed.tool(p, { startedAt: T('2025-03-01T00:00:00Z'), createdAt: T('2025-03-01T00:00:00Z'), source: 'ACTUAL' });
    await seed.context(p, { createdAt: T('2025-03-01T00:00:00Z'), source: 'ACTUAL' });
    const { by } = await get();
    for (const k of ['memory', 'tool', 'context']) {
      expect(by[k].status, k).toBe('SIMULATED_ONLY');
      expect(by[k].actualEvents, k).toBe(1);
      expect(by[k].notes, k).toMatch(/labelled ACTUAL.*unverified/);
    }
    // honest notes for the always-simulated kinds
    expect(by.memory.notes).toMatch(/No real memory runtime/);
  });
});
