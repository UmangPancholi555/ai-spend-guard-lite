import type { PrismaClient, Budget, BudgetAlert, Project } from '@prisma/client';
import type {
  AlertThreshold, BudgetAlertDto, BudgetDto, BudgetPeriod, BudgetUtilization, BudgetUtilizationHistoryPoint,
} from '../../../../shared/types';
import { alertLevelFor } from '../../../../shared/types';
import type { BudgetService } from '../../contracts/services';
import type { Instrumentation } from '../../contracts/instrumentation';
import { percentOf, picoToUsd } from '../../utils/money';
import { periodBounds, previousPeriodStart } from './periods';

export const THRESHOLDS: AlertThreshold[] = [50, 80, 100];

export type BudgetWithProject = Budget & { project: Pick<Project, 'id' | 'name' | 'status'> | null };
type AlertWithBudget = BudgetAlert & { budget: BudgetWithProject };

export const budgetInclude = { project: { select: { id: true, name: true, status: true } } } as const;

export function toBudgetDto(b: BudgetWithProject): BudgetDto {
  return {
    id: b.id, projectId: b.projectId, projectName: b.project?.name ?? null,
    name: b.name, period: b.period as BudgetPeriod, limitUsd: picoToUsd(b.limitPico), active: b.active,
    createdAt: b.createdAt.toISOString(), updatedAt: b.updatedAt.toISOString(),
  };
}

export function toAlertDto(a: AlertWithBudget): BudgetAlertDto {
  return {
    id: a.id, budgetId: a.budgetId, budgetName: a.budget.name,
    projectId: a.budget.projectId, projectName: a.budget.project?.name ?? null,
    period: a.budget.period as BudgetPeriod, threshold: a.threshold as AlertThreshold, level: alertLevelFor(a.threshold),
    periodStart: a.periodStart.toISOString(), periodEnd: a.periodEnd.toISOString(),
    spendUsd: picoToUsd(a.spendPico), limitUsd: picoToUsd(a.limitPico), percent: a.percent,
    createdAt: a.createdAt.toISOString(),
  };
}

/** SUM(UsageEvent.costPico) in [start, end) for a project budget (or all projects when projectId is null). */
export async function spendInPeriod(prisma: PrismaClient, projectId: string | null, start: Date, end: Date): Promise<bigint> {
  const agg = await prisma.usageEvent.aggregate({
    _sum: { costPico: true },
    where: { ...(projectId ? { projectId } : {}), createdAt: { gte: start, lt: end } },
  });
  return agg._sum.costPico ?? 0n;
}

/** exact (integer) check that spend has reached `threshold` percent of limit */
export function reachedThreshold(spend: bigint, limit: bigint, threshold: number): boolean {
  return limit > 0n && spend * 100n >= limit * BigInt(threshold);
}
export function highestThreshold(spend: bigint, limit: bigint): AlertThreshold | null {
  for (const t of [...THRESHOLDS].reverse()) if (reachedThreshold(spend, limit, t)) return t;
  return null;
}

export async function utilizationFor(prisma: PrismaClient, budget: BudgetWithProject, at: Date): Promise<BudgetUtilization> {
  const { start, end } = periodBounds(budget.period as BudgetPeriod, at);
  const spend = await spendInPeriod(prisma, budget.projectId, start, end);
  return {
    budget: toBudgetDto(budget),
    periodStart: start.toISOString(), periodEnd: end.toISOString(),
    spendUsd: picoToUsd(spend), limitUsd: picoToUsd(budget.limitPico),
    percent: percentOf(spend, budget.limitPico),
    highestThresholdReached: highestThreshold(spend, budget.limitPico),
  };
}

/** `periods` previous periods before the one containing `at`, oldest first. */
export async function historyFor(prisma: PrismaClient, budget: BudgetWithProject, at: Date, periods: number): Promise<BudgetUtilizationHistoryPoint[]> {
  const period = budget.period as BudgetPeriod;
  const out: BudgetUtilizationHistoryPoint[] = [];
  let start = periodBounds(period, at).start;
  for (let i = 0; i < periods; i++) {
    start = previousPeriodStart(period, start);
    const { end } = periodBounds(period, start);
    const spend = await spendInPeriod(prisma, budget.projectId, start, end);
    out.push({ periodStart: start.toISOString(), periodEnd: end.toISOString(), spendUsd: picoToUsd(spend), percent: percentOf(spend, budget.limitPico) });
  }
  return out.reverse();
}

