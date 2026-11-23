/** Activity feed read API (module obs-events). `GET /api/activity` with filters + pagination. */
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AppDeps } from '../../contracts/services';
import { ah, pageOf, parse } from '../../utils/http';
import {
  SOURCE_ENUM, checkRange, cleanQuery, listBase, mapActivity, projectNames, rangeFilter, rangeShape, searchOr, skipTake,
} from '../observability/common';

export const activityQuery = listBase.extend({
  type: z.string().trim().min(1).max(100).optional(),        // exact; comma-separated list allowed ("a,b")
  level: z.enum(['INFO', 'WARN', 'ERROR']).optional(),
  source: SOURCE_ENUM.optional(),
  projectId: z.string().min(1).max(64).optional(),
  traceId: z.string().min(1).max(64).optional(),
  search: z.string().trim().min(1).max(200).optional(),      // case-insensitive substring of message, type or requestId
  ...rangeShape,                                              // createdAt, `to` inclusive (date-only => whole UTC day)
}).superRefine(checkRange);

export function createActivityRouter(deps: AppDeps): Router {
  const r = Router();
  const { prisma } = deps;

  r.get('/activity', ah(async (req, res) => {
    const q = parse(activityQuery, cleanQuery(req.query));
    const and: Prisma.ActivityEventWhereInput[] = [];
    if (q.type) {
      const types = q.type.split(',').map(s => s.trim()).filter(Boolean);
      and.push(types.length === 1 ? { type: types[0] } : { type: { in: types } });
    }
    if (q.level) and.push({ level: q.level });
    if (q.source) and.push({ source: q.source });
    if (q.projectId) and.push({ projectId: q.projectId });
    if (q.traceId) and.push({ traceId: q.traceId });
    const range = rangeFilter(q.from, q.to);
    if (range) and.push({ createdAt: range });
    const s = searchOr(q.search, ['message', 'type', 'requestId']);
    if (s) and.push(s);
    const where: Prisma.ActivityEventWhereInput = and.length ? { AND: and } : {};

    const [total, rows] = await Promise.all([
      prisma.activityEvent.count({ where }),
      prisma.activityEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...skipTake(q.page, q.pageSize) }),
    ]);
    const names = await projectNames(prisma, rows.map(x => x.projectId));
    res.json({
      data: rows.map(x => mapActivity(x, x.projectId ? names.get(x.projectId) ?? null : null)),
      pagination: pageOf(total, q.page, q.pageSize),
    });
  }));
  return r;
}
