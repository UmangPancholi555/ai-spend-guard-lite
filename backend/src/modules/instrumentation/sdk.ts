/**
 * Instrumentation SDK implementation (Prisma + JSONL).
 *
 * Every record* call: (1) inserts a typed row (where a typed table exists), (2) mirrors an ExecutionLog row,
 * (3) appends the ExecutionLogDto as one JSON line to `${logDir}/execution-YYYY-MM-DD.jsonl` (date = event ts, UTC; rolls over to
 * `execution-YYYY-MM-DD.N.jsonl` at 50MB).
 *
 * Resilience: instrumentation must never crash the host app. Every DB / file write is wrapped; failures are reported with
 * a rate-limited console.error (non-test runs) and the optional `onError(error, context)` hook (called every time) and then swallowed. Handles keep working
 * even if their rows could not be written (ids are generated client-side). DB and file writes are independent: a DB failure
 * still produces the JSONL line and vice versa.
 *
 * Optional backdating: callers (e.g. demo seeding) may pass `at: Date` on any record* input / startTrace input (not part of the
 * published contract types; read defensively). Spans of a trace use a monotonic virtual clock anchored at the trace start, so a
 * backdated trace has consistent span timestamps.
 */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type {
  ErrorCategory, ExecutionLogDto, LogCategory, LogLevel, Source, SpanKind, TaskKind,
} from '../../../../shared/types';
import {
  toErrorInfo,
  type ActivityInput, type BusRecordInput, type ContextRecordInput, type Correlation, type ErrorInfo, type ErrorRecordInput,
  type Instrumentation, type LogInput, type MemoryRecordInput, type SpanHandle, type TaskHandle, type ToolRecordInput,
  type TraceHandle,
} from '../../contracts/instrumentation';
import { newSpanId, newTraceId } from '../../utils/ids';
import { safeStringify } from '../../utils/serialize';
import { createJsonlWriter, maxDirBytesFromEnv } from './jsonl';
import { boundText, sanitizeAttributes } from './sanitize';

export interface InstrumentationOptions {
  logDir: string;
  /** Called on EVERY instrumentation write failure (not rate limited). Mainly for tests / custom alerting. */
  onError?: (error: unknown, context: string) => void;
  /** Max size of one JSONL day file before rolling over to `execution-<day>.<n>.jsonl` (default 50MB). */
  maxLogFileBytes?: number;
  /** Cap on the TOTAL JSONL directory size (default 500MB, env LOG_DIR_MAX_MB): oldest day files are dropped first, then appends are suspended with one warning. */
  maxLogDirBytes?: number;
  /** JSONL write batching: max delay in ms before buffered lines hit disk (default 250; 0 = write-through, the default under NODE_ENV=test/VITEST). Call `flushLogs()` on shutdown. */
  jsonlFlushMs?: number;
  /**
   * Print write failures to console.error (default: true except when NODE_ENV=test or VITEST is set).
   * Rate limited: at most one line per failure context per `errorLogIntervalMs`, with a count of suppressed repeats.
   */
  consoleErrors?: boolean;
  /** Console rate-limit window per failure context (default 30000 ms). */
  errorLogIntervalMs?: number;
}

const newId = () => `c${randomBytes(12).toString('hex')}`;
const json = (v: unknown) => safeStringify(v) ?? '{}';
const TIMEOUT_RE = /time(d)?[\s-]?out|ETIMEDOUT|deadline/i;
const MAX_MSG = 2000;
const MAX_STACK = 8000;

function atOf(i: unknown): Date | undefined {
  const at = (i as { at?: unknown } | undefined)?.at;
  return at instanceof Date && !Number.isNaN(at.getTime()) ? at : undefined;
}

function errFields(error: unknown): { errorMessage: string; stack?: string; category?: ErrorCategory } {
  const info: ErrorInfo = toErrorInfo(error);
  return { errorMessage: boundText(info.message, MAX_MSG) ?? 'Unknown error', stack: boundText(info.stack, MAX_STACK), category: info.category };
}

