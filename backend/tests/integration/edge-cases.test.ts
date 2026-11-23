import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDir, createTestApp } from '../helpers/testApp';
import { api, Ctx, expectedPico, listAll, mkProject, pay, picoToUsd, usdToPico } from './helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

describe('budget periods (UTC) with backdated usage', () => {
  it('MONTHLY / WEEKLY / DAILY spend equals the oracle sum over usage rows inside the UTC period', async () => {
    const p = await mkProject(ctx, 'period-proj');
    const seed = await api(ctx).post('/api/simulations/seed').send({ projectId: p.id, requests: 120, spreadDays: 70, includeFailures: true });
    expect(seed.status, JSON.stringify(seed.body)).toBeLessThan(300);
    await pay(ctx, { projectId: p.id, prompt: 'now' });
    const rows = await listAll<any>(ctx, `/api/usage?projectId=${p.id}`);
    expect(rows.length).toBe(121);

    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const dow = (dayStart.getUTCDay() + 6) % 7; // Monday = 0
    const weekStart = new Date(dayStart.getTime() - dow * 86_400_000);
    const spendSince = (d: Date) => rows.filter(r => Date.parse(r.createdAt) >= d.getTime()).reduce((s, r) => s + usdToPico(r.costUsd), 0n);

    for (const [period, start] of [['MONTHLY', monthStart], ['WEEKLY', weekStart], ['DAILY', dayStart]] as const) {
      const b = await api(ctx).post('/api/budgets').send({ projectId: p.id, name: period, period, limitUsd: '1000.000000000000' });
      expect(b.status).toBe(201);
      const u = (await api(ctx).get(`/api/budgets/${b.body.data.id}/utilization?periods=3`)).body.data;
      expect(u.periodStart).toBe(start.toISOString());
      expect(usdToPico(u.spendUsd), period).toBe(spendSince(start));
      expect(u.history.length).toBeGreaterThanOrEqual(1);
    }
    // spend in older periods is NOT counted in the current month
    expect(spendSince(monthStart) < rows.reduce((s, r) => s + usdToPico(r.costUsd), 0n)).toBe(true);
  });

  it('dashboard `days` validation and range', async () => {
    for (const bad of ['0', '-1', 'abc', '100000']) {
      const r = await api(ctx).get(`/api/dashboard?days=${bad}`);
      expect(r.status, `days=${bad}`).toBeLessThan(500);
    }
    const d1 = (await api(ctx).get('/api/dashboard?days=1')).body.data;
    expect(d1.dailySpend.length).toBe(1);
    const d90 = (await api(ctx).get('/api/dashboard?days=90')).body.data;
    expect(d90.dailySpend.length).toBe(90);
  });
});

describe('uniqueness races', () => {
  it('concurrent creation of the same project name (case-insensitive) yields exactly one project', async () => {
    const names = ['Race-Proj', 'race-proj', 'RACE-PROJ', 'Race-Proj', 'race-PROJ', 'Race-Proj', 'rAcE-pRoJ', 'RACE-proj'];
    const rs = await Promise.all(names.map(n => api(ctx).post('/api/projects').send({ name: n })));
    const codes = rs.map(r => r.status).sort();
    expect(rs.every(r => [201, 409].includes(r.status)), JSON.stringify(codes)).toBe(true);
    const created = (await listAll<any>(ctx, '/api/projects?includeTest=true')).filter(p => p.name.toLowerCase() === 'race-proj');
    expect(created.length, `concurrent same-name creates produced statuses ${codes.join(',')}`).toBe(1);
  });

  it('concurrent creation of the same budget scope+period yields exactly one budget', async () => {
    const p = await mkProject(ctx, 'budget-race');
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => api(ctx).post('/api/budgets').send({ projectId: p.id, name: `b${i}`, period: 'DAILY', limitUsd: '5.00' })));
    const ok = rs.filter(r => r.status === 201).length;
    expect(rs.every(r => [201, 409].includes(r.status))).toBe(true);
    expect(ok).toBe(1);
    expect(await ctx.prisma.budget.count({ where: { projectId: p.id, period: 'DAILY' } })).toBe(1);
  });

  it('renaming onto an existing name is a 409; renaming to a different case of itself is fine; archive/unarchive are idempotent', async () => {
    const a = await mkProject(ctx, 'rename-a'); const b = await mkProject(ctx, 'rename-b');
    expect((await api(ctx).patch(`/api/projects/${b.id}`).send({ name: 'RENAME-A' })).status).toBe(409);
    expect((await api(ctx).patch(`/api/projects/${a.id}`).send({ name: 'Rename-A' })).status).toBe(200);
    expect((await api(ctx).post(`/api/projects/${a.id}/archive`)).status).toBe(200);
    expect((await api(ctx).post(`/api/projects/${a.id}/archive`)).status).toBeLessThan(500);
    expect((await api(ctx).post(`/api/projects/${a.id}/unarchive`)).status).toBe(200);
    expect((await api(ctx).post(`/api/projects/${a.id}/unarchive`)).status).toBeLessThan(500);
    expect((await api(ctx).get(`/api/projects/${a.id}`)).body.data.status).toBe('ACTIVE');
  });
});

describe('pricing edge cases', () => {
  it('a pricing version effective in the FUTURE does not apply to requests made now', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const p = await mkProject(ctx, 'future-price');
    const before = await pay(ctx, { projectId: p.id, provider: 'openai', model: 'gpt-4.1', prompt: 'future price' });
    const created = await api(ctx).post('/api/cost/pricing').send({ provider: 'openai', model: 'gpt-4.1', inputPerMTok: '99.000000', outputPerMTok: '99.000000', cachedPerMTok: '99.000000', effectiveFrom: future });
    expect(created.status).toBe(201);
    const after = await pay(ctx, { projectId: p.id, provider: 'openai', model: 'gpt-4.1', prompt: 'future price' });
    expect(after.cost.pricingVersion).toBe(before.cost.pricingVersion);
    expect(after.cost.totalCostUsd).toBe(before.cost.totalCostUsd);
    expect(after.cost.totalCostUsd).toBe(picoToUsd(expectedPico('openai/gpt-4.1', after.usage).total));
    const pricing = (await api(ctx).get('/api/cost/pricing?provider=openai&model=gpt-4.1')).body.data;
    expect(pricing.filter((x: any) => x.isCurrent)).toHaveLength(1);
    expect(pricing.find((x: any) => x.isCurrent).version).toBe(before.cost.pricingVersion);
  });

  it('/cost/calculate: unknown model => ESTIMATED; zero tokens => zero cost; huge tokens stay exact (BigInt)', async () => {
    const u = await api(ctx).post('/api/cost/calculate').send({ provider: 'openai', model: 'nope', inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(u.body.data.costClass).toBe('ESTIMATED');
    expect(u.body.data.totalCostUsd).toBe('20.000000000000'); // 5 + 15 per MTok
    const z = await api(ctx).post('/api/cost/calculate').send({ provider: 'openai', model: 'gpt-4o', inputTokens: 0, outputTokens: 0 });
    expect(z.body.data.totalCostUsd).toBe('0.000000000000');
    const huge = await api(ctx).post('/api/cost/calculate').send({ provider: 'anthropic', model: 'claude-opus', inputTokens: 2_000_000_000, outputTokens: 1_999_999_999, cachedTokens: 7 });
    expect(huge.status).toBe(200);
    const exp = 2_000_000_000n * 15_000_000n + 1_999_999_999n * 75_000_000n + 7n * 1_500_000n;
    expect(huge.body.data.totalCostUsd).toBe(picoToUsd(exp));
  });
});
