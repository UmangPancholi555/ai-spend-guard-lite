import type { Request, RequestHandler, Response } from 'express';
import { performance } from 'node:perf_hooks';
import type { Instrumentation } from '../../contracts/instrumentation';
import { newRequestId } from '../../utils/ids';
import { runtimeRegistry } from '../runtime/registry';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const MAX_PATH_ATTR = 120;
const DEFAULT_SUMMARY_MS = 60_000;
const DEFAULT_MAX_DETAILED_PER_MIN = 1200;

export interface RequestMiddlewareOptions {
  /** Window for the aggregated `request.rejected.summary` log (default 60s). */
  summaryIntervalMs?: number;
  /** Hard cap of detailed per-request log rows per minute (default 1200); the excess is only counted in the summary. */
  maxDetailedPerMinute?: number;
}
export type RequestLifecycleMiddleware = RequestHandler & {
  /** Emit the pending aggregated summary now (if any). */
  flushSummary(): Promise<void>;
  /** Cancel the summary timer (does not emit). */
  stop(): void;
};

/** `base` = req.baseUrl captured at middleware entry (Express restores baseUrl after routing, so it is stale at 'finish'). */
function routeOf(req: Request, base: string): string {
  if (req.route && typeof req.route.path === 'string') return `${base}${req.route.path}` || '/';
  return '(unmatched)';
}

/**
 * ACTUAL request lifecycle middleware (mounted at /api, BEFORE auth, so it must treat the network as hostile).
 *  - sets res.locals.requestId (+ `x-request-id` response header; an incoming x-request-id is honoured only if it matches
 *    /^[A-Za-z0-9._-]{8,64}$/, otherwise a fresh id is generated)
 *  - measures duration; on response finish writes an ExecutionLog event (category REQUEST, operation `METHOD /route-pattern`):
 *      status SUCCESS (<400), INFO (4xx), FAILURE (>=500); eventType request.completed (<500) | request.failed (>=500);
 *      level INFO | WARN (4xx) | ERROR (5xx)
 *  - logs every non-GET/HEAD/OPTIONS request and any request with status >= 400; successful GET/HEAD/OPTIONS are NOT logged
 *    (avoids flooding); /api/health is never logged.
 *  - FLOOD PROTECTION (M2): unauthenticated noise is never written per request. 401, 429 and unmatched-route 404 responses are only
 *    COUNTED in memory and flushed as at most one aggregated `request.rejected.summary` log per window (default 60s; counts by
 *    status, no attacker-controlled strings). Detailed rows are additionally capped at `maxDetailedPerMinute` (excess counted as
 *    `suppressed` in the summary). 403 / other 4xx / 5xx on matched routes are still logged individually. The logged `path`
 *    attribute is truncated to 120 chars.
 *  - does NOT create traces (provider pipeline / tools / simulators own those). Handlers that start a trace set res.locals.traceId
 *    (+ res.locals.projectId): the request log row then carries traceId, and the trace attributes + usage metadata carry
 *    `httpRequestId` (= res.locals.requestId) so HTTP log line <-> trace <-> usage event are joinable.
 *  - never throws / never blocks the response.
 */
export function requestLifecycleMiddleware(instr: Instrumentation, opts: RequestMiddlewareOptions = {}): RequestLifecycleMiddleware {
  runtimeRegistry.register({ kind: 'request', name: 'Request lifecycle middleware', description: 'Real: API request middleware logs every state-changing / failed request (ACTUAL); handlers that start a trace set res.locals.traceId so the HTTP log line joins to its trace and usage event.' });
  const windowMs = opts.summaryIntervalMs ?? DEFAULT_SUMMARY_MS;
  const maxDetailed = opts.maxDetailedPerMinute ?? DEFAULT_MAX_DETAILED_PER_MIN;
  const counts = new Map<string, number>(); // '401' | '404' | '429' -> n   (rejected, never logged individually)
  let suppressed = 0;
  let timer: NodeJS.Timeout | undefined;
  let windowStart = Date.now();
  let detailedInWindow = 0;
  let detailedWindowStart = Date.now();

  async function flushSummary(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (counts.size === 0 && suppressed === 0) return;
    const byStatus = Object.fromEntries([...counts.entries()].sort());
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const sup = suppressed;
    const seconds = Math.max(1, Math.round((Date.now() - windowStart) / 1000));
    counts.clear(); suppressed = 0;
    const detail = Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(', ');
    await instr.log({
      level: 'WARN', eventType: 'request.rejected.summary', category: 'REQUEST', operation: 'request.rejected.summary', status: 'INFO', source: 'ACTUAL',
      message: `${total} rejected request(s) in the last ${seconds}s${detail ? ` (${detail})` : ''}${sup ? `; ${sup} detailed log(s) suppressed by rate cap` : ''}`,
      attributes: { windowSeconds: seconds, total, byStatus, suppressedDetailed: sup },
    }).catch(() => {});
  }
  function arm() {
    if (timer) return;
    windowStart = Date.now();
    timer = setTimeout(() => { timer = undefined; void flushSummary(); }, windowMs);
    timer.unref();
  }
  const count = (key: string) => { counts.set(key, (counts.get(key) ?? 0) + 1); arm(); };
  function allowDetailed(): boolean {
    const now = Date.now();
    if (now - detailedWindowStart >= 60_000) { detailedWindowStart = now; detailedInWindow = 0; }
    if (detailedInWindow >= maxDetailed) { suppressed++; arm(); return false; }
    detailedInWindow++;
    return true;
  }

  const handler: RequestHandler = (req, res, next) => {
    const start = performance.now();
    const base = req.baseUrl ?? '';
    const incoming = req.header('x-request-id');
    const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : newRequestId('req');
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    res.once('finish', () => {
      try {
        const code = res.statusCode;
        if (code === 401 || code === 429 || (code === 404 && !req.route)) {
          if (!isHealth(req)) count(String(code));
          return;
        }
        logRequest(instr, req, res, requestId, base, Math.max(0, Math.round(performance.now() - start)), allowDetailed);
      } catch { /* never crash */ }
    });
    next();
  };
  return Object.assign(handler, { flushSummary, stop() { if (timer) { clearTimeout(timer); timer = undefined; } } });
}

function isHealth(req: Request): boolean {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
  return path === '/api/health' || path === '/api/health/';
}

function logRequest(
  instr: Instrumentation, req: Request, res: Response, requestId: string, base: string, durationMs: number, allowDetailed: () => boolean,
) {
  if (isHealth(req)) return;
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0].slice(0, MAX_PATH_ATTR);
  const method = req.method.toUpperCase();
  const code = res.statusCode;
  const readOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  if (readOnly && code < 400) return;
  if (!allowDetailed()) return;

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
