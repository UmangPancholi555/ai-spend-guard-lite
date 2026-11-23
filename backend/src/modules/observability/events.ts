import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { pageOf } from '../../utils/http';
import {
  SOURCE_ENUM, checkRange, listBase, mapBus, mapContext, mapMemory, mapTool, rangeFilter, rangeShape, searchOr, skipTake,
} from './common';

const common = {
  traceId: z.string().min(1).max(64).optional(),
  projectId: z.string().min(1).max(64).optional(),
  source: SOURCE_ENUM.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  ...rangeShape,
};
const memoryQuery = listBase.extend({ ...common, status: z.enum(['STARTED', 'SUCCESS', 'FAILURE']).optional() }).superRefine(checkRange);
const finalStatusQuery = listBase.extend({ ...common, status: z.enum(['SUCCESS', 'FAILURE']).optional() }).superRefine(checkRange);

type Q = { traceId?: string; projectId?: string; source?: 'ACTUAL' | 'SIMULATED'; status?: string; from?: Date; to?: Date; search?: string; page: number; pageSize: number };

/** common filter set; all event tables use createdAt for the date range */
function baseWhere(q: Q) {
  const w: { traceId?: string; projectId?: string; source?: string; status?: string; createdAt?: Prisma.DateTimeFilter } = {};
  if (q.traceId) w.traceId = q.traceId;
  if (q.projectId) w.projectId = q.projectId;
  if (q.source) w.source = q.source;
  if (q.status) w.status = q.status;
  const r = rangeFilter(q.from, q.to);
  if (r) w.createdAt = r;
  return w;
}
const order = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

export const memoryEvents = {
  schema: memoryQuery,
  async run(prisma: PrismaClient, q: z.infer<typeof memoryQuery>) {
    const where: Prisma.MemoryEventWhereInput = { ...baseWhere(q), ...searchOr(q.search, ['memorySource', 'category', 'operationId', 'errorMessage']) };
    const [total, rows] = await Promise.all([prisma.memoryEvent.count({ where }), prisma.memoryEvent.findMany({ where, orderBy: order, ...skipTake(q.page, q.pageSize) })]);
    return { data: rows.map(mapMemory), pagination: pageOf(total, q.page, q.pageSize) };
  },
};
export const busEvents = {
  schema: finalStatusQuery,
  async run(prisma: PrismaClient, q: z.infer<typeof finalStatusQuery>) {
    const where: Prisma.BusEventWhereInput = { ...baseWhere(q), ...searchOr(q.search, ['operationName', 'eventName', 'operationId', 'errorMessage']) };
    const [total, rows] = await Promise.all([prisma.busEvent.count({ where }), prisma.busEvent.findMany({ where, orderBy: order, ...skipTake(q.page, q.pageSize) })]);
    return { data: rows.map(mapBus), pagination: pageOf(total, q.page, q.pageSize) };
  },
};
export const toolEvents = {
  schema: finalStatusQuery,
  async run(prisma: PrismaClient, q: z.infer<typeof finalStatusQuery>) {
    const where: Prisma.ToolCallEventWhereInput = { ...baseWhere(q), ...searchOr(q.search, ['toolName', 'toolCallId', 'errorMessage']) };
    const [total, rows] = await Promise.all([prisma.toolCallEvent.count({ where }), prisma.toolCallEvent.findMany({ where, orderBy: order, ...skipTake(q.page, q.pageSize) })]);
    return { data: rows.map(mapTool), pagination: pageOf(total, q.page, q.pageSize) };
  },
};
export const contextEvents = {
  schema: finalStatusQuery,
  async run(prisma: PrismaClient, q: z.infer<typeof finalStatusQuery>) {
    const where: Prisma.ContextEventWhereInput = { ...baseWhere(q), ...searchOr(q.search, ['contextId', 'contextSource', 'operation', 'errorMessage']) };
    const [total, rows] = await Promise.all([prisma.contextEvent.count({ where }), prisma.contextEvent.findMany({ where, orderBy: order, ...skipTake(q.page, q.pageSize) })]);
    return { data: rows.map(mapContext), pagination: pageOf(total, q.page, q.pageSize) };
  },
};
