/** POST /simulations/agent-run: a full SIMULATED agent execution (no usage event). */
import { performance } from 'node:perf_hooks';
import type { AppDeps } from '../../../contracts/services';
import type { ErrorInfo } from '../../../contracts/instrumentation';
import type { SimulatedFailure } from '../../../../../shared/types';
import { newRequestId } from '../../../utils/ids';
import { loadActiveProject } from '../pipeline';
import { emitSimulatedAgentActivity } from './agentActivity';
import { mulberry32, randInt, seedFromString } from '../mock/prng';
import { SIM_LABEL } from '../mock/types';

export interface AgentRunResult {
  traceId: string; requestId: string; status: 'SUCCESS' | 'FAILURE';
  simulated: true; label: typeof SIM_LABEL; error?: { message: string };
}

export async function runAgentSimulation(deps: AppDeps, input: { projectId: string; simulateFailure?: SimulatedFailure }): Promise<AgentRunResult> {
  const { instr } = deps;
  const failure = input.simulateFailure ?? 'none';
  const project = await loadActiveProject(deps, input.projectId);
  const requestId = newRequestId('agent');
  const seed = seedFromString(`agent-run|${requestId}`);
  const rng = mulberry32(seed);

  const at = new Date();
  const trace = await instr.startTrace({
    name: 'agent.run', projectId: project.id, requestId, source: 'SIMULATED',
    attributes: { simulated: true, label: SIM_LABEL, simulateFailure: failure },
    at,
  });
  const perf0 = performance.now();
  const clock = (): Date => new Date(at.getTime() + Math.floor(performance.now() - perf0));
  const ids = () => ({ traceId: trace.traceId, spanId: trace.rootSpan.spanId, projectId: project.id, requestId, at: clock() });
  const log = (eventType: string, message: string, status: 'STARTED' | 'SUCCESS' | 'FAILURE' | 'INFO', extra: Record<string, unknown> = {}, err?: ErrorInfo) =>
    instr.log({
      ...ids(), level: status === 'FAILURE' ? 'ERROR' : 'INFO', eventType, category: 'REQUEST', operation: 'agent.run', status, source: 'SIMULATED',
      message, attributes: { simulated: true, ...extra }, errorMessage: err?.message, errorCategory: err ? (err.category ?? 'UNKNOWN') : undefined,
    });

  try {
    await log('execution.started', 'Simulated agent execution started', 'STARTED');
    const summary = await emitSimulatedAgentActivity(instr, {
      trace, parentSpan: trace.rootSpan, projectId: project.id, requestId, seed, failure, forceFailure: failure !== 'none', clock,
    });

    if (summary.failed) {
      const err = summary.error ?? { message: 'Simulated agent failure' };
      await log('execution.failed', 'Simulated agent execution failed', 'FAILURE', { failure }, err);
      await instr.recordActivity({
        ...ids(), type: 'agent.run.failed', level: 'ERROR', source: 'SIMULATED', message: `Simulated agent run failed (${failure})`,
        metadata: { simulated: true, label: SIM_LABEL, failure },
      });
      await trace.end({ message: err.message, stack: err.stack, category: err.category });
      return { traceId: trace.traceId, requestId, status: 'FAILURE', simulated: true, label: SIM_LABEL, error: { message: err.message } };
    }

    const span = await trace.rootSpan.startSpan('response.generate', 'INTERNAL', { simulated: true }, { source: 'SIMULATED' });
    const outputTokens = randInt(rng, 80, 600);
    await log('response.generated', 'Simulated agent response generated', 'SUCCESS', { outputTokens, simulatedDurationMs: randInt(rng, 40, 400) });
    await span.end();
    await log('execution.completed', 'Simulated agent execution completed', 'SUCCESS', {
      contextEvents: summary.contextEvents, memoryEvents: summary.memoryEvents, busEvents: summary.busEvents, toolCalls: summary.toolCalls,
    });
    await instr.recordActivity({
      ...ids(), type: 'agent.run.completed', level: 'INFO', source: 'SIMULATED', message: 'Simulated agent run completed',
      metadata: { simulated: true, label: SIM_LABEL, ...summary },
    });
    await trace.end();
    return { traceId: trace.traceId, requestId, status: 'SUCCESS', simulated: true, label: SIM_LABEL };
  } catch (e) {
    await trace.end(e).catch(() => undefined);
    throw e;
  }
}