/** Current-period utilization for budgets (all, or only those of `projectId`). */
export async function computeUtilizations(prisma: PrismaClient, opts: { projectId?: string; at?: Date } = {}): Promise<BudgetUtilization[]> {
  const budgets = await prisma.budget.findMany({
    where: opts.projectId ? { projectId: opts.projectId } : {},
    include: budgetInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  const at = opts.at ?? new Date();
  return Promise.all(budgets.map(b => utilizationFor(prisma, b, at)));
}

const code = (e: unknown) => (e as { code?: string } | null)?.code;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function createBudgetService(prisma: PrismaClient, instr: Instrumentation): BudgetService {
  async function safe(fn: () => Promise<unknown>) { try { await fn(); } catch { /* instrumentation must never break evaluation */ } }

  /** insert alert; returns null when it already exists (unique violation => another evaluation won the race) */
  async function insertAlert(data: { budgetId: string; threshold: number; periodStart: Date; periodEnd: Date; spendPico: bigint; limitPico: bigint; percent: number }) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.budgetAlert.create({ data, include: { budget: { include: budgetInclude } } });
      } catch (e) {
        const c = code(e);
        if (c === 'P2002' || c === 'P2003' || c === 'P2025') return null; // duplicate, or budget deleted meanwhile
        if ((c === 'P1008' || c === 'P2034') && attempt < 5) { await sleep(20 * (attempt + 1)); continue; }
        throw e;
      }
    }
  }

  async function emit(alert: AlertWithBudget, ctx: { traceId?: string; spanId?: string; projectId?: string }) {
    const dto = toAlertDto(alert);
    const projectId = alert.budget.projectId ?? ctx.projectId;
    // severity escalates with the threshold: 50% INFO, 80% WARN, 100% CRITICAL. A crossing is a successful, noteworthy event:
    // even CRITICAL is never an ERROR/FAILURE (it does not count as a failed operation or an error in Observability).
    const level = dto.level;
    const base = { traceId: ctx.traceId, spanId: ctx.spanId, projectId };
    const meta = {
      budgetId: dto.budgetId, budgetName: dto.budgetName, threshold: dto.threshold, level: dto.level, percent: dto.percent,
      period: dto.period, periodStart: dto.periodStart, alertId: dto.id, budgetProjectId: dto.projectId,
    };
    const message = `Budget "${dto.budgetName}" reached ${dto.threshold}% of its ${dto.period.toLowerCase()} limit (${dto.percent}% used)`;
    await safe(() => instr.recordActivity({ ...base, type: 'budget.alert', level, message, source: 'ACTUAL', metadata: meta }));
    await safe(() => instr.recordBus({
      ...base, source: 'ACTUAL', operationName: 'budget.alert.publish', operationType: 'PUBLISH',
      eventName: 'budget.threshold.crossed', inputMeta: { budgetId: dto.budgetId, threshold: dto.threshold, percent: dto.percent, period: dto.period },
      outputStatus: 'persisted', success: true,
    }));
    // no separate instr.log: recordActivity/recordBus already mirror into ExecutionLog (one entry per call)
    return dto;
  }

  async function evaluateBudgets(budgets: BudgetWithProject[], at: Date, ctx: { traceId?: string; spanId?: string; projectId?: string }): Promise<BudgetAlertDto[]> {
    const created: BudgetAlertDto[] = [];
    for (const budget of budgets) {
      if (!budget.active) continue;
      if (budget.project && budget.project.status !== 'ACTIVE') continue; // archived project: budget dormant
      const { start, end } = periodBounds(budget.period as BudgetPeriod, at);
      const spend = await spendInPeriod(prisma, budget.projectId, start, end);
      const crossed = THRESHOLDS.filter(t => reachedThreshold(spend, budget.limitPico, t));
      if (crossed.length === 0) continue;
      const existing = await prisma.budgetAlert.findMany({
        where: { budgetId: budget.id, periodStart: start, threshold: { in: crossed } }, select: { threshold: true },
      });
      const have = new Set(existing.map(e => e.threshold));
      const percent = percentOf(spend, budget.limitPico);
      for (const threshold of crossed) {
        if (have.has(threshold)) continue;
        let alert;
        try {
          alert = await insertAlert({ budgetId: budget.id, threshold, periodStart: start, periodEnd: end, spendPico: spend, limitPico: budget.limitPico, percent });
        } catch (e) {
          // alert creation itself failed: the only case reported as an error
          await safe(() => instr.recordError({
            ...ctx, source: 'ACTUAL', category: 'DATABASE', operation: 'budget.alert.create', error: e,
            attributes: { budgetId: budget.id, threshold },
          }));
          throw e;
        }
        if (!alert) continue;
        created.push(await emit(alert, ctx));
      }
    }
    return created;
  }

  return {
    async evaluateAfterUsage(input) {
      const budgets = await prisma.budget.findMany({
        where: { active: true, OR: [{ projectId: input.projectId }, { projectId: null }] },
        include: budgetInclude, orderBy: { createdAt: 'asc' },
      });
      return evaluateBudgets(budgets, input.at, input);
    },
    async evaluateAll(at = new Date()) {
      const budgets = await prisma.budget.findMany({ where: { active: true }, include: budgetInclude, orderBy: { createdAt: 'asc' } });
      return evaluateBudgets(budgets, at, {});
    },
  };
}
