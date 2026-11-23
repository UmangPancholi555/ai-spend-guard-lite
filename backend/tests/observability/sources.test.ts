import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeHarness, seed, T, type Harness } from './helpers';
import { getSources } from '../../src/modules/observability/sources';
import { RuntimeRegistry } from '../../src/modules/runtime/registry';

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

  it('empty DB: every kind is CONNECTED (real components registered) with zero counts; the DEMO simulator entry is SIMULATED_ONLY', async () => {
    const { list, by } = await get();
    expect(list.map(s => s.kind)).toEqual(['request', 'memory', 'bus', 'tool', 'context', 'error', 'simulator']);
    for (const k of ['request', 'memory', 'bus', 'tool', 'context', 'error']) { expect(by[k].status, k).toBe('CONNECTED'); expect(by[k].notes, k).toMatch(/^Real:/); }
    for (const k of ['memory', 'bus', 'tool', 'context']) expect(by[k].notes, k).toMatch(/No events recorded yet/);
    expect(by.simulator.status).toBe('SIMULATED_ONLY');
    for (const s of list) expect(s).toMatchObject({ actualEvents: 0, simulatedEvents: 0, lastEventAt: null });
  });

  it('a kind WITHOUT a registered component is never CONNECTED: UNAVAILABLE when empty (nothing is fabricated)', async () => {
    const empty = new RuntimeRegistry();
    const list = await getSources(h.prisma, empty);
    for (const s of list.filter(x => x.kind !== 'simulator')) expect(s.status, s.kind).toBe('UNAVAILABLE');
    // register only the tool component: only tool becomes CONNECTED
    const partial = new RuntimeRegistry();
    partial.register({ kind: 'tool', name: 't', description: 'tool executor' });
    const l2 = await getSources(h.prisma, partial);
    expect(l2.filter(s => s.status === 'CONNECTED').map(s => s.kind)).toEqual(['tool']);
  });

  it('simulated-only data: registered kinds stay CONNECTED, simulated rows are counted separately (never as actual); counts from the DB', async () => {
    const p = h.prisma;
    await seed.memory(p, { createdAt: T('2025-01-01T00:00:00Z'), phase: 'STARTED', status: 'STARTED' }); // not counted (injection = COMPLETED|FAILED)
    await seed.memory(p, { createdAt: T('2025-01-02T00:00:00Z'), phase: 'COMPLETED' });
    await seed.memory(p, { createdAt: T('2025-01-03T00:00:00Z'), phase: 'FAILED', status: 'FAILURE' });
    await seed.tool(p, { startedAt: T('2025-01-04T00:00:00Z'), createdAt: T('2025-01-04T00:00:00Z') });
    await seed.tool(p, { startedAt: T('2025-01-05T00:00:00Z'), createdAt: T('2025-01-05T00:00:00Z') });
    await seed.context(p, { createdAt: T('2025-01-06T00:00:00Z') });
    await seed.bus(p, { createdAt: T('2025-01-07T00:00:00Z'), source: 'SIMULATED' });
    const { by } = await get();
    expect(by.memory).toMatchObject({ status: 'CONNECTED', actualEvents: 0, simulatedEvents: 2, lastEventAt: '2025-01-03T00:00:00.000Z' });
    expect(by.tool).toMatchObject({ status: 'CONNECTED', actualEvents: 0, simulatedEvents: 2, lastEventAt: '2025-01-05T00:00:00.000Z' });
    expect(by.context).toMatchObject({ status: 'CONNECTED', actualEvents: 0, simulatedEvents: 1 });
    expect(by.bus).toMatchObject({ status: 'CONNECTED', actualEvents: 0, simulatedEvents: 1 });
    expect(by.simulator).toMatchObject({ status: 'SIMULATED_ONLY', actualEvents: 0, simulatedEvents: 6, lastEventAt: '2025-01-07T00:00:00.000Z' });
    // WITHOUT registered components the same rows are SIMULATED_ONLY (the honest fallback)
    const un = Object.fromEntries((await getSources(h.prisma, new RuntimeRegistry())).map(s => [s.kind, s]));
    for (const k of ['memory', 'tool', 'context', 'bus']) expect(un[k].status, k).toBe('SIMULATED_ONLY');
  });

  it('request/error/bus counts split by source', async () => {
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

  it('ACTUAL rows without a registered real component are flagged as unverified, never CONNECTED', async () => {
    const p = h.prisma;
    await seed.memory(p, { createdAt: T('2025-03-01T00:00:00Z'), source: 'ACTUAL' });
    await seed.tool(p, { startedAt: T('2025-03-01T00:00:00Z'), createdAt: T('2025-03-01T00:00:00Z'), source: 'ACTUAL' });
    await seed.context(p, { createdAt: T('2025-03-01T00:00:00Z'), source: 'ACTUAL' });
    const by = Object.fromEntries((await getSources(p, new RuntimeRegistry())).map(s => [s.kind, s]));
    for (const k of ['memory', 'tool', 'context']) {
      expect(by[k].status, k).toBe('SIMULATED_ONLY');
      expect(by[k].actualEvents, k).toBeGreaterThanOrEqual(1);
      expect(by[k].notes, k).toMatch(/labelled ACTUAL.*unverified/);
    }
    expect(by.memory.notes).toMatch(/No real memory component is registered/);
    // with the real components registered the same rows count as ACTUAL and the kind is CONNECTED
    const reg = await get();
    for (const k of ['memory', 'tool', 'context']) expect(reg.by[k].status, k).toBe('CONNECTED');
  });
});
