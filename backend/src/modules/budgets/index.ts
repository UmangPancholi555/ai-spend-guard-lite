// STUB - owned by the budgets module agent. Keep this exported factory signature.
import { Router } from 'express';
import type { AppDeps } from '../../contracts/services';

export function createBudgetsRouter(_deps: AppDeps): Router {
  return Router();
}

import type { PrismaClient } from '@prisma/client';
import type { BudgetService } from '../../contracts/services';
import type { Instrumentation } from '../../contracts/instrumentation';
export function createBudgetService(_prisma: PrismaClient, _instr: Instrumentation): BudgetService {
  return { evaluateAfterUsage: async () => [], evaluateAll: async () => [] };
}
