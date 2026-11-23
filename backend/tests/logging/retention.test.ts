import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { readJsonl } from '../instrumentation/util';

let ctx: TestCtx;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

async function seed() {
  const i = ctx.deps.instr;
  const at = (d: Date) => ({ at: d } as object);
  for (const [tag, d] of [['old', daysAgo(40)], ['new', daysAgo(2)]] as const) {
    await i.recordMemory({ source: 'SIMULATED', phase: 'COMPLETED', memorySource: `mem-${tag}`, category: 'c', itemCount: 1, estimatedTokens: 1, payloadBytes: 1, ...at(d) });
    await i.recordBus({ source: 'ACTUAL', operationName: `bus-${tag}`, operationType: 'PUBLISH', eventName: 'e', success: true, ...at(d) });
    await i.recordTool({ source: 'SIMULATED', toolName: `tool-${tag}`, toolCallId: `c-${tag}`, startedAt: d, endedAt: d, success: true });
    await i.recordContext({ source: 'SIMULATED', contextId: `ctx-${tag}`, operation: 'CREATED', contextSource: 's', sizeBytes: 1, estimatedTokens: 1, version: 1, ...at(d) });
    const t = await i.startTrace({ name: `trace-${tag}`, source: 'ACTUAL', ...at(d) });
    const s = await t.startSpan('child', 'INTERNAL'); await s.end(); await t.end();
    await i.recordActivity({ type: `act.${tag}`, message: 'm', source: 'ACTUAL', ...at(d) });
  }
  // old but RUNNING trace must be kept
  await i.startTrace({ name: 'trace-old-running', source: 'ACTUAL', ...at(daysAgo(60)) });
}

