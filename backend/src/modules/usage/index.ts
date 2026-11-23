import { Router, type Response } from 'express';
import type { AppDeps } from '../../contracts/services';
import type { UsageFilterOptions } from '../../../../shared/types';
import { ah, csvCell, pageOf, parse } from '../../utils/http';
import { notFound } from '../../utils/errors';
import { toUsageEventDetail, toUsageEventDto, usd } from './mappers';
import { countUsage, exportBatchIds, hydrateUsage, pageUsageIds, usageQuery } from './query';
import { usageFilterQuery, usageIdParam, usageListQuery } from './schemas';

const EXPORT_BATCH = 500;
const CSV_HEADERS = [
  'request_id', 'created_at', 'project_id', 'project_name', 'provider', 'model', 'status', 'error_code',
  'input_tokens', 'output_tokens', 'cached_tokens', 'cost_usd', 'cost_class', 'pricing_version',
  'duration_ms', 'trace_id', 'simulated',
];

/** write with backpressure; resolves false when the client has gone away */
async function write(res: Response, chunk: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (!res.write(chunk)) {
    await new Promise<void>(resolve => { res.once('drain', resolve); res.once('close', resolve); });
  }
  return !res.destroyed;
}

export function createUsageRouter(deps: AppDeps): Router {
  const router = Router();
  const { prisma } = deps;

  router.get('/usage', ah(async (req, res) => {
    const filters = parse(usageFilterQuery, req.query);
    const { page, pageSize, sort, order } = parse(usageListQuery, req.query);
    const q = usageQuery(filters);
    const [total, ids] = await Promise.all([
      countUsage(prisma, q),
      pageUsageIds(prisma, q, { sort, order, limit: pageSize, offset: (page - 1) * pageSize }),
    ]);
    const rows = await hydrateUsage(prisma, ids);
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
    const stamp = new Date().toISOString().slice(0, 10);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usage-export-${stamp}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!(await write(res, `${CSV_HEADERS.map(csvCell).join(',')}\n`))) return;
      // keyset pagination over (createdAt desc, id desc): stable under concurrent inserts/deletes, uses the createdAt index
      let last: { createdAt: Date; id: string } | undefined;
      for (;;) {
        const rows = await hydrateUsage(prisma, await exportBatchIds(prisma, filters, last, EXPORT_BATCH));
        if (rows.length === 0) break;
        const chunk = rows.map(r => `${[
          r.requestId, r.createdAt.toISOString(), r.projectId, r.project?.name ?? '', r.providerKey, r.modelName, r.status,
          r.errorCode, r.inputTokens, r.outputTokens, r.cachedTokens, usd(r.costPico), r.costClass, r.pricingVersion,
          r.durationMs, r.traceId, r.simulated,
        ].map(csvCell).join(',')}\n`).join('');
        if (!(await write(res, chunk))) return; // client went away
        if (rows.length < EXPORT_BATCH) break;
        last = { createdAt: rows[rows.length - 1].createdAt, id: rows[rows.length - 1].id };
      }
      res.end();
    } catch (e) {
      // headers are already sent: the only honest signal left is to abort the connection
      res.destroy(e instanceof Error ? e : undefined);
    }
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
