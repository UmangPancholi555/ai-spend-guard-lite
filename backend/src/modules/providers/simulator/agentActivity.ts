/**
 * SIMULATED agent activity generator (DEMO). Emits context / memory / bus / tool events through the
 * Instrumentation SDK with source 'SIMULATED', correlated to an existing trace via child spans.
 * Metadata only: counts, sizes, hashes, names. Never any content. Deterministic from `seed`.
 */
import type { Instrumentation, SpanHandle, TraceHandle, ErrorInfo } from '../../../contracts/instrumentation';
import type { ContextOperation, SimulatedFailure } from '../../../../../shared/types';
import { sha256 } from '../../../utils/ids';
import { mulberry32, randInt } from '../mock/prng';

export interface AgentActivityInput {
  trace: TraceHandle;
  parentSpan: SpanHandle;
  projectId: string;
  requestId: string;
  seed: number;
  failure: SimulatedFailure;
  /** make the failure mode deterministic (always fails the matching step) instead of seed-probabilistic */
  forceFailure?: boolean;
  /**
   * Event clock. Every event is stamped `at: clock()` so simulated events stay inside the trace window
   * [trace start, trace end] (also for backdated traces). Default: real time.
   * Simulated latencies are NOT used as timestamps/durations (they would run past the trace end); they are
   * reported as `simulatedDurationMs` / `simulatedLatencyMs` attributes and the event durations are the real elapsed ms.
   */
  clock?: () => Date;
}

export interface AgentActivitySummary {
  contextEvents: number; memoryEvents: number; busEvents: number; toolCalls: number;
  failed: boolean; error?: ErrorInfo;
}

const SRC = 'SIMULATED' as const;
const hex = (rng: () => number, n: number) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('');

