/** Traces + background tasks read API (module obs-events). */
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AppDeps } from '../../contracts/services';
import { ah, pageOf, parse } from '../../utils/http';
import { notFound } from '../../utils/errors';
import type { TraceDetail } from '../../../../shared/types';
import {
  SOURCE_ENUM, SPAN_STATUS, checkRange, cleanQuery, listBase, mapBus, mapContext, mapExecutionLog, mapMemory, mapSpan, mapTask,
  mapTool, mapTrace, rangeFilter, rangeShape, searchOr, skipTake,
} from '../observability/common';
import { buildTimeline } from './timeline';

export const tracesQuery = listBase.extend({
  status: SPAN_STATUS.optional(),
  source: SOURCE_ENUM.optional(),
  projectId: z.string().min(1).max(64).optional(),
  search: z.string().trim().min(1).max(200).optional(), // name | traceId | requestId (substring, case-insensitive)
  ...rangeShape,                                         // on startedAt, `to` inclusive
}).superRefine(checkRange);

export const tasksQuery = listBase.extend({
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']).optional(),
  kind: z.enum(['RETENTION_SWEEP', 'DEMO_SEED', 'BUDGET_EVALUATION', 'EXPORT', 'OTHER']).optional(),
  source: SOURCE_ENUM.optional(),
  ...rangeShape,                                         // on createdAt
}).superRefine(checkRange);

const traceIdParam = z.object({ traceId: z.string().min(1).max(64) });

export function createTracesRouter(deps: AppDeps): Router {
  const r = Router();
  const { prisma } = deps;

  r.get('/traces', ah(async (req, res) => {
    const q = parse(tracesQuery, cleanQuery(req.query));
    const and: Prisma.TraceWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (q.source) and.push({ source: q.source });
    if (q.projectId) and.push({ projectId: q.projectId });
    const range = rangeFilter(q.from, q.to);
    if (range) and.push({ startedAt: range });
    const s = searchOr(q.search, ['name', 'traceId', 'requestId']);
    if (s) and.push(s);
    const where: Prisma.TraceWhereInput = and.length ? { AND: and } : {};
    const [total, rows] = await Promise.all([
      prisma.trace.count({ where }),
      prisma.trace.findMany({
        where, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], ...skipTake(q.page, q.pageSize),
        include: { _count: { select: { spans: true } } },
      }),
    ]);
    res.json({ data: rows.map(t => mapTrace(t, t._count.spans)), pagination: pageOf(total, q.page, q.pageSize) });
  }));

  r.get('/traces/:traceId', ah(async (req, res) => {
    const { traceId } = parse(traceIdParam, req.params);
    const trace = await prisma.trace.findUnique({ where: { traceId } });
    if (!trace) throw notFound('Trace');
    const byTrace = { traceId };
    const [spans, memory, bus, tools, contexts, logs] = await Promise.all([
      prisma.span.findMany({ where: byTrace, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] }),
      prisma.memoryEvent.findMany({ where: byTrace, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      prisma.busEvent.findMany({ where: byTrace, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      prisma.toolCallEvent.findMany({ where: byTrace, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] }),
      prisma.contextEvent.findMany({ where: byTrace, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      prisma.executionLog.findMany({ where: byTrace, orderBy: [{ ts: 'asc' }, { id: 'asc' }] }),
    ]);
    const spanDtos = spans.map(mapSpan);
    const traceDto = mapTrace(trace, spans.length);
    const detail: TraceDetail = {
      trace: traceDto, spans: spanDtos,
      timeline: buildTimeline({
        trace: traceDto, spans: spanDtos, memory: memory.map(mapMemory), bus: bus.map(mapBus), tools: tools.map(mapTool),
        contexts: contexts.map(mapContext), logs: logs.map(mapExecutionLog),
      }),
    };
    res.json({ data: detail });
  }));

  r.get('/background-tasks', ah(async (req, res) => {
    const q = parse(tasksQuery, cleanQuery(req.query));
    const where: Prisma.BackgroundTaskWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.kind) where.kind = q.kind;
    if (q.source) where.source = q.source;
    const range = rangeFilter(q.from, q.to);
    if (range) where.createdAt = range;
    const [total, rows] = await Promise.all([
      prisma.backgroundTask.count({ where }),
      prisma.backgroundTask.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...skipTake(q.page, q.pageSize) }),
    ]);
    res.json({ data: rows.map(mapTask), pagination: pageOf(total, q.page, q.pageSize) });
  }));

  return r;
}
