/**
 * Real ToolExecutor + registry of real local tools. Every invocation is an instrumented tool call (ACTUAL):
 *  - Zod input validation (invalid input => 400, recorded as FAILURE, never retried)
 *  - transient errors are retried with bounded backoff (maxRetries 2; 20ms, 40ms; hard cap 100ms)
 *  - inputMeta = parameter names / types / sizes / short hash ONLY (never values); outputMeta = key names / size / status
 *  - a TOOL span under the caller's trace
 */
import { z, type ZodType } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { Instrumentation, SpanHandle } from '../../contracts/instrumentation';
import { toErrorInfo } from '../../contracts/instrumentation';
import type { CostService } from '../../contracts/services';
import type { ToolDescriptorDto, ToolParamDto } from '../../../../shared/runtime';
import { AppError, badRequest, notFound } from '../../utils/errors';
import { newRequestId, sha256 } from '../../utils/ids';
import { safeStringify } from '../../utils/serialize';
import { picoToUsd } from '../../utils/money';
import { computeBudgetUtilization } from '../dashboard/budgetUtil';
import { scopeClock, type Scope } from './bus';

/** errors that are worth retrying */
export class TransientToolError extends Error {
  readonly transient = true;
  constructor(message: string) { super(message); this.name = 'TransientToolError'; }
}
const TRANSIENT_RE = /SQLITE_BUSY|database is locked|ETIMEDOUT|ECONNRESET|P1008|P2034/i;
export const isTransient = (e: unknown): boolean =>
  !!e && typeof e === 'object' && ((e as { transient?: unknown }).transient === true || TRANSIENT_RE.test(String((e as { message?: unknown }).message ?? '')));

export interface ToolContext { prisma: PrismaClient; cost: CostService }
export interface ToolDef<I = unknown> {
  name: string; description: string; params: ToolParamDto[]; maxRetries?: number;
  schema: ZodType<I, any, any>;
  run(input: I, ctx: ToolContext): Promise<Record<string, unknown>>;
}

export class ToolExecutionError extends AppError {
  constructor(message: string, readonly toolCallId: string, readonly attempts: number, readonly cause?: unknown) {
    super(502, 'TOOL_FAILED', message);
  }
}

export interface ToolExecution { output: Record<string, unknown>; toolCallId: string; attempts: number; durationMs: number }

