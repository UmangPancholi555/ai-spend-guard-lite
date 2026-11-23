import type { PrismaClient } from '@prisma/client';
import type { BudgetUtilization } from '../../../../shared/types';
import { budgetInclude, highestThreshold, utilizationFor } from '../budgets/service';
import { periodBounds } from '../budgets/periods';

export { periodBounds, highestThreshold };

/**
 * Current-period utilization for the dashboard widget, computed with the budgets module's own period math
 * (budgets/periods.ts) and spend/threshold logic, so it always equals `GET /budgets/utilization`.
 * ACTIVE budgets only. With `projectId`: that project's budgets AND the global budgets (which also cover the project's spend).
 */
export async function computeBudgetUtilization(prisma: PrismaClient, at: Date, projectId?: string): Promise<BudgetUtilization[]> {
  const budgets = await prisma.budget.findMany({
    where: { active: true, ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}) },
    include: budgetInclude,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return Promise.all(budgets.map(b => utilizationFor(prisma, b, at)));
}