export async function emitSimulatedAgentActivity(instr: Instrumentation, input: AgentActivityInput): Promise<AgentActivitySummary> {
  const { trace, parentSpan, projectId, requestId, failure } = input;
  const clock = input.clock ?? (() => new Date());
  const ms = (from: Date) => Math.max(0, clock().getTime() - from.getTime());
  const rng = mulberry32((input.seed ^ 0x5bd1e995) >>> 0);
  const corr = (s: SpanHandle) => ({ traceId: trace.traceId, spanId: s.spanId, projectId, requestId, at: clock() });
  const child = (name: string, kind: Parameters<SpanHandle['startSpan']>[1], attrs: Record<string, unknown> = {}) =>
    parentSpan.startSpan(name, kind, { simulated: true, ...attrs }, { source: SRC });

  const summary: AgentActivitySummary = { contextEvents: 0, memoryEvents: 0, busEvents: 0, toolCalls: 0, failed: false };
  const fail = (e: ErrorInfo) => { summary.failed = true; summary.error ??= e; };
  const draw = (p: number) => rng() < p; // always consumes one draw => stream stays stable

  // ---- 1. context lifecycle: CREATED -> UPDATED -> ADDED -> MODIFIED (increasing version / size) ----
  const contextId = `ctx_${hex(rng, 16)}`;
  const ops: { op: ContextOperation; source: string }[] = [
    { op: 'CREATED', source: 'agent-session' }, { op: 'UPDATED', source: 'user-input' },
    { op: 'ADDED', source: 'retrieved-documents' }, { op: 'MODIFIED', source: 'tool-output' },
  ];
  let sizeBytes = randInt(rng, 1500, 4000);
  let version = 0;
  for (const { op, source } of ops) {
    version += 1;
    if (op !== 'CREATED') sizeBytes += randInt(rng, 400, 2600);
    const simMs = randInt(rng, 1, 18);
    const t0 = clock();
    const span = await child(`context.${op.toLowerCase()}`, 'CONTEXT', { contextId, version, sizeBytes });
    await instr.recordContext({
      ...corr(span), source: SRC, contextId, operation: op, contextSource: source,
      sizeBytes, estimatedTokens: Math.ceil(sizeBytes / 4), version, success: true, durationMs: ms(t0),
    });
    await span.end(undefined, { simulatedDurationMs: simMs });
    summary.contextEvents++;
  }

  // ---- 2. memory injection: STARTED -> COMPLETED (or FAILED) ----
  const memFail = failure === 'error' && (input.forceFailure === true || draw(0.5));
  {
    const itemCount = randInt(rng, 2, 14);
    const payloadBytes = itemCount * randInt(rng, 120, 480);
    const estimatedTokens = Math.ceil(payloadBytes / 4);
    const simMs = randInt(rng, 5, 60);
    const t0 = clock();
    const span = await child('memory.injection', 'MEMORY', { itemCount, payloadBytes });
    const base = { ...corr(span), source: SRC, memorySource: 'session-memory', category: 'user-preferences', itemCount, estimatedTokens, payloadBytes };
    const operationId = await instr.recordMemory({ ...base, phase: 'STARTED', at: t0 });
    summary.memoryEvents++;
    if (memFail) {
      const err: ErrorInfo = { message: 'Simulated memory store unavailable (DEMO / SIMULATED)', category: 'MEMORY' };
      await instr.recordMemory({ ...base, operationId, phase: 'FAILED', at: clock(), durationMs: ms(t0), errorMessage: err.message });
      await span.end(err, { simulatedDurationMs: simMs });
      fail(err);
    } else {
      await instr.recordMemory({ ...base, operationId, phase: 'COMPLETED', at: clock(), durationMs: ms(t0) });
      await span.end(undefined, { simulatedDurationMs: simMs });
    }
    summary.memoryEvents++;
  }

  // ---- 3. bus operations ----
  const busFail = failure === 'rate_limit';
  {
    const simMs = randInt(rng, 1, 9);
    const t0 = clock();
    const span = await child('bus.publish', 'BUS', { eventName: 'agent.context.ready' });
    await instr.recordBus({
      ...corr(span), source: SRC, operationName: 'context-bus.publish', operationType: 'PUBLISH', eventName: 'agent.context.ready',
      inputMeta: { payloadBytes: sizeBytes, subscribers: randInt(rng, 1, 4), simulated: true, simulatedLatencyMs: simMs }, outputStatus: 'delivered', success: true, durationMs: ms(t0),
    });
    await span.end(undefined, { simulatedDurationMs: simMs });
    summary.busEvents++;
  }
  {
    const simMs = randInt(rng, 2, 30);
    const t0 = clock();
    const span = await child('bus.request', 'BUS', { eventName: 'agent.tool.dispatch' });
    if (busFail) {
      const err: ErrorInfo = { message: 'Simulated bus request rate limited (DEMO / SIMULATED)', category: 'BUS' };
      await instr.recordBus({
        ...corr(span), source: SRC, operationName: 'tool-bus.request', operationType: 'REQUEST', eventName: 'agent.tool.dispatch',
        inputMeta: { simulated: true, simulatedLatencyMs: simMs }, outputStatus: 'error', success: false, durationMs: ms(t0), errorMessage: err.message,
      });
      await span.end(err, { simulatedDurationMs: simMs });
      fail(err);
    } else {
      await instr.recordBus({
        ...corr(span), source: SRC, operationName: 'tool-bus.request', operationType: 'REQUEST', eventName: 'agent.tool.dispatch',
        inputMeta: { simulated: true, tools: 2, simulatedLatencyMs: simMs }, outputStatus: 'delivered', success: true, durationMs: ms(t0),
      });
      await span.end(undefined, { simulatedDurationMs: simMs });
    }
    summary.busEvents++;
  }

  // ---- 4. tool calls: web_search (first attempt fails transiently -> retry), read_file ----
  // Timestamps come from the trace clock; the simulated latency is reported as `simulatedLatencyMs` metadata only.
  const toolFinalFail = failure === 'timeout';
  {
    const toolCallId = `call_${hex(rng, 20)}`;
    const queryChars = randInt(rng, 12, 90);
    const inputMeta = { paramNames: ['query', 'maxResults'], queryChars, queryHash: sha256(`q|${input.seed}|${queryChars}`).slice(0, 16), simulated: true };
    const sim1 = randInt(rng, 80, 420);
    const sim2 = randInt(rng, 90, 480);
    const resultCount = randInt(rng, 3, 10);
    const resultBytes = randInt(rng, 2000, 9000);
    const span = await child('tool.web_search', 'TOOL', { toolName: 'web_search', toolCallId, maxRetries: 2 });
    const t0 = clock();
    await instr.recordTool({ ...corr(span), at: t0, source: SRC, toolName: 'web_search', toolCallId, inputMeta, startedAt: t0, phase: 'INITIATED', success: true, retryCount: 0, maxRetries: 2 });
    const e1 = clock();
    await instr.recordTool({
      ...corr(span), at: e1, source: SRC, toolName: 'web_search', toolCallId, inputMeta, outputMeta: { simulatedLatencyMs: sim1, simulated: true },
      startedAt: t0, endedAt: e1, durationMs: e1.getTime() - t0.getTime(),
      success: false, errorMessage: 'Simulated transient upstream error (HTTP 503) (DEMO / SIMULATED)', retryCount: 0, maxRetries: 2, phase: 'COMPLETED',
    });
    summary.toolCalls++;
    const t1 = clock();
    const e2 = clock();
    if (toolFinalFail) {
      const err: ErrorInfo = { message: 'Simulated tool timeout after retry (DEMO / SIMULATED)', category: 'TIMEOUT' };
      await instr.recordTool({
        ...corr(span), at: e2, source: SRC, toolName: 'web_search', toolCallId, inputMeta, outputMeta: { simulatedLatencyMs: sim2, simulated: true },
        startedAt: t1, endedAt: e2, durationMs: e2.getTime() - t1.getTime(),
        success: false, errorMessage: err.message, retryCount: 1, maxRetries: 2, phase: 'COMPLETED',
      });
      await span.end(err, { attempts: 2, simulatedDurationMs: sim1 + sim2 });
      fail(err);
    } else {
      await instr.recordTool({
        ...corr(span), at: e2, source: SRC, toolName: 'web_search', toolCallId, inputMeta, outputMeta: { resultCount, bytes: resultBytes, simulatedLatencyMs: sim2, simulated: true },
        startedAt: t1, endedAt: e2, durationMs: e2.getTime() - t1.getTime(), success: true, retryCount: 1, maxRetries: 2, phase: 'COMPLETED',
      });
      await span.end(undefined, { attempts: 2, simulatedDurationMs: sim1 + sim2 });
    }
    summary.toolCalls++;
  }
  if (!toolFinalFail) {
    const toolCallId = `call_${hex(rng, 20)}`;
    const inputMeta = { paramNames: ['path'], pathChars: randInt(rng, 8, 40), simulated: true };
    const sim = randInt(rng, 4, 40);
    const outBytes = randInt(rng, 300, 6000);
    const span = await child('tool.read_file', 'TOOL', { toolName: 'read_file', toolCallId });
    const t0 = clock();
    await instr.recordTool({ ...corr(span), at: t0, source: SRC, toolName: 'read_file', toolCallId, inputMeta, startedAt: t0, phase: 'INITIATED', success: true, retryCount: 0, maxRetries: 0 });
    const e = clock();
    await instr.recordTool({
      ...corr(span), at: e, source: SRC, toolName: 'read_file', toolCallId, inputMeta, outputMeta: { bytes: outBytes, simulatedLatencyMs: sim, simulated: true },
      startedAt: t0, endedAt: e, durationMs: e.getTime() - t0.getTime(), success: true, retryCount: 0, maxRetries: 0, phase: 'COMPLETED',
    });
    await span.end(undefined, { simulatedDurationMs: sim });
    summary.toolCalls++;
  }

  return summary;
}
