/**
 * Dataset registry for GET /logs and GET /export/:dataset. Each dataset declares its filter schema (same filters as the
 * corresponding list endpoint), a Prisma where-builder, newest-first cursor-paged reads, a DTO mapper and CSV columns.
 */
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { dateQuery } from '../../utils/http';
import { AppError } from '../../utils/errors';
import {
  toActivityDto, toAlertDto, toBusDto, toContextDto, toLogDto, toMemoryDto, toTaskDto, toToolDto, toTraceDto,
} from './mappers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const toQuery = z.string().refine(s => !Number.isNaN(Date.parse(s)), 'invalid date').transform(s => {
  const d = new Date(s);
  return DATE_ONLY.test(s) ? new Date(d.getTime() + 86_400_000 - 1) : d; // date-only `to` => end of that UTC day (inclusive)
});

const str = z.string().min(1).max(300);
const source = z.enum(['ACTUAL', 'SIMULATED']);
const range = { from: dateQuery.optional(), to: toQuery.optional() };

function between(from?: Date, to?: Date) {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
}
function and(...parts: (Record<string, unknown> | undefined)[]) {
  return { AND: parts.filter(Boolean) as Record<string, unknown>[] };
}
const contains = (fields: string[], s?: string) => (s ? { OR: fields.map(f => ({ [f]: { contains: s } })) } : undefined);
const eq = (field: string, v?: unknown) => (v === undefined ? undefined : { [field]: v });

export interface Dataset<Q = any> {
  name: string;
  filterSchema: z.ZodType<Q, z.ZodTypeDef, unknown>;
  where(q: Q): Record<string, unknown>;
  delegate(p: PrismaClient): { findMany(a: any): Promise<any[]>; count(a: any): Promise<number> };
  orderBy: Record<string, 'desc'>[];
  include?: Record<string, unknown>;
  toDto(row: any): any;
  headers: string[];
  toRow(dto: any): unknown[];
}

// ---- logs
const logsFilter = z.object({
  eventType: str.optional(), category: z.enum(['REQUEST', 'MEMORY', 'BUS', 'TOOL', 'CONTEXT', 'ERROR', 'SYSTEM', 'BUDGET', 'PROVIDER']).optional(),
  status: z.enum(['STARTED', 'SUCCESS', 'FAILURE', 'INFO']).optional(), level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL']).optional(),
  source: source.optional(), traceId: str.optional(), requestId: str.optional(), projectId: str.optional(), search: str.optional(), ...range,
});
/** eventType: exact, comma-separated list, or trailing `*` prefix match (e.g. `memory.injection.*`). */
function eventTypeWhere(v?: string) {
  if (!v) return undefined;
  const parts = v.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length > 20) throw new AppError(400, 'VALIDATION_ERROR', 'eventType accepts at most 20 comma-separated values');
  const ors = parts.map(s => (s.endsWith('*') ? { eventType: { startsWith: s.slice(0, -1) } } : { eventType: s }));
  return ors.length ? { OR: ors } : undefined;
}
const logsWhere = (q: z.infer<typeof logsFilter>) => and(
  eventTypeWhere(q.eventType), eq('category', q.category), eq('status', q.status), eq('level', q.level), eq('source', q.source),
  eq('traceId', q.traceId), eq('requestId', q.requestId), eq('projectId', q.projectId),
  contains(['operation'], q.search), q.from || q.to ? { ts: between(q.from, q.to) } : undefined,
);
const logHeaders = ['id', 'ts', 'level', 'eventType', 'category', 'operation', 'status', 'source', 'traceId', 'spanId', 'requestId', 'projectId',
  'durationMs', 'message', 'attributes', 'errorCategory', 'errorMessage', 'stack'];
const logRow = (d: any) => logHeaders.map(h => d[h]);

const logs: Dataset<z.infer<typeof logsFilter>> = {
  name: 'logs', filterSchema: logsFilter, where: logsWhere, delegate: p => p.executionLog as any, orderBy: [{ ts: 'desc' }, { id: 'desc' }],
  toDto: toLogDto, headers: logHeaders, toRow: logRow,
};

