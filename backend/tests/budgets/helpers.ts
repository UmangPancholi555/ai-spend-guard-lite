import express from 'express';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Instrumentation, ActivityInput, BusRecordInput, LogInput, ErrorRecordInput } from '../../src/contracts/instrumentation';
import type { AppDeps } from '../../src/contracts/services';
import type { TestCtx } from '../helpers/testApp';
import { createCostRouter, createCostService } from '../../src/modules/cost';
import { createBudgetsRouter, createBudgetService } from '../../src/modules/budgets';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createNoopInstrumentation } from '../../src/contracts/noop';
import { usdToPico } from '../../src/utils/money';

export interface TaskRecord { name: string; kind: string; source: string; succeeded?: Record<string, unknown>; failed?: unknown }
export interface RecordingInstr extends Instrumentation {
  activities: ActivityInput[]; bus: BusRecordInput[]; logs: LogInput[]; errors: ErrorRecordInput[]; tasks: TaskRecord[];
}

/** Recording fake Instrumentation (the real SDK is built by another agent). */
export function createRecordingInstr(overrides: Partial<Instrumentation> = {}): RecordingInstr {
  const base = createNoopInstrumentation();
  const rec = {
    activities: [] as ActivityInput[], bus: [] as BusRecordInput[], logs: [] as LogInput[], errors: [] as ErrorRecordInput[], tasks: [] as TaskRecord[],
  };
  const instr: RecordingInstr = {
    ...base, ...rec,
    recordActivity: async i => { rec.activities.push(i); },
    recordBus: async i => { rec.bus.push(i); return 'op_' + rec.bus.length; },
    log: async i => { rec.logs.push(i); },
    recordError: async i => { rec.errors.push(i); },
    startTask: async t => {
      const r: TaskRecord = { name: t.name, kind: t.kind, source: t.source };
      rec.tasks.push(r);
      return { id: 'task_' + rec.tasks.length, succeed: async res => { r.succeeded = res ?? {}; }, fail: async e => { r.failed = e; } };
    },
    ...overrides,
  };
  return instr;
}

export interface Harness { app: express.Express; deps: AppDeps; instr: RecordingInstr }

/** Mini express app mounting ONLY the cost + budgets routers on top of a test ctx (isolated from other modules). */
export function createHarness(ctx: TestCtx, instr: RecordingInstr = createRecordingInstr()): Harness {
  const deps: AppDeps = {
    ...ctx.deps, prisma: ctx.prisma, instr,
    cost: createCostService(ctx.prisma), budgets: createBudgetService(ctx.prisma, instr),
  };
  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use(createCostRouter(deps));
  api.use(createBudgetsRouter(deps));
  app.use('/api', api);
  app.use(errorHandler(instr));
  return { app, deps, instr };
}

let seq = 0;
export async function makeProject(prisma: PrismaClient, name = `proj-${++seq}-${randomUUID().slice(0, 6)}`, extra: { status?: string } = {}) {
  return prisma.project.create({ data: { name, status: extra.status ?? 'ACTIVE' } });
}

export async function makeBudget(
  prisma: PrismaClient,
  o: { projectId?: string | null; period: 'DAILY' | 'WEEKLY' | 'MONTHLY'; limitUsd: string; active?: boolean; name?: string },
) {
  return prisma.budget.create({
    data: { projectId: o.projectId ?? null, period: o.period, limitPico: usdToPico(o.limitUsd), active: o.active ?? true, name: o.name ?? `${o.period} budget` },
  });
}

/** Insert a UsageEvent directly with a given total cost (USD decimal string) at `at`. */
export async function addUsage(prisma: PrismaClient, projectId: string, usd: string, at: Date) {
  const pico = usdToPico(usd);
  return prisma.usageEvent.create({
    data: {
      requestId: `req_${randomUUID().replace(/-/g, '')}`, projectId, providerKey: 'openai', modelName: 'gpt-4o', status: 'SUCCESS',
      inputTokens: 1, outputTokens: 1, cachedTokens: 0,
      costPico: pico, inputCostPico: pico, outputCostPico: 0n, cachedCostPico: 0n,
      costClass: 'SIMULATED', durationMs: 1, promptHash: 'h', promptChars: 1, metadata: '{}', createdAt: at,
    },
  });
}
