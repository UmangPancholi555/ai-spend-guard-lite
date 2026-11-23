import type { Request, RequestHandler } from 'express';
import type { AppDeps } from '../../contracts/services';
import { AppError } from '../../utils/errors';
import { csrfMatches, getAuthCore } from './core';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Unauthenticated endpoints (method + path relative to /api). Everything else - including unknown paths - needs a session. */
const PUBLIC: Array<{ methods: string[]; path: string }> = [
  { methods: ['GET', 'HEAD'], path: '/health' },
  { methods: ['GET', 'HEAD'], path: '/auth/status' },
  { methods: ['POST'], path: '/auth/setup' },
  { methods: ['POST'], path: '/auth/login' },
];

/** Non-GET endpoints that VIEWER accounts may still call (own session/password, pure calculators). */
const VIEWER_WRITE_ALLOWED = new Set(['/auth/logout', '/auth/password', '/cost/calculate']);

/** Path relative to the /api mount, lower-cased, no query, no trailing slash. Never URL-decoded (matches Express routing). */
export function apiPath(req: Request): string {
  let p = `${req.baseUrl ?? ''}${req.path ?? ''}`.toLowerCase();
  if (p.startsWith('/api')) p = p.slice(4);
  p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

export function isPublicRoute(req: Request): boolean {
  const p = apiPath(req);
  return PUBLIC.some(r => r.path === p && r.methods.includes(req.method.toUpperCase()));
}

/** Authenticates the request (cookie session), enforces CSRF on unsafe methods and the VIEWER read-only rule. */
export function sessionGate(deps: AppDeps): RequestHandler {
  const core = getAuthCore(deps);
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = core.readToken(req);
    core.resolveSession(token).then(found => {
      if (!found) {
        if (token) core.clearCookie(res);
        return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
      }
      req.user = found.user;
      req.authSession = found.session;
      (res.locals as { user?: unknown; csrfToken?: string }).user = found.user;
      (res.locals as { csrfToken?: string }).csrfToken = found.csrfToken;
      const method = req.method.toUpperCase();
      if (!SAFE_METHODS.has(method)) {
        if (!csrfMatches(found.session.csrfHash, req.get('x-csrf-token'))) {
          return next(new AppError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token'));
        }
        const p = apiPath(req);
        const allowed = VIEWER_WRITE_ALLOWED.has(p) || p.startsWith('/auth/sessions/');
        if (found.user.role === 'VIEWER' && !allowed) {
          return next(new AppError(403, 'FORBIDDEN', 'Read-only account: this action is not permitted'));
        }
      }
      next();
    }, next);
  };
}

/** Mounted at /api after the auth router. No-op when auth is disabled. */
export function requireAuth(deps: AppDeps): RequestHandler {
  if (!deps.config.auth.enabled) return (_req, _res, next) => next();
  const gate = sessionGate(deps);
  return (req, res, next) => {
    if (isPublicRoute(req)) return next();
    gate(req, res, next);
  };
}
