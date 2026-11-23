/** Providers module: mock AI providers, request pipeline and demo simulators. 100% local/simulated - no network. */
import { Router } from 'express';
import type { AppDeps } from '../../contracts/services';
import type { ProviderDto, ProviderKey } from '../../../../shared/types';
import { ah, parse } from '../../utils/http';
import { executeMockRequest } from './pipeline';
import { agentRunSchema, mockProviderRequestSchema, seedRequestSchema } from './schemas';
import { runSeed } from './simulator/seed';
import { runAgentSimulation } from './simulator/agentRun';
import { SIM_LABEL } from './mock';

export function createProvidersRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/providers', ah(async (_req, res) => {
    const providers = await deps.prisma.provider.findMany({ orderBy: { key: 'asc' }, include: { models: { orderBy: { name: 'asc' } } } });
    const data: ProviderDto[] = providers.map(p => ({
      key: p.key as ProviderKey, displayName: p.displayName, isSimulated: true, label: SIM_LABEL,
      models: p.models.map(m => ({ name: m.name, displayName: m.displayName, contextWindow: m.contextWindow, active: m.active })),
    }));
    res.json({ data });
  }));

  router.post('/providers/requests', ah(async (req, res) => {
    const input = parse(mockProviderRequestSchema, req.body);
    const data = await executeMockRequest(deps, input);
    res.status(201).json({ data });
  }));

  router.post('/simulations/seed', ah(async (req, res) => {
    const input = parse(seedRequestSchema, req.body);
    const data = await runSeed(deps, input);
    res.status(201).json({ data: { taskId: data.taskId, created: data.created, projectId: data.projectId, failures: data.failures } });
  }));

  router.post('/simulations/agent-run', ah(async (req, res) => {
    const input = parse(agentRunSchema, req.body);
    const data = await runAgentSimulation(deps, input);
    res.status(201).json({ data });
  }));

  return router;
}

export { executeMockRequest } from './pipeline';
export type { ExecuteOptions } from './pipeline';
export { emitSimulatedAgentActivity } from './simulator/agentActivity';
export { runSeed, DEMO_PROJECT_NAME } from './simulator/seed';
export { runAgentSimulation } from './simulator/agentRun';
export { getMockProvider, MockOpenAIProvider, MockAnthropicProvider } from './mock';
export type { MockProvider, MockCompletion } from './mock';
