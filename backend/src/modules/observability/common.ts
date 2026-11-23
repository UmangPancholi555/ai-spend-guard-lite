/**
 * Shared query helpers + row->DTO mappers for the read-side modules (observability, traces, activity).
 * Everything here is pure (no DB access) except `loadSettings`.
 */
import { z } from 'zod';
import type { Request } from 'express';
import type {
  Prisma, PrismaClient, ExecutionLog, MemoryEvent, BusEvent, ToolCallEvent, ContextEvent, Trace, Span, ActivityEvent, BackgroundTask,
} from '@prisma/client';
import { paginationQuery } from '../../utils/http';
import { parseJson } from '../../utils/serialize';
import type {
  ActivityEventDto, BackgroundTaskDto, BusEventDto, ContextEventDto, ErrorCategory, ExecutionLogDto, LogCategory,
  MemoryEventDto, SpanDto, ToolCallEventDto, TraceDto,
} from '../../../../shared/types';

// ---------------------------------------------------------------- enums
export const SOURCE_ENUM = z.enum(['ACTUAL', 'SIMULATED']);
export const LOG_LEVELS = z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']);
export const ERROR_CATEGORIES = z.enum([
  'VALIDATION', 'PROVIDER', 'TIMEOUT', 'TOOL', 'BUS', 'MEMORY', 'CONTEXT', 'DATABASE', 'INTERNAL', 'UNKNOWN',
]);
export const SPAN_STATUS = z.enum(['RUNNING', 'OK', 'ERROR']);

// ---------------------------------------------------------------- query parsing
/** Drop empty-string / undefined query values so `?status=` behaves like "no filter". */
export function cleanQuery(q: Request['query']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === '' || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * ISO date bound. Date-only values ("2025-01-31") are expanded to the whole UTC day:
 * `from` -> 00:00:00.000Z, `to` -> 23:59:59.999Z (so `to` is inclusive). Full timestamps are used verbatim.
 */
export const dateBound = (isEnd: boolean) =>
  z.string().refine(s => !Number.isNaN(Date.parse(s)), 'invalid date').transform(s => {
    if (DATE_ONLY.test(s)) return new Date(`${s}T${isEnd ? '23:59:59.999' : '00:00:00.000'}Z`);
    return new Date(s);
  });

export const rangeShape = { from: dateBound(false).optional(), to: dateBound(true).optional() };

/** zod superRefine callback: from must not be after to */
export const checkRange = (v: { from?: Date; to?: Date }, ctx: z.RefinementCtx) => {
  if (v.from && v.to && v.from.getTime() > v.to.getTime()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: '`from` must not be after `to`' });
  }
};

export const listBase = paginationQuery;

export function rangeFilter(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  const f: Prisma.DateTimeFilter = {};
  if (from) f.gte = from;
  if (to) f.lte = to;
  return f;
}

/** Resolve [from,to] with default window (last `defaultDays` days, ending now). */
export function resolveRange(from: Date | undefined, to: Date | undefined, defaultDays = 7, now = new Date()) {
  const end = to ?? now;
  const start = from ?? new Date(end.getTime() - defaultDays * 86_400_000);
  return { from: start, to: end };
}

export const skipTake = (page: number, pageSize: number) => ({ skip: (page - 1) * pageSize, take: pageSize });

/** case-insensitive (ASCII, SQLite LIKE) substring match over several columns */
export function searchOr<K extends string>(search: string | undefined, fields: K[]): { OR: Record<K, { contains: string }>[] } | undefined {
  if (!search) return undefined;
  return { OR: fields.map(f => ({ [f]: { contains: search } }) as Record<K, { contains: string }>) };
}

// ---------------------------------------------------------------- settings
export const DEFAULT_SLOW_MS = 500;
/** reads AppSetting key `settings` (JSON of AppSettings) directly; falls back to the default 500ms */
export async function loadSlowThresholdMs(prisma: PrismaClient): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: 'settings' } });
  const v = parseJson<{ slowOperationMs?: unknown }>(row?.value, {});
  const n = v.slowOperationMs;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : DEFAULT_SLOW_MS;
}

// ---------------------------------------------------------------- mappers
type ExecutionLogRow = ExecutionLog; type MemoryRow = MemoryEvent; type BusRow = BusEvent; type ToolRow = ToolCallEvent;
type ContextRow = ContextEvent; type TraceRow = Trace; type SpanRow = Span; type ActivityRow = ActivityEvent; type TaskRow = BackgroundTask;
export type { ExecutionLogRow, MemoryRow, BusRow, ToolRow, ContextRow, TraceRow, SpanRow, ActivityRow, TaskRow };

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export const mapExecutionLog = (r: ExecutionLogRow): ExecutionLogDto => ({
  id: r.id, ts: iso(r.ts), level: r.level as ExecutionLogDto['level'], eventType: r.eventType,
  category: r.category as LogCategory, operation: r.operation, status: r.status as ExecutionLogDto['status'],
  source: r.source as ExecutionLogDto['source'], traceId: r.traceId, spanId: r.spanId, requestId: r.requestId,
  projectId: r.projectId, durationMs: r.durationMs, message: r.message, attributes: parseJson(r.attributes),
  errorCategory: (r.errorCategory as ErrorCategory | null) ?? null, errorMessage: r.errorMessage, stack: r.stack,
});

