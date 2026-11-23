import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { runSeed, runAgentSimulation, DEMO_PROJECT_NAME } from '../../src/modules/providers';
import type { AppDeps } from '../../src/contracts/services';
import { fakeBudgets, fakeCost, makeProject, recordingInstr, type FakeBudgets, type RecordingInstr } from './helpers';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

function fresh(): { deps: AppDeps; instr: RecordingInstr; budgets: FakeBudgets } {
  const instr = recordingInstr();
  const budgets = fakeBudgets();
  return { deps: { ...ctx.deps, instr, cost: fakeCost(), budgets }, instr, budgets };
}

describe('runSeed (simulations/seed)', () => {
  it('creates the demo project, N backdated events spread over the window, wrapped in a DEMO_SEED SIMULATED task', async () => {
    const { deps, instr, budgets } = fresh();
    const N = 240, DAYS = 30;
    const r = await runSeed(deps, { requests: N, spreadDays: DAYS });
    expect(r.created).toBe(N);

    const project = await ctx.prisma.project.findUniqueOrThrow({ where: { id: r.projectId } });
    expect(project.name).toBe(DEMO_PROJECT_NAME);
    expect(project.isTest).toBe(true);

    const rows = await ctx.prisma.usageEvent.findMany({ where: { projectId: r.projectId }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(N);
    const now = Date.now();
    expect(rows.every(x => x.simulated)).toBe(true);
    expect(rows[rows.length - 1]!.createdAt.getTime()).toBeLessThanOrEqual(now);
    expect(rows[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(now - (DAYS + 1) * 86_400_000);
    // really spread: many distinct UTC days, oldest well in the past
    const days = new Set(rows.map(x => x.createdAt.toISOString().slice(0, 10)));
    expect(days.size).toBeGreaterThan(15);
    expect(now - rows[0]!.createdAt.getTime()).toBeGreaterThan(20 * 86_400_000);
    // mix of providers/models/sizes/classes
    expect(new Set(rows.map(x => x.providerKey))).toEqual(new Set(['openai', 'anthropic']));
    expect(new Set(rows.map(x => x.modelName)).size).toBeGreaterThan(4);
    expect(rows.some(x => x.cachedTokens > 0)).toBe(true);
    expect(rows.some(x => x.promptChars < 200)).toBe(true);
    expect(rows.some(x => x.promptChars > 1500)).toBe(true);
    // failures ~6%
    const failures = rows.filter(x => x.status === 'FAILURE');
    expect(failures.length).toBe(r.failures);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.length / N).toBeLessThan(0.2);
    expect(new Set(failures.map(x => x.errorCode)).size).toBeGreaterThanOrEqual(1);
    // metadata marks seeded, no prompts stored, requestIds unique
    expect(new Set(rows.map(x => x.requestId)).size).toBe(N);
    expect(JSON.parse(rows[0]!.metadata)).toMatchObject({ seeded: true, backdated: true, simulated: true });
    expect(rows.every(x => !x.responseText?.includes('Simulated demo prompt'))).toBe(true);
    // budgets evaluated chronologically with at = createdAt
    expect(budgets.calls).toHaveLength(N);
    const ats = budgets.calls.map(c => c.at.getTime());
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(ats).toEqual(rows.map(x => x.createdAt.getTime()));
    // task
    expect(instr.tasks).toHaveLength(1);
    expect(instr.tasks[0]).toMatchObject({ kind: 'DEMO_SEED', source: 'SIMULATED', status: 'SUCCEEDED' });
    expect(instr.tasks[0]!.result).toMatchObject({ created: N, projectId: r.projectId });
    expect(r.taskId).toBe('task_1');
    // no per-request traces/activity by default; summary activity is SIMULATED
    expect(instr.traces).toHaveLength(0);
    const acts = instr.calls.filter(c => c.fn === 'recordActivity') as any[];
    expect(acts.filter(a => a.type === 'usage.recorded')).toHaveLength(0);
    expect(acts.find(a => a.type === 'simulation.seeded')).toMatchObject({ source: 'SIMULATED' });
  });

  it('reuses the demo project on a second run and is deterministic for equal parameters', async () => {
    const a = fresh(); const b = fresh();
    const r1 = await runSeed(a.deps, { requests: 30, spreadDays: 10, seed: 'det-1' });
    const r2 = await runSeed(b.deps, { requests: 30, spreadDays: 10, seed: 'det-1' });
    expect(r2.projectId).toBe(r1.projectId);
    expect(await ctx.prisma.project.count({ where: { name: DEMO_PROJECT_NAME } })).toBe(1);
    const hashes = (await ctx.prisma.usageEvent.findMany({ where: { projectId: r1.projectId }, select: { promptHash: true } })).map(x => x.promptHash);
    const counts = new Map<string, number>();
    for (const h of hashes) counts.set(h, (counts.get(h) ?? 0) + 1);
    // the second run reproduced the first run's prompts exactly => many hashes seen at least twice
    expect([...counts.values()].filter(n => n >= 2).length).toBeGreaterThanOrEqual(25);
  });

  it('includeFailures=false produces no failures', async () => {
    const { deps } = fresh();
    const p = await makeProject(ctx.prisma);
    const r = await runSeed(deps, { projectId: p.id, requests: 150, spreadDays: 5, includeFailures: false });
    expect(r.failures).toBe(0);
    expect(await ctx.prisma.usageEvent.count({ where: { projectId: p.id, status: 'FAILURE' } })).toBe(0);
  });

  it('includeAgentActivity traces at most 25 SIMULATED requests with agent events', async () => {
    const { deps, instr } = fresh();
    const p = await makeProject(ctx.prisma);
    await runSeed(deps, { projectId: p.id, requests: 60, spreadDays: 7, includeAgentActivity: true });
    expect(instr.traces).toHaveLength(25);
    expect(instr.traces.every(t => t.source === 'SIMULATED' && t.name === 'provider.request')).toBe(true);
    expect(instr.calls.filter(c => c.fn === 'recordContext')).toHaveLength(25 * 4);
    const withTrace = await ctx.prisma.usageEvent.count({ where: { projectId: p.id, traceId: { not: null } } });
    expect(withTrace).toBe(25);
  });

  it('archived / unknown explicit project => 409 / 404 and no task started', async () => {
    const { deps, instr } = fresh();
    const archived = await makeProject(ctx.prisma, undefined, 'ARCHIVED');
    await expect(runSeed(deps, { projectId: archived.id, requests: 5, spreadDays: 3 })).rejects.toMatchObject({ status: 409 });
    await expect(runSeed(deps, { projectId: 'nope', requests: 5, spreadDays: 3 })).rejects.toMatchObject({ status: 404 });
    expect(instr.tasks).toHaveLength(0);
  });

  it('marks the task FAILED when generation throws', async () => {
    const { deps, instr } = fresh();
    const p = await makeProject(ctx.prisma);
    const boom = { ...deps, cost: { calculate: async () => { throw new Error('cost down'); } } };
    await expect(runSeed(boom, { projectId: p.id, requests: 3, spreadDays: 2 })).rejects.toThrow('cost down');
    expect(instr.tasks[0]!.status).toBe('FAILED');
  });
});

describe('runAgentSimulation (simulations/agent-run)', () => {
  it('emits a complete SIMULATED execution on one trace without a usage event', async () => {
    const { deps, instr } = fresh();
    const p = await makeProject(ctx.prisma);
    const r = await runAgentSimulation(deps, { projectId: p.id });
    expect(r.status).toBe('SUCCESS');
    expect(r.traceId).toBe(instr.traces[0]!.traceId);
    expect(instr.traces[0]).toMatchObject({ name: 'agent.run', source: 'SIMULATED', ended: true });
    const logs = instr.calls.filter(c => c.fn === 'log').map((c: any) => c.eventType);
    expect(logs).toEqual(['execution.started', 'response.generated', 'execution.completed']);
    expect(instr.calls.filter(c => c.fn === 'recordContext')).toHaveLength(4);
    expect(instr.calls.filter(c => c.fn === 'recordTool' && c.retryCount === 1)).toHaveLength(1);
    expect(instr.calls.filter(c => ['recordContext', 'recordMemory', 'recordBus', 'recordTool', 'log'].includes(c.fn as string)).every((c: any) => c.source === 'SIMULATED' && c.traceId === r.traceId)).toBe(true);
    expect(await ctx.prisma.usageEvent.count({ where: { projectId: p.id } })).toBe(0);
  });

  it('simulateFailure produces a failed run and an errored trace', async () => {
    for (const mode of ['error', 'timeout', 'rate_limit'] as const) {
      const { deps, instr } = fresh();
      const p = await makeProject(ctx.prisma);
      const r = await runAgentSimulation(deps, { projectId: p.id, simulateFailure: mode });
      expect(r.status).toBe('FAILURE');
      expect(instr.traces[0]!.endError).toBeTruthy();
      expect(instr.calls.some(c => c.fn === 'log' && (c as any).eventType === 'execution.failed')).toBe(true);
    }
  });

  it('404 unknown project, 409 archived', async () => {
    const { deps } = fresh();
    await expect(runAgentSimulation(deps, { projectId: 'nope' })).rejects.toMatchObject({ status: 404 });
    const a = await makeProject(ctx.prisma, undefined, 'ARCHIVED');
    await expect(runAgentSimulation(deps, { projectId: a.id })).rejects.toMatchObject({ status: 409 });
  });
});