interface LogEntry extends Correlation {
  ts?: Date;
  level: LogLevel; eventType: string; category: LogCategory; operation: string;
  status: ExecutionLogDto['status']; source: Source; message: string; durationMs?: number | null;
  attributes?: Record<string, unknown>;
  errorCategory?: ErrorCategory | null; errorMessage?: string | null; stack?: string | null;
}

export function createInstrumentation(prisma: PrismaClient, opts: InstrumentationOptions): Instrumentation {
  const { logDir } = opts;
  const consoleErrors = opts.consoleErrors ?? !(process.env.NODE_ENV === 'test' || process.env.VITEST);
  const windowMs = opts.errorLogIntervalMs ?? 30_000;
  const lastPrinted = new Map<string, { at: number; suppressed: number }>();

  const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
  const jsonl = createJsonlWriter(logDir, {
    maxFileBytes: opts.maxLogFileBytes, maxDirBytes: opts.maxLogDirBytes ?? maxDirBytesFromEnv(),
    flushIntervalMs: opts.jsonlFlushMs ?? (isTest ? 0 : undefined),
    onError: (e, ctx) => reportFailure(ctx, e),
  });

  function reportFailure(context: string, e: unknown) {
    if (consoleErrors) {
      const now = Date.now();
      const st = lastPrinted.get(context);
      if (!st || now - st.at >= windowMs) {
        const extra = st && st.suppressed > 0 ? ` (+${st.suppressed} similar suppressed in the last ${Math.round((now - st.at) / 1000)}s)` : '';
        console.error(`[instrumentation] ${context} failed: ${e instanceof Error ? e.message : String(e)}${extra}`);
        lastPrinted.set(context, { at: now, suppressed: 0 });
      } else {
        st.suppressed++;
      }
    }
    try { opts.onError?.(e, context); } catch { /* hook errors are ignored */ }
  }
  async function db(context: string, fn: () => Promise<unknown>): Promise<boolean> {
    try { await fn(); return true; } catch (e) { reportFailure(context, e); return false; }
  }

  // in-flight emits, so flush() can wait for log calls nobody awaited (e.g. the request 'finish' log)
  const pending = new Set<Promise<ExecutionLogDto>>();
  /** Mirror into ExecutionLog + JSONL. Never throws. */
  function emit(e: LogEntry): Promise<ExecutionLogDto> {
    const p = writeLog(e);
    pending.add(p);
    p.finally(() => pending.delete(p)).catch(() => {});
    return p;
  }
  async function flush(): Promise<void> {
    while (pending.size > 0) await Promise.allSettled(pending);
    await jsonl.flush();
  }
  async function writeLog(e: LogEntry): Promise<ExecutionLogDto> {
    const ts = e.ts ?? new Date();
    const dto: ExecutionLogDto = {
      id: newId(), ts: ts.toISOString(), level: e.level, eventType: e.eventType, category: e.category,
      operation: (boundText(e.operation, 300) ?? '').replace(/\s*\n+\s*/g, ' '), status: e.status, source: e.source,
      traceId: e.traceId ?? null, spanId: e.spanId ?? null, requestId: e.requestId ?? null, projectId: e.projectId ?? null,
      durationMs: e.durationMs ?? null, message: boundText(e.message, MAX_MSG) ?? '',
      attributes: e.attributes ?? {}, errorCategory: e.errorCategory ?? null,
      errorMessage: boundText(e.errorMessage, MAX_MSG) ?? null, stack: boundText(e.stack, MAX_STACK) ?? null,
    };
    await db('executionLog.create', () => prisma.executionLog.create({
      data: {
        id: dto.id, ts, level: dto.level, eventType: dto.eventType, category: dto.category, operation: dto.operation,
        status: dto.status, source: dto.source, traceId: dto.traceId, spanId: dto.spanId, requestId: dto.requestId,
        projectId: dto.projectId, durationMs: dto.durationMs, message: dto.message, attributes: json(dto.attributes),
        errorCategory: dto.errorCategory, errorMessage: dto.errorMessage, stack: dto.stack,
      },
    }));
    await jsonl.append(dto);
    return dto;
  }

  // ---------------------------------------------------------------- traces / spans
  interface TraceCtx { traceId: string; projectId?: string; requestId?: string; source: Source; anchorMs: number; anchorPerf: number }
  const clockNow = (t: TraceCtx) => new Date(t.anchorMs + (performance.now() - t.anchorPerf));

  async function createSpan(
    t: TraceCtx, parentSpanId: string | null, name: string, kind: SpanKind,
    attributes: Record<string, unknown> | undefined, source: Source,
  ): Promise<SpanHandle> {
    const spanId = newSpanId();
    const startPerf = performance.now();
    const startedAt = clockNow(t);
    let attrs = sanitizeAttributes(attributes);
    let duration: number | undefined;
    await db('span.create', () => prisma.span.create({
      data: {
        spanId, traceId: t.traceId, parentSpanId, name: boundText(name, 300) ?? '', kind, status: 'RUNNING', source,
        startedAt, attributes: json(attrs),
      },
    }));
    const handle: SpanHandle = {
      spanId, traceId: t.traceId,
      startSpan: (n, k, a, o) => createSpan(t, spanId, n, k, a, o?.source ?? source),
      end: async (error, endAttributes) => {
        if (duration !== undefined) return duration; // idempotent
        duration = Math.max(0, Math.round(performance.now() - startPerf));
        const d = duration;
        if (endAttributes) attrs = { ...attrs, ...sanitizeAttributes(endAttributes) };
        const hasError = error !== undefined && error !== null;
        const ef = hasError ? errFields(error) : undefined;
        await db('span.end', () => prisma.span.update({
          where: { spanId },
          data: {
            status: hasError ? 'ERROR' : 'OK', endedAt: new Date(startedAt.getTime() + d), durationMs: d,
            errorMessage: ef?.errorMessage ?? null, stack: ef?.stack ?? null, attributes: json(attrs),
          },
        }));
        return d;
      },
    };
    return handle;
  }

  async function startTrace(input: {
    name: string; projectId?: string; requestId?: string; source: Source; attributes?: Record<string, unknown>;
  }): Promise<TraceHandle> {
    const traceId = newTraceId();
    const startPerf = performance.now();
    const at = atOf(input) ?? new Date();
    const t: TraceCtx = {
      traceId, projectId: input.projectId, requestId: input.requestId, source: input.source,
      anchorMs: at.getTime(), anchorPerf: startPerf,
    };
    const name = boundText(input.name, 300) ?? '';
    await db('trace.create', () => prisma.trace.create({
      data: {
        traceId, name, projectId: input.projectId ?? null, requestId: input.requestId ?? null,
        status: 'RUNNING', source: input.source, startedAt: at,
      },
    }));
    const rootSpan = await createSpan(t, null, name, 'REQUEST', input.attributes, input.source);
    const corr = { traceId, spanId: rootSpan.spanId, projectId: input.projectId, requestId: input.requestId };
    await emit({
      ...corr, ts: at, level: 'INFO', eventType: 'request.started', category: 'REQUEST', operation: name, status: 'STARTED',
      source: input.source, message: `Trace started: ${name}`, attributes: sanitizeAttributes(input.attributes),
    });
    let endResult: Promise<number> | undefined;
    const handle: TraceHandle = {
      traceId, rootSpan,
      startSpan: (n, k, a, o) => (o?.parent ?? rootSpan).startSpan(n, k, a, { source: o?.source ?? input.source }),
      end: (error) => {
        endResult ??= (async () => {
          const hasError = error !== undefined && error !== null;
          const ef = hasError ? errFields(error) : undefined;
          const d = await rootSpan.end(hasError ? error : undefined);
          const endedAt = new Date(at.getTime() + d);
          await db('trace.end', () => prisma.trace.update({
            where: { traceId },
            data: { status: hasError ? 'ERROR' : 'OK', endedAt, durationMs: d, errorMessage: ef?.errorMessage ?? null, stack: ef?.stack ?? null },
          }));
          await emit({
            ...corr, ts: endedAt, level: hasError ? 'ERROR' : 'INFO', eventType: hasError ? 'request.failed' : 'request.completed',
            category: 'REQUEST', operation: name, status: hasError ? 'FAILURE' : 'SUCCESS', source: input.source, durationMs: d,
            message: hasError ? `Trace failed: ${name}` : `Trace completed: ${name}`,
            errorCategory: hasError ? (ef?.category ?? 'UNKNOWN') : null, errorMessage: ef?.errorMessage, stack: ef?.stack,
          });
          return d;
        })();
        return endResult;
      },
    };
    return handle;
  }

  async function withSpan<T>(
    parent: TraceHandle | SpanHandle, name: string, kind: SpanKind, fn: (span: SpanHandle) => Promise<T>,
    o?: { source?: Source; attributes?: Record<string, unknown> },
  ): Promise<T> {
    const span = await parent.startSpan(name, kind, o?.attributes, { source: o?.source });
    try {
      const result = await fn(span);
      await span.end();
      return result;
    } catch (e) {
      await span.end(e);
      throw e;
    }
  }

  // ---------------------------------------------------------------- typed events
  async function recordMemory(i: MemoryRecordInput): Promise<string> {
    const operationId = i.operationId ?? `mem_${randomUUID().replace(/-/g, '')}`;
    try {
      const failed = i.phase === 'FAILED';
      const status = i.phase === 'STARTED' ? 'STARTED' : failed ? 'FAILURE' : 'SUCCESS';
      const at = atOf(i) ?? new Date();
      const ef = failed ? errFields(i.errorMessage ?? 'Memory injection failed') : undefined;
      const errorMessage = failed ? boundText(i.errorMessage ?? 'Memory injection failed', MAX_MSG) : (i.errorMessage ? boundText(i.errorMessage, MAX_MSG) : undefined);
      await db('memoryEvent.create', () => prisma.memoryEvent.create({
        data: {
          operationId, phase: i.phase, status, source: i.source, memorySource: boundText(i.memorySource, 200) ?? '',
          category: boundText(i.category, 200) ?? '', itemCount: i.itemCount, estimatedTokens: i.estimatedTokens,
          payloadBytes: i.payloadBytes, durationMs: i.durationMs ?? null, errorMessage: errorMessage ?? null,
          traceId: i.traceId ?? null, spanId: i.spanId ?? null, projectId: i.projectId ?? null, createdAt: at,
        },
      }));
      const phaseWord = i.phase.toLowerCase();
      await emit({
        ts: at, traceId: i.traceId, spanId: i.spanId, projectId: i.projectId, requestId: i.requestId,
        level: failed ? 'ERROR' : 'INFO', eventType: `memory.injection.${phaseWord}`, category: 'MEMORY',
        operation: i.memorySource, status, source: i.source, durationMs: i.durationMs,
        message: `Memory injection ${phaseWord}: ${i.memorySource}`,
        attributes: {
          operationId, memorySource: boundText(i.memorySource, 200), memoryCategory: boundText(i.category, 200),
          itemCount: i.itemCount, estimatedTokens: i.estimatedTokens, payloadBytes: i.payloadBytes,
        },
        errorCategory: failed ? (ef?.category ?? 'MEMORY') : null, errorMessage: failed ? errorMessage : undefined,
        stack: failed ? boundText(i.stack, MAX_STACK) : undefined,
      });
    } catch (e) { reportFailure('recordMemory', e); }
    return operationId;
  }

  async function recordBus(i: BusRecordInput): Promise<string> {
    const operationId = i.operationId ?? `bus_${randomUUID().replace(/-/g, '')}`;
    try {
      const at = atOf(i) ?? new Date();
      const inputMeta = sanitizeAttributes(i.inputMeta);
      const errorMessage = i.success ? undefined : boundText(i.errorMessage ?? 'Bus operation failed', MAX_MSG);
      const stack = i.success ? undefined : boundText(i.stack, MAX_STACK);
      await db('busEvent.create', () => prisma.busEvent.create({
        data: {
          operationId, operationName: boundText(i.operationName, 300) ?? '', operationType: i.operationType,
          eventName: boundText(i.eventName, 300) ?? '', inputMeta: json(inputMeta), outputStatus: i.outputStatus ?? null,
          status: i.success ? 'SUCCESS' : 'FAILURE', source: i.source, durationMs: i.durationMs ?? null,
          errorMessage: errorMessage ?? null, stack: stack ?? null, traceId: i.traceId ?? null, spanId: i.spanId ?? null,
          projectId: i.projectId ?? null, createdAt: at,
        },
      }));
      await emit({
        ts: at, traceId: i.traceId, spanId: i.spanId, projectId: i.projectId, requestId: i.requestId,
        level: i.success ? 'INFO' : 'ERROR', eventType: 'bus.operation', category: 'BUS', operation: i.operationName,
        status: i.success ? 'SUCCESS' : 'FAILURE', source: i.source, durationMs: i.durationMs,
        message: `Bus ${i.operationType} ${i.eventName}${i.success ? '' : ' failed'}`,
        attributes: {
          operationId, operationType: i.operationType, eventName: boundText(i.eventName, 300),
          outputStatus: i.outputStatus ?? null, inputMeta,
        },
        errorCategory: i.success ? null : 'BUS', errorMessage, stack,
      });
    } catch (e) { reportFailure('recordBus', e); }
    return operationId;
  }

  async function recordTool(i: ToolRecordInput): Promise<void> {
    try {
      const inputMeta = sanitizeAttributes(i.inputMeta);
      const outputMeta = sanitizeAttributes(i.outputMeta);
      const corr = { traceId: i.traceId, spanId: i.spanId, projectId: i.projectId, requestId: i.requestId };
      const baseAttrs = { toolCallId: i.toolCallId, retryCount: i.retryCount ?? 0, maxRetries: i.maxRetries ?? 0, inputMeta };
      if (i.phase === 'INITIATED') {
        await emit({
          ...corr, ts: atOf(i) ?? i.startedAt, level: 'INFO', eventType: 'tool.call.initiated', category: 'TOOL',
          operation: i.toolName, status: 'STARTED', source: i.source, message: `Tool call initiated: ${i.toolName}`,
          attributes: baseAttrs,
        });
        return;
      }
      const endedAt = i.endedAt ?? atOf(i) ?? new Date();
      const durationMs = i.durationMs ?? Math.max(0, endedAt.getTime() - i.startedAt.getTime());
      const errorMessage = i.success ? undefined : boundText(i.errorMessage ?? 'Tool call failed', MAX_MSG);
      await db('toolCallEvent.create', () => prisma.toolCallEvent.create({
        data: {
          toolName: boundText(i.toolName, 300) ?? '', toolCallId: i.toolCallId, requestId: i.requestId ?? null,
          inputMeta: json(inputMeta), outputMeta: json(outputMeta), status: i.success ? 'SUCCESS' : 'FAILURE', source: i.source,
          startedAt: i.startedAt, endedAt, durationMs, errorMessage: errorMessage ?? null, retryCount: i.retryCount ?? 0,
          maxRetries: i.maxRetries ?? 0, traceId: i.traceId ?? null, spanId: i.spanId ?? null, projectId: i.projectId ?? null,
          createdAt: endedAt,
        },
      }));
      await emit({
        ...corr, ts: endedAt, level: i.success ? 'INFO' : 'ERROR', eventType: i.success ? 'tool.call.completed' : 'tool.call.failed',
        category: 'TOOL', operation: i.toolName, status: i.success ? 'SUCCESS' : 'FAILURE', source: i.source, durationMs,
        message: `Tool call ${i.success ? 'completed' : 'failed'}: ${i.toolName}`,
        attributes: { ...baseAttrs, outputMeta },
        errorCategory: i.success ? null : (TIMEOUT_RE.test(errorMessage ?? '') ? 'TIMEOUT' : 'TOOL'),
        errorMessage, stack: i.success ? undefined : boundText(i.stack, MAX_STACK),
      });
    } catch (e) { reportFailure('recordTool', e); }
  }

  async function recordContext(i: ContextRecordInput): Promise<void> {
    try {
      const ok = i.success !== false;
      const at = atOf(i) ?? new Date();
      const op = i.operation.toLowerCase();
      const errorMessage = ok ? undefined : boundText(i.errorMessage ?? 'Context operation failed', MAX_MSG);
      await db('contextEvent.create', () => prisma.contextEvent.create({
        data: {
          contextId: i.contextId, operation: i.operation, contextSource: boundText(i.contextSource, 200) ?? '',
          sizeBytes: i.sizeBytes, estimatedTokens: i.estimatedTokens, version: i.version, status: ok ? 'SUCCESS' : 'FAILURE',
          source: i.source, errorMessage: errorMessage ?? null, durationMs: i.durationMs ?? null, traceId: i.traceId ?? null,
          spanId: i.spanId ?? null, projectId: i.projectId ?? null, createdAt: at,
        },
      }));
      await emit({
        ts: at, traceId: i.traceId, spanId: i.spanId, projectId: i.projectId, requestId: i.requestId,
        level: ok ? 'INFO' : 'ERROR', eventType: `context.${op}`, category: 'CONTEXT', operation: i.contextId,
        status: ok ? 'SUCCESS' : 'FAILURE', source: i.source, durationMs: i.durationMs,
        message: `Context ${op}: ${i.contextId}`,
        attributes: {
          contextId: i.contextId, contextOperation: i.operation, contextSource: boundText(i.contextSource, 200),
          sizeBytes: i.sizeBytes, estimatedTokens: i.estimatedTokens, version: i.version,
        },
        errorCategory: ok ? null : 'CONTEXT', errorMessage,
      });
    } catch (e) { reportFailure('recordContext', e); }
  }

  function activityCategory(type: string): LogCategory {
    const p = type.split('.')[0];
    if (p === 'budget') return 'BUDGET';
    if (p === 'usage' || p === 'provider') return 'PROVIDER';
    if (p === 'request') return 'REQUEST';
    return 'SYSTEM';
  }

  async function recordActivity(i: ActivityInput): Promise<void> {
    try {
      const at = atOf(i) ?? new Date();
      const level = i.level ?? 'INFO';
      const metadata = sanitizeAttributes(i.metadata);
      const message = boundText(i.message, MAX_MSG) ?? '';
      await db('activityEvent.create', () => prisma.activityEvent.create({
        data: {
          type: boundText(i.type, 200) ?? '', level, message, source: i.source, projectId: i.projectId ?? null,
          traceId: i.traceId ?? null, requestId: i.requestId ?? null, metadata: json(metadata), createdAt: at,
        },
      }));
      const category = activityCategory(i.type);
      await emit({
        ts: at, traceId: i.traceId, spanId: i.spanId, projectId: i.projectId, requestId: i.requestId,
        level, eventType: `activity.${i.type}`, category, operation: i.type,
        status: level === 'ERROR' ? 'FAILURE' : 'INFO', source: i.source, message, attributes: metadata,
        errorCategory: level === 'ERROR' ? (category === 'PROVIDER' || category === 'REQUEST' ? 'PROVIDER' : category === 'BUDGET' ? 'INTERNAL' : 'UNKNOWN') : null,
        errorMessage: level === 'ERROR' ? message : undefined,
      });
    } catch (e) { reportFailure('recordActivity', e); }
  }

  async function recordError(i: ErrorRecordInput): Promise<void> {
    try {
      const ef = errFields(i.error);
      await emit({
        ts: atOf(i), traceId: i.traceId, spanId: i.spanId, projectId: i.projectId, requestId: i.requestId,
        level: 'ERROR', eventType: 'error', category: 'ERROR', operation: i.operation, status: 'FAILURE', source: i.source,
        durationMs: i.durationMs, message: `Error in ${i.operation}: ${ef.errorMessage}`,
        attributes: sanitizeAttributes(i.attributes), errorCategory: i.category ?? ef.category ?? 'UNKNOWN',
        errorMessage: ef.errorMessage, stack: ef.stack,
      });
    } catch (e) { reportFailure('recordError', e); }
  }

  async function log(i: LogInput): Promise<void> {
    try {
      await emit({
        ts: atOf(i), traceId: i.traceId, spanId: i.spanId, projectId: i.projectId, requestId: i.requestId,
        level: i.level, eventType: i.eventType, category: i.category, operation: i.operation, status: i.status, source: i.source,
        message: i.message, durationMs: i.durationMs, attributes: sanitizeAttributes(i.attributes),
        errorCategory: i.errorCategory, errorMessage: i.errorMessage, stack: i.stack,
      });
    } catch (e) { reportFailure('log', e); }
  }

  // ---------------------------------------------------------------- background tasks
  async function startTask(input: { name: string; kind: TaskKind; source: Source; traceId?: string }): Promise<TaskHandle> {
    const id = newId();
    const createdAt = new Date();
    const name = boundText(input.name, 300) ?? '';
    const startPerf = performance.now();
    await db('backgroundTask.create', () => prisma.backgroundTask.create({
      data: { id, name, kind: input.kind, status: 'QUEUED', source: input.source, traceId: input.traceId ?? null, createdAt },
    }));
    const startedAt = new Date();
    await db('backgroundTask.start', () => prisma.backgroundTask.update({ where: { id }, data: { status: 'RUNNING', startedAt } }));
    await emit({
      ts: startedAt, traceId: input.traceId, level: 'INFO', eventType: 'background.task.started', category: 'SYSTEM', operation: name,
      status: 'STARTED', source: input.source, message: `Background task started: ${name}`, attributes: { taskId: id, kind: input.kind },
    });
    let finished = false;
    return {
      id,
      succeed: async (result) => {
        if (finished) return;
        finished = true;
        const durationMs = Math.max(0, Math.round(performance.now() - startPerf));
        const endedAt = new Date();
        const res = sanitizeAttributes(result);
        await db('backgroundTask.succeed', () => prisma.backgroundTask.update({
          where: { id }, data: { status: 'SUCCEEDED', endedAt, durationMs, result: json(res) },
        }));
        await emit({
          ts: endedAt, traceId: input.traceId, level: 'INFO', eventType: 'background.task.completed', category: 'SYSTEM', operation: name,
          status: 'SUCCESS', source: input.source, durationMs, message: `Background task completed: ${name}`,
          attributes: { taskId: id, kind: input.kind, result: res },
        });
      },
      fail: async (error) => {
        if (finished) return;
        finished = true;
        const durationMs = Math.max(0, Math.round(performance.now() - startPerf));
        const endedAt = new Date();
        const ef = errFields(error);
        await db('backgroundTask.fail', () => prisma.backgroundTask.update({
          where: { id }, data: { status: 'FAILED', endedAt, durationMs, errorMessage: ef.errorMessage, stack: ef.stack ?? null },
        }));
        await emit({
          ts: endedAt, traceId: input.traceId, level: 'ERROR', eventType: 'background.task.failed', category: 'SYSTEM', operation: name,
          status: 'FAILURE', source: input.source, durationMs, message: `Background task failed: ${name}`,
          attributes: { taskId: id, kind: input.kind }, errorCategory: ef.category ?? 'INTERNAL', errorMessage: ef.errorMessage, stack: ef.stack,
        });
      },
    };
  }

  // make sure the log dir exists up-front (best effort)
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) { reportFailure('logDir.mkdir', e); }

  return { startTrace, recordMemory, recordBus, recordTool, recordContext, recordActivity, recordError, log, flush, startTask, withSpan };
}