export const mapMemory = (r: MemoryRow): MemoryEventDto => ({
  id: r.id, operationId: r.operationId, phase: r.phase as MemoryEventDto['phase'], status: r.status as MemoryEventDto['status'],
  source: r.source as MemoryEventDto['source'], memorySource: r.memorySource, category: r.category, itemCount: r.itemCount,
  estimatedTokens: r.estimatedTokens, payloadBytes: r.payloadBytes, durationMs: r.durationMs, errorMessage: r.errorMessage,
  traceId: r.traceId, spanId: r.spanId, projectId: r.projectId, createdAt: iso(r.createdAt),
});

export const mapBus = (r: BusRow): BusEventDto => ({
  id: r.id, operationId: r.operationId, operationName: r.operationName, operationType: r.operationType as BusEventDto['operationType'],
  eventName: r.eventName, inputMeta: parseJson(r.inputMeta), outputStatus: r.outputStatus, status: r.status as BusEventDto['status'],
  source: r.source as BusEventDto['source'], durationMs: r.durationMs, errorMessage: r.errorMessage, stack: r.stack,
  traceId: r.traceId, spanId: r.spanId, projectId: r.projectId, createdAt: iso(r.createdAt),
});

export const mapTool = (r: ToolRow): ToolCallEventDto => ({
  id: r.id, toolName: r.toolName, toolCallId: r.toolCallId, requestId: r.requestId, inputMeta: parseJson(r.inputMeta),
  outputMeta: parseJson(r.outputMeta), status: r.status as ToolCallEventDto['status'], source: r.source as ToolCallEventDto['source'],
  startedAt: iso(r.startedAt), endedAt: isoOrNull(r.endedAt), durationMs: r.durationMs, errorMessage: r.errorMessage,
  retryCount: r.retryCount, maxRetries: r.maxRetries, traceId: r.traceId, spanId: r.spanId, projectId: r.projectId,
  createdAt: iso(r.createdAt),
});

export const mapContext = (r: ContextRow): ContextEventDto => ({
  id: r.id, contextId: r.contextId, operation: r.operation as ContextEventDto['operation'], contextSource: r.contextSource,
  sizeBytes: r.sizeBytes, estimatedTokens: r.estimatedTokens, version: r.version, status: r.status as ContextEventDto['status'],
  source: r.source as ContextEventDto['source'], errorMessage: r.errorMessage, durationMs: r.durationMs,
  traceId: r.traceId, spanId: r.spanId, projectId: r.projectId, createdAt: iso(r.createdAt),
});

export const mapTrace = (r: TraceRow, spanCount: number): TraceDto => ({
  traceId: r.traceId, name: r.name, projectId: r.projectId, requestId: r.requestId, status: r.status as TraceDto['status'],
  source: r.source as TraceDto['source'], startedAt: iso(r.startedAt), endedAt: isoOrNull(r.endedAt), durationMs: r.durationMs,
  errorMessage: r.errorMessage, stack: r.stack, spanCount,
});

export const mapSpan = (r: SpanRow): SpanDto => ({
  spanId: r.spanId, traceId: r.traceId, parentSpanId: r.parentSpanId, name: r.name, kind: r.kind as SpanDto['kind'],
  status: r.status as SpanDto['status'], source: r.source as SpanDto['source'], startedAt: iso(r.startedAt),
  endedAt: isoOrNull(r.endedAt), durationMs: r.durationMs, errorMessage: r.errorMessage, stack: r.stack,
  attributes: parseJson(r.attributes),
});

export const mapActivity = (r: ActivityRow, projectName: string | null): ActivityEventDto => ({
  id: r.id, type: r.type, level: r.level as ActivityEventDto['level'], message: r.message, source: r.source as ActivityEventDto['source'],
  projectId: r.projectId, projectName, traceId: r.traceId, requestId: r.requestId, metadata: parseJson(r.metadata),
  createdAt: iso(r.createdAt),
});

export const mapTask = (r: TaskRow): BackgroundTaskDto => ({
  id: r.id, name: r.name, kind: r.kind as BackgroundTaskDto['kind'], status: r.status as BackgroundTaskDto['status'],
  source: r.source as BackgroundTaskDto['source'], traceId: r.traceId, startedAt: isoOrNull(r.startedAt), endedAt: isoOrNull(r.endedAt),
  durationMs: r.durationMs, result: parseJson(r.result), errorMessage: r.errorMessage, stack: r.stack, createdAt: iso(r.createdAt),
});

/** id -> project name lookup for a set of rows */
export async function projectNames(prisma: PrismaClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const rows = await prisma.project.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
  return new Map(rows.map(r => [r.id, r.name]));
}