/** names/types/sizes/hash of the raw input; NEVER the values */
export function describeInput(input: unknown): Record<string, unknown> {
  const obj = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const keys = Object.keys(obj).sort().slice(0, 20);
  const sizeOf = (v: unknown): number => {
    if (typeof v === 'string') return v.length;
    if (Array.isArray(v)) return v.length;
    try { return Buffer.byteLength(safeStringify(v) ?? '', 'utf8'); } catch { return 0; }
  };
  return {
    paramNames: keys.map(k => k.slice(0, 64)),
    paramTypes: Object.fromEntries(keys.map(k => [k.slice(0, 64), Array.isArray(obj[k]) ? 'array' : typeof obj[k]])),
    paramSizes: Object.fromEntries(keys.map(k => [k.slice(0, 64), sizeOf(obj[k])])),
    inputHash: sha256(safeStringify(keys.map(k => [k, obj[k]])) ?? '').slice(0, 16),
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const backoffMs = (attempt: number) => Math.min(100, 20 * 2 ** attempt);

// ---------------------------------------------------------------- built-in tools

const pricingLookup: ToolDef<{ provider: string; model: string }> = {
  name: 'pricing.lookup', description: 'Look up the current illustrative per-million-token pricing for a provider/model (cost service, PricingConfig table).',
  params: [
    { name: 'provider', type: 'string', required: true, description: 'provider key, e.g. openai' },
    { name: 'model', type: 'string', required: true, description: 'model name (unknown models resolve to fallback ESTIMATED pricing)' },
  ],
  schema: z.object({ provider: z.string().min(1).max(100), model: z.string().min(1).max(100) }),
  async run(i, ctx) {
    const c = await ctx.cost.calculate({ provider: i.provider, model: i.model, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    return { provider: i.provider, model: i.model, inputPerMTok: c.pricing.inputPerMTok, outputPerMTok: c.pricing.outputPerMTok, cachedPerMTok: c.pricing.cachedPerMTok, pricingVersion: c.pricingVersion, costClass: c.costClass, unknownModel: c.unknownModel };
  },
};

const budgetStatus: ToolDef<{ projectId: string }> = {
  name: 'budget.status', description: "Current-period utilization of the project's active budgets (plus global budgets).",
  params: [{ name: 'projectId', type: 'string', required: true, description: 'project id' }],
  schema: z.object({ projectId: z.string().min(1).max(100) }),
  async run(i, ctx) {
    const all = await computeBudgetUtilization(ctx.prisma, new Date());
    const rel = all.filter(u => u.budget.projectId === null || u.budget.projectId === i.projectId);
    const highest = rel.reduce((m, u) => Math.max(m, u.percent), 0);
    return {
      projectId: i.projectId, count: rel.length, highestPercent: highest, overLimit: rel.some(u => u.percent >= 100),
      budgets: rel.map(u => ({ name: u.budget.name, period: u.budget.period, scope: u.budget.projectId ? 'project' : 'global', percent: u.percent, spendUsd: u.spendUsd, limitUsd: u.limitUsd, highestThresholdReached: u.highestThresholdReached })),
    };
  },
};

const usageSummary: ToolDef<{ projectId: string; days: number }> = {
  name: 'usage.summary', description: 'Recent usage and spend of a project over the last N days (UsageEvent table).',
  params: [
    { name: 'projectId', type: 'string', required: true, description: 'project id' },
    { name: 'days', type: 'number', required: false, description: 'window in days (1..365, default 7)' },
  ],
  schema: z.object({ projectId: z.string().min(1).max(100), days: z.number().int().min(1).max(365).default(7) }),
  async run(i, ctx) {
    const since = new Date(Date.now() - i.days * 86_400_000);
    const agg = await ctx.prisma.usageEvent.aggregate({
      where: { projectId: i.projectId, createdAt: { gte: since } },
      _count: { _all: true }, _sum: { costPico: true, inputTokens: true, outputTokens: true, cachedTokens: true },
    });
    const failures = await ctx.prisma.usageEvent.count({ where: { projectId: i.projectId, createdAt: { gte: since }, status: 'FAILURE' } });
    return {
      projectId: i.projectId, days: i.days, requests: agg._count._all, failures,
      inputTokens: agg._sum.inputTokens ?? 0, outputTokens: agg._sum.outputTokens ?? 0, cachedTokens: agg._sum.cachedTokens ?? 0,
      costUsd: picoToUsd(agg._sum.costPico ?? 0n),
    };
  },
};

export const BUILTIN_TOOLS: ToolDef<any>[] = [pricingLookup, budgetStatus, usageSummary];

// ---------------------------------------------------------------- executor

export class ToolExecutor {
  private readonly tools = new Map<string, ToolDef<any>>();
  constructor(private readonly instr: Instrumentation, private readonly ctx: ToolContext, tools: ToolDef<any>[] = BUILTIN_TOOLS) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  register(tool: ToolDef<any>): void { this.tools.set(tool.name, tool); }
  has(name: string): boolean { return this.tools.has(name); }

  list(): ToolDescriptorDto[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({
      name: t.name, description: t.description, params: t.params, maxRetries: t.maxRetries ?? 2, source: 'ACTUAL' as const,
    }));
  }

  async execute(name: string, rawInput: unknown, scope: Scope = {}): Promise<ToolExecution> {
    const def = this.tools.get(name);
    if (!def) throw notFound(`Tool "${name}"`);
    const maxRetries = def.maxRetries ?? 2;
    const toolCallId = newRequestId('call');
    const inputMeta = describeInput(rawInput);
    const parent = scope.parentSpan ?? scope.trace?.rootSpan;
    const span: SpanHandle | undefined = parent
      ? await parent.startSpan(`tool.${name}`, 'TOOL', { toolName: name, toolCallId, maxRetries }, { source: 'ACTUAL' })
      : undefined;
    const base = {
      traceId: scope.traceId ?? scope.trace?.traceId, spanId: span?.spanId, projectId: scope.projectId, requestId: scope.requestId,
      source: 'ACTUAL' as const, toolName: name, toolCallId, inputMeta, maxRetries,
    };
    const tStart = scopeClock(scope);

    const parsed = def.schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const message = `Invalid input for tool ${name}: ${parsed.error.issues.map(i => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`.slice(0, 500);
      const at = scopeClock(scope);
      await this.instr.recordTool({ ...base, at, startedAt: tStart, endedAt: at, durationMs: Math.max(0, at.getTime() - tStart.getTime()), success: false, errorMessage: message, retryCount: 0, phase: 'COMPLETED' });
      await span?.end({ message, category: 'VALIDATION' }, { attempts: 1 });
      throw badRequest(message);
    }

    for (let attempt = 0; ; attempt++) {
      const startedAt = scopeClock(scope);
      if (attempt === 0) await this.instr.recordTool({ ...base, at: startedAt, startedAt, phase: 'INITIATED', success: true, retryCount: 0 });
      try {
        const output = await def.run(parsed.data, this.ctx);
        const endedAt = scopeClock(scope);
        const durationMs = Math.max(0, endedAt.getTime() - tStart.getTime());
        await this.instr.recordTool({
          ...base, at: endedAt, startedAt, endedAt, durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()), success: true, retryCount: attempt, phase: 'COMPLETED',
          outputMeta: { status: 'ok', outputKeys: Object.keys(output).slice(0, 30), outputBytes: Buffer.byteLength(safeStringify(output) ?? '', 'utf8'), attempts: attempt + 1 },
        });
        await span?.end(undefined, { attempts: attempt + 1 });
        return { output, toolCallId, attempts: attempt + 1, durationMs };
      } catch (e) {
        const endedAt = scopeClock(scope);
        const info = toErrorInfo(e);
        const transient = isTransient(e);
        const final = !transient || attempt >= maxRetries;
        await this.instr.recordTool({
          ...base, at: endedAt, startedAt, endedAt, durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()), success: false,
          errorMessage: info.message.slice(0, 500), stack: info.stack, retryCount: attempt, phase: 'COMPLETED',
          outputMeta: { status: 'error', transient, willRetry: !final, attempts: attempt + 1 },
        });
        if (final) {
          await span?.end({ message: info.message, stack: info.stack, category: transient ? 'TIMEOUT' : 'TOOL' }, { attempts: attempt + 1 });
          throw new ToolExecutionError(`Tool ${name} failed after ${attempt + 1} attempt(s): ${info.message}`.slice(0, 500), toolCallId, attempt + 1, e);
        }
        await sleep(backoffMs(attempt));
      }
    }
  }
}
