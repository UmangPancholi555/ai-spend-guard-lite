import type {
  ActivityEventDto, BackgroundTaskDto, BudgetAlertDto, BusEventDto, ContextEventDto, ErrorCategory, ExecutionLogDto,
  MemoryEventDto, Source, SpanStatus, TaskKind, TaskStatus, ToolCallEventDto, TraceDto,
} from '../../../../shared/types';
import { alertLevelFor } from '../../../../shared/types';
import { picoToUsd } from '../../utils/money';
import { parseJson } from '../../utils/serialize';

/* eslint-disable @typescript-eslint/no-explicit-any */
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const toLogDto = (r: any): ExecutionLogDto => ({
  id: r.id, ts: r.ts.toISOString(), level: r.level, eventType: r.eventType, category: r.category, operation: r.operation,
  status: r.status, source: r.source as Source, traceId: r.traceId, spanId: r.spanId, requestId: r.requestId, projectId: r.projectId,
  durationMs: r.durationMs, message: r.message, attributes: parseJson(r.attributes), errorCategory: (r.errorCategory ?? null) as ErrorCategory | null,
  errorMessage: r.errorMessage, stack: r.stack,
});
export const toActivityDto = (r: any): ActivityEventDto => ({
  id: r.id, type: r.type, level: r.level, message: r.message, source: r.source, projectId: r.projectId,
  projectName: r.project?.name ?? null, traceId: r.traceId, requestId: r.requestId, metadata: parseJson(r.metadata), createdAt: r.createdAt.toISOString(),
});
export const toTraceDto = (r: any): TraceDto => ({
  traceId: r.traceId, name: r.name, projectId: r.projectId, requestId: r.requestId, status: r.status as SpanStatus, source: r.source,
  startedAt: r.startedAt.toISOString(), endedAt: iso(r.endedAt), durationMs: r.durationMs, errorMessage: r.errorMessage, stack: r.stack,
  spanCount: r._count?.spans ?? 0,
});
export const toMemoryDto = (r: any): MemoryEventDto => ({
  id: r.id, operationId: r.operationId, phase: r.phase, status: r.status, source: r.source, memorySource: r.memorySource,
  category: r.category, itemCount: r.itemCount, estimatedTokens: r.estimatedTokens, payloadBytes: r.payloadBytes,
  durationMs: r.durationMs, errorMessage: r.errorMessage, traceId: r.traceId, spanId: r.spanId, projectId: r.projectId,
  createdAt: r.createdAt.toISOString(),
});
export const toBusDto = (r: any): BusEventDto => ({
  id: r.id, operationId: r.operationId, operationName: r.operationName, operationType: r.operationType, eventName: r.eventName,
  inputMeta: parseJson(r.inputMeta), outputStatus: r.outputStatus, status: r.status, source: r.source, durationMs: r.durationMs,
  errorMessage: r.errorMessage, stack: r.stack, traceId: r.traceId, spanId: r.spanId, projectId: r.projectId, createdAt: r.createdAt.toISOString(),
});
export const toToolDto = (r: any): ToolCallEventDto => ({
  id: r.id, toolName: r.toolName, toolCallId: r.toolCallId, requestId: r.requestId, inputMeta: parseJson(r.inputMeta),
  outputMeta: parseJson(r.outputMeta), status: r.status, source: r.source, startedAt: r.startedAt.toISOString(), endedAt: iso(r.endedAt),
  durationMs: r.durationMs, errorMessage: r.errorMessage, retryCount: r.retryCount, maxRetries: r.maxRetries, traceId: r.traceId,
  spanId: r.spanId, projectId: r.projectId, createdAt: r.createdAt.toISOString(),
});
export const toContextDto = (r: any): ContextEventDto => ({
  id: r.id, contextId: r.contextId, operation: r.operation, contextSource: r.contextSource, sizeBytes: r.sizeBytes,
  estimatedTokens: r.estimatedTokens, version: r.version, status: r.status, source: r.source, errorMessage: r.errorMessage,
  durationMs: r.durationMs, traceId: r.traceId, spanId: r.spanId, projectId: r.projectId, createdAt: r.createdAt.toISOString(),
});
export const toAlertDto = (r: any): BudgetAlertDto => ({
  id: r.id, budgetId: r.budgetId, budgetName: r.budget?.name ?? '', projectId: r.budget?.projectId ?? null,
  projectName: r.budget?.project?.name ?? null, period: r.budget?.period, threshold: r.threshold, level: alertLevelFor(r.threshold), periodStart: r.periodStart.toISOString(),
  periodEnd: r.periodEnd.toISOString(), spendUsd: picoToUsd(r.spendPico), limitUsd: picoToUsd(r.limitPico), percent: r.percent,
  createdAt: r.createdAt.toISOString(),
});
export const toTaskDto = (r: any): BackgroundTaskDto => ({
  id: r.id, name: r.name, kind: r.kind as TaskKind, status: r.status as TaskStatus, source: r.source, traceId: r.traceId,
  startedAt: iso(r.startedAt), endedAt: iso(r.endedAt), durationMs: r.durationMs, result: parseJson(r.result),
  errorMessage: r.errorMessage, stack: r.stack, createdAt: r.createdAt.toISOString(),
});
