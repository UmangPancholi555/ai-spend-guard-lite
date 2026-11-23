import type { PrismaClient } from '@prisma/client';
import type { AlertThreshold, BudgetDto, BudgetPeriod, BudgetUtilization } from '../../../../shared/types';
import { percentOf, picoToUsd } from '../../utils/money';

const DAY_MS = 86_400_000;

/**
 * Current period bounds (UTC). `end` is EXCLUSIVE (= start of the next period).
 *  DAILY = UTC day, WEEKLY = ISO week (Monday 00:00 UTC), MONTHLY = UTC calendar month.
 */
export function periodBounds(period: BudgetPeriod, at: Date): { start: Date; end: Date } {
  const dayStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  if (period === 'DAILY') return { start: new Date(dayStart), end: new Date(dayStart + DAY_MS) };
  if (period === 'WEEKLY') {
    const dow = (new Date(dayStart).getUTCDay() + 6) % 7; // Monday = 0
    const start = dayStart - dow * DAY_MS;
    return { start: new Date(start), end: new Date(start + 7 * DAY_MS) };
  }
  return {
    start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
    end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
  };
}

export function highestThreshold(spend: bigint, limit: bigint): AlertThreshold | null {
  if (limit <= 0n) return null;
  for (const t of [100, 80, 50] as const) if (spend * 100n >= limit * BigInt(t)) return t;
  return null;
}

/** Utilization of every ACTIVE budget (optionally only one project's budgets) for the period containing `at`. */
export async function computeBudgetUtilization(prisma: PrismaClient, at: Date, projectId?: string): Promise<BudgetUtilization[]> {
  const budgets = await prisma.budget.findMany({
    where: { active: true, ...(projectId ? { projectId } : {}) },
    include: { project: { select: { name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const out: BudgetUtilization[] = [];
  for (const b of budgets) {
    const { start, end } = periodBounds(b.period as BudgetPeriod, at);
    const agg = await prisma.usageEvent.aggregate({
      _sum: { costPico: true },
      where: { createdAt: { gte: start, lt: end }, ...(b.projectId ? { projectId: b.projectId } : {}) },
    });
    const spend = agg._sum.costPico ?? 0n;
    const budget: BudgetDto = {
      id: b.id, projectId: b.projectId, projectName: b.project?.name ?? null, name: b.name,
      period: b.period as BudgetPeriod, limitUsd: picoToUsd(b.limitPico), active: b.active,
      createdAt: b.createdAt.toISOString(), updatedAt: b.updatedAt.toISOString(),
    };
    out.push({
      budget, periodStart: start.toISOString(), periodEnd: end.toISOString(),
      spendUsd: picoToUsd(spend), limitUsd: picoToUsd(b.limitPico),
      percent: percentOf(spend, b.limitPico), highestThresholdReached: highestThreshold(spend, b.limitPico),
    });
  }
  return out;
}
