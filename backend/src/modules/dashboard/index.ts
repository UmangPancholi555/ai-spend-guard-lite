import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { AppDeps } from '../../contracts/services';
import type { BudgetAlertDto, BudgetPeriod, DashboardStats, AlertThreshold } from '../../../../shared/types';
import { ah, parse } from '../../utils/http';
import { notFound } from '../../utils/errors';
import { picoToUsd } from '../../utils/money';
import { toActivityDto } from '../projects/mappers';
import { toUsageEventDto } from '../usage/mappers';
import { computeBudgetUtilization } from './budgetUtil';

const DAY_MS = 86_400_000;
const dashboardQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  projectId: z.string().trim().min(1).max(100).optional(),
});

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * One grouped query instead of loading every row: createdAt is stored as integer epoch-ms, so the UTC day is exact.
 * Uses (projectId, createdAt) / createdAt indexes. SUM over int64 is exact (overflows only above ~9.2M USD per day).
 */
async function dailyBuckets(prisma: PrismaClient, from: Date, to: Date, projectId?: string) {
  const rows = await prisma.$queryRaw<{ day: string; pico: bigint; requests: bigint; failures: bigint }[]>(Prisma.sql`
    SELECT strftime('%Y-%m-%d', createdAt / 1000, 'unixepoch') AS day,
           COALESCE(SUM(costPico), 0) AS pico, COUNT(*) AS requests,
           COALESCE(SUM(CASE WHEN status = 'FAILURE' THEN 1 ELSE 0 END), 0) AS failures
    FROM "UsageEvent"
    WHERE createdAt >= ${from} AND createdAt < ${to} ${projectId ? Prisma.sql`AND projectId = ${projectId}` : Prisma.empty}
    GROUP BY day`);
  return rows.map(r => ({ day: r.day, pico: BigInt(r.pico), requests: Number(r.requests), failures: Number(r.failures) }));
}

export function createDashboardRouter(deps: AppDeps): Router {
  const router = Router();
  const { prisma } = deps;

  router.get('/dashboard', ah(async (req, res) => {
    const { days, projectId } = parse(dashboardQuery, req.query);
    if (projectId && !(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))) throw notFound('Project');

    const now = new Date();
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const fromMs = todayStart - (days - 1) * DAY_MS;
    const from = new Date(fromMs);
    const tomorrow = new Date(todayStart + DAY_MS);
    const where: Prisma.UsageEventWhereInput = { createdAt: { gte: from, lt: tomorrow }, ...(projectId ? { projectId } : {}) };
    const projWhere = projectId ? { projectId } : {};

    const [totalAgg, failureCount, byProvider, byModel, dailyRows, budgetUtilization, activity, errors, alerts] = await Promise.all([
      prisma.usageEvent.aggregate({
        where, _count: { _all: true }, _sum: { costPico: true, inputTokens: true, outputTokens: true, cachedTokens: true },
      }),
      prisma.usageEvent.count({ where: { ...where, status: 'FAILURE' } }),
      prisma.usageEvent.groupBy({
        by: ['providerKey'], where, _count: { _all: true }, _sum: { costPico: true, inputTokens: true, outputTokens: true, cachedTokens: true },
      }),
      prisma.usageEvent.groupBy({
        by: ['providerKey', 'modelName'], where, _count: { _all: true }, _sum: { costPico: true, inputTokens: true, outputTokens: true, cachedTokens: true },
      }),
      dailyBuckets(prisma, from, tomorrow, projectId),
      computeBudgetUtilization(prisma, now, projectId),
      prisma.activityEvent.findMany({
        where: projWhere, include: { project: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10,
      }),
      prisma.usageEvent.findMany({
        where: { status: 'FAILURE', ...projWhere }, include: { project: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10,
      }),
      prisma.budgetAlert.findMany({
        where: projectId ? { budget: { OR: [{ projectId }, { projectId: null }] } } : {},
        include: { budget: { include: { project: { select: { name: true } } } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10,
      }),
    ]);

    // zero-filled UTC days; per-day sums were accumulated exactly in SQL (int64) and arrive as BigInt
    const buckets = new Map<string, { pico: bigint; requests: number; failures: number }>();
    for (let i = 0; i < days; i++) buckets.set(dayKey(new Date(fromMs + i * DAY_MS)), { pico: 0n, requests: 0, failures: 0 });
    for (const r of dailyRows) {
      const b = buckets.get(r.day);
      if (b) { b.pico = r.pico; b.requests = r.requests; b.failures = r.failures; }
    }

    const requests = totalAgg._count._all;
    const sum = (s: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null }) => ({
      inputTokens: s.inputTokens ?? 0, outputTokens: s.outputTokens ?? 0, cachedTokens: s.cachedTokens ?? 0,
    });
    const byCostDesc = <T extends { costPico: bigint; requests: number }>(a: T, b: T) =>
      a.costPico === b.costPico ? b.requests - a.requests : a.costPico > b.costPico ? -1 : 1;

    const providerBreakdown = byProvider
      .map(g => ({ provider: g.providerKey, requests: g._count._all, costPico: g._sum.costPico ?? 0n, ...sum(g._sum) }))
      .sort((a, b) => byCostDesc(a, b) || a.provider.localeCompare(b.provider))
      .map(({ costPico, ...rest }) => ({ provider: rest.provider, requests: rest.requests, costUsd: picoToUsd(costPico), inputTokens: rest.inputTokens, outputTokens: rest.outputTokens, cachedTokens: rest.cachedTokens }));
    const modelBreakdown = byModel
      .map(g => ({ provider: g.providerKey, model: g.modelName, requests: g._count._all, costPico: g._sum.costPico ?? 0n, ...sum(g._sum) }))
      .sort((a, b) => byCostDesc(a, b) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
      .map(({ costPico, ...rest }) => ({ provider: rest.provider, model: rest.model, requests: rest.requests, costUsd: picoToUsd(costPico), inputTokens: rest.inputTokens, outputTokens: rest.outputTokens, cachedTokens: rest.cachedTokens }));

    const recentAlerts: BudgetAlertDto[] = alerts.map(a => ({
      id: a.id, budgetId: a.budgetId, budgetName: a.budget.name, projectId: a.budget.projectId,
      projectName: a.budget.project?.name ?? null, period: a.budget.period as BudgetPeriod,
      threshold: a.threshold as AlertThreshold, periodStart: a.periodStart.toISOString(), periodEnd: a.periodEnd.toISOString(),
      spendUsd: picoToUsd(a.spendPico), limitUsd: picoToUsd(a.limitPico), percent: a.percent, createdAt: a.createdAt.toISOString(),
    }));

    const stats: DashboardStats = {
      range: { from: from.toISOString(), to: now.toISOString(), days },
      simulated: true, label: 'DEMO / SIMULATED',
      totals: {
        spendUsd: picoToUsd(totalAgg._sum.costPico ?? 0n), requests, successes: requests - failureCount, failures: failureCount,
        successRate: requests === 0 ? 0 : (requests - failureCount) / requests, ...sum(totalAgg._sum),
      },
      providerBreakdown, modelBreakdown,
      dailySpend: [...buckets].map(([date, b]) => ({ date, costUsd: picoToUsd(b.pico), requests: b.requests, failures: b.failures })),
      budgetUtilization,
      recentActivity: activity.map(toActivityDto),
      recentErrors: errors.map(toUsageEventDto),
      recentAlerts,
    };
    res.json({ data: stats });
  }));

  return router;
}
