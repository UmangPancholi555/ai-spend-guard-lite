import type { PrismaClient } from '@prisma/client';
import type { CostBreakdown, CostCalculateInput, BudgetAlertDto } from '../../../shared/types';
import type { Instrumentation } from './instrumentation';

export interface CostService {
  /** Pure, reproducible: same input + same pricing history => same output. Unknown model => ESTIMATED via fallback pricing ("*","*"). */
  calculate(input: CostCalculateInput): Promise<CostBreakdown & { totalCostPico: bigint; inputCostPico: bigint; outputCostPico: bigint; cachedCostPico: bigint }>;
}

export interface BudgetService {
  /**
   * Evaluate all active budgets (global + the project's) after new spend at `at`.
   * Creates BudgetAlert rows for newly crossed thresholds (50/80/100) - at most once per budget/period/threshold
   * (DB unique + app check; must be race-safe: catch unique violation). Records activity + log events via instrumentation.
   * Returns ONLY newly created alerts.
   */
  evaluateAfterUsage(input: { projectId: string; at: Date; traceId?: string; spanId?: string }): Promise<BudgetAlertDto[]>;
  /** Re-evaluate every active budget for now. */
  evaluateAll(at?: Date): Promise<BudgetAlertDto[]>;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  logDir: string;
  frontendDist: string | null;
}

export interface AppDeps {
  prisma: PrismaClient;
  instr: Instrumentation;
  cost: CostService;
  budgets: BudgetService;
  config: AppConfig;
}
