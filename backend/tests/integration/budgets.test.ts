import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDir, createTestApp } from '../helpers/testApp';
import { api, Ctx, listAll, mkProject, pay, picoToUsd, expectedPico } from './helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const PROMPT = 'budget threshold prompt '.repeat(10);

/** cost (pico) of one identical request, measured in a throwaway project so budgets of other projects are unaffected */
async function unitCostPico(): Promise<bigint> {
  const probe = await mkProject(ctx, `probe-${Math.random().toString(36).slice(2, 8)}`);
  const r = await pay(ctx, { projectId: probe.id, prompt: PROMPT, model: 'gpt-4o', maxOutputTokens: 200 });
  const total = expectedPico('openai/gpt-4o', r.usage).total;
  expect(r.cost.totalCostUsd).toBe(picoToUsd(total));
  expect(total > 0n).toBe(true);
  return total;
}

async function mkBudget(projectId: string | null, limitPico: bigint, period = 'MONTHLY', name = 'b') {
  const r = await api(ctx).post('/api/budgets').send({ projectId, name, period, limitUsd: picoToUsd(limitPico) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string };
}
const alertsOf = (budgetId: string) => listAll(ctx, `/api/budget-alerts?budgetId=${budgetId}`);

describe('budget alerts through the real pipeline', () => {
  it('creates exactly one alert at 50, 80, 100 and never duplicates on further requests', async () => {
    const c = await unitCostPico();
    const p = await mkProject(ctx, 'seq-budget-proj');
    const b = await mkBudget(p.id, c * 10n, 'MONTHLY', 'seq');
    const seen: Record<number, number[]> = {};
    for (let i = 1; i <= 13; i++) {
      const r = await pay(ctx, { projectId: p.id, prompt: PROMPT, model: 'gpt-4o', maxOutputTokens: 200 });
      for (const a of r.budgetAlerts) (seen[a.threshold] ??= []).push(i);
    }
    // request i brings spend to i*10 %
    expect(seen).toEqual({ 50: [5], 80: [8], 100: [10] });
    const alerts = await alertsOf(b.id);
    expect(alerts.map((a: any) => a.threshold).sort((x: number, y: number) => x - y)).toEqual([50, 80, 100]);
    for (const a of alerts) {
      expect(a.budgetId).toBe(b.id);
      expect(a.projectId).toBe(p.id);
      expect(a.period).toBe('MONTHLY');
      expect(a.limitUsd).toBe(picoToUsd(c * 10n));
      expect(a.percent).toBeGreaterThanOrEqual(a.threshold);
    }
    const a50 = alerts.find((a: any) => a.threshold === 50);
    expect(a50.spendUsd).toBe(picoToUsd(c * 5n));
    expect(a50.percent).toBe(50);
    // explicit re-evaluation does not duplicate either
    const ev = await api(ctx).post('/api/budgets/evaluate');
    expect(ev.status).toBe(200);
    expect(ev.body.data).toEqual([]);
    expect(await alertsOf(b.id)).toHaveLength(3);
    // utilization reflects 13 requests = 130%
    const u = await api(ctx).get(`/api/budgets/utilization?projectId=${p.id}`);
    expect(u.body.data).toHaveLength(1);
    expect(u.body.data[0].spendUsd).toBe(picoToUsd(c * 13n));
    expect(u.body.data[0].percent).toBe(130);
    expect(u.body.data[0].highestThresholdReached).toBe(100);
    // activity feed has exactly 3 budget.alert events for this project
    const act = await listAll(ctx, `/api/activity?projectId=${p.id}&type=budget.alert`);
    expect(act).toHaveLength(3);
    // level escalates with the threshold, in the alert list, the activity feed and the dashboard
    expect(Object.fromEntries(alerts.map((a: any) => [a.threshold, a.level]))).toEqual({ 50: 'INFO', 80: 'WARN', 100: 'CRITICAL' });
    expect(Object.fromEntries(act.map((a: any) => [a.metadata.threshold, a.level]))).toEqual({ 50: 'INFO', 80: 'WARN', 100: 'CRITICAL' });
    // dashboard exposes them
    const dash = await api(ctx).get(`/api/dashboard?projectId=${p.id}`);
    expect(dash.body.data.recentAlerts).toHaveLength(3);
    expect(Object.fromEntries(dash.body.data.recentAlerts.map((a: any) => [a.threshold, a.level]))).toEqual({ 50: 'INFO', 80: 'WARN', 100: 'CRITICAL' });
    // activity level filter finds exactly the CRITICAL (100%) alert
    const crit = await listAll(ctx, `/api/activity?projectId=${p.id}&type=budget.alert&level=CRITICAL`);
    expect(crit.map((a: any) => a.metadata.threshold)).toEqual([100]);
    // CRITICAL is an alert severity, not a failure: its log row is level CRITICAL / status INFO and is not listed as an error
    const logs = await listAll(ctx, `/api/logs?projectId=${p.id}&level=CRITICAL`);
    expect(logs.map((l: any) => [l.eventType, l.status])).toEqual([['activity.budget.alert', 'INFO']]);
    const errs = await listAll(ctx, `/api/observability/errors?projectId=${p.id}`);
    expect(errs.filter((e: any) => e.operation === 'budget.alert')).toHaveLength(0);
    // the alerts export carries the level
    const csv = await api(ctx).get(`/api/export/alerts?budgetId=${b.id}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toContain('threshold,level,');
    expect(csv.text).toContain(',100,CRITICAL,');
  });

  it('one request that jumps over several thresholds creates every crossed alert once', async () => {
    const c = await unitCostPico();
    const p = await mkProject(ctx, 'jump-proj');
    const b = await mkBudget(p.id, c, 'DAILY', 'jump'); // a single request == 100%
    const r = await pay(ctx, { projectId: p.id, prompt: PROMPT, model: 'gpt-4o', maxOutputTokens: 200 });
    expect(r.budgetAlerts.map(a => a.threshold).sort((x: number, y: number) => x - y)).toEqual([50, 80, 100]);
    await pay(ctx, { projectId: p.id, prompt: PROMPT, model: 'gpt-4o', maxOutputTokens: 200 });
    expect(await alertsOf(b.id)).toHaveLength(3);
  });

  it('concurrent requests (Promise.all) never produce duplicate alerts and never error', async () => {
    const c = await unitCostPico();
    const p = await mkProject(ctx, 'concurrent-proj');
    const b = await mkBudget(p.id, c * 10n, 'WEEKLY', 'conc');
    const results = await Promise.all(Array.from({ length: 12 }, () => api(ctx).post('/api/providers/requests')
      .send({ projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: PROMPT, maxOutputTokens: 200 })));
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201);
    const alerts = await alertsOf(b.id);
    expect(alerts.map((a: any) => a.threshold).sort((x: number, y: number) => x - y)).toEqual([50, 80, 100]);
    // responses collectively announce each alert exactly once
    const announced = results.flatMap(r => r.body.data.budgetAlerts.map((a: any) => a.threshold)).sort((x: number, y: number) => x - y);
    expect(announced).toEqual([50, 80, 100]);
    expect(await ctx.prisma.budgetAlert.count({ where: { budgetId: b.id } })).toBe(3);
    expect(await ctx.prisma.usageEvent.count({ where: { projectId: p.id } })).toBe(12);
    const act = await listAll(ctx, `/api/activity?projectId=${p.id}&type=budget.alert`);
    expect(act).toHaveLength(3);
  });

  it('global budget aggregates all projects; inactive budgets raise nothing; project-scoped does not see other projects', async () => {
    const c = await unitCostPico();
    const g = await mkBudget(null, c * 100_000n, 'MONTHLY', 'global-huge');
    const pa = await mkProject(ctx, 'scope-a'); const pb = await mkProject(ctx, 'scope-b');
    const ba = await mkBudget(pa.id, c * 2n, 'MONTHLY', 'a-budget');
    const inactive = await api(ctx).post('/api/budgets').send({ projectId: pb.id, name: 'off', period: 'MONTHLY', limitUsd: picoToUsd(c), active: false });
    expect(inactive.status).toBe(201);
    await pay(ctx, { projectId: pb.id, prompt: PROMPT, model: 'gpt-4o', maxOutputTokens: 200 });
    await pay(ctx, { projectId: pb.id, prompt: PROMPT, model: 'gpt-4o', maxOutputTokens: 200 });
    expect(await alertsOf(ba.id)).toHaveLength(0);
    expect(await alertsOf(inactive.body.data.id)).toHaveLength(0);
    expect(await alertsOf(g.id)).toHaveLength(0);
    await pay(ctx, { projectId: pa.id, prompt: PROMPT, model: 'gpt-4o', maxOutputTokens: 200 }); // 50%
    expect((await alertsOf(ba.id)).map((a: any) => a.threshold)).toEqual([50]);
    // duplicate budget (same project+period) is a 409; limit must be > 0
    const dup = await api(ctx).post('/api/budgets').send({ projectId: pa.id, name: 'dup', period: 'MONTHLY', limitUsd: '1.000000000000' });
    expect(dup.status).toBe(409);
    const zero = await api(ctx).post('/api/budgets').send({ projectId: pa.id, name: 'z', period: 'DAILY', limitUsd: '0' });
    expect(zero.status).toBe(400);
  });

  it('deleting a test project cascades usage, budgets and alerts', async () => {
    const c = await unitCostPico();
    const p = await mkProject(ctx, 'cascade-proj', true);
    const b = await mkBudget(p.id, c, 'MONTHLY', 'cascade');
    const r = await pay(ctx, { projectId: p.id, prompt: PROMPT, model: 'gpt-4o', maxOutputTokens: 200 });
    expect((await alertsOf(b.id)).length).toBe(3);
    const del = await api(ctx).delete(`/api/projects/${p.id}`);
    expect(del.status).toBe(204);
    expect(await ctx.prisma.usageEvent.count({ where: { projectId: p.id } })).toBe(0);
    expect(await ctx.prisma.budget.count({ where: { projectId: p.id } })).toBe(0);
    expect(await ctx.prisma.budgetAlert.count({ where: { budgetId: b.id } })).toBe(0);
    expect((await api(ctx).get(`/api/usage/${r.requestId}`)).status).toBe(404);
    expect((await api(ctx).get(`/api/projects/${p.id}`)).status).toBe(404);
    // non-test project cannot be deleted
    const real = await mkProject(ctx, 'real-proj', false);
    const blocked = await api(ctx).delete(`/api/projects/${real.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CONFLICT');
    expect((await api(ctx).get(`/api/projects/${real.id}`)).status).toBe(200);
  });
});
