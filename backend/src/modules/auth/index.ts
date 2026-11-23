// STUB - owned by the `auth` agent. Keep exported names/signatures.
import { Router, type RequestHandler } from 'express';
import type { AppDeps } from '../../contracts/services';

/** Mounted at /api BEFORE all other routers: /auth/status, /auth/setup, /auth/login, /auth/logout, /auth/me, /auth/password ... */
export function createAuthRouter(_deps: AppDeps): Router { return Router(); }
/** Mounted at /api AFTER the auth router and BEFORE every other router. Must allow /health and /auth/* unauthenticated; no-op when !deps.config.auth.enabled. */
export function requireAuth(_deps: AppDeps): RequestHandler { return (_req, _res, next) => next(); }
