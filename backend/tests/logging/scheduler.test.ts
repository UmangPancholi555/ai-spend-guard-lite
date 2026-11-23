import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import type { AppDeps } from '../../src/contracts/services';
import { startRetentionScheduler } from '../../src/modules/logging';
import { createTestApp, cleanupTestDir } from '../helpers/testApp';

const HOUR = 3_600_000;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Pure in-memory deps: lets us drive the scheduler with fake timers (no real I/O). */
function stubDeps(opts: { retentionDays?: number; sweepMs?: number; failFirst?: number } = {}) {
  const st = { started: 0, running: 0, maxRunning: 0, succeeded: [] as Record<string, unknown>[], failed: [] as unknown[], deleteCutoffs: [] as Date[] };
  let failuresLeft = opts.failFirst ?? 0;
  const zero = { deleteMany: async () => ({ count: 0 }) };
  const prisma = {
    appSetting: { findMany: async () => (opts.retentionDays === undefined ? [] : [{ key: 'retentionDays', value: String(opts.retentionDays) }]) },
    executionLog: {
      deleteMany: async (a: { where: { ts: { lt: Date } } }) => {
        st.deleteCutoffs.push(a.where.ts.lt);
        if (opts.sweepMs) await new Promise(r => setTimeout(r, opts.sweepMs));
        if (failuresLeft > 0) { failuresLeft--; throw new Error('sweep exploded'); }
        return { count: 3 };
      },
    },
    memoryEvent: zero, busEvent: zero, toolCallEvent: zero, contextEvent: zero, trace: zero,
    span: { count: async () => 0 },
    backgroundTask: {
      findUnique: async () => ({ id: 't', name: 'retention.sweep', kind: 'RETENTION_SWEEP', status: 'SUCCEEDED', source: 'ACTUAL', traceId: null, startedAt: new Date(), endedAt: new Date(), durationMs: 1, result: '{}', errorMessage: null, stack: null, createdAt: new Date() }),
    },
  };
  const instr = {
    startTask: async () => {
      st.started++; st.running++; st.maxRunning = Math.max(st.maxRunning, st.running);
      return {
        id: 't',
        succeed: async (r?: Record<string, unknown>) => { st.running--; st.succeeded.push(r ?? {}); },
        fail: async (e: unknown) => { st.running--; st.failed.push(e); },
      };
    },
  };
  const deps = { prisma, instr, config: { logDir: path.join(os.tmpdir(), 'no-such-logdir-xyz') } } as unknown as AppDeps;
  return { deps, st };
}

