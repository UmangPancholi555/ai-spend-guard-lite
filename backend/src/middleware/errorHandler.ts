import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import type { Instrumentation } from '../contracts/instrumentation';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

export function errorHandler(instr: Instrumentation) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: err.issues } });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { type?: string; message?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } });
    }
    if (e?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large (limit 1mb)' } });
    }
    // Unexpected: record as ACTUAL error event (instrumented error handler), never leak the stack to the client.
    void instr.recordError({
      source: 'ACTUAL', category: 'INTERNAL', operation: `${req.method} ${req.path}`, error: err,
      traceId: (res.locals as { traceId?: string }).traceId,
    }).catch(() => {});
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  };
}