const errorsFilter = z.object({
  category: z.enum(['VALIDATION', 'PROVIDER', 'TIMEOUT', 'TOOL', 'BUS', 'MEMORY', 'CONTEXT', 'DATABASE', 'INTERNAL', 'UNKNOWN']).optional(),
  search: str.optional(), traceId: str.optional(), source: source.optional(), projectId: str.optional(), ...range,
});
const errors: Dataset<z.infer<typeof errorsFilter>> = {
  name: 'errors', filterSchema: errorsFilter, delegate: p => p.executionLog as any, orderBy: [{ ts: 'desc' }, { id: 'desc' }],
  where: q => and(
    { OR: [{ level: 'ERROR' }, { status: 'FAILURE' }] }, eq('errorCategory', q.category), eq('traceId', q.traceId), eq('source', q.source),
    eq('projectId', q.projectId), contains(['operation', 'message', 'errorMessage'], q.search), q.from || q.to ? { ts: between(q.from, q.to) } : undefined,
  ),
  toDto: toLogDto, headers: logHeaders, toRow: logRow,
};

// ---- activity
const activityFilter = z.object({
  type: str.optional(), level: z.enum(['INFO', 'WARN', 'ERROR', 'CRITICAL']).optional(), source: source.optional(), projectId: str.optional(),
  traceId: str.optional(), search: str.optional(), ...range,
});
const activityHeaders = ['id', 'createdAt', 'type', 'level', 'message', 'source', 'projectId', 'projectName', 'traceId', 'requestId', 'metadata'];
const activity: Dataset<z.infer<typeof activityFilter>> = {
  name: 'activity', filterSchema: activityFilter, delegate: p => p.activityEvent as any, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  include: { project: { select: { name: true } } },
  where: q => and(eq('type', q.type), eq('level', q.level), eq('source', q.source), eq('projectId', q.projectId), eq('traceId', q.traceId),
    contains(['message', 'type', 'requestId'], q.search), q.from || q.to ? { createdAt: between(q.from, q.to) } : undefined),
  toDto: toActivityDto, headers: activityHeaders, toRow: d => activityHeaders.map(h => d[h]),
};

// ---- traces
const tracesFilter = z.object({
  status: z.enum(['RUNNING', 'OK', 'ERROR']).optional(), source: source.optional(), projectId: str.optional(), search: str.optional(), ...range,
});
const traceHeaders = ['traceId', 'name', 'projectId', 'requestId', 'status', 'source', 'startedAt', 'endedAt', 'durationMs', 'errorMessage', 'stack', 'spanCount'];
const traces: Dataset<z.infer<typeof tracesFilter>> = {
  name: 'traces', filterSchema: tracesFilter, delegate: p => p.trace as any, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  include: { _count: { select: { spans: true } } },
  where: q => and(eq('status', q.status), eq('source', q.source), eq('projectId', q.projectId), contains(['name', 'traceId', 'requestId'], q.search),
    q.from || q.to ? { startedAt: between(q.from, q.to) } : undefined),
  toDto: toTraceDto, headers: traceHeaders, toRow: d => traceHeaders.map(h => d[h]),
};

// ---- memory / bus / tools / context
const eventFilter = z.object({ traceId: str.optional(), status: z.enum(['STARTED', 'SUCCESS', 'FAILURE']).optional(), source: source.optional(),
  projectId: str.optional(), search: str.optional(), ...range });
type EventQ = z.infer<typeof eventFilter>;
const eventWhere = (searchFields: string[], dateField = 'createdAt') => (q: EventQ) => and(
  eq('traceId', q.traceId), eq('status', q.status), eq('source', q.source), eq('projectId', q.projectId), contains(searchFields, q.search),
  q.from || q.to ? { [dateField]: between(q.from, q.to) } : undefined);

const memHeaders = ['id', 'createdAt', 'operationId', 'phase', 'status', 'source', 'memorySource', 'category', 'itemCount', 'estimatedTokens',
  'payloadBytes', 'durationMs', 'errorMessage', 'traceId', 'spanId', 'projectId'];
