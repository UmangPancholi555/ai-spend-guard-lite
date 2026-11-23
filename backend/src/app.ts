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

export function createDeps(prisma: PrismaClient, config: AppConfig): AppDeps {
  const instr = createInstrumentation(prisma, { logDir: config.logDir });
  const cost = createCostService(prisma);
  const budgets = createBudgetService(prisma, instr);
  return { prisma, instr, cost, budgets, config };
}

export function buildApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', requestLifecycleMiddleware(deps.instr));

  app.get('/api/health', (_req, res) => {
    res.json({ data: { status: 'ok', version: '0.1.0', simulated: true, label: 'DEMO / SIMULATED', time: new Date().toISOString() } });
  });

  const api = express.Router();
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
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use(errorHandler(deps.instr));
  return app;
}
