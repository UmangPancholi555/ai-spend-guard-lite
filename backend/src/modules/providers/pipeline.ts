/**
 * Mock request pipeline (the ONLY place that creates UsageEvents). See docs/CONTRACT.md "Mock request pipeline".
 * The mock provider call is a local deterministic SIMULATION; the surrounding lifecycle (cost, persistence,
 * budgets, tracing) is real app execution, hence ACTUAL spans with `simulated: true` on the provider span.
 */
import { performance } from 'node:perf_hooks';
import type { AppDeps } from '../../contracts/services';
import type { ErrorInfo, SpanHandle, TraceHandle } from '../../contracts/instrumentation';
import type { BudgetAlertDto, CostBreakdown, MockProviderResponse, Source } from '../../../../shared/types';
import { newRequestId, sha256 } from '../../utils/ids';
import { notFound, conflict } from '../../utils/errors';
import { parse } from '../../utils/http';
import { safeStringify } from '../../utils/serialize';
import { getMockProvider, SIM_LABEL, type MockCompletion } from './mock';
import { mockProviderRequestSchema, type MockProviderRequestInput } from './schemas';
import { emitSimulatedAgentActivity } from './simulator/agentActivity';

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

  // 1. project must exist (404) and be ACTIVE (409)
  const project = opts.project ?? await loadActiveProject(deps, input.projectId);

  const requestId = newRequestId();
  const at = opts.createdAt ?? new Date();
  const promptHash = sha256(input.prompt);
  const promptChars = input.prompt.length;

  // 2. trace
  const trace = opts.trace === false ? undefined
    : await instr.startTrace({
      name: 'provider.request', projectId: project.id, requestId, source,
      attributes: { provider: input.provider, model: input.model, simulated: true, label: SIM_LABEL },
      at, // anchor: backdated traces stay in the past
    });
  const traceId = trace?.traceId;
  // Event clock tied to the trace anchor: events stamped with it always fall inside [trace start, trace end].
  const perf0 = performance.now();
  const clock = (): Date => (trace ? new Date(at.getTime() + Math.floor(performance.now() - perf0)) : at);

  let failureInfo: ErrorInfo | undefined;
  try {
    // 3. mock provider (simulated)
    const provider = getMockProvider(input.provider);
    const completion: MockCompletion = await inSpan(trace, source, 'provider.mock', 'PROVIDER',
      { provider: input.provider, model: input.model, simulated: true, label: SIM_LABEL, simulateFailure: input.simulateFailure },
      async () => {
        const c = provider.complete({
          model: input.model, prompt: input.prompt, maxOutputTokens: input.maxOutputTokens,
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
    const metadata: Record<string, unknown> = {
      simulated: true, label: SIM_LABEL,
      provider: input.provider, model: input.model,
      temperature: completion.temperature, maxOutputTokens: completion.maxOutputTokens,
      simulatedFailure: input.simulateFailure, mockSeed: completion.seed,
      apiVersion: completion.apiVersion, responseId: completion.responseId, finishReason: completion.finishReason,
      tokenConvention: 'inputTokens = non-cached prompt tokens; cachedTokens = cached prompt tokens; total prompt tokens = inputTokens + cachedTokens',
      totalPromptTokens: completion.totalPromptTokens,
      providerResponse: completion.providerResponse,
      agentActivitySimulated: input.simulateAgentActivity,
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

    if (opts.activity !== false) {
      await instr.recordActivity(completion.failure
        ? {
          type: 'request.failed', level: 'ERROR', source: 'ACTUAL', projectId: project.id, traceId, requestId, at: clock(),
          message: `Simulated ${input.provider}/${input.model} request failed: ${completion.failure.code}`,
          metadata: { usageEventId: event.id, provider: input.provider, model: input.model, errorCode: completion.failure.code, simulated: true, label: SIM_LABEL },
        }
        : {
          type: 'usage.recorded', level: 'INFO', source: 'ACTUAL', projectId: project.id, traceId, requestId, at: clock(),
          message: `Recorded simulated ${input.provider}/${input.model} usage (${completion.inputTokens + completion.cachedTokens} in / ${completion.outputTokens} out tokens)`,
          metadata: {
            usageEventId: event.id, provider: input.provider, model: input.model, inputTokens: completion.inputTokens,
            outputTokens: completion.outputTokens, cachedTokens: completion.cachedTokens, costUsd: cost.totalCostUsd, costClass: cost.costClass,
            simulated: true, label: SIM_LABEL,
          },
        });
    }

    // 5. budgets
    const budgetAlerts: BudgetAlertDto[] = await inSpan(trace, source, 'budget.evaluate', 'BUDGET', { projectId: project.id }, async span => {
      const alerts = await deps.budgets.evaluateAfterUsage({ projectId: project.id, at, traceId, spanId: span?.spanId });
      return { value: alerts, endAttrs: { newAlerts: alerts.length } };
    });

    // 6. simulated agent activity
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
    };
  } catch (e) {
    await trace?.end(e).catch(() => undefined);
    throw e;
  }
}