const memory: Dataset<EventQ> = {
  name: 'memory', filterSchema: eventFilter, delegate: p => p.memoryEvent as any, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  where: eventWhere(['memorySource', 'category', 'operationId']), toDto: toMemoryDto, headers: memHeaders, toRow: d => memHeaders.map(h => d[h]),
};
const busHeaders = ['id', 'createdAt', 'operationId', 'operationName', 'operationType', 'eventName', 'inputMeta', 'outputStatus', 'status', 'source',
  'durationMs', 'errorMessage', 'stack', 'traceId', 'spanId', 'projectId'];
const bus: Dataset<EventQ> = {
  name: 'bus', filterSchema: eventFilter, delegate: p => p.busEvent as any, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  where: eventWhere(['operationName', 'eventName', 'operationId']), toDto: toBusDto, headers: busHeaders, toRow: d => busHeaders.map(h => d[h]),
};
const toolHeaders = ['id', 'createdAt', 'toolName', 'toolCallId', 'requestId', 'inputMeta', 'outputMeta', 'status', 'source', 'startedAt', 'endedAt',
  'durationMs', 'errorMessage', 'retryCount', 'maxRetries', 'traceId', 'spanId', 'projectId'];
const tools: Dataset<EventQ> = {
  name: 'tools', filterSchema: eventFilter, delegate: p => p.toolCallEvent as any, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  where: eventWhere(['toolName', 'toolCallId']), toDto: toToolDto, headers: toolHeaders, toRow: d => toolHeaders.map(h => d[h]),
};
const ctxHeaders = ['id', 'createdAt', 'contextId', 'operation', 'contextSource', 'sizeBytes', 'estimatedTokens', 'version', 'status', 'source',
  'errorMessage', 'durationMs', 'traceId', 'spanId', 'projectId'];
const context: Dataset<EventQ> = {
  name: 'context', filterSchema: eventFilter, delegate: p => p.contextEvent as any, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  where: eventWhere(['contextId', 'contextSource', 'operation']), toDto: toContextDto, headers: ctxHeaders, toRow: d => ctxHeaders.map(h => d[h]),
};

// ---- alerts
const alertsFilter = z.object({
  budgetId: str.optional(), projectId: str.optional(), threshold: z.coerce.number().int().refine(n => [50, 80, 100].includes(n), 'threshold must be 50, 80 or 100').optional(), ...range,
});
const alertHeaders = ['id', 'createdAt', 'budgetId', 'budgetName', 'projectId', 'projectName', 'period', 'threshold', 'level', 'periodStart', 'periodEnd',
  'spendUsd', 'limitUsd', 'percent'];
const alerts: Dataset<z.infer<typeof alertsFilter>> = {
  name: 'alerts', filterSchema: alertsFilter, delegate: p => p.budgetAlert as any, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  include: { budget: { include: { project: { select: { name: true } } } } },
  where: q => and(eq('budgetId', q.budgetId), eq('threshold', q.threshold), q.projectId ? { budget: { projectId: q.projectId } } : undefined,
    q.from || q.to ? { createdAt: between(q.from, q.to) } : undefined),
  toDto: toAlertDto, headers: alertHeaders, toRow: d => alertHeaders.map(h => d[h]),
};

// ---- tasks
const tasksFilter = z.object({
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']).optional(),
  kind: z.enum(['RETENTION_SWEEP', 'DEMO_SEED', 'BUDGET_EVALUATION', 'EXPORT', 'OTHER']).optional(), source: source.optional(), ...range,
});
const taskHeaders = ['id', 'createdAt', 'name', 'kind', 'status', 'source', 'traceId', 'startedAt', 'endedAt', 'durationMs', 'result', 'errorMessage', 'stack'];
const tasks: Dataset<z.infer<typeof tasksFilter>> = {
  name: 'tasks', filterSchema: tasksFilter, delegate: p => p.backgroundTask as any, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  where: q => and(eq('status', q.status), eq('kind', q.kind), eq('source', q.source), q.from || q.to ? { createdAt: between(q.from, q.to) } : undefined),
  toDto: toTaskDto, headers: taskHeaders, toRow: d => taskHeaders.map(h => d[h]),
};

export const DATASETS: Record<string, Dataset> = { activity, traces, logs, errors, memory, bus, tools, context, alerts, tasks };
export const logsDataset = logs;
