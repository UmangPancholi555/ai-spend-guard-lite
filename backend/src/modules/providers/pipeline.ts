/**
 * Mock request pipeline (the ONLY place that creates UsageEvents). See docs/CONTRACT.md "Mock request pipeline".
 * The mock provider call is a local deterministic SIMULATION; the surrounding lifecycle (cost, persistence,
 * budgets, tracing) is real app execution, hence ACTUAL spans with `simulated: true` on the provider span.
 */
import type { AppDeps } from '../../contracts/services';
import type { ErrorInfo, SpanHandle, TraceHandle } from '../../contracts/instrumentation';
import type { BudgetAlertDto, CostBreakdown, MockProviderResponse, Source } from '../../../../shared/types';
import { newRequestId, sha256 } from '../../utils/ids';
import { notFound, conflict } from '../../utils/errors';
import { parse } from '../../utils/http';
import { safeStringify } from '../../utils/serialize';
import { getMockProvider, SIM_LABEL, DEFAULT_MAX_OUTPUT_TOKENS, type MockCompletion } from './mock';
import { mockProviderRequestSchema, type MockProviderRequestInput } from './schemas';
import { emitSimulatedAgentActivity } from './simulator/agentActivity';
import { getRuntime } from '../runtime';
import { makeClock } from '../runtime/clock';
import type { Scope } from '../runtime/bus';
import { injectProjectMemory, DEFAULT_CONTEXT_WINDOW_TOKENS } from '../runtime/injection';
import type { RuntimeToolSummary, RuntimeBudgetPreflight } from '../../../../shared/runtime';

export interface ExecuteOptions {
  /** explicit event time (backdated seeding); budgets are evaluated `at` this instant */
  createdAt?: Date;
  /** source of trace/spans. Default 'ACTUAL' (live request lifecycle). Seeding passes 'SIMULATED'. */
  traceSource?: Source;
  /** create a trace + spans (default true). Seeding disables it for speed. */
  trace?: boolean;
  /** emit usage.recorded / request.failed activity (default true) */
  activity?: boolean;
  /** really sleep a tiny capped amount (<=25ms) to feel like a request (default true) */
  latency?: boolean;
  /** preloaded & already validated active project (skips the lookup) */
  project?: { id: string; name: string };
  /** extra metadata merged into UsageEvent.metadata (metadata only) */
  extraMetadata?: Record<string, unknown>;
  /**
   * 'full' (default): the real runtime components (context manager, memory injection, tool calls, event bus) record ACTUAL events.
   * 'silent': same behaviour, nothing recorded and no tool calls (bulk demo seeding).
   */
  runtime?: 'full' | 'silent';
  /** override the request's injectMemory flag (seeding disables injection) */
  injectMemory?: boolean;
  /** id of the HTTP request that triggered this execution (joins HTTP log line <-> trace <-> usage event) */
  httpRequestId?: string;
  /** called as soon as the trace exists (routes set res.locals.traceId) */
  onTrace?: (traceId: string) => void;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** span helper tolerant of "no trace" mode */
async function inSpan<T>(
  trace: TraceHandle | undefined, source: Source, name: string, kind: Parameters<TraceHandle['startSpan']>[1],
  attributes: Record<string, unknown>, fn: (span: SpanHandle | undefined) => Promise<{ value: T; endAttrs?: Record<string, unknown>; error?: ErrorInfo }>,
): Promise<T> {
  const span = trace ? await trace.startSpan(name, kind, attributes, { source }) : undefined;
  try {
    const r = await fn(span);
    await span?.end(r.error, r.endAttrs);
    return r.value;
  } catch (e) {
    await span?.end(e);
    throw e;
  }
}

export async function loadActiveProject(deps: AppDeps, projectId: string) {
  const project = await deps.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, status: true } });
  if (!project) throw notFound('Project');
  if (project.status !== 'ACTIVE') throw conflict('Project is archived and cannot accept new provider requests', { projectId, status: project.status });
  return project;
}

