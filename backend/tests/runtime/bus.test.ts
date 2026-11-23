import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { EventBus } from '../../src/modules/runtime';
import { executeMockRequest } from '../../src/modules/providers';
import { recordingInstr } from '../providers/helpers';
import { makeProject } from './helpers';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const busCalls = (instr: ReturnType<typeof recordingInstr>) => instr.calls.filter(c => c.fn === 'recordBus') as any[];

describe('EventBus (real in-process pub/sub, instrumented)', () => {
  it('publish: delivers to every subscriber in order and records PUBLISH + one SUBSCRIBE per delivery (ACTUAL, metadata only)', async () => {
    const instr = recordingInstr();
    const bus = new EventBus(instr);
    const got: string[] = [];
    bus.subscribe('thing.happened', 'first', async p => { got.push(`first:${(p as any).id}`); });
    bus.subscribe('thing.happened', 'second', p => { got.push(`second:${(p as any).id}`); });
    const r = await bus.publish('thing.happened', { id: 7, secret: 'BUS-PAYLOAD-SENTINEL' }, { projectId: 'p1', requestId: 'r1' });
    expect(r).toEqual({ delivered: 2, failed: 0 });
    expect(got).toEqual(['first:7', 'second:7']);
    const rec = busCalls(instr);
    expect(rec.map(c => c.operationType)).toEqual(['SUBSCRIBE', 'SUBSCRIBE', 'PUBLISH']);
    expect(rec.every(c => c.source === 'ACTUAL' && c.eventName === 'thing.happened' && c.success === true && c.projectId === 'p1' && c.requestId === 'r1')).toBe(true);
    expect(rec.slice(0, 2).map(c => c.inputMeta.subscriber)).toEqual(['first', 'second']);
    expect(rec[2].outputStatus).toBe('delivered');
    expect(rec[2].inputMeta).toMatchObject({ payloadKeys: ['id', 'secret'], subscribers: 2 });
    expect(rec[2].inputMeta.payloadBytes).toBeGreaterThan(0);
    expect(JSON.stringify(rec)).not.toContain('BUS-PAYLOAD-SENTINEL'); // values never recorded
  });

  it('failure isolation: a throwing subscriber is recorded (error + stack) but neither stops other subscribers nor the publisher', async () => {
    const instr = recordingInstr();
    const bus = new EventBus(instr);
    const got: string[] = [];
    bus.subscribe('e', 'bad', () => { throw new Error('subscriber exploded'); });
    bus.subscribe('e', 'good', () => { got.push('ok'); });
    const r = await bus.publish('e', { a: 1 });
    expect(r).toEqual({ delivered: 1, failed: 1 });
    expect(got).toEqual(['ok']);
    const rec = busCalls(instr);
    const bad = rec.find(c => c.inputMeta?.subscriber === 'bad');
    expect(bad).toMatchObject({ operationType: 'SUBSCRIBE', success: false, outputStatus: 'error', errorMessage: 'subscriber exploded' });
    expect(typeof bad.stack).toBe('string');
    expect(rec.find(c => c.inputMeta?.subscriber === 'good').success).toBe(true);
    const pub = rec.find(c => c.operationType === 'PUBLISH');
    expect(pub).toMatchObject({ success: false, outputStatus: 'partial-failure' });
    expect(pub.errorMessage).toMatch(/1 of 2 subscriber\(s\) failed: bad/);
  });

  it('publish without subscribers is recorded as no-subscribers (success)', async () => {
    const instr = recordingInstr();
    const r = await new EventBus(instr).publish('nobody.listens', {});
    expect(r).toEqual({ delivered: 0, failed: 0 });
    expect(busCalls(instr)).toHaveLength(1);
    expect(busCalls(instr)[0]).toMatchObject({ operationType: 'PUBLISH', outputStatus: 'no-subscribers', success: true });
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new EventBus(recordingInstr());
    let n = 0;
    const off = bus.subscribe('e', 's', () => { n++; });
    await bus.publish('e', {});
    off();
    await bus.publish('e', {});
    expect(n).toBe(1);
    expect(bus.subscriberCount('e')).toBe(0);
  });

  it('request: single responder returns a value (REQUEST recorded); failures are recorded then rethrown; no responder is an error', async () => {
    const instr = recordingInstr();
    const bus = new EventBus(instr);
    bus.respond('sum', 'adder', (p: any) => p.a + p.b);
    bus.respond('boom', 'exploder', () => { throw new Error('responder failed'); });
    expect(await bus.request<number>('sum', { a: 2, b: 3 })).toBe(5);
    await expect(bus.request('boom', {})).rejects.toThrow('responder failed');
    await expect(bus.request('missing', {})).rejects.toThrow(/No responder/);
    const rec = busCalls(instr);
    expect(rec.map(c => [c.operationType, c.eventName, c.success])).toEqual([['REQUEST', 'sum', true], ['REQUEST', 'boom', false], ['REQUEST', 'missing', false]]);
    expect(rec[0].inputMeta).toMatchObject({ responder: 'adder', payloadKeys: ['a', 'b'] });
    expect(rec[1]).toMatchObject({ outputStatus: 'error', errorMessage: 'responder failed' });
  });

  it('dispatch: returns before subscribers run, records DISPATCH (queued) and later SUBSCRIBE; subscriber failures isolated', async () => {
    const instr = recordingInstr();
    const bus = new EventBus(instr);
    const got: string[] = [];
    bus.subscribe('later', 'a', () => { got.push('a'); });
    bus.subscribe('later', 'b', () => { throw new Error('b failed'); });
    bus.subscribe('later', 'c', () => { got.push('c'); });
    const d = bus.dispatch('later', { x: 1 });
    expect(got).toEqual([]); // asynchronous
    await d.queued;
    expect(busCalls(instr).map(c => c.operationType)).toEqual(['DISPATCH']);
    expect(busCalls(instr)[0]).toMatchObject({ outputStatus: 'queued', success: true });
    const res = await d.settled;
    expect(res).toEqual({ delivered: 2, failed: 1 });
    expect(got).toEqual(['a', 'c']);
    expect(busCalls(instr).filter(c => c.operationType === 'SUBSCRIBE').map(c => c.success)).toEqual([true, false, true]);
  });

  it('with a trace scope, bus operations get BUS spans (ACTUAL) and correlation ids', async () => {
    const instr = recordingInstr();
    const trace = await instr.startTrace({ name: 't', source: 'ACTUAL' });
    const bus = new EventBus(instr);
    bus.subscribe('e', 's', () => {});
    bus.respond('r', 'resp', () => 1);
    await bus.publish('e', {}, { trace, traceId: trace.traceId });
    await bus.request('r', {}, { trace, traceId: trace.traceId });
    expect(instr.spans.filter(s => s.kind === 'BUS').map(s => [s.name, s.source])).toEqual([['bus.publish', 'ACTUAL'], ['bus.request', 'ACTUAL']]);
    expect(busCalls(instr).every(c => c.traceId === trace.traceId)).toBe(true);
  });
});

