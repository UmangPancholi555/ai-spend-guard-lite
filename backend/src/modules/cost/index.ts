// STUB - owned by the cost module agent. Keep this exported factory signature.
import { Router } from 'express';
import type { AppDeps } from '../../contracts/services';

export function createCostRouter(_deps: AppDeps): Router {
  return Router();
}

import type { PrismaClient } from '@prisma/client';
import type { CostService } from '../../contracts/services';
export function createCostService(_prisma: PrismaClient): CostService {
  return { calculate: async () => { throw new Error('cost module not implemented'); } };
}
