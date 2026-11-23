/** Test helpers for obs-events modules: isolated app mounting only the read-side routers + direct prisma seeding. */
import express from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { createActivityRouter } from '../../src/modules/activity';
import { createTracesRouter } from '../../src/modules/traces';
import { createObservabilityRouter } from '../../src/modules/observability';
import { errorHandler, notFoundHandler } from '../../src/middleware/errorHandler';

export interface Harness { ctx: TestCtx; prisma: PrismaClient; app: express.Express; close(): Promise<void> }

/**
 * The app has ONLY the three read-side routers (no request-lifecycle middleware), so the GETs made by tests never write
 * traces/logs themselves and counts stay exact even once the real instrumentation SDK lands.
 */
export async function makeHarness(): Promise<Harness> {
  const ctx = await createTestApp();
  const app = express();
  app.use('/api', createActivityRouter(ctx.deps));
  app.use('/api', createTracesRouter(ctx.deps));
  app.use('/api', createObservabilityRouter(ctx.deps));
  app.use('/api', notFoundHandler);
  app.use(errorHandler(ctx.deps.instr));
  return { ctx, prisma: ctx.prisma, app, close: async () => { await ctx.close(); cleanupTestDir(ctx.dir); } };
}

export const T = (iso: string) => new Date(iso);
let n = 0;
const uid = (p: string) => `${p}_${String(++n).padStart(5, '0')}`;

export const seed = {
  project: (p: PrismaClient, name: string) => p.project.create({ data: { name } }),
  log: (p: PrismaClient, o: Partial<Prisma.ExecutionLogUncheckedCreateInput> & { ts: Date }) =>
    p.executionLog.create({ data: { level: 'INFO', eventType: 'x.y', category: 'SYSTEM', operation: 'op', status: 'SUCCESS', source: 'ACTUAL', message: 'm', ...o } }),
  trace: (p: PrismaClient, o: Partial<Prisma.TraceUncheckedCreateInput> & { startedAt: Date }) =>
    p.trace.create({ data: { traceId: uid('trace').padEnd(32, '0'), name: 'agent.run', status: 'OK', source: 'ACTUAL', ...o } }),
  span: (p: PrismaClient, traceId: string, o: Partial<Prisma.SpanUncheckedCreateInput> & { startedAt: Date }) =>
    p.span.create({ data: { spanId: uid('span').padEnd(16, '0'), traceId, name: 'span', kind: 'INTERNAL', status: 'OK', source: 'ACTUAL', ...o } }),
  memory: (p: PrismaClient, o: Partial<Prisma.MemoryEventUncheckedCreateInput> & { createdAt: Date }) =>
    p.memoryEvent.create({ data: { operationId: uid('mop'), phase: 'COMPLETED', status: 'SUCCESS', source: 'SIMULATED', memorySource: 'session-memory', category: 'prefs', itemCount: 3, estimatedTokens: 120, payloadBytes: 480, ...o } }),
  bus: (p: PrismaClient, o: Partial<Prisma.BusEventUncheckedCreateInput> & { createdAt: Date }) =>
    p.busEvent.create({ data: { operationId: uid('bop'), operationName: 'budget.alert.publish', operationType: 'PUBLISH', eventName: 'budget.alert', status: 'SUCCESS', source: 'ACTUAL', ...o } }),
  tool: (p: PrismaClient, o: Partial<Prisma.ToolCallEventUncheckedCreateInput> & { startedAt: Date }) =>
    p.toolCallEvent.create({ data: { toolName: 'search', toolCallId: uid('call'), status: 'SUCCESS', source: 'SIMULATED', ...o } }),
  context: (p: PrismaClient, o: Partial<Prisma.ContextEventUncheckedCreateInput> & { createdAt: Date }) =>
    p.contextEvent.create({ data: { contextId: uid('ctx'), operation: 'CREATED', contextSource: 'agent', sizeBytes: 100, estimatedTokens: 25, version: 1, status: 'SUCCESS', source: 'SIMULATED', ...o } }),
  activity: (p: PrismaClient, o: Partial<Prisma.ActivityEventUncheckedCreateInput> & { createdAt: Date }) =>
    p.activityEvent.create({ data: { type: 'usage.recorded', level: 'INFO', message: 'msg', source: 'ACTUAL', ...o } }),
  task: (p: PrismaClient, o: Partial<Prisma.BackgroundTaskUncheckedCreateInput>) =>
    p.backgroundTask.create({ data: { name: 'task', kind: 'OTHER', status: 'SUCCEEDED', source: 'ACTUAL', ...o } }),
};
