import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { pageOf } from '../../utils/http';
import type { ErrorCategory, ErrorGroup, ExecutionLogDto } from '../../../../shared/types';
import {
  ERROR_CATEGORIES, SOURCE_ENUM, checkRange, listBase, mapExecutionLog, rangeFilter, rangeShape, searchOr, skipTake,
} from './common';
import { ERROR_WHERE } from './overview';

const filterShape = {
  category: ERROR_CATEGORIES.optional(), // ExecutionLog.errorCategory (same values /errors/groups reports)
  search: z.string().trim().min(1).max(200).optional(),
  traceId: z.string().min(1).max(64).optional(),
  source: SOURCE_ENUM.optional(),
  ...rangeShape,
};
export const errorsQuery = listBase.extend(filterShape).superRefine(checkRange);
export const errorGroupsQuery = z.object(filterShape).superRefine(checkRange);

/** Errors = ExecutionLog rows with level ERROR or status FAILURE. `search` matches message, errorMessage, operation, eventType. */
function errorWhere(q: z.infer<typeof errorGroupsQuery>): Prisma.ExecutionLogWhereInput {
  const and: Prisma.ExecutionLogWhereInput[] = [ERROR_WHERE];
  if (q.category) and.push({ errorCategory: q.category });
  if (q.traceId) and.push({ traceId: q.traceId });
  if (q.source) and.push({ source: q.source });
  const r = rangeFilter(q.from, q.to);
  if (r) and.push({ ts: r });
  const s = searchOr(q.search, ['message', 'errorMessage', 'operation', 'eventType']);
  if (s) and.push(s);
  return { AND: and };
}

export async function listErrors(prisma: PrismaClient, q: z.infer<typeof errorsQuery>): Promise<{ data: ExecutionLogDto[]; pagination: ReturnType<typeof pageOf> }> {
  const where = errorWhere(q);
  const [total, rows] = await Promise.all([
    prisma.executionLog.count({ where }),
    prisma.executionLog.findMany({ where, orderBy: [{ ts: 'desc' }, { id: 'desc' }], ...skipTake(q.page, q.pageSize) }),
  ]);
  return { data: rows.map(mapExecutionLog), pagination: pageOf(total, q.page, q.pageSize) };
}

/** Groups by errorCategory (null -> UNKNOWN), most frequent first. */
export async function errorGroups(prisma: PrismaClient, q: z.infer<typeof errorGroupsQuery>): Promise<ErrorGroup[]> {
  const rows = await prisma.executionLog.groupBy({
    by: ['errorCategory'], where: errorWhere(q), _count: { _all: true }, _max: { ts: true },
  });
  const merged = new Map<ErrorCategory, { count: number; last: Date }>();
  for (const r of rows) {
    const cat = (r.errorCategory ?? 'UNKNOWN') as ErrorCategory;
    const cur = merged.get(cat);
    const last = r._max.ts as Date;
    if (cur) { cur.count += r._count._all; if (last > cur.last) cur.last = last; } else merged.set(cat, { count: r._count._all, last });
  }
  return [...merged.entries()]
    .map(([category, v]) => ({ category, count: v.count, lastSeen: v.last.toISOString() }))
    .sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0) || a.category.localeCompare(b.category));
}
