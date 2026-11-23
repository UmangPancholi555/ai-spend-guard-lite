import type { Request, RequestHandler, Response } from 'express';
import { performance } from 'node:perf_hooks';
import type { Instrumentation } from '../../contracts/instrumentation';
import { newRequestId } from '../../utils/ids';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** `base` = req.baseUrl captured at middleware entry (Express restores baseUrl after routing, so it is stale at 'finish'). */
function routeOf(req: Request, base: string): string {
  if (req.route && typeof req.route.path === 'string') return `${base}${req.route.path}` || '/';
  return '(unmatched)';
}

/**
 * ACTUAL request lifecycle middleware (mounted at /api).
 *  - sets res.locals.requestId (+ `x-request-id` response header; a well-formed incoming x-request-id is honoured)
 *  - measures duration; on response finish writes an ExecutionLog event (category REQUEST, operation `METHOD /route-pattern`):
 *      status SUCCESS (<400), INFO (4xx), FAILURE (>=500); eventType request.completed (<500) | request.failed (>=500);
 *      level INFO | WARN (4xx) | ERROR (5xx)
 *  - logs every non-GET/HEAD/OPTIONS request and any request with status >= 400; successful GET/HEAD/OPTIONS are NOT logged
 *    (avoids flooding); /api/health is never logged.
 *  - does NOT create traces (provider pipeline / simulators own those); sets nothing on res.locals.traceId.
 *  - never throws / never blocks the response.
 */
export function requestLifecycleMiddleware(instr: Instrumentation): RequestHandler {
  return (req, res, next) => {
    const start = performance.now();
    const base = req.baseUrl ?? '';
    const incoming = req.header('x-request-id');
    const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : newRequestId('req');
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    res.once('finish', () => {
      try { logRequest(instr, req, res, requestId, base, Math.max(0, Math.round(performance.now() - start))); } catch { /* never crash */ }
    });
    next();
  };
}

function logRequest(instr: Instrumentation, req: Request, res: Response, requestId: string, base: string, durationMs: number) {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
  if (path === '/api/health' || path === '/api/health/') return;
  const method = req.method.toUpperCase();
  const code = res.statusCode;
  const readOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  if (readOnly && code < 400) return;

  const route = routeOf(req, base);
  const operation = `${method} ${route}`;
  const serverError = code >= 500;
  const locals = res.locals as { traceId?: string; projectId?: string };
  void instr.log({
    level: serverError ? 'ERROR' : code >= 400 ? 'WARN' : 'INFO',
    eventType: serverError ? 'request.failed' : 'request.completed',
    category: 'REQUEST',
    operation,
    status: serverError ? 'FAILURE' : code >= 400 ? 'INFO' : 'SUCCESS',
    source: 'ACTUAL',
    message: `${operation} -> ${code} in ${durationMs}ms`,
    durationMs,
    requestId,
    traceId: locals.traceId,
    projectId: locals.projectId,
    attributes: { method, route, path, statusCode: code },
    errorCategory: serverError ? 'INTERNAL' : undefined,
    errorMessage: serverError ? `HTTP ${code}` : undefined,
  }).catch(() => {});
}