describe('startRetentionScheduler (fake timers)', () => {
  it('first run ~60s after start, then every interval (default 6h); each run is a scheduled sweep task', async () => {
    vi.useFakeTimers();
    const { deps, st } = stubDeps({});
    const s = startRetentionScheduler(deps);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(st.started).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(st.started).toBe(1);
    expect(st.succeeded[0]).toMatchObject({ trigger: 'scheduled', retentionDays: 30, skipped: false });
    await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
    expect(st.started).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(st.started).toBe(2);
    s.stop();
  });

  it('honours custom intervals and the injected clock for the cutoff', async () => {
    vi.useFakeTimers();
    const { deps, st } = stubDeps({ retentionDays: 10 });
    const fixed = new Date('2026-06-15T12:00:00.000Z');
    const s = startRetentionScheduler(deps, { intervalMs: 1000, firstDelayMs: 500, now: () => fixed });
    await vi.advanceTimersByTimeAsync(500);
    expect(st.started).toBe(1);
    expect(st.deleteCutoffs[0].toISOString()).toBe('2026-06-05T12:00:00.000Z');
    expect(st.succeeded[0].cutoff).toBe('2026-06-05T12:00:00.000Z');
    await vi.advanceTimersByTimeAsync(3000);
    expect(st.started).toBe(4);
    s.stop();
  });

  it('skips (no task row) when retentionDays = 0 and keeps scheduling', async () => {
    vi.useFakeTimers();
    const { deps, st } = stubDeps({ retentionDays: 0 });
    const s = startRetentionScheduler(deps, { intervalMs: 100, firstDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(st.started).toBe(0);
    expect(st.deleteCutoffs).toHaveLength(0);
    s.stop();
  });

  it('never overlaps itself even when a sweep takes longer than the interval', async () => {
    vi.useFakeTimers();
    const { deps, st } = stubDeps({ sweepMs: 1000 });
    const s = startRetentionScheduler(deps, { intervalMs: 100, firstDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(st.maxRunning).toBe(1);
    expect(st.started).toBeGreaterThanOrEqual(3);
    expect(st.started).toBeLessThanOrEqual(5);
    // runNow while a sweep is already running is a no-op
    const before = st.started;
    const p = Promise.all([s.runNow(), s.runNow(), s.runNow()]);
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(st.maxRunning).toBe(1);
    expect(st.started - before).toBeLessThanOrEqual(2);
    s.stop();
  });

  it('survives errors: records the FAILED task (via the sweep), logs to console, keeps scheduling', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, st } = stubDeps({ failFirst: 1 });
    const s = startRetentionScheduler(deps, { intervalMs: 100, firstDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(st.failed).toHaveLength(1);
    expect((st.failed[0] as Error).message).toBe('sweep exploded');
    expect(spy).toHaveBeenCalledWith('[retention] scheduled sweep failed:', 'sweep exploded');
    await vi.advanceTimersByTimeAsync(100);
    expect(st.succeeded).toHaveLength(1);
    expect(st.running).toBe(0);
    s.stop();
  });

  it('survives startTask itself failing (e.g. DB down)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = stubDeps({});
    let calls = 0;
    (deps.instr as any).startTask = async () => { calls++; throw new Error('db down'); };
    const s = startRetentionScheduler(deps, { intervalMs: 100, firstDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(350);
    expect(calls).toBe(3);
    s.stop();
  });

  it('stop() cancels future runs (also before the first one)', async () => {
    vi.useFakeTimers();
    const a = stubDeps({});
    const s1 = startRetentionScheduler(a.deps, { intervalMs: 100, firstDelayMs: 100 });
    s1.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.st.started).toBe(0);
    const b = stubDeps({});
    const s2 = startRetentionScheduler(b.deps, { intervalMs: 100, firstDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(250);
    const n = b.st.started;
    expect(n).toBeGreaterThan(0);
    s2.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.st.started).toBe(n);
    await s2.runNow(); // no-op after stop
    expect(b.st.started).toBe(n);
  });
});

describe('startRetentionScheduler (real timers)', () => {
  it('timers are unref()ed so they never keep the process alive', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const { deps } = stubDeps({});
    const s = startRetentionScheduler(deps);
    const timer = spy.mock.results[0].value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    s.stop();
  });

  it('end to end on a real DB: creates an ACTUAL RETENTION_SWEEP task with trigger "scheduled" and deletes old data', async () => {
    const ctx = await createTestApp();
    try {
      const old = new Date(Date.now() - 90 * 86_400_000);
      await ctx.deps.instr.recordBus({ source: 'ACTUAL', operationName: 'sched-old', operationType: 'PUBLISH', eventName: 'e', success: true, ...({ at: old } as object) });
      await ctx.deps.instr.recordBus({ source: 'ACTUAL', operationName: 'sched-new', operationType: 'PUBLISH', eventName: 'e', success: true });
      const s = startRetentionScheduler(ctx.deps, { firstDelayMs: 10, intervalMs: 3_600_000 });
      let task = null;
      for (let i = 0; i < 100 && !task; i++) {
        await new Promise(r => setTimeout(r, 50));
        task = await ctx.prisma.backgroundTask.findFirst({ where: { kind: 'RETENTION_SWEEP', status: 'SUCCEEDED' } });
      }
      s.stop();
      expect(task).toBeTruthy();
      expect(task!.source).toBe('ACTUAL');
      const result = JSON.parse(task!.result);
      expect(result.trigger).toBe('scheduled');
      expect(result.deleted.busEvents).toBe(1);
      expect((await ctx.prisma.busEvent.findMany()).map(b => b.operationName)).toEqual(['sched-new']);
      const api = await request(ctx.app).get('/api/background-tasks?kind=RETENTION_SWEEP');
      expect(api.status).toBe(200);
    } finally { await ctx.close(); cleanupTestDir(ctx.dir); }
  });
});