function toCostBreakdown(c: CostBreakdown): CostBreakdown {
  return {
    currency: 'USD', inputCostUsd: c.inputCostUsd, outputCostUsd: c.outputCostUsd, cachedCostUsd: c.cachedCostUsd, totalCostUsd: c.totalCostUsd,
    costClass: c.costClass, unknownModel: c.unknownModel, pricingConfigId: c.pricingConfigId, pricingVersion: c.pricingVersion, pricing: c.pricing,
  };
}

export async function executeMockRequest(deps: AppDeps, rawInput: MockProviderRequestInput, opts: ExecuteOptions = {}): Promise<MockProviderResponse> {
  const { instr, prisma } = deps;
  const input = parse(mockProviderRequestSchema, rawInput);
  const source: Source = opts.traceSource ?? 'ACTUAL';
  const silent = opts.runtime === 'silent';
  const rt = getRuntime(deps, { silent });

  // 1. project must exist (404) and be ACTIVE (409)
  const project = opts.project ?? await loadActiveProject(deps, input.projectId);

  const requestId = newRequestId();
  const at = opts.createdAt ?? new Date();
  const promptHash = sha256(input.prompt);
  const promptChars = input.prompt.length;

  // 2. trace (anchored at `at`: backdated traces stay in the past)
  const trace = opts.trace === false ? undefined
    : await instr.startTrace({
      name: 'provider.request', projectId: project.id, requestId, source,
      attributes: { provider: input.provider, model: input.model, simulated: true, label: SIM_LABEL, ...(opts.httpRequestId ? { httpRequestId: opts.httpRequestId } : {}) },
      at,
    });
  const traceId = trace?.traceId;
  if (traceId) opts.onTrace?.(traceId);
  // Event clock tied to the trace anchor: events stamped with it always fall inside [trace start, trace end].
  const clock = trace ? makeClock(at) : () => at;
  const scope: Scope = { trace, traceId, projectId: project.id, requestId, clock };

  let failureInfo: ErrorInfo | undefined;
  try {
    // 2b. REAL request context + memory injection (ACTUAL runtime events)
    const ctx = rt.contexts.forRequest(scope);
    await ctx.create({ chars: promptChars, bytes: Buffer.byteLength(input.prompt, 'utf8') });
    const maxOut = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const wantMemory = (opts.injectMemory ?? input.injectMemory) !== false;
    const inj = wantMemory
      ? await injectProjectMemory(rt, prisma, ctx, scope, { projectId: project.id, provider: input.provider, model: input.model, promptChars, maxOutputTokens: maxOut })
      : { memoryText: '', windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, summary: { injected: false, items: 0, estimatedTokens: 0, truncated: false, droppedItems: 0 } };
    const effectivePrompt = inj.memoryText + input.prompt; // transient; never persisted or logged

    // 2c. REAL tool calls (pricing.lookup + budget.status). Preflight only: failures are recorded but never block the request.
    const tools: RuntimeToolSummary[] = [];
    let budgetPreflight: RuntimeBudgetPreflight | undefined;
    let pricingPreflight: Record<string, unknown> | undefined;
    if (!silent) {
      const runTool = async (name: string, toolInput: Record<string, unknown>) => {
        const t0 = clock();
        try {
          const r = await rt.tools.execute(name, toolInput, scope);
          tools.push({ name, toolCallId: r.toolCallId, status: 'SUCCESS', attempts: r.attempts, durationMs: r.durationMs });
          return r.output;
        } catch (e) {
          const tc = (e as { toolCallId?: string; attempts?: number }) ?? {};
          tools.push({ name, toolCallId: tc.toolCallId ?? '', status: 'FAILURE', attempts: tc.attempts ?? 1, durationMs: Math.max(0, clock().getTime() - t0.getTime()) });
          return undefined;
        }
      };
      const pricing = await runTool('pricing.lookup', { provider: input.provider, model: input.model });
      const budget = await runTool('budget.status', { projectId: project.id });
      if (pricing) pricingPreflight = { pricingVersion: pricing.pricingVersion, costClass: pricing.costClass, unknownModel: pricing.unknownModel };
      budgetPreflight = budget
        ? { status: 'OK', budgets: Number(budget.count), highestPercent: Number(budget.highestPercent), overLimit: Boolean(budget.overLimit) }
        : { status: 'UNAVAILABLE', budgets: 0, highestPercent: 0, overLimit: false };
    }

    // 3. mock provider (simulated). Token counts reflect prompt + injected memory (deterministic for the same memory).
    const provider = getMockProvider(input.provider);
    const completion: MockCompletion = await inSpan(trace, source, 'provider.mock', 'PROVIDER',
      { provider: input.provider, model: input.model, simulated: true, label: SIM_LABEL, simulateFailure: input.simulateFailure },
      async () => {
        const c = provider.complete({
          model: input.model, prompt: effectivePrompt, maxOutputTokens: input.maxOutputTokens,
          temperature: input.temperature, simulateFailure: input.simulateFailure,
        });
        if (opts.latency !== false) await sleep(Math.min(25, Math.round(c.durationMs / 36)));
        let error: ErrorInfo | undefined;
        if (c.failure) {
          const err = new Error(c.failure.message);
          error = { message: c.failure.message, stack: err.stack, category: c.failure.category };
          failureInfo = error;
        }
        return {
          value: c, error,
          endAttrs: { simulated: true, simulatedDurationMs: c.durationMs, finishReason: c.finishReason, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cachedTokens: c.cachedTokens, errorCode: c.failure?.code },
        };
      });
    if (completion.failure) {
      await instr.recordError({
        source, category: completion.failure.category, operation: 'provider.mock', error: failureInfo,
        traceId, projectId: project.id, requestId, at: clock(),
        attributes: { provider: input.provider, model: input.model, errorCode: completion.failure.code, simulated: true },
        durationMs: completion.durationMs,
      });
    }
    await ctx.appendResponse({ bytes: Buffer.byteLength(completion.content ?? '', 'utf8'), outputTokens: completion.outputTokens, failed: !!completion.failure });

    // 4a. cost
    const cost = await inSpan(trace, source, 'cost.calculate', 'COST', { provider: input.provider, model: input.model }, async () => {
      const c = await deps.cost.calculate({
        provider: input.provider, model: input.model,
        inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, cachedTokens: completion.cachedTokens,
        at: at.toISOString(),
      });
      return { value: c, endAttrs: { costClass: c.costClass, totalCostUsd: c.totalCostUsd, unknownModel: c.unknownModel, pricingVersion: c.pricingVersion } };
    });

    // 4b. persist usage
    const runtimeSummary = {
      memory: inj.summary,
      context: { contextId: ctx.contextId, version: ctx.version, sizeBytes: ctx.sizeBytes, estimatedTokens: ctx.estimatedTokens, windowTokens: inj.windowTokens, truncated: ctx.truncated },
    };
    const metadata: Record<string, unknown> = {
      simulated: true, label: SIM_LABEL,
      provider: input.provider, model: input.model,
      temperature: completion.temperature, maxOutputTokens: completion.maxOutputTokens,
      simulatedFailure: input.simulateFailure, mockSeed: completion.seed,
      apiVersion: completion.apiVersion, responseId: completion.responseId, finishReason: completion.finishReason,
      tokenConvention: 'inputTokens = non-cached prompt tokens; cachedTokens = cached prompt tokens; total prompt tokens = inputTokens + cachedTokens',
      totalPromptTokens: completion.totalPromptTokens,
      effectivePromptChars: effectivePrompt.length,
      providerResponse: completion.providerResponse,
      agentActivitySimulated: input.simulateAgentActivity,
      memory: inj.summary, context: runtimeSummary.context,
      ...(tools.length ? { tools } : {}),
      ...(budgetPreflight ? { budgetPreflight } : {}),
      ...(pricingPreflight ? { pricingPreflight } : {}),
      ...(opts.httpRequestId ? { httpRequestId: opts.httpRequestId } : {}),
      ...opts.extraMetadata,
    };
    const event = await inSpan(trace, source, 'usage.persist', 'INTERNAL', { projectId: project.id }, async () => {
      const row = await prisma.usageEvent.create({
        data: {
          requestId, projectId: project.id, providerKey: input.provider, modelName: input.model,
          status: completion.failure ? 'FAILURE' : 'SUCCESS',
          errorCode: completion.failure?.code ?? null, errorMessage: completion.failure?.message ?? null,
          inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, cachedTokens: completion.cachedTokens,
          costPico: cost.totalCostPico, inputCostPico: cost.inputCostPico, outputCostPico: cost.outputCostPico, cachedCostPico: cost.cachedCostPico,
          costClass: cost.costClass, pricingConfigId: cost.pricingConfigId, pricingVersion: cost.pricingVersion,
          durationMs: completion.durationMs, simulated: true, traceId: traceId ?? null,
          promptHash, promptChars, responseText: completion.content, metadata: safeStringify(metadata),
          createdAt: at,
        },
      });
      return { value: row, endAttrs: { usageEventId: row.id } };
    });

    // 4c. REAL event bus: persistence publishes usage.recorded / request.failed; the activity recorder is a real subscriber.
    if (opts.activity !== false) {
      const base = { source: 'ACTUAL' as const, projectId: project.id, traceId, requestId, at: clock() };
      await rt.bus.publish(completion.failure ? 'request.failed' : 'usage.recorded', completion.failure
        ? {
          ...base, type: 'request.failed', level: 'ERROR',
          message: `Simulated ${input.provider}/${input.model} request failed: ${completion.failure.code}`,
          metadata: { usageEventId: event.id, provider: input.provider, model: input.model, errorCode: completion.failure.code, simulated: true, label: SIM_LABEL },
        }
        : {
          ...base, type: 'usage.recorded', level: 'INFO',
          message: `Recorded simulated ${input.provider}/${input.model} usage (${completion.inputTokens + completion.cachedTokens} in / ${completion.outputTokens} out tokens)`,
          metadata: {
            usageEventId: event.id, provider: input.provider, model: input.model, inputTokens: completion.inputTokens,
            outputTokens: completion.outputTokens, cachedTokens: completion.cachedTokens, costUsd: cost.totalCostUsd, costClass: cost.costClass,
            memoryItems: inj.summary.items, contextVersion: ctx.version, simulated: true, label: SIM_LABEL,
          },
        }, scope);
    }

    // 5. budgets: bus.request('budget.evaluate') -> real budget engine; returns the newly raised alerts synchronously
    const budgetAlerts: BudgetAlertDto[] = await inSpan(trace, source, 'budget.evaluate', 'BUDGET', { projectId: project.id }, async span => {
      const alerts = await rt.bus.request<BudgetAlertDto[]>('budget.evaluate', { projectId: project.id, at, traceId, spanId: span?.spanId }, { ...scope, parentSpan: span });
      return { value: alerts, endAttrs: { newAlerts: alerts.length } };
    });

    // 6. SIMULATED agent activity (DEMO generator; stays labelled SIMULATED)
    if (input.simulateAgentActivity && trace) {
      await emitSimulatedAgentActivity(instr, {
        trace, parentSpan: trace.rootSpan, projectId: project.id, requestId, seed: completion.seed, failure: input.simulateFailure, clock,
      });
    }

    // 7. end trace
    await trace?.end(failureInfo);

    return {
      requestId, traceId: traceId ?? '', simulated: true, label: SIM_LABEL,
      provider: input.provider, model: input.model, projectId: project.id,
      status: completion.failure ? 'FAILURE' : 'SUCCESS',
      content: completion.content, finishReason: completion.finishReason,
      usage: { inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, cachedTokens: completion.cachedTokens },
      cost: toCostBreakdown(cost), durationMs: completion.durationMs,
      ...(completion.failure ? { error: { code: completion.failure.code, message: completion.failure.message } } : {}),
      budgetAlerts, usageEventId: event.id,
      memory: runtimeSummary.memory, context: runtimeSummary.context,
      ...(tools.length ? { tools } : {}),
      ...(budgetPreflight ? { budgetPreflight } : {}),
      ...(opts.httpRequestId ? { httpRequestId: opts.httpRequestId } : {}),
    };
  } catch (e) {
    await trace?.end(e).catch(() => undefined);
    throw e;
  }
}
