// STUB - owned by the observability-core agent. Keep exported names/signatures.
import type { PrismaClient } from '@prisma/client';
import type { RequestHandler } from 'express';
import type { Instrumentation } from '../../contracts/instrumentation';
import { createNoopInstrumentation } from '../../contracts/noop';

export interface InstrumentationOptions { logDir: string }
export function createInstrumentation(_prisma: PrismaClient, _opts: InstrumentationOptions): Instrumentation {
  return createNoopInstrumentation();
}
/** Express middleware: ACTUAL request lifecycle (trace per /api request, spans, logs, activity). Sets res.locals.traceId. */
export function requestLifecycleMiddleware(_instr: Instrumentation): RequestHandler {
  return (_req, _res, next) => next();
}