describe('pipeline over the real bus', () => {
  it('a request records ACTUAL bus events: PUBLISH usage.recorded -> SUBSCRIBE activity-recorder, REQUEST budget.evaluate -> budget-engine', async () => {
    const p = await makeProject(ctx.prisma);
    const r = await executeMockRequest(ctx.deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'bus please' }, { latency: false });
    const ev = await ctx.prisma.busEvent.findMany({ where: { traceId: r.traceId }, orderBy: { createdAt: 'asc' } });
    expect(ev.map(e => [e.operationType, e.eventName, e.status, e.source])).toEqual([
      ['SUBSCRIBE', 'usage.recorded', 'SUCCESS', 'ACTUAL'],
      ['PUBLISH', 'usage.recorded', 'SUCCESS', 'ACTUAL'],
      ['REQUEST', 'budget.evaluate', 'SUCCESS', 'ACTUAL'],
    ]);
    expect(JSON.parse(ev[0]!.inputMeta)).toMatchObject({ subscriber: 'activity-recorder' });
    expect(JSON.parse(ev[2]!.inputMeta)).toMatchObject({ responder: 'budget-engine' });
    expect(ev.every(e => e.projectId === p.id && e.spanId)).toBe(true);
    const busSpans = await ctx.prisma.span.findMany({ where: { traceId: r.traceId, kind: 'BUS' } });
    expect(busSpans.map(s => s.name).sort()).toEqual(['bus.publish', 'bus.request']);
    // the activity subscriber really recorded the activity
    expect(await ctx.prisma.activityEvent.count({ where: { requestId: r.requestId, type: 'usage.recorded', source: 'ACTUAL' } })).toBe(1);
  });

  it('failed requests publish request.failed (activity request.failed ERROR via the bus)', async () => {
    const p = await makeProject(ctx.prisma);
    const r = await executeMockRequest(ctx.deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'will fail', simulateFailure: 'error' }, { latency: false });
    const ev = await ctx.prisma.busEvent.findMany({ where: { traceId: r.traceId, operationType: 'PUBLISH' } });
    expect(ev.map(e => e.eventName)).toEqual(['request.failed']);
    expect(await ctx.prisma.activityEvent.count({ where: { requestId: r.requestId, type: 'request.failed', level: 'ERROR' } })).toBe(1);
  });

  it('a failing subscriber (activity recorder) never breaks the request; the failure is recorded as a FAILURE bus event', async () => {
    const p = await makeProject(ctx.prisma);
    const real = ctx.deps.instr;
    const deps = { ...ctx.deps, instr: new Proxy(real, { get(t, prop, rcv) { if (prop === 'recordActivity') return async () => { throw new Error('activity sink down'); }; return Reflect.get(t, prop, rcv); } }) };
    const r = await executeMockRequest(deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'isolated' }, { latency: false });
    expect(r.status).toBe('SUCCESS');
    expect(r.usageEventId).toBeTruthy();
    const ev = await ctx.prisma.busEvent.findMany({ where: { traceId: r.traceId }, orderBy: { createdAt: 'asc' } });
    const sub = ev.find(e => e.operationType === 'SUBSCRIBE')!;
    expect(sub).toMatchObject({ status: 'FAILURE', errorMessage: 'activity sink down', source: 'ACTUAL' });
    expect(ev.find(e => e.operationType === 'PUBLISH')).toMatchObject({ status: 'FAILURE' });
    expect(ev.find(e => e.operationType === 'REQUEST')).toMatchObject({ status: 'SUCCESS' }); // budget evaluation unaffected
    const log = await ctx.prisma.executionLog.findFirst({ where: { traceId: r.traceId, category: 'BUS', status: 'FAILURE' } });
    expect(log).toMatchObject({ level: 'ERROR', errorCategory: 'BUS' });
  });

  it('budget evaluation over bus.request still returns the newly raised alerts synchronously', async () => {
    const p = await makeProject(ctx.prisma);
    await ctx.prisma.budget.create({ data: { projectId: p.id, name: 'tiny', period: 'DAILY', limitPico: 1n } });
    const r = await executeMockRequest(ctx.deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'alerts' }, { latency: false });
    expect(r.budgetAlerts.map(a => a.threshold).sort((x, y) => x - y)).toEqual([50, 80, 100]);
  });

  it('a failing budget responder propagates (request fails with the error, trace ERROR) and is recorded as a failed REQUEST', async () => {
    const p = await makeProject(ctx.prisma);
    const deps = { ...ctx.deps, budgets: { ...ctx.deps.budgets, evaluateAfterUsage: async () => { throw new Error('budget engine down'); } } };
    await expect(executeMockRequest(deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'x' }, { latency: false })).rejects.toThrow('budget engine down');
    const trace = await ctx.prisma.trace.findFirstOrThrow({ where: { projectId: p.id } });
    expect(trace.status).toBe('ERROR');
    expect(await ctx.prisma.busEvent.count({ where: { traceId: trace.traceId, operationType: 'REQUEST', status: 'FAILURE' } })).toBe(1);
  });
});
