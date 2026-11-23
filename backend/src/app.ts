import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig, AppDeps } from './contracts/services';
import { createInstrumentation, requestLifecycleMiddleware } from './modules/instrumentation';
import { createCostRouter, createCostService } from './modules/cost';
import { createBudgetsRouter, createBudgetService } from './modules/budgets';
import { createProjectsRouter } from './modules/projects';
import { createProvidersRouter } from './modules/providers';
import { createUsageRouter } from './modules/usage';
import { createDashboardRouter } from './modules/dashboard';
import { createActivityRouter } from './modules/activity';
import { createTracesRouter } from './modules/traces';
import { createObservabilityRouter } from './modules/observability';
import { createLoggingRouter } from './modules/logging';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { securityHeaders, rateLimiter, hostGuard } from './middleware/security';
import { createAuthRouter, requireAuth } from './modules/auth';

export function createDeps(prisma: PrismaClient, config: AppConfig): AppDeps {
  const instr = createInstrumentation(prisma, { logDir: config.logDir });
  const cost = createCostService(prisma);
  const budgets = createBudgetService(prisma, instr);
  return { prisma, instr, cost, budgets, config };
}

export function buildApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  // TRUST_PROXY: opt-in (number of hops, or 'loopback'); default off so X-Forwarded-For cannot be spoofed
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  app.use(hostGuard(deps.config.security.allowedHosts));
  app.use(securityHeaders());
  app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] }));
  // CSRF guard: state-changing /api requests carrying a foreign Origin are rejected (blocks cross-site form POSTs).
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (!safe && origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin state-changing requests are not allowed' } });
    }
    next();
  });
  app.use('/api', rateLimiter(deps.config.security.rateLimitPerMinute));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', requestLifecycleMiddleware(deps.instr));

  app.get('/api/health', (_req, res) => {
    res.json({ data: { status: 'ok', version: '0.1.0', simulated: true, label: 'DEMO / SIMULATED', time: new Date().toISOString() } });
  });

  const api = express.Router();
  api.use(createAuthRouter(deps));
  api.use(requireAuth(deps));
  api.use(createDashboardRouter(deps));
  api.use(createProjectsRouter(deps));
  api.use(createProvidersRouter(deps));
  api.use(createUsageRouter(deps));
  api.use(createCostRouter(deps));
  api.use(createBudgetsRouter(deps));
  api.use(createActivityRouter(deps));
  api.use(createTracesRouter(deps));
  api.use(createObservabilityRouter(deps));
  api.use(createLoggingRouter(deps));
  app.use('/api', api);
  app.use('/api', notFoundHandler);

  const dist = deps.config.frontendDist;
  if (dist && fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (_req, res, next) => {
      res.sendFile(path.join(dist, 'index.html'), err => {
        // dist may be mid-rebuild: answer 503 instead of leaking an internal 500
        if (err && !res.headersSent) res.status(503).json({ error: { code: 'FRONTEND_UNAVAILABLE', message: 'Frontend build is not available right now, retry shortly' } });
        else if (err) next(err);
      });
    });
  }
  app.use(errorHandler(deps.instr));
  return app;
}
