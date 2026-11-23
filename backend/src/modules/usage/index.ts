import { Router } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppDeps } from '../../contracts/services';
import type { UsageFilterOptions } from '../../../../shared/types';
import { ah, pageOf, parse, toCsv } from '../../utils/http';
import { notFound } from '../../utils/errors';
import { toUsageEventDetail, toUsageEventDto, usd } from './mappers';
import { hasLikeWildcard, usageIdsBySearch } from './search';
import { usageFilterQuery, usageIdParam, usageListQuery, type UsageFilters } from './schemas';

export async function buildUsageWhere(prisma: PrismaClient, f: UsageFilters): Promise<Prisma.UsageEventWhereInput> {
  const and: Prisma.UsageEventWhereInput[] = [];
  if (f.provider) and.push({ providerKey: f.provider });
  if (f.model) and.push({ modelName: f.model });
  if (f.projectId) and.push({ projectId: f.projectId });
  if (f.status) and.push({ status: f.status });
  if (f.from || f.to) and.push({ createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } });
  if (f.search && hasLikeWildcard(f.search)) {
    and.push({ id: { in: await usageIdsBySearch(prisma, f.search) } });
  } else if (f.search) {
    const s = f.search;
    and.push({
      OR: [
        { requestId: { contains: s } },
        { modelName: { contains: s } },
        { providerKey: { contains: s } },
        { errorMessage: { contains: s } },
        { traceId: { contains: s } },
        { project: { is: { name: { contains: s } } } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

export function createUsageRouter(deps: AppDeps): Router {
  const router = Router();
  const { prisma } = deps;

  router.get('/usage', ah(async (req, res) => {
    const filters = parse(usageFilterQuery, req.query);
    const { page, pageSize, sort, order } = parse(usageListQuery, req.query);
    const where = await buildUsageWhere(prisma, filters);
    const column = sort === 'costUsd' ? 'costPico' : sort;
    const orderBy: Prisma.UsageEventOrderByWithRelationInput[] = [{ [column]: order }];
    if (column !== 'createdAt') orderBy.push({ createdAt: 'desc' });
    orderBy.push({ id: 'desc' });
    const [total, rows] = await Promise.all([
      prisma.usageEvent.count({ where }),
      prisma.usageEvent.findMany({
        where, orderBy, skip: (page - 1) * pageSize, take: pageSize, include: { project: { select: { name: true } } },
      }),
    ]);
    res.json({ data: rows.map(toUsageEventDto), pagination: pageOf(total, page, pageSize) });
  }));

  router.get('/usage/filters', ah(async (_req, res) => {
    const [used, models] = await Promise.all([
      prisma.usageEvent.groupBy({ by: ['providerKey', 'modelName'] }),
      prisma.model.findMany({ where: { active: true }, include: { provider: { select: { key: true } } } }),
    ]);
    const pairs = new Map<string, { provider: string; model: string }>();
    for (const u of used) pairs.set(`${u.providerKey}\u0000${u.modelName}`, { provider: u.providerKey, model: u.modelName });
    for (const m of models) pairs.set(`${m.provider.key}\u0000${m.name}`, { provider: m.provider.key, model: m.name });
    const list = [...pairs.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
    const out: UsageFilterOptions = { providers: [...new Set(list.map(p => p.provider))], models: list };
    res.json({ data: out });
  }));

  router.get('/usage/export.csv', ah(async (req, res) => {
    const filters = parse(usageFilterQuery, req.query);
    const rows = await prisma.usageEvent.findMany({
      where: await buildUsageWhere(prisma, filters),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { project: { select: { name: true } } },
    });
    const headers = [
      'request_id', 'created_at', 'project_id', 'project_name', 'provider', 'model', 'status', 'error_code',
      'input_tokens', 'output_tokens', 'cached_tokens', 'cost_usd', 'cost_class', 'pricing_version',
      'duration_ms', 'trace_id', 'simulated',
    ];
    const csv = toCsv(headers, rows.map(r => [
      r.requestId, r.createdAt.toISOString(), r.projectId, r.project?.name ?? '', r.providerKey, r.modelName, r.status,
      r.errorCode, r.inputTokens, r.outputTokens, r.cachedTokens, usd(r.costPico), r.costClass, r.pricingVersion,
      r.durationMs, r.traceId, r.simulated,
    ]));
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usage-export-${stamp}.csv"`);
    res.send(csv);
  }));

  router.get('/usage/:id', ah(async (req, res) => {
    const { id } = parse(usageIdParam, req.params);
    const row = await prisma.usageEvent.findFirst({
      where: { OR: [{ id }, { requestId: id }] }, include: { project: { select: { name: true } } },
    });
    if (!row) throw notFound('Usage event');
    res.json({ data: toUsageEventDetail(row) });
  }));

  return router;
}
