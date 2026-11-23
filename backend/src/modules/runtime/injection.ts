/**
 * Real memory injection step of the request pipeline.
 * Loads the project's enabled memory items, adds them to the request context, REALLY truncates (drops whole items, oldest kept first)
 * when prompt + memory + max output would exceed the model's context window, and returns the text that is prepended to the
 * provider prompt. Emits ACTUAL memory events (STARTED -> COMPLETED | FAILED) + context events + a MEMORY span.
 * No items => nothing is emitted (nothing is fabricated). A DB error is recorded as FAILED and the request continues without memory.
 */
import type { PrismaClient } from '@prisma/client';
import type { ErrorInfo } from '../../contracts/instrumentation';
import { toErrorInfo } from '../../contracts/instrumentation';
import type { RuntimeMemorySummary } from '../../../../shared/runtime';
import { estimateTokens } from '../providers/mock/engine';
import { scopeClock, type Scope } from './bus';
import type { RequestContext } from './context';
import type { Runtime } from './index';
import { fitToBudget, planInjection } from './memory';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const MEMORY_SOURCE = 'project-memory-store';

export interface InjectionResult {
  memoryText: string;
  summary: RuntimeMemorySummary;
  windowTokens: number;
  failed?: ErrorInfo;
}

export async function resolveWindowTokens(prisma: PrismaClient, provider: string, model: string): Promise<number> {
  const m = await prisma.model.findFirst({ where: { name: model, provider: { key: provider } }, select: { contextWindow: true } });
  return m?.contextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export async function injectProjectMemory(
  rt: Runtime, prisma: PrismaClient, ctx: RequestContext, scope: Scope,
  req: { projectId: string; provider: string; model: string; promptChars: number; maxOutputTokens: number },
): Promise<InjectionResult> {
  const none = (windowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS): InjectionResult => ({
    memoryText: '', windowTokens, summary: { injected: false, items: 0, estimatedTokens: 0, truncated: false, droppedItems: 0 },
  });
  const t0 = scopeClock(scope);
  const base = { traceId: scope.traceId ?? scope.trace?.traceId, projectId: scope.projectId, requestId: scope.requestId, source: 'ACTUAL' as const, memorySource: MEMORY_SOURCE };
  const dur = () => Math.max(0, scopeClock(scope).getTime() - t0.getTime());
  const parent = scope.parentSpan ?? scope.trace?.rootSpan;

  let rows: Awaited<ReturnType<Runtime['memory']['enabledItems']>>;
  let windowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
  try {
    rows = await rt.memory.enabledItems(req.projectId);
    windowTokens = await resolveWindowTokens(prisma, req.provider, req.model);
  } catch (e) {
    const err: ErrorInfo = { ...toErrorInfo(e), category: 'MEMORY' };
    const span = parent ? await parent.startSpan('memory.injection', 'MEMORY', { memorySource: MEMORY_SOURCE }, { source: 'ACTUAL' }) : undefined;
    const operationId = await rt.instr.recordMemory({ ...base, spanId: span?.spanId, at: t0, phase: 'STARTED', category: 'unknown', itemCount: 0, estimatedTokens: 0, payloadBytes: 0 });
    await rt.instr.recordMemory({
      ...base, spanId: span?.spanId, at: scopeClock(scope), operationId, phase: 'FAILED', category: 'unknown', itemCount: 0, estimatedTokens: 0, payloadBytes: 0,
      durationMs: dur(), errorMessage: `Memory lookup failed: ${err.message}`.slice(0, 500), stack: err.stack,
    });
    await span?.end(err, { failed: true });
    return { ...none(), failed: err };
  }
  if (rows.length === 0) return none(windowTokens);

  const plan = planInjection(rows);
  const category = plan.categories.join(',');
  const span = parent ? await parent.startSpan('memory.injection', 'MEMORY', { memorySource: MEMORY_SOURCE, itemCount: plan.items.length, estimatedTokens: plan.tokens }, { source: 'ACTUAL' }) : undefined;
  const corr = { ...base, spanId: span?.spanId, category };
  const operationId = await rt.instr.recordMemory({ ...corr, at: t0, phase: 'STARTED', itemCount: plan.items.length, estimatedTokens: plan.tokens, payloadBytes: plan.bytes });

  await ctx.addMemory({ bytes: plan.bytes, tokens: plan.tokens, items: plan.items.length });

  // REAL truncation: prompt + memory + reserved output must fit the model window
  const budget = Math.max(0, windowTokens - req.maxOutputTokens - estimateTokens(req.promptChars));
  const fit = fitToBudget(plan, budget);
  if (fit.dropped > 0) {
    await ctx.truncate({
      removedBytes: plan.bytes - fit.plan.bytes, removedTokens: plan.tokens - fit.plan.tokens, droppedItems: fit.dropped, windowTokens,
    });
  }
  await rt.instr.recordMemory({
    ...corr, at: scopeClock(scope), operationId, phase: 'COMPLETED', itemCount: fit.plan.items.length,
    estimatedTokens: fit.plan.tokens, payloadBytes: fit.plan.bytes, durationMs: dur(),
  });
  await span?.end(undefined, { itemCount: fit.plan.items.length, estimatedTokens: fit.plan.tokens, droppedItems: fit.dropped, truncated: fit.dropped > 0 });
  return {
    memoryText: fit.plan.items.map(i => i.text).join(''), windowTokens,
    summary: { injected: fit.plan.items.length > 0, items: fit.plan.items.length, estimatedTokens: fit.plan.tokens, truncated: fit.dropped > 0, droppedItems: fit.dropped },
  };
}
