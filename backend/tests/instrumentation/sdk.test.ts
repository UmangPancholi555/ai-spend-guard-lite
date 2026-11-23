import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { createInstrumentation } from '../../src/modules/instrumentation';
import { readJsonl, sleep } from './util';

let ctx: TestCtx;
const logDir = () => ctx.deps.config.logDir;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

describe('traces and spans', () => {
  it('creates 32-hex trace id, 16-hex span ids, root span and parent/child relations', async () => {
    const instr = ctx.deps.instr;
    const trace = await instr.startTrace({ name: 'unit.trace', source: 'ACTUAL', requestId: 'req_x', attributes: { route: '/x' } });
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.rootSpan.spanId).toMatch(/^[0-9a-f]{16}$/);
    const a = await trace.startSpan('a', 'COST');
    const b = await a.startSpan('b', 'BUDGET');
    const c = await trace.startSpan('c', 'INTERNAL', undefined, { parent: a });
    for (const s of [a, b, c]) expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    await b.end(); await c.end(); await a.end(); await trace.end();

    const spans = await ctx.prisma.span.findMany({ where: { traceId: trace.traceId } });
    const byName = Object.fromEntries(spans.map(s => [s.name, s]));
    expect(spans).toHaveLength(4);
    expect(byName['unit.trace'].parentSpanId).toBeNull();
    expect(byName['a'].parentSpanId).toBe(trace.rootSpan.spanId); // defaults to root
    expect(byName['b'].parentSpanId).toBe(a.spanId); // child of the span it was started from
    expect(byName['c'].parentSpanId).toBe(a.spanId); // explicit parent
    expect(new Set(spans.map(s => s.spanId)).size).toBe(4);
    expect(spans.every(s => s.status === 'OK' && s.endedAt && s.durationMs !== null && s.source === 'ACTUAL')).toBe(true);
  });

  it('measures durations and persists trace status/endedAt/durationMs', async () => {
    const trace = await ctx.deps.instr.startTrace({ name: 'dur', source: 'SIMULATED', projectId: undefined });
    const s = await trace.startSpan('slow', 'TOOL');
    await sleep(40);
    const d = await s.end();
    expect(d).toBeGreaterThanOrEqual(35);
    expect(d).toBeLessThan(2000);
    await sleep(10);
    const td = await trace.end();
    expect(td).toBeGreaterThanOrEqual(d);
    const row = await ctx.prisma.trace.findUniqueOrThrow({ where: { traceId: trace.traceId } });
    expect(row.status).toBe('OK');
    expect(row.durationMs).toBe(td);
    expect(row.endedAt).toBeInstanceOf(Date);
    expect(row.source).toBe('SIMULATED');
    const sp = await ctx.prisma.span.findUniqueOrThrow({ where: { spanId: s.spanId } });
    expect(sp.durationMs).toBe(d);
    expect(sp.source).toBe('SIMULATED'); // inherits trace source
  });

  it('records error spans with message + stack, and an ERROR trace', async () => {
    const trace = await ctx.deps.instr.startTrace({ name: 'err', source: 'ACTUAL' });
    const s = await trace.startSpan('boom', 'PROVIDER');
    const err = new Error('provider exploded');
    await s.end(err);
    await trace.end(err);
    const sp = await ctx.prisma.span.findUniqueOrThrow({ where: { spanId: s.spanId } });
    expect(sp.status).toBe('ERROR');
    expect(sp.errorMessage).toBe('provider exploded');
    expect(sp.stack).toContain('provider exploded');
    const tr = await ctx.prisma.trace.findUniqueOrThrow({ where: { traceId: trace.traceId } });
    expect(tr.status).toBe('ERROR');
    expect(tr.errorMessage).toBe('provider exploded');
    expect(tr.stack).toBeTruthy();
    const root = await ctx.prisma.span.findUniqueOrThrow({ where: { spanId: trace.rootSpan.spanId } });
    expect(root.status).toBe('ERROR');
    const logs = await ctx.prisma.executionLog.findMany({ where: { traceId: trace.traceId }, orderBy: { ts: 'asc' } });
    expect(logs.map(l => l.eventType)).toEqual(['request.started', 'request.failed']);
    expect(logs[1].level).toBe('ERROR');
    expect(logs[1].status).toBe('FAILURE');
    expect(logs[1].errorCategory).toBeTruthy();
  });

  it('end() is idempotent for spans and traces (first result wins)', async () => {
    const trace = await ctx.deps.instr.startTrace({ name: 'idem', source: 'ACTUAL' });
    const s = await trace.startSpan('s', 'INTERNAL');
    const d1 = await s.end();
    await sleep(15);
    const d2 = await s.end(new Error('late error must be ignored'));
    expect(d2).toBe(d1);
    const t1 = await trace.end();
    await sleep(15);
    const t2 = await trace.end(new Error('ignored'));
    expect(t2).toBe(t1);
    const sp = await ctx.prisma.span.findUniqueOrThrow({ where: { spanId: s.spanId } });
    expect(sp.status).toBe('OK');
    expect((await ctx.prisma.trace.findUniqueOrThrow({ where: { traceId: trace.traceId } })).status).toBe('OK');
    expect(await ctx.prisma.executionLog.count({ where: { traceId: trace.traceId, eventType: { startsWith: 'request.' } } })).toBe(2);
  });

  it('withSpan ends the span OK, or with ERROR and rethrows', async () => {
    const instr = ctx.deps.instr;
    const trace = await instr.startTrace({ name: 'ws', source: 'ACTUAL' });
    const v = await instr.withSpan(trace, 'ok-span', 'COST', async sp => { expect(sp.traceId).toBe(trace.traceId); return 42; });
    expect(v).toBe(42);
    await expect(instr.withSpan(trace, 'bad-span', 'COST', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    const spans = await ctx.prisma.span.findMany({ where: { traceId: trace.traceId } });
    expect(spans.find(s => s.name === 'ok-span')!.status).toBe('OK');
    const bad = spans.find(s => s.name === 'bad-span')!;
    expect(bad.status).toBe('ERROR');
    expect(bad.errorMessage).toBe('nope');
    await trace.end();
  });

  it('supports backdated traces via `at` with consistent span timestamps', async () => {
    const at = new Date('2026-01-05T10:00:00.000Z');
    const trace = await ctx.deps.instr.startTrace({ name: 'old', source: 'SIMULATED', ...({ at } as object) });
    const s = await trace.startSpan('x', 'INTERNAL');
    await s.end(); await trace.end();
    const tr = await ctx.prisma.trace.findUniqueOrThrow({ where: { traceId: trace.traceId } });
    expect(tr.startedAt.toISOString()).toBe(at.toISOString());
    const sp = await ctx.prisma.span.findUniqueOrThrow({ where: { spanId: s.spanId } });
    expect(sp.startedAt.getTime()).toBeGreaterThanOrEqual(at.getTime());
    expect(sp.startedAt.getTime() - at.getTime()).toBeLessThan(5000);
  });
});

describe('record* writes typed row + ExecutionLog + JSONL', () => {
  const find = (id: string) => ctx.prisma.executionLog.findUniqueOrThrow({ where: { id } });

  it('recordMemory (started/completed/failed)', async () => {
    const instr = ctx.deps.instr;
    const base = { source: 'SIMULATED' as const, memorySource: 'session-memory-A', category: 'user-preferences', itemCount: 3, estimatedTokens: 120, payloadBytes: 480, traceId: 't_mem' };
    const opId = await instr.recordMemory({ ...base, phase: 'STARTED' });
    expect(await instr.recordMemory({ ...base, phase: 'COMPLETED', operationId: opId, durationMs: 12 })).toBe(opId);
    await instr.recordMemory({ ...base, phase: 'FAILED', operationId: opId, durationMs: 3, errorMessage: 'store unavailable', stack: 'stack-x' });
    const rows = await ctx.prisma.memoryEvent.findMany({ where: { operationId: opId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map(r => [r.phase, r.status])).toEqual([['STARTED', 'STARTED'], ['COMPLETED', 'SUCCESS'], ['FAILED', 'FAILURE']]);
    expect(rows[1].durationMs).toBe(12);
    expect(rows[2].errorMessage).toBe('store unavailable');
    const logs = await ctx.prisma.executionLog.findMany({ where: { operation: 'session-memory-A' }, orderBy: { ts: 'asc' } });
    expect(logs.map(l => l.eventType)).toEqual(['memory.injection.started', 'memory.injection.completed', 'memory.injection.failed']);
    expect(logs.every(l => l.category === 'MEMORY' && l.source === 'SIMULATED')).toBe(true);
    expect(logs[2]).toMatchObject({ level: 'ERROR', status: 'FAILURE', errorCategory: 'MEMORY', errorMessage: 'store unavailable', stack: 'stack-x' });
    expect(logs[0]).toMatchObject({ level: 'INFO', status: 'STARTED' });
    const jl = readJsonl(logDir()).filter(l => l.operation === 'session-memory-A');
    expect(jl).toHaveLength(3);
    expect(jl[2]).toMatchObject({ id: logs[2].id, eventType: 'memory.injection.failed' });
  });

  it('recordBus', async () => {
    const instr = ctx.deps.instr;
    const ok = await instr.recordBus({ source: 'ACTUAL', operationName: 'budget.alert.publish', operationType: 'PUBLISH', eventName: 'budget.threshold', inputMeta: { threshold: 80, keys: ['a'] }, outputStatus: 'delivered', success: true, durationMs: 2, traceId: 't_bus' });
    const bad = await instr.recordBus({ source: 'SIMULATED', operationName: 'bus.fail.op', operationType: 'DISPATCH', eventName: 'x', success: false, errorMessage: 'no route', stack: 'st' });
    const rows = await ctx.prisma.busEvent.findMany({ orderBy: { createdAt: 'asc' } });
    const r1 = rows.find(r => r.operationId === ok)!;
    expect(r1).toMatchObject({ status: 'SUCCESS', outputStatus: 'delivered', operationType: 'PUBLISH', source: 'ACTUAL' });
    expect(JSON.parse(r1.inputMeta)).toEqual({ threshold: 80, keys: ['a'] });
    expect(rows.find(r => r.operationId === bad)).toMatchObject({ status: 'FAILURE', errorMessage: 'no route', stack: 'st' });
    const log = await ctx.prisma.executionLog.findFirstOrThrow({ where: { operation: 'budget.alert.publish' } });
    expect(log).toMatchObject({ eventType: 'bus.operation', category: 'BUS', status: 'SUCCESS', level: 'INFO' });
    const flog = await ctx.prisma.executionLog.findFirstOrThrow({ where: { operation: 'bus.fail.op' } });
    expect(flog).toMatchObject({ level: 'ERROR', status: 'FAILURE', errorCategory: 'BUS' });
    expect(readJsonl(logDir()).some(l => l.id === log.id)).toBe(true);
    expect(readJsonl(logDir()).some(l => l.id === flog.id)).toBe(true);
  });

  it('recordTool (initiated, completed, failed with timeout mapped to TIMEOUT)', async () => {
    const instr = ctx.deps.instr;
    const startedAt = new Date(Date.now() - 100);
    await instr.recordTool({ source: 'SIMULATED', toolName: 'web.search', toolCallId: 'call_1', startedAt, success: true, phase: 'INITIATED', traceId: 't_tool' });
    expect(await ctx.prisma.toolCallEvent.count({ where: { toolCallId: 'call_1' } })).toBe(0); // initiated: log only
    await instr.recordTool({ source: 'SIMULATED', toolName: 'web.search', toolCallId: 'call_1', startedAt, endedAt: new Date(), success: true, inputMeta: { prompt: 'secret search', paramCount: 1 }, outputMeta: { resultCount: 3 }, traceId: 't_tool' });
    await instr.recordTool({ source: 'SIMULATED', toolName: 'web.search', toolCallId: 'call_2', startedAt, success: false, errorMessage: 'upstream timed out', retryCount: 1, maxRetries: 2, durationMs: 77 });
    await instr.recordTool({ source: 'SIMULATED', toolName: 'web.search', toolCallId: 'call_3', startedAt, success: false, errorMessage: 'bad args' });
    const rows = await ctx.prisma.toolCallEvent.findMany({ orderBy: { createdAt: 'asc' } });
    const ok = rows.find(r => r.toolCallId === 'call_1')!;
    expect(ok.status).toBe('SUCCESS');
    expect(ok.durationMs).toBeGreaterThanOrEqual(90);
    expect(JSON.parse(ok.inputMeta).prompt.redacted).toBe(true);
    expect(JSON.parse(ok.inputMeta).paramCount).toBe(1);
    expect(rows.find(r => r.toolCallId === 'call_2')).toMatchObject({ status: 'FAILURE', retryCount: 1, maxRetries: 2, durationMs: 77 });
    const logs = await ctx.prisma.executionLog.findMany({ where: { operation: 'web.search' }, orderBy: { ts: 'asc' } });
    expect(logs.map(l => l.eventType).sort()).toEqual(['tool.call.completed', 'tool.call.failed', 'tool.call.failed', 'tool.call.initiated']);
    expect(logs.find(l => l.eventType === 'tool.call.initiated')!.status).toBe('STARTED');
    const f = logs.filter(l => l.eventType === 'tool.call.failed');
    expect(f.map(l => l.errorCategory).sort()).toEqual(['TIMEOUT', 'TOOL']);
    expect(readJsonl(logDir()).filter(l => l.operation === 'web.search')).toHaveLength(4);
  });

  it('recordContext', async () => {
    const instr = ctx.deps.instr;
    await instr.recordContext({ source: 'SIMULATED', contextId: 'ctx_1', operation: 'CREATED', contextSource: 'agent', sizeBytes: 1024, estimatedTokens: 256, version: 1, durationMs: 4, traceId: 't_ctx' });
    await instr.recordContext({ source: 'SIMULATED', contextId: 'ctx_1', operation: 'MODIFIED', contextSource: 'agent', sizeBytes: 2048, estimatedTokens: 512, version: 2, success: false, errorMessage: 'conflict' });
    const rows = await ctx.prisma.contextEvent.findMany({ where: { contextId: 'ctx_1' }, orderBy: { version: 'asc' } });
    expect(rows.map(r => [r.operation, r.status, r.version])).toEqual([['CREATED', 'SUCCESS', 1], ['MODIFIED', 'FAILURE', 2]]);
    const logs = await ctx.prisma.executionLog.findMany({ where: { operation: 'ctx_1' }, orderBy: { ts: 'asc' } });
    expect(logs.map(l => l.eventType)).toEqual(['context.created', 'context.modified']);
    expect(logs[1]).toMatchObject({ level: 'ERROR', status: 'FAILURE', errorCategory: 'CONTEXT', category: 'CONTEXT' });
    expect(readJsonl(logDir()).filter(l => l.operation === 'ctx_1')).toHaveLength(2);
  });

  it('recordActivity', async () => {
    const instr = ctx.deps.instr;
    await instr.recordActivity({ type: 'project.created', message: 'Project "Demo" created', source: 'ACTUAL', metadata: { name: 'Demo', description: 'sensitive description text' } });
    await instr.recordActivity({ type: 'request.failed', level: 'ERROR', message: 'mock failure', source: 'ACTUAL', traceId: 't_act' });
    const rows = await ctx.prisma.activityEvent.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map(r => [r.type, r.level])).toEqual([['project.created', 'INFO'], ['request.failed', 'ERROR']]);
    expect(JSON.parse(rows[0].metadata).name).toBe('Demo');
    const logs = await ctx.prisma.executionLog.findMany({ where: { eventType: { startsWith: 'activity.' } }, orderBy: { ts: 'asc' } });
    expect(logs.map(l => l.eventType)).toEqual(['activity.project.created', 'activity.request.failed']);
    expect(logs[1]).toMatchObject({ level: 'ERROR', status: 'FAILURE', operation: 'request.failed' });
    expect(logs[0]).toMatchObject({ status: 'INFO', operation: 'project.created' });
    expect(readJsonl(logDir()).filter(l => l.eventType.startsWith('activity.'))).toHaveLength(2);
  });

  it('recordError and log (error log has errorCategory/stack; operation searchable)', async () => {
    const instr = ctx.deps.instr;
    await instr.recordError({ source: 'ACTUAL', category: 'DATABASE', operation: 'db.write.thing', error: new Error('disk full'), attributes: { table: 'x' }, traceId: 't_e' });
    await instr.recordError({ source: 'ACTUAL', category: 'UNKNOWN', operation: 'weird', error: 'plain string' });
    await instr.log({ level: 'WARN', eventType: 'custom.event', category: 'SYSTEM', operation: 'custom.op', status: 'INFO', source: 'ACTUAL', message: 'hello', durationMs: 5, attributes: { a: 1 } });
    const e = await ctx.prisma.executionLog.findFirstOrThrow({ where: { operation: 'db.write.thing' } });
    expect(e).toMatchObject({ eventType: 'error', category: 'ERROR', level: 'ERROR', status: 'FAILURE', errorCategory: 'DATABASE', errorMessage: 'disk full' });
    expect(e.stack).toContain('disk full');
    const w = await ctx.prisma.executionLog.findFirstOrThrow({ where: { operation: 'weird' } });
    expect(w.errorMessage).toBe('plain string');
    const c = await ctx.prisma.executionLog.findFirstOrThrow({ where: { operation: 'custom.op' } });
    expect(c).toMatchObject({ level: 'WARN', durationMs: 5, eventType: 'custom.event' });
    const jl = readJsonl(logDir());
    expect(jl.find(l => l.id === e.id)).toMatchObject({ errorCategory: 'DATABASE', source: 'ACTUAL' });
    expect(jl.find(l => l.id === c.id)!.attributes).toEqual({ a: 1 });
  });

  it('JSONL file is named by UTC day, one valid JSON object per line, equal to the DB row', async () => {
    const files = fs.readdirSync(logDir()).filter(f => f.endsWith('.jsonl'));
    expect(files).toContain(`execution-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const lines = fs.readFileSync(path.join(logDir(), files[0]), 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      const o = JSON.parse(l);
      expect(Object.keys(o)).toEqual(expect.arrayContaining(['id', 'ts', 'level', 'eventType', 'category', 'operation', 'status', 'source', 'attributes']));
    }
    const dbLog = await ctx.prisma.executionLog.findFirstOrThrow({ where: { operation: 'custom.op' } });
    const jl = readJsonl(logDir()).find(l => l.id === dbLog.id)!;
    expect(jl.ts).toBe(dbLog.ts.toISOString());
    expect(jl.message).toBe(dbLog.message);
  });
});

describe('background tasks', () => {
  it('persists QUEUED->RUNNING->SUCCEEDED with duration and result; idempotent', async () => {
    const instr = ctx.deps.instr;
    const t = await instr.startTask({ name: 'unit.task', kind: 'OTHER', source: 'ACTUAL' });
    let row = await ctx.prisma.backgroundTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.status).toBe('RUNNING');
    expect(row.startedAt).toBeInstanceOf(Date);
    await sleep(20);
    await t.succeed({ processed: 5 });
    await t.fail(new Error('ignored after success'));
    row = await ctx.prisma.backgroundTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.status).toBe('SUCCEEDED');
    expect(row.durationMs).toBeGreaterThanOrEqual(15);
    expect(JSON.parse(row.result)).toEqual({ processed: 5 });
    const logs = await ctx.prisma.executionLog.findMany({ where: { operation: 'unit.task' }, orderBy: { ts: 'asc' } });
    expect(logs.map(l => l.eventType)).toEqual(['background.task.started', 'background.task.completed']);
  });

  it('persists failures with error and stack', async () => {
    const t = await ctx.deps.instr.startTask({ name: 'unit.failing', kind: 'DEMO_SEED', source: 'SIMULATED' });
    await t.fail(new Error('seed broke'));
    const row = await ctx.prisma.backgroundTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(row).toMatchObject({ status: 'FAILED', errorMessage: 'seed broke', source: 'SIMULATED', kind: 'DEMO_SEED' });
    expect(row.stack).toContain('seed broke');
    const log = await ctx.prisma.executionLog.findFirstOrThrow({ where: { operation: 'unit.failing', eventType: 'background.task.failed' } });
    expect(log).toMatchObject({ level: 'ERROR', status: 'FAILURE' });
  });
});

describe('resilience: instrumentation failures never crash the app', () => {
  it('swallows DB failures, reports via onError, still writes JSONL and returns ids', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = path.join(ctx.dir, 'resilience-logs');
    const broken = new Proxy(ctx.prisma, {
      get(target, prop, recv) {
        if (['memoryEvent', 'executionLog', 'trace', 'span', 'backgroundTask', 'activityEvent'].includes(String(prop))) {
          return new Proxy({}, { get: () => async () => { throw new Error('db down'); } });
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const instr = createInstrumentation(broken, { logDir: dir, onError: (_e, c) => errors.push(c) });
    const opId = await instr.recordMemory({ source: 'ACTUAL', phase: 'STARTED', memorySource: 'm', category: 'c', itemCount: 1, estimatedTokens: 1, payloadBytes: 1 });
    expect(opId).toBeTruthy();
    const trace = await instr.startTrace({ name: 'x', source: 'ACTUAL' });
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    const span = await trace.startSpan('s', 'INTERNAL');
    await expect(span.end(new Error('e'))).resolves.toBeGreaterThanOrEqual(0);
    await expect(trace.end()).resolves.toBeGreaterThanOrEqual(0);
    const task = await instr.startTask({ name: 't', kind: 'OTHER', source: 'ACTUAL' });
    await expect(task.succeed({})).resolves.toBeUndefined();
    await expect(instr.recordActivity({ type: 'a.b', message: 'm', source: 'ACTUAL' })).resolves.toBeUndefined();
    expect(errors).toEqual(expect.arrayContaining(['memoryEvent.create', 'executionLog.create', 'trace.create', 'span.create']));
    expect(spy).toHaveBeenCalled();
    expect(readJsonl(dir).length).toBeGreaterThanOrEqual(4); // file mirror survives DB outage
    spy.mockRestore();
  });

  it('swallows file-system failures but keeps DB rows', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const blocker = path.join(ctx.dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x'); // logDir points below a regular file => mkdir/append fail
    const errors: string[] = [];
    const instr = createInstrumentation(ctx.prisma, { logDir: path.join(blocker, 'logs'), onError: (_e, c) => errors.push(c) });
    await expect(instr.log({ level: 'INFO', eventType: 'fs.fail.test', category: 'SYSTEM', operation: 'fs.fail.op', status: 'INFO', source: 'ACTUAL', message: 'm' })).resolves.toBeUndefined();
    expect(errors).toContain('jsonl.append');
    expect(await ctx.prisma.executionLog.count({ where: { operation: 'fs.fail.op' } })).toBe(1);
    spy.mockRestore();
  });

  it('invalid correlation (unknown FK) does not throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const trace = await ctx.deps.instr.startTrace({ name: 'bad-fk', source: 'ACTUAL', projectId: 'does-not-exist' });
    await expect(trace.end()).resolves.toBeGreaterThanOrEqual(0);
    spy.mockRestore();
  });
});

describe('persistence across restart', () => {
  it('rows and JSONL survive ctx.restart()', async () => {
    const trace = await ctx.deps.instr.startTrace({ name: 'persist.me', source: 'ACTUAL' });
    await trace.end();
    const before = readJsonl(logDir()).length;
    const c2 = await ctx.restart();
    try {
      expect(await c2.prisma.trace.count({ where: { traceId: trace.traceId } })).toBe(1);
      expect(readJsonl(c2.deps.config.logDir).length).toBe(before);
      await c2.deps.instr.log({ level: 'INFO', eventType: 'after.restart', category: 'SYSTEM', operation: 'after', status: 'INFO', source: 'ACTUAL', message: 'm' });
      expect(readJsonl(c2.deps.config.logDir).length).toBe(before + 1); // appends to the same file
    } finally {
      await c2.close();
    }
    ctx = await (async () => { const { createTestApp: c } = await import('../helpers/testApp'); return c({ dir: ctx.dir }); })();
  });
});