describe('POST /logging/retention/run', () => {
  it('deletes only data older than retentionDays, keeps new data, running traces and usage-like tables', async () => {
    await seed();
    const logDir = ctx.deps.config.logDir;
    // backdated events already created JSONL files for -40d and -60d; add -45d (old), -1d (new) and a foreign file that must stay
    const oldFile = path.join(logDir, `execution-${daysAgo(45).toISOString().slice(0, 10)}.jsonl`);
    const newFile = path.join(logDir, `execution-${daysAgo(1).toISOString().slice(0, 10)}.jsonl`);
    const foreign = path.join(logDir, 'notes.txt');
    fs.writeFileSync(oldFile, '{}\n'); fs.writeFileSync(newFile, '{}\n'); fs.writeFileSync(foreign, 'keep');
    const beforeSpans = await ctx.prisma.span.count();

    const res = await request(ctx.app).post('/api/logging/retention/run');
    expect(res.status).toBe(200);
    const task = res.body.data;
    expect(task).toMatchObject({ kind: 'RETENTION_SWEEP', status: 'SUCCEEDED', source: 'ACTUAL' });
    expect(task.durationMs).toBeGreaterThanOrEqual(0);
    expect(task.result.retentionDays).toBe(30);
    expect(task.result.deleted).toMatchObject({ memoryEvents: 1, busEvents: 1, toolCallEvents: 1, contextEvents: 1, traces: 1, spans: 2, logFiles: 3 });
    expect(task.result.deleted.executionLogs).toBeGreaterThanOrEqual(7);
    expect(task.result.totalDeleted).toBeGreaterThan(10);

    expect(await ctx.prisma.memoryEvent.findMany({ select: { memorySource: true } })).toEqual([{ memorySource: 'mem-new' }]);
    expect((await ctx.prisma.busEvent.findMany()).map(b => b.operationName)).toEqual(['bus-new']);
    expect((await ctx.prisma.toolCallEvent.findMany()).map(b => b.toolName)).toEqual(['tool-new']);
    expect((await ctx.prisma.contextEvent.findMany()).map(b => b.contextId)).toEqual(['ctx-new']);
    expect((await ctx.prisma.trace.findMany({ orderBy: { name: 'asc' } })).map(t => t.name)).toEqual(['trace-new', 'trace-old-running']);
    expect(await ctx.prisma.span.count()).toBe(beforeSpans - 2); // cascade removed old trace's spans
    expect(await ctx.prisma.span.count({ where: { trace: { name: 'trace-old' } } })).toBe(0);
    const logs = await ctx.prisma.executionLog.findMany();
    expect(logs.some(l => l.ts < daysAgo(30))).toBe(false);
    expect(logs.some(l => l.operation === 'mem-new')).toBe(true);
    // activity events are not part of the sweep
    expect(await ctx.prisma.activityEvent.count({ where: { type: 'act.old' } })).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    // task persisted in BackgroundTask and visible in tasks export
    const row = await ctx.prisma.backgroundTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('SUCCEEDED');
    expect(JSON.parse(row.result).deleted.traces).toBe(1);
    // and the sweep itself logged ACTUAL events
    expect(readJsonl(logDir).some(l => l.eventType === 'background.task.completed' && l.operation === 'retention.sweep')).toBe(true);
  });

  it('is idempotent: a second run deletes nothing', async () => {
    const res = await request(ctx.app).post('/api/logging/retention/run');
    expect(res.body.data.status).toBe('SUCCEEDED');
    const d = res.body.data.result.deleted;
    expect(d).toMatchObject({ memoryEvents: 0, busEvents: 0, toolCallEvents: 0, contextEvents: 0, traces: 0, spans: 0, logFiles: 0 });
  });

  it('retentionDays = 0 keeps everything forever', async () => {
    await request(ctx.app).put('/api/settings').send({ retentionDays: 0 });
    await ctx.deps.instr.recordBus({ source: 'ACTUAL', operationName: 'bus-ancient', operationType: 'PUBLISH', eventName: 'e', success: true, ...({ at: daysAgo(4000) } as object) });
    const res = await request(ctx.app).post('/api/logging/retention/run');
    expect(res.body.data.status).toBe('SUCCEEDED');
    expect(res.body.data.result).toMatchObject({ skipped: true, retentionDays: 0, totalDeleted: 0 });
    expect(await ctx.prisma.busEvent.count({ where: { operationName: 'bus-ancient' } })).toBe(1);
  });

  it('honours a shorter retention window', async () => {
    await request(ctx.app).put('/api/settings').send({ retentionDays: 1 });
    const res = await request(ctx.app).post('/api/logging/retention/run');
    expect(res.body.data.result.deleted.busEvents).toBeGreaterThanOrEqual(2);
    expect(await ctx.prisma.busEvent.count()).toBe(0);
    expect(await ctx.prisma.memoryEvent.count()).toBe(0);
  });

  it('records a FAILED task with stack when the sweep throws, and returns 500', async () => {
    const original = ctx.prisma.executionLog.deleteMany;
    (ctx.prisma.executionLog as any).deleteMany = async () => { throw new Error('disk I/O error'); };
    const res = await request(ctx.app).post('/api/logging/retention/run');
    (ctx.prisma.executionLog as any).deleteMany = original;
    expect(res.status).toBe(500);
    const failed = await ctx.prisma.backgroundTask.findFirstOrThrow({ where: { kind: 'RETENTION_SWEEP', status: 'FAILED' } });
    expect(failed.errorMessage).toBe('disk I/O error');
    expect(failed.stack).toContain('disk I/O error');
  });
});

describe('restart persistence', () => {
  it('logs, JSONL files, tasks and settings survive ctx.restart()', async () => {
    await request(ctx.app).put('/api/settings').send({ retentionDays: 21 });
    await ctx.deps.instr.log({ level: 'INFO', eventType: 'persist.check', category: 'SYSTEM', operation: 'persist.op', status: 'INFO', source: 'ACTUAL', message: 'hello' });
    const jsonlBefore = readJsonl(ctx.deps.config.logDir).filter(l => l.operation === 'persist.op').length;
    const c2 = await ctx.restart();
    try {
      const logs = await request(c2.app).get('/api/logs?search=persist.op');
      expect(logs.body.data).toHaveLength(1);
      expect((await request(c2.app).get('/api/settings')).body.data.retentionDays).toBe(21);
      expect(await c2.prisma.backgroundTask.count({ where: { kind: 'RETENTION_SWEEP' } })).toBeGreaterThan(0);
      expect(readJsonl(c2.deps.config.logDir).filter(l => l.operation === 'persist.op')).toHaveLength(jsonlBefore);
      const exp = await request(c2.app).get('/api/export/logs?search=persist.op');
      expect(exp.status).toBe(200);
    } finally { await c2.close(); }
    ctx = await createTestApp({ dir: ctx.dir });
  });
});
