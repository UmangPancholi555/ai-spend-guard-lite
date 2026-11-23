import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { LogCategory, OperationStat, PerformanceStats } from '../../../../shared/types';
import { checkRange, loadSlowThresholdMs, mapExecutionLog, rangeShape, resolveRange } from './common';
import { avg, max, percentile, rate, round2 } from './stats';
import { OPERATION_STATUSES } from './overview';

export const performanceQuery = z.object({ ...rangeShape, bucket: z.enum(['hour', 'day']).optional() }).superRefine(checkRange);

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_FILLED_BUCKETS = 1000;

const latency = (nums: number[]) => ({ avgMs: avg(nums), p95Ms: percentile(nums, 95), count: nums.length });

/**
 * Performance stats over [from,to] (default: last 7 days).
 *  - averageExecutionMs: mean durationMs of finished traces (status != RUNNING) that started in range.
 *  - requestLatency: ExecutionLog rows category REQUEST, status SUCCESS|FAILURE, with a duration.
 *  - toolLatency: ToolCallEvent.durationMs; memoryInjectionLatency: MemoryEvent (phase COMPLETED|FAILED) durationMs.
 *  - p95 = nearest-rank percentile computed in JS over the raw rows; avg rounded to 2 decimals. Empty -> 0.
 *  - operations / operationCounts / failureRate: ExecutionLog rows with status SUCCESS|FAILURE ("operations").
 *    Per-operation avg/p95/max only use rows with a duration.
 *  - slowOperations: operations with durationMs STRICTLY greater than AppSetting `settings`.slowOperationMs (default 500),
 *    slowest first, max 20.
 *  - durationSeries: operations with a duration, bucketed by UTC hour|day (default: hour when range <= 48h else day);
 *    zero-filled when it yields <= 1000 buckets.
 */
export async function getPerformance(prisma: PrismaClient, q: z.infer<typeof performanceQuery>): Promise<PerformanceStats> {
  const { from, to } = resolveRange(q.from, q.to);
  const slowThresholdMs = await loadSlowThresholdMs(prisma);
  const bucket = q.bucket ?? (to.getTime() - from.getTime() <= 2 * DAY ? 'hour' : 'day');

  const [ops, traces, tools, memories, slow] = await Promise.all([
    prisma.executionLog.findMany({
      where: { ts: { gte: from, lte: to }, status: { in: OPERATION_STATUSES } },
      select: { category: true, operation: true, status: true, durationMs: true, ts: true },
    }),
    prisma.trace.findMany({
      where: { startedAt: { gte: from, lte: to }, status: { not: 'RUNNING' }, durationMs: { not: null } }, select: { durationMs: true },
    }),
    prisma.toolCallEvent.findMany({ where: { createdAt: { gte: from, lte: to }, durationMs: { not: null } }, select: { durationMs: true } }),
    prisma.memoryEvent.findMany({
      where: { createdAt: { gte: from, lte: to }, phase: { in: ['COMPLETED', 'FAILED'] }, durationMs: { not: null } }, select: { durationMs: true },
    }),
    prisma.executionLog.findMany({
      where: { ts: { gte: from, lte: to }, status: { in: OPERATION_STATUSES }, durationMs: { gt: slowThresholdMs } },
      orderBy: [{ durationMs: 'desc' }, { ts: 'desc' }, { id: 'desc' }], take: 20,
    }),
  ]);

  const failed = ops.filter(o => o.status === 'FAILURE').length;
  const requestDur = ops.filter(o => o.category === 'REQUEST' && o.durationMs !== null).map(o => o.durationMs as number);

  const cat = new Map<string, { count: number; failures: number }>();
  const opMap = new Map<string, { operation: string; category: LogCategory; count: number; failures: number; durs: number[] }>();
  for (const o of ops) {
    const c = cat.get(o.category) ?? { count: 0, failures: 0 };
    c.count++; if (o.status === 'FAILURE') c.failures++;
    cat.set(o.category, c);
    const key = `${o.category}\u0000${o.operation}`;
    const s = opMap.get(key) ?? { operation: o.operation, category: o.category as LogCategory, count: 0, failures: 0, durs: [] };
    s.count++; if (o.status === 'FAILURE') s.failures++;
    if (o.durationMs !== null) s.durs.push(o.durationMs);
    opMap.set(key, s);
  }
  const operations: OperationStat[] = [...opMap.values()]
    .map(s => ({ operation: s.operation, category: s.category, count: s.count, failures: s.failures, avgMs: avg(s.durs), p95Ms: percentile(s.durs, 95), maxMs: max(s.durs) }))
    .sort((a, b) => b.count - a.count || b.avgMs - a.avgMs || a.operation.localeCompare(b.operation));

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    slowThresholdMs,
    averageExecutionMs: avg(traces.map(t => t.durationMs as number)),
    requestLatency: latency(requestDur),
    toolLatency: latency(tools.map(t => t.durationMs as number)),
    memoryInjectionLatency: latency(memories.map(m => m.durationMs as number)),
    failureRate: rate(failed, ops.length),
    operationCounts: [...cat.entries()]
      .map(([category, c]) => ({ category: category as LogCategory, count: c.count, failures: c.failures }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    operations,
    slowOperations: slow.map(mapExecutionLog),
    durationSeries: buildSeries(ops.filter(o => o.durationMs !== null) as { ts: Date; durationMs: number }[], from, to, bucket),
  };
}

function bucketStart(ms: number, bucket: 'hour' | 'day'): number {
  const size = bucket === 'hour' ? HOUR : DAY;
  return Math.floor(ms / size) * size; // epoch is UTC-aligned for both
}

function buildSeries(rows: { ts: Date; durationMs: number }[], from: Date, to: Date, bucket: 'hour' | 'day') {
  const size = bucket === 'hour' ? HOUR : DAY;
  const groups = new Map<number, number[]>();
  for (const r of rows) {
    const k = bucketStart(r.ts.getTime(), bucket);
    const g = groups.get(k);
    if (g) g.push(r.durationMs); else groups.set(k, [r.durationMs]);
  }
  const first = bucketStart(from.getTime(), bucket);
  const last = bucketStart(to.getTime(), bucket);
  const keys: number[] = [];
  if ((last - first) / size + 1 <= MAX_FILLED_BUCKETS) {
    for (let t = first; t <= last; t += size) keys.push(t);
  } else {
    keys.push(...[...groups.keys()].sort((a, b) => a - b));
  }
  return keys.map(k => {
    const g = groups.get(k) ?? [];
    return { bucket: new Date(k).toISOString(), avgMs: round2(avg(g)), count: g.length };
  });
}
