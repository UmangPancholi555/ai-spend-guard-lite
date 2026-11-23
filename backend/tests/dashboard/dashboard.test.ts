import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { cleanupTestDir } from '../helpers/testApp';
import { createCoreCtx, insertUsage, insertProject, type CoreCtx } from '../core/coreHelpers';
import { periodBounds, highestThreshold } from '../../src/modules/dashboard/budgetUtil';

const NOW = new Date('2025-06-15T10:00:00.000Z'); // Sunday; ISO week starts Mon 2025-06-09
afterEach(() => { vi.useRealTimers(); });
const freeze = (d: Date = NOW) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(d); };

describe('budgetUtil period math (pure)', () => {
  it('DAILY / WEEKLY (ISO Monday) / MONTHLY bounds in UTC with exclusive end', () => {
    const d = periodBounds('DAILY', new Date('2025-06-15T23:59:59.999Z'));
    expect([d.start.toISOString(), d.end.toISOString()]).toEqual(['2025-06-15T00:00:00.000Z', '2025-06-16T00:00:00.000Z']);
    const sun = periodBounds('WEEKLY', new Date('2025-06-15T10:00:00Z'));
    expect([sun.start.toISOString(), sun.end.toISOString()]).toEqual(['2025-06-09T00:00:00.000Z', '2025-06-16T00:00:00.000Z']);
    const mon = periodBounds('WEEKLY', new Date('2025-06-16T00:00:00Z'));
    expect(mon.start.toISOString()).toBe('2025-06-16T00:00:00.000Z');
    const wed = periodBounds('WEEKLY', new Date('2025-01-01T05:00:00Z')); // week crossing year boundary
    expect(wed.start.toISOString()).toBe('2024-12-30T00:00:00.000Z');
    const m = periodBounds('MONTHLY', new Date('2025-12-31T23:00:00Z'));
    expect([m.start.toISOString(), m.end.toISOString()]).toEqual(['2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });
  it('highestThreshold uses exact integer comparison', () => {
    expect(highestThreshold(499n, 1000n)).toBeNull();
    expect(highestThreshold(500n, 1000n)).toBe(50);
    expect(highestThreshold(799n, 1000n)).toBe(50);
    expect(highestThreshold(800n, 1000n)).toBe(80);
    expect(highestThreshold(1000n, 1000n)).toBe(100);
    expect(highestThreshold(5000n, 1000n)).toBe(100);
    expect(highestThreshold(1n, 0n)).toBeNull();
  });
});

describe('dashboard: empty database', () => {
  let ctx: CoreCtx;
  beforeAll(async () => { ctx = await createCoreCtx(); });
  afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

  it('returns zeros, a zero-filled range and empty lists', async () => {
    freeze();
    const res = await request(ctx.api).get('/api/dashboard');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.simulated).toBe(true);
    expect(d.label).toBe('DEMO / SIMULATED');
    expect(d.range).toEqual({ from: '2025-05-17T00:00:00.000Z', to: NOW.toISOString(), days: 30 });
    expect(d.totals).toEqual({ spendUsd: '0.000000000000', requests: 0, successes: 0, failures: 0, successRate: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    expect(d.providerBreakdown).toEqual([]);
    expect(d.modelBreakdown).toEqual([]);
    expect(d.dailySpend).toHaveLength(30);
    expect(d.dailySpend[0]).toEqual({ date: '2025-05-17', costUsd: '0.000000000000', requests: 0, failures: 0 });
    expect(d.dailySpend[29].date).toBe('2025-06-15');
    expect(d.dailySpend.every((p: { costUsd: string; requests: number }) => p.costUsd === '0.000000000000' && p.requests === 0)).toBe(true);
    expect(d.budgetUtilization).toEqual([]);
    expect(d.recentActivity).toEqual([]);
    expect(d.recentErrors).toEqual([]);
    expect(d.recentAlerts).toEqual([]);
  });

  it('validates days (1..365) and projectId', async () => {
    for (const q of ['days=0', 'days=366', 'days=abc', 'days=1.5', 'days=-3']) {
      const r = await request(ctx.api).get(`/api/dashboard?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await request(ctx.api).get('/api/dashboard?projectId=nope')).status).toBe(404);
    const one = await request(ctx.api).get('/api/dashboard?days=1');
    expect(one.body.data.dailySpend.map((p: { date: string }) => p.date).length).toBe(1);
    const max = await request(ctx.api).get('/api/dashboard?days=365');
    expect(max.body.data.dailySpend).toHaveLength(365);
  });

  it('zero-fills across month/leap-day boundaries with unique consecutive UTC dates', async () => {
    freeze(new Date('2024-03-02T01:00:00.000Z'));
    const res = await request(ctx.api).get('/api/dashboard?days=5');
    expect(res.body.data.dailySpend.map((p: { date: string }) => p.date)).toEqual(['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02']);
  });
});

describe('dashboard: aggregations from persisted data', () => {
  let ctx: CoreCtx;
  let p1: string; let p2: string;
  beforeAll(async () => {
    ctx = await createCoreCtx();
    p1 = (await insertProject(ctx.prisma, 'Dash One')).id;
    p2 = (await insertProject(ctx.prisma, 'Dash Two')).id;
    const u = (o: Parameters<typeof insertUsage>[1]) => insertUsage(ctx.prisma, o);
    // inside 7-day window (2025-06-09 .. 2025-06-15)
    await u({ projectId: p1, provider: 'openai', model: 'gpt-4o-mini', costPico: 1_500_000_000_001n, inputTokens: 10, outputTokens: 20, cachedTokens: 1, createdAt: new Date('2025-06-15T09:00:00.000Z') });
    await u({ projectId: p1, provider: 'anthropic', model: 'claude-sonnet', costPico: 2_000_000_000_000n, inputTokens: 5, outputTokens: 0, cachedTokens: 0, status: 'FAILURE', errorCode: 'PROVIDER_ERROR', errorMessage: 'boom', createdAt: new Date('2025-06-15T00:00:00.000Z') });
    await u({ projectId: p2, provider: 'openai', model: 'gpt-4o-mini', costPico: 3n, inputTokens: 100, outputTokens: 50, cachedTokens: 10, createdAt: new Date('2025-06-14T23:59:59.999Z') });
    await u({ projectId: p2, provider: 'openai', model: 'gpt-4o', costPico: 7_000_000_000_007n, inputTokens: 7, outputTokens: 8, cachedTokens: 2, createdAt: new Date('2025-06-12T12:00:00.000Z') });
    // outside 7 days, inside 30
    await u({ projectId: p1, provider: 'openai', model: 'gpt-4o-mini', costPico: 100n, inputTokens: 1, outputTokens: 1, cachedTokens: 0, createdAt: new Date('2025-06-08T23:59:59.999Z') });
    // outside 30 days (range starts 2025-05-17)
    await u({ projectId: p1, provider: 'openai', model: 'gpt-4o', costPico: 999_999_999_999n, createdAt: new Date('2025-05-16T23:59:59.999Z') });
    // future day (beyond today) must be ignored
    await u({ projectId: p1, provider: 'openai', model: 'gpt-4o', costPico: 888n, createdAt: new Date('2025-06-16T00:00:00.000Z') });
  });
  afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

  const dash = async (q = '') => { freeze(); const r = await request(ctx.api).get(`/api/dashboard${q}`); vi.useRealTimers(); return r; };

  it('computes exact totals for a 7-day range (boundaries inclusive of start-of-day, exclusive of tomorrow)', async () => {
    const res = await dash('?days=7');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.range).toEqual({ from: '2025-06-09T00:00:00.000Z', to: NOW.toISOString(), days: 7 });
    expect(d.totals).toEqual({
      spendUsd: '10.500000000011', requests: 4, successes: 3, failures: 1, successRate: 0.75,
      inputTokens: 122, outputTokens: 78, cachedTokens: 13,
    });
  });

  it('breaks down by provider and model, ordered by cost desc, with exact pico sums', async () => {
    const d = (await dash('?days=7')).body.data;
    expect(d.providerBreakdown).toEqual([
      { provider: 'openai', requests: 3, costUsd: '8.500000000011', inputTokens: 117, outputTokens: 78, cachedTokens: 13 },
      { provider: 'anthropic', requests: 1, costUsd: '2.000000000000', inputTokens: 5, outputTokens: 0, cachedTokens: 0 },
    ]);
    expect(d.modelBreakdown).toEqual([
      { provider: 'openai', model: 'gpt-4o', requests: 1, costUsd: '7.000000000007', inputTokens: 7, outputTokens: 8, cachedTokens: 2 },
      { provider: 'anthropic', model: 'claude-sonnet', requests: 1, costUsd: '2.000000000000', inputTokens: 5, outputTokens: 0, cachedTokens: 0 },
      { provider: 'openai', model: 'gpt-4o-mini', requests: 2, costUsd: '1.500000000004', inputTokens: 110, outputTokens: 70, cachedTokens: 11 },
    ]);
  });

  it('buckets daily spend per UTC day, zero-filled, summing exactly to the total', async () => {
    const d = (await dash('?days=7')).body.data;
    expect(d.dailySpend).toEqual([
      { date: '2025-06-09', costUsd: '0.000000000000', requests: 0, failures: 0 },
      { date: '2025-06-10', costUsd: '0.000000000000', requests: 0, failures: 0 },
      { date: '2025-06-11', costUsd: '0.000000000000', requests: 0, failures: 0 },
      { date: '2025-06-12', costUsd: '7.000000000007', requests: 1, failures: 0 },
      { date: '2025-06-13', costUsd: '0.000000000000', requests: 0, failures: 0 },
      { date: '2025-06-14', costUsd: '0.000000000003', requests: 1, failures: 0 },
      { date: '2025-06-15', costUsd: '3.500000000001', requests: 2, failures: 1 },
    ]);
  });

  it('a 30-day range additionally includes the earlier event and excludes older/future ones', async () => {
    const d = (await dash('?days=30')).body.data;
    expect(d.totals.requests).toBe(5);
    expect(d.totals.spendUsd).toBe('10.500000000111');
    expect(d.dailySpend).toHaveLength(30);
    expect(d.dailySpend.find((p: { date: string }) => p.date === '2025-06-08')).toMatchObject({ costUsd: '0.000000000100', requests: 1 });
    expect(d.dailySpend.find((p: { date: string }) => p.date === '2025-05-16')).toBeUndefined();
    expect(d.dailySpend.find((p: { date: string }) => p.date === '2025-06-16')).toBeUndefined();
    // default days = 30
    expect((await dash()).body.data.range.days).toBe(30);
  });

  it('filters everything by projectId (archived projects stay included)', async () => {
    await ctx.prisma.project.update({ where: { id: p2 }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    const d = (await dash(`?days=7&projectId=${p2}`)).body.data;
    expect(d.totals).toMatchObject({ spendUsd: '7.000000000010', requests: 2, successes: 2, failures: 0, successRate: 1, inputTokens: 107, outputTokens: 58, cachedTokens: 12 });
    expect(d.providerBreakdown).toHaveLength(1);
    expect(d.modelBreakdown.map((m: { model: string }) => m.model)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(d.dailySpend.filter((p: { requests: number }) => p.requests > 0).map((p: { date: string }) => p.date)).toEqual(['2025-06-12', '2025-06-14']);
    expect(d.recentErrors).toEqual([]);
    const d1 = (await dash(`?days=7&projectId=${p1}`)).body.data;
    expect(d1.totals).toMatchObject({ spendUsd: '3.500000000001', requests: 2, failures: 1, successRate: 0.5 });
    expect(d1.recentErrors).toHaveLength(1);
  });

  it('recentErrors: FAILURE usage events only, newest first, max 10, DTO shape', async () => {
    const r = await insertProject(ctx.prisma, 'Err Heavy');
    for (let i = 0; i < 12; i++) {
      await insertUsage(ctx.prisma, { projectId: r.id, status: 'FAILURE', errorCode: 'X', errorMessage: `fail ${i}`, createdAt: new Date(Date.UTC(2025, 5, 1, 0, i)), requestId: `req_err_${i}` });
    }
    await insertUsage(ctx.prisma, { projectId: r.id, status: 'SUCCESS', requestId: 'req_ok_x', createdAt: new Date('2025-06-02T00:00:00Z') });
    const d = (await dash('?days=30')).body.data;
    // global: also contains the p1 failure from 2025-06-15 first
    expect(d.recentErrors).toHaveLength(10);
    expect(d.recentErrors[0]).toMatchObject({ errorMessage: 'boom', status: 'FAILURE', projectName: 'Dash One', simulated: true, label: 'DEMO / SIMULATED' });
    expect(d.recentErrors.slice(1).map((e: { requestId: string }) => e.requestId)).toEqual(
      Array.from({ length: 9 }, (_, i) => `req_err_${11 - i}`));
    expect(d.recentErrors.every((e: { status: string }) => e.status === 'FAILURE')).toBe(true);
    const only = (await dash(`?projectId=${r.id}`)).body.data;
    expect(only.recentErrors).toHaveLength(10);
    await ctx.prisma.usageEvent.deleteMany({ where: { projectId: r.id } });
    await ctx.prisma.project.delete({ where: { id: r.id } });
  });

  it('recentActivity: last 10 activity events (all, or per project)', async () => {
    for (let i = 0; i < 12; i++) {
      await ctx.prisma.activityEvent.create({
        data: { type: 'usage.recorded', level: 'INFO', message: `act ${i}`, source: 'ACTUAL', projectId: i % 2 ? p1 : p2, metadata: JSON.stringify({ i }), createdAt: new Date(Date.UTC(2025, 5, 10, 0, i)) },
      });
    }
    const d = (await dash()).body.data;
    expect(d.recentActivity).toHaveLength(10);
    expect(d.recentActivity.map((a: { message: string }) => a.message)).toEqual(Array.from({ length: 10 }, (_, i) => `act ${11 - i}`));
    expect(d.recentActivity[0]).toMatchObject({ type: 'usage.recorded', source: 'ACTUAL', metadata: { i: 11 }, projectName: 'Dash One' });
    const only = (await dash(`?projectId=${p2}`)).body.data;
    expect(only.recentActivity).toHaveLength(6);
    expect(only.recentActivity.every((a: { projectId: string }) => a.projectId === p2)).toBe(true);
  });

  it('budgetUtilization: current period spend per budget with exact pico math; inactive budgets skipped', async () => {
    const mk = (data: { projectId?: string | null; name: string; period: string; limitPico: bigint; active?: boolean }) => ctx.prisma.budget.create({ data: { projectId: data.projectId ?? null, name: data.name, period: data.period, limitPico: data.limitPico, active: data.active ?? true } });
    const daily = await mk({ name: 'Global daily', period: 'DAILY', limitPico: 10_000_000_000_000n });
    const weekly = await mk({ projectId: p2, name: 'P2 weekly', period: 'WEEKLY', limitPico: 14_000_000_000_020n });
    const monthly = await mk({ name: 'Global monthly', period: 'MONTHLY', limitPico: 3_500_000_000_000n });
    await mk({ name: 'Off', period: 'DAILY', limitPico: 1n, active: false });

    const d = (await dash()).body.data;
    const by = Object.fromEntries(d.budgetUtilization.map((b: { budget: { id: string } }) => [b.budget.id, b]));
    expect(d.budgetUtilization).toHaveLength(3);

    expect(by[daily.id]).toMatchObject({
      periodStart: '2025-06-15T00:00:00.000Z', periodEnd: '2025-06-16T00:00:00.000Z',
      spendUsd: '3.500000000001', limitUsd: '10.000000000000', percent: 35, highestThresholdReached: null,
    });
    expect(by[daily.id].budget).toMatchObject({ name: 'Global daily', period: 'DAILY', projectId: null, projectName: null, active: true, limitUsd: '10.000000000000' });

    expect(by[weekly.id]).toMatchObject({
      periodStart: '2025-06-09T00:00:00.000Z', periodEnd: '2025-06-16T00:00:00.000Z',
      spendUsd: '7.000000000010', limitUsd: '14.000000000020', percent: 50, highestThresholdReached: 50,
    });
    expect(by[weekly.id].budget).toMatchObject({ projectId: p2, projectName: 'Dash Two' });

    // monthly global: spend = every event in the UTC month (incl. the 06-16 row: period math is calendar based, not clamped to now)
    expect(by[monthly.id]).toMatchObject({
      periodStart: '2025-06-01T00:00:00.000Z', periodEnd: '2025-07-01T00:00:00.000Z', highestThresholdReached: 100,
    });
    expect(by[monthly.id].spendUsd).toBe('10.500000000999'); // 10_500_000_000_111 + 888 (future-dated row still inside the month)
    expect(by[monthly.id].percent).toBe(300);

    // project filter -> only that project's budgets
    const f = (await dash(`?projectId=${p2}`)).body.data;
    expect(f.budgetUtilization.map((b: { budget: { id: string } }) => b.budget.id)).toEqual([weekly.id]);
    expect((await dash(`?projectId=${p1}`)).body.data.budgetUtilization).toEqual([]);
  });

  it('recentAlerts: last 10 budget alerts newest first, with budget/project info', async () => {
    const b = await ctx.prisma.budget.findFirstOrThrow({ where: { name: 'P2 weekly' } });
    const g = await ctx.prisma.budget.findFirstOrThrow({ where: { name: 'Global daily' } });
    for (let i = 0; i < 12; i++) {
      await ctx.prisma.budgetAlert.create({
        data: {
          budgetId: i % 2 ? b.id : g.id, threshold: i % 3 === 0 ? 50 : i % 3 === 1 ? 80 : 100,
          periodStart: new Date(Date.UTC(2025, 0, 1 + i)), periodEnd: new Date(Date.UTC(2025, 0, 2 + i)),
          spendPico: 5_000_000_000_001n, limitPico: 10_000_000_000_000n, percent: 50.01, createdAt: new Date(Date.UTC(2025, 5, 11, 0, i)),
        },
      });
    }
    const d = (await dash()).body.data;
    expect(d.recentAlerts).toHaveLength(10);
    expect(d.recentAlerts[0]).toMatchObject({
      budgetId: b.id, budgetName: 'P2 weekly', projectId: p2, projectName: 'Dash Two', period: 'WEEKLY', threshold: 100,
      spendUsd: '5.000000000001', limitUsd: '10.000000000000', percent: 50.01,
      periodStart: '2025-01-12T00:00:00.000Z', periodEnd: '2025-01-13T00:00:00.000Z',
    });
    expect(d.recentAlerts[1]).toMatchObject({ budgetName: 'Global daily', projectId: null, projectName: null, period: 'DAILY' });
    const times = d.recentAlerts.map((a: { createdAt: string }) => a.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    const f = (await dash(`?projectId=${p2}`)).body.data;
    expect(f.recentAlerts).toHaveLength(6);
    expect(f.recentAlerts.every((a: { projectId: string }) => a.projectId === p2)).toBe(true);
  });
});
