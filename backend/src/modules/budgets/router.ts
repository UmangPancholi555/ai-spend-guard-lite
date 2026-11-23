import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../contracts/services';
import type { BudgetAlertDto, BudgetUtilizationDetail } from '../../../../shared/types';
import { ah, parse, pageOf, paginationQuery } from '../../utils/http';
import { conflict, notFound, badRequest } from '../../utils/errors';
import { usdToPico } from '../../utils/money';
import {
  budgetInclude, computeUtilizations, historyFor, toAlertDto, toBudgetDto, utilizationFor,
} from './service';

const blank = (v: unknown) => (v === '' ? undefined : v);
const optStr = z.preprocess(blank, z.string().trim().min(1).optional());

const limitUsd = z.string().refine(s => {
  try { return usdToPico(s) > 0n; } catch { return false; }
}, 'limitUsd must be a positive decimal string with at most 12 fraction digits');

const createSchema = z.object({
  projectId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(80),
  period: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  limitUsd,
  active: z.boolean().optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  limitUsd: limitUsd.optional(),
  active: z.boolean().optional(),
});
const listQuery = z.object({ projectId: optStr });
const detailQuery = z.object({ periods: z.preprocess(blank, z.coerce.number().int().min(0).max(60).default(6)) });

const dateOrUndef = z.preprocess(blank, z.string().refine(s => !Number.isNaN(Date.parse(s)), 'invalid date').optional());
const alertsQuery = paginationQuery.extend({
  budgetId: optStr, projectId: optStr,
  threshold: z.preprocess(blank, z.coerce.number().refine(n => [50, 80, 100].includes(n), 'threshold must be 50, 80 or 100').optional()),
  from: dateOrUndef, to: dateOrUndef,
});

/** serialise budget create (unique per project|global+period cannot be enforced by a DB index: project_id may be NULL) */
let writeChain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

export function createBudgetsRouter(deps: AppDeps): Router {
  const r = Router();
  const { prisma, instr, budgets } = deps;

  const loadBudget = async (id: string) => {
    const b = await prisma.budget.findUnique({ where: { id }, include: budgetInclude });
    if (!b) throw notFound('Budget');
    return b;
  };

  // ---- fixed paths first so they are never shadowed by '/budgets/:id' ----
  r.get('/budgets', ah(async (req, res) => {
    const q = parse(listQuery, req.query);
    const rows = await prisma.budget.findMany({
      where: q.projectId ? { projectId: q.projectId } : {}, include: budgetInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    res.json({ data: rows.map(toBudgetDto) });
  }));

  r.post('/budgets', ah(async (req, res) => {
    const b = parse(createSchema, req.body);
    const projectId = b.projectId ?? null;
    const created = await serial(async () => {
      if (projectId) {
        const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
        if (!p) throw notFound('Project');
      }
      const dup = await prisma.budget.findFirst({ where: { projectId, period: b.period }, select: { id: true } });
      if (dup) throw conflict(`A ${b.period} budget already exists for ${projectId ? 'this project' : 'the global scope'}`, { existingBudgetId: dup.id });
      return prisma.budget.create({
        data: { projectId, name: b.name, period: b.period, limitPico: usdToPico(b.limitUsd), active: b.active ?? true },
        include: budgetInclude,
      });
    });
    res.status(201).json({ data: toBudgetDto(created) });
  }));

  r.get('/budgets/utilization', ah(async (req, res) => {
    const q = parse(listQuery, req.query);
    res.json({ data: await computeUtilizations(prisma, { projectId: q.projectId }) });
  }));

  r.post('/budgets/evaluate', ah(async (_req, res) => {
    const task = await instr.startTask({ name: 'Budget evaluation', kind: 'BUDGET_EVALUATION', source: 'ACTUAL' });
    let alerts: BudgetAlertDto[];
    try {
      const evaluated = await prisma.budget.count({ where: { active: true } });
      alerts = await budgets.evaluateAll(new Date());
      await task.succeed({ budgetsEvaluated: evaluated, alertsCreated: alerts.length, alertIds: alerts.map(a => a.id) });
    } catch (e) {
      await task.fail(e);
      throw e;
    }
    res.json({ data: alerts });
  }));

  r.get('/budget-alerts', ah(async (req, res) => {
    const q = parse(alertsQuery, req.query);
    const to = q.to ? new Date(q.to) : undefined;
    // date-only "to" is inclusive of the whole day
    if (to && q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) to.setTime(to.getTime() + 86_400_000 - 1);
    const where = {
      ...(q.budgetId ? { budgetId: q.budgetId } : {}),
      ...(q.threshold ? { threshold: q.threshold } : {}),
      ...(q.projectId ? { budget: { projectId: q.projectId } } : {}),
      ...(q.from || to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.budgetAlert.count({ where }),
      prisma.budgetAlert.findMany({
        where, include: { budget: { include: budgetInclude } },
        orderBy: [{ createdAt: 'desc' }, { threshold: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
    ]);
    res.json({ data: rows.map(toAlertDto), pagination: pageOf(total, q.page, q.pageSize) });
  }));

  // ---- parameterised paths ----
  r.get('/budgets/:id/utilization', ah(async (req, res) => {
    const q = parse(detailQuery, req.query);
    const budget = await loadBudget(req.params.id);
    const now = new Date();
    const current = await utilizationFor(prisma, budget, now);
    const detail: BudgetUtilizationDetail = { ...current, history: await historyFor(prisma, budget, now, q.periods) };
    res.json({ data: detail });
  }));

  r.patch('/budgets/:id', ah(async (req, res) => {
    const b = parse(updateSchema, req.body);
    if (b.name === undefined && b.limitUsd === undefined && b.active === undefined) throw badRequest('No updatable fields provided (name, limitUsd, active)');
    await loadBudget(req.params.id);
    const updated = await prisma.budget.update({
      where: { id: req.params.id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.limitUsd !== undefined ? { limitPico: usdToPico(b.limitUsd) } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      },
      include: budgetInclude,
    });
    res.json({ data: toBudgetDto(updated) });
  }));

  r.delete('/budgets/:id', ah(async (req, res) => {
    await loadBudget(req.params.id);
    await prisma.budget.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }));

  return r;
}
