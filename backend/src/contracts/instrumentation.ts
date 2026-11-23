/**
 * Instrumentation SDK contract. Implemented by modules/instrumentation (createInstrumentation).
 * Every record* call: (1) inserts into its typed table, (2) mirrors into ExecutionLog,
 * (3) appends a JSONL line to the persistent log file. Never pass sensitive content: only metadata
 * (names, counts, sizes, hashes). The SDK additionally strips/hashes values under keys that look
 * like content (see implementation).
 *
 * `source` semantics (never fabricate):
 *  - 'ACTUAL'    : emitted by a real instrumented component of THIS app (request lifecycle, in-app bus, budget engine, background tasks, error handler).
 *  - 'SIMULATED' : emitted by the DEMO/SIMULATED generators (mock agent activity: memory injection, tool calls, context lifecycle, simulated bus ops).
 */
import type {
  Source, SpanKind, ErrorCategory, ContextOperation, BusOperationType, TaskKind, TaskStatus,
} from '../../../shared/types';

export interface ErrorInfo { message: string; stack?: string; category?: ErrorCategory }

export interface SpanHandle {
  readonly spanId: string;
  readonly traceId: string;
  /** child span; parent = this span */
  startSpan(name: string, kind: SpanKind, attributes?: Record<string, unknown>, opts?: { source?: Source }): Promise<SpanHandle>;
  /** end span; status ERROR when error given. Idempotent. Returns duration ms. */
  end(error?: ErrorInfo | unknown, attributes?: Record<string, unknown>): Promise<number>;
}

export interface TraceHandle {
  readonly traceId: string;
  readonly rootSpan: SpanHandle;
  startSpan(name: string, kind: SpanKind, attributes?: Record<string, unknown>, opts?: { source?: Source; parent?: SpanHandle }): Promise<SpanHandle>;
  /** end trace (+ root span). status ERROR if error given. Idempotent. */
  end(error?: ErrorInfo | unknown): Promise<number>;
}

export interface Correlation { traceId?: string; spanId?: string; projectId?: string; requestId?: string }

export interface MemoryRecordInput extends Correlation {
  source: Source;
  operationId?: string;       // reuse the id of 'started' for completed/failed
  phase: 'STARTED' | 'COMPLETED' | 'FAILED';
  memorySource: string; category: string;
  itemCount: number; estimatedTokens: number; payloadBytes: number;
  durationMs?: number; errorMessage?: string; stack?: string;
}
export interface BusRecordInput extends Correlation {
  source: Source;
  operationId?: string;
  operationName: string; operationType: BusOperationType; eventName: string;
  inputMeta?: Record<string, unknown>; outputStatus?: string;
  success: boolean; durationMs?: number; errorMessage?: string; stack?: string;
}
export interface ToolRecordInput extends Correlation {
  source: Source;
  toolName: string; toolCallId: string;
  inputMeta?: Record<string, unknown>; outputMeta?: Record<string, unknown>;
  startedAt: Date; endedAt?: Date; durationMs?: number;
  success: boolean; errorMessage?: string; stack?: string; retryCount?: number; maxRetries?: number;
  /** 'INITIATED' logs only the start (no table row finalization); default 'COMPLETED' */
  phase?: 'INITIATED' | 'COMPLETED';
}
export interface ContextRecordInput extends Correlation {
  source: Source;
  contextId: string; operation: ContextOperation; contextSource: string;
  sizeBytes: number; estimatedTokens: number; version: number;
  success?: boolean; errorMessage?: string; durationMs?: number;
}
export interface ActivityInput extends Correlation {
  type: string; level?: 'INFO' | 'WARN' | 'ERROR'; message: string; source: Source; metadata?: Record<string, unknown>;
}
export interface ErrorRecordInput extends Correlation {
  source: Source; category: ErrorCategory; operation: string; error: ErrorInfo | unknown;
  attributes?: Record<string, unknown>; durationMs?: number;
}
export interface LogInput extends Correlation {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  eventType: string;
  category: 'REQUEST' | 'MEMORY' | 'BUS' | 'TOOL' | 'CONTEXT' | 'ERROR' | 'SYSTEM' | 'BUDGET' | 'PROVIDER';
  operation: string; status: 'STARTED' | 'SUCCESS' | 'FAILURE' | 'INFO'; source: Source;
  message: string; durationMs?: number; attributes?: Record<string, unknown>;
  errorCategory?: ErrorCategory; errorMessage?: string; stack?: string;
}

export interface TaskHandle {
  readonly id: string;
  succeed(result?: Record<string, unknown>): Promise<void>;
  fail(error: ErrorInfo | unknown): Promise<void>;
}

export interface Instrumentation {
  startTrace(input: { name: string; projectId?: string; requestId?: string; source: Source; attributes?: Record<string, unknown> }): Promise<TraceHandle>;
  recordMemory(i: MemoryRecordInput): Promise<string>;   // returns operationId
  recordBus(i: BusRecordInput): Promise<string>;         // returns operationId
  recordTool(i: ToolRecordInput): Promise<void>;
  recordContext(i: ContextRecordInput): Promise<void>;
  recordActivity(i: ActivityInput): Promise<void>;
  recordError(i: ErrorRecordInput): Promise<void>;
  log(i: LogInput): Promise<void>;
  /** background task lifecycle (persisted in BackgroundTask) */
  startTask(input: { name: string; kind: TaskKind; source: Source; traceId?: string }): Promise<TaskHandle>;
  /** Convenience: run fn inside a span, auto end/ error. */
  withSpan<T>(parent: TraceHandle | SpanHandle, name: string, kind: SpanKind, fn: (span: SpanHandle) => Promise<T>, opts?: { source?: Source; attributes?: Record<string, unknown> }): Promise<T>;
}

/** Normalizes unknown throwables into ErrorInfo. */
export function toErrorInfo(e: unknown): ErrorInfo {
  if (e && typeof e === 'object' && 'message' in e) {
    const x = e as { message: unknown; stack?: unknown; category?: ErrorCategory };
    return { message: String(x.message), stack: typeof x.stack === 'string' ? x.stack : undefined, category: x.category };
  }
  return { message: String(e) };
}

export type { TaskStatus };
