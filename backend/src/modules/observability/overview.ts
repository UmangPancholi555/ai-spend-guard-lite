import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { ObservabilityOverview } from '../../../../shared/types';
import { checkRange, mapExecutionLog, mapTrace, rangeShape, resolveRange } from './common';
import { avg, rate } from './stats';

export const overviewQuery = z.object(rangeShape).superRefine(checkRange);

/** An "operation" = one ExecutionLog row with status SUCCESS or FAILURE (STARTED/INFO rows are not operations). */
export const OPERATION_STATUSES = ['SUCCESS', 'FAILURE'];
/** An "error" = ExecutionLog row with level ERROR or status FAILURE. */
export const ERROR_WHERE: Prisma.ExecutionLogWhereInput = { OR: [{ level: 'ERROR' }, { status: 'FAILURE' }] };

/**
 * Overview over [from,to] (default: last 7 days).
 *  - totals.operations / successful / failed: ExecutionLog rows with status SUCCESS|FAILURE and ts in range.
 *  - memoryInjections: MemoryEvent rows with phase COMPLETED|FAILED (STARTED rows are not counted twice).
 *  - busOperations / toolCalls / contextUpdates: BusEvent / ToolCallEvent / ContextEvent rows (createdAt in range).
 *  - averageDurationMs: mean durationMs of operations that have a duration (0 if none); failureRate = failed / operations (0..1).
 *  - bySource: operation counts by ExecutionLog.source.
 */
export async function getOverview(prisma: PrismaClient, q: z.infer<typeof overviewQuery>): Promise<ObservabilityOverview> {
  const { from, to } = resolveRange(q.from, q.to);
  const ts = { gte: from, lte: to };
  const createdAt = { gte: from, lte: to };
  const opWhere: Prisma.ExecutionLogWhereInput = { ts, status: { in: OPERATION_STATUSES } };

  const [byStatusSource, durAgg, memoryInjections, busOperations, toolCalls, contextUpdates, errors, traces] = await Promise.all([
    prisma.executionLog.groupBy({ by: ['status', 'source'], where: opWhere, _count: { _all: true } }),
    prisma.executionLog.aggregate({ where: { ...opWhere, durationMs: { not: null } }, _avg: { durationMs: true } }),
    prisma.memoryEvent.count({ where: { createdAt, phase: { in: ['COMPLETED', 'FAILED'] } } }),
    prisma.busEvent.count({ where: { createdAt } }),
    prisma.toolCallEvent.count({ where: { createdAt } }),
    prisma.contextEvent.count({ where: { createdAt } }),
    prisma.executionLog.findMany({ where: { AND: [{ ts }, ERROR_WHERE] }, orderBy: [{ ts: 'desc' }, { id: 'desc' }], take: 10 }),
    prisma.trace.findMany({
      where: { startedAt: { gte: from, lte: to } }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 10,
      include: { _count: { select: { spans: true } } },
    }),
  ]);

  let successful = 0, failed = 0, actual = 0, simulated = 0;
  for (const g of byStatusSource) {
    const n = g._count._all;
    if (g.status === 'SUCCESS') successful += n; else failed += n;
    if (g.source === 'ACTUAL') actual += n; else simulated += n;
  }
  const operations = successful + failed;
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    totals: {
      operations, successful, failed, memoryInjections, busOperations, toolCalls, contextUpdates,
      averageDurationMs: avg(durAgg._avg.durationMs === null ? [] : [durAgg._avg.durationMs]),
      failureRate: rate(failed, operations),
    },
    bySource: { actual, simulated },
    recentErrors: errors.map(mapExecutionLog),
    recentTraces: traces.map(t => mapTrace(t, t._count.spans)),
  };
}
