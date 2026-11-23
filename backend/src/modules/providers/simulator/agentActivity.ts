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
}

export interface AgentActivitySummary {
  contextEvents: number; memoryEvents: number; busEvents: number; toolCalls: number;
  failed: boolean; error?: ErrorInfo;
}

const SRC = 'SIMULATED' as const;
const hex = (rng: () => number, n: number) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('');

export async function emitSimulatedAgentActivity(instr: Instrumentation, input: AgentActivityInput): Promise<AgentActivitySummary> {
  const { trace, parentSpan, projectId, requestId, failure } = input;
  const rng = mulberry32((input.seed ^ 0x5bd1e995) >>> 0);
  const corr = (s: SpanHandle) => ({ traceId: trace.traceId, spanId: s.spanId, projectId, requestId });
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
    const durationMs = randInt(rng, 1, 18);
    const span = await child(`context.${op.toLowerCase()}`, 'CONTEXT', { contextId, version, sizeBytes });
    await instr.recordContext({
      ...corr(span), source: SRC, contextId, operation: op, contextSource: source,
      sizeBytes, estimatedTokens: Math.ceil(sizeBytes / 4), version, success: true, durationMs,
    });
    await span.end(undefined, { simulatedDurationMs: durationMs });
    summary.contextEvents++;
  }

  // ---- 2. memory injection: STARTED -> COMPLETED (or FAILED) ----
  const memFail = failure === 'error' && (input.forceFailure === true || draw(0.5));
  {
    const itemCount = randInt(rng, 2, 14);
    const payloadBytes = itemCount * randInt(rng, 120, 480);
    const estimatedTokens = Math.ceil(payloadBytes / 4);
    const durationMs = randInt(rng, 5, 60);
    const span = await child('memory.injection', 'MEMORY', { itemCount, payloadBytes });
    const base = { ...corr(span), source: SRC, memorySource: 'session-memory', category: 'user-preferences', itemCount, estimatedTokens, payloadBytes };
    const operationId = await instr.recordMemory({ ...base, phase: 'STARTED' });
    summary.memoryEvents++;
    if (memFail) {
      const err: ErrorInfo = { message: 'Simulated memory store unavailable (DEMO / SIMULATED)', category: 'MEMORY' };
      await instr.recordMemory({ ...base, operationId, phase: 'FAILED', durationMs, errorMessage: err.message });
      await span.end(err, { simulatedDurationMs: durationMs });
      fail(err);
    } else {
      await instr.recordMemory({ ...base, operationId, phase: 'COMPLETED', durationMs });
      await span.end(undefined, { simulatedDurationMs: durationMs });
    }
    summary.memoryEvents++;
  }

  // ---- 3. bus operations ----
  const busFail = failure === 'rate_limit';
  {
    const span = await child('bus.publish', 'BUS', { eventName: 'agent.context.ready' });
    const durationMs = randInt(rng, 1, 9);
    await instr.recordBus({
      ...corr(span), source: SRC, operationName: 'context-bus.publish', operationType: 'PUBLISH', eventName: 'agent.context.ready',
      inputMeta: { payloadBytes: sizeBytes, subscribers: randInt(rng, 1, 4), simulated: true }, outputStatus: 'delivered', success: true, durationMs,
    });
    await span.end(undefined, { simulatedDurationMs: durationMs });
    summary.busEvents++;
  }
  {
    const span = await child('bus.request', 'BUS', { eventName: 'agent.tool.dispatch' });
    const durationMs = randInt(rng, 2, 30);
    if (busFail) {
      const err: ErrorInfo = { message: 'Simulated bus request rate limited (DEMO / SIMULATED)', category: 'BUS' };
      await instr.recordBus({
        ...corr(span), source: SRC, operationName: 'tool-bus.request', operationType: 'REQUEST', eventName: 'agent.tool.dispatch',
        inputMeta: { simulated: true }, outputStatus: 'error', success: false, durationMs, errorMessage: err.message,
      });
      await span.end(err, { simulatedDurationMs: durationMs });
      fail(err);
    } else {
      await instr.recordBus({
        ...corr(span), source: SRC, operationName: 'tool-bus.request', operationType: 'REQUEST', eventName: 'agent.tool.dispatch',
        inputMeta: { simulated: true, tools: 2 }, outputStatus: 'delivered', success: true, durationMs,
      });
      await span.end(undefined, { simulatedDurationMs: durationMs });
    }
    summary.busEvents++;
  }

  // ---- 4. tool calls: web_search (first attempt fails transiently -> retry), read_file ----
  const toolFinalFail = failure === 'timeout';
  {
    const toolCallId = `call_${hex(rng, 20)}`;
    const queryChars = randInt(rng, 12, 90);
    const inputMeta = { paramNames: ['query', 'maxResults'], queryChars, queryHash: sha256(`q|${input.seed}|${queryChars}`).slice(0, 16), simulated: true };
    const span = await child('tool.web_search', 'TOOL', { toolName: 'web_search', toolCallId, maxRetries: 2 });
    const t0 = new Date();
    const d1 = randInt(rng, 80, 420);
    await instr.recordTool({ ...corr(span), source: SRC, toolName: 'web_search', toolCallId, inputMeta, startedAt: t0, phase: 'INITIATED', success: true, retryCount: 0, maxRetries: 2 });
    const err1 = 'Simulated transient upstream error (HTTP 503) (DEMO / SIMULATED)';
    await instr.recordTool({
      ...corr(span), source: SRC, toolName: 'web_search', toolCallId, inputMeta, startedAt: t0, endedAt: new Date(t0.getTime() + d1), durationMs: d1,
      success: false, errorMessage: err1, retryCount: 0, maxRetries: 2, phase: 'COMPLETED',
    });
    summary.toolCalls++;
    const d2 = randInt(rng, 90, 480);
    const t1 = new Date(t0.getTime() + d1 + 50);
    if (toolFinalFail) {
      const err: ErrorInfo = { message: 'Simulated tool timeout after retry (DEMO / SIMULATED)', category: 'TIMEOUT' };
      await instr.recordTool({
        ...corr(span), source: SRC, toolName: 'web_search', toolCallId, inputMeta, startedAt: t1, endedAt: new Date(t1.getTime() + d2), durationMs: d2,
        success: false, errorMessage: err.message, retryCount: 1, maxRetries: 2, phase: 'COMPLETED',
      });
      await span.end(err, { attempts: 2, simulatedDurationMs: d1 + d2 });
      fail(err);
    } else {
      await instr.recordTool({
        ...corr(span), source: SRC, toolName: 'web_search', toolCallId, inputMeta, outputMeta: { resultCount: randInt(rng, 3, 10), bytes: randInt(rng, 2000, 9000), simulated: true },
        startedAt: t1, endedAt: new Date(t1.getTime() + d2), durationMs: d2, success: true, retryCount: 1, maxRetries: 2, phase: 'COMPLETED',
      });
      await span.end(undefined, { attempts: 2, simulatedDurationMs: d1 + d2 });
    }
    summary.toolCalls++;
  }
  if (!toolFinalFail) {
    const toolCallId = `call_${hex(rng, 20)}`;
    const inputMeta = { paramNames: ['path'], pathChars: randInt(rng, 8, 40), simulated: true };
    const span = await child('tool.read_file', 'TOOL', { toolName: 'read_file', toolCallId });
    const t0 = new Date();
    const d = randInt(rng, 4, 40);
    await instr.recordTool({ ...corr(span), source: SRC, toolName: 'read_file', toolCallId, inputMeta, startedAt: t0, phase: 'INITIATED', success: true, retryCount: 0, maxRetries: 0 });
    await instr.recordTool({
      ...corr(span), source: SRC, toolName: 'read_file', toolCallId, inputMeta, outputMeta: { bytes: randInt(rng, 300, 6000), simulated: true },
      startedAt: t0, endedAt: new Date(t0.getTime() + d), durationMs: d, success: true, retryCount: 0, maxRetries: 0, phase: 'COMPLETED',
    });
    await span.end(undefined, { simulatedDurationMs: d });
    summary.toolCalls++;
  }

  return summary;
}
