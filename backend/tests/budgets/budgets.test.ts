import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import {
  createHarness, createRecordingInstr, makeProject, makeBudget, addUsage, type Harness, type RecordingInstr,
} from './helpers';
import { createBudgetService, periodBounds } from '../../src/modules/budgets';
import type { BudgetAlertDto, BudgetDto, BudgetUtilization, BudgetUtilizationDetail } from '../../../shared/types';
import { alertLevelFor } from '../../../shared/types';
import { toAlertDto as toLogAlertDto } from '../../src/modules/logging/mappers';

let ctx: TestCtx;
let instr: RecordingInstr;
let svc: ReturnType<typeof createBudgetService>;
let h: Harness;

// Wednesday, mid-March 2025 (month: Mar; week: Mon 10 Mar..Mon 17 Mar)
const AT = new Date('2025-03-12T10:00:00.000Z');

beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });
beforeEach(async () => {
  // isolate every test: clean tables touched here
  await ctx.prisma.budgetAlert.deleteMany();
  await ctx.prisma.budget.deleteMany();
  await ctx.prisma.usageEvent.deleteMany();
  instr = createRecordingInstr();
  h = createHarness(ctx, instr);
  svc = h.deps.budgets as ReturnType<typeof createBudgetService>;
});

const thresholds = (a: BudgetAlertDto[]) => a.map(x => x.threshold);
const dbAlerts = (budgetId?: string) => ctx.prisma.budgetAlert.findMany({ where: budgetId ? { budgetId } : {}, orderBy: { threshold: 'asc' } });

describe('alert thresholds', () => {
  it('fires exactly at 50 / 80 / 100 and not a cent before', async () => {
    const p = await makeProject(ctx.prisma);
    const b = await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '100' });

    await addUsage(ctx.prisma, p.id, '49.99', AT);
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]);
    expect(await dbAlerts()).toHaveLength(0);

    await addUsage(ctx.prisma, p.id, '0.01', AT); // 50.00
    const a50 = await svc.evaluateAfterUsage({ projectId: p.id, at: AT });
    expect(thresholds(a50)).toEqual([50]);
    expect(a50[0]).toMatchObject({
      budgetId: b.id, budgetName: 'MONTHLY budget', projectId: p.id, projectName: p.name, period: 'MONTHLY',
      spendUsd: '50.000000000000', limitUsd: '100.000000000000', percent: 50,
      periodStart: '2025-03-01T00:00:00.000Z', periodEnd: '2025-04-01T00:00:00.000Z',
    });

    await addUsage(ctx.prisma, p.id, '29.99', AT); // 79.99
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]);
    await addUsage(ctx.prisma, p.id, '0.01', AT); // 80.00
    expect(thresholds(await svc.evaluateAfterUsage({ projectId: p.id, at: AT }))).toEqual([80]);

    await addUsage(ctx.prisma, p.id, '19.99', AT); // 99.99
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]);
    await addUsage(ctx.prisma, p.id, '0.01', AT); // 100.00
    expect(thresholds(await svc.evaluateAfterUsage({ projectId: p.id, at: AT }))).toEqual([100]);

    await addUsage(ctx.prisma, p.id, '50', AT); // 150%
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]); // nothing above 100
    expect((await dbAlerts()).map(a => a.threshold)).toEqual([50, 80, 100]);
  });

  it('uses exact integer math at the boundary (sub-cent amounts)', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'DAILY', limitUsd: '0.000000000003' }); // 3 pico
    await addUsage(ctx.prisma, p.id, '0.000000000001', AT); // 33.33%
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]);
    await addUsage(ctx.prisma, p.id, '0.000000000001', AT); // 66.66%
    expect(thresholds(await svc.evaluateAfterUsage({ projectId: p.id, at: AT }))).toEqual([50]);
  });

  it('a jump from 10% to 120% creates 50, 80 and 100 together', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '100' });
    await addUsage(ctx.prisma, p.id, '10', AT);
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]);
    await addUsage(ctx.prisma, p.id, '110', AT);
    const alerts = await svc.evaluateAfterUsage({ projectId: p.id, at: AT });
    expect(thresholds(alerts)).toEqual([50, 80, 100]);
    expect(alerts.every(a => a.percent === 120 && a.spendUsd === '120.000000000000')).toBe(true);
    expect(await dbAlerts()).toHaveLength(3);
  });

  it('persists the alert row (pico + percent) and survives lookup via the API', async () => {
    const p = await makeProject(ctx.prisma);
    const b = await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '10' });
    await addUsage(ctx.prisma, p.id, '5', AT);
    await svc.evaluateAfterUsage({ projectId: p.id, at: AT });
    const row = (await dbAlerts(b.id))[0];
    expect(row.spendPico).toBe(5_000_000_000_000n);
    expect(row.limitPico).toBe(10_000_000_000_000n);
    expect(row.percent).toBe(50);
  });
});

describe('duplicate prevention', () => {
  it('sequential evaluations create each (budget, period, threshold) once', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '100' });
    await addUsage(ctx.prisma, p.id, '85', AT);
    expect(thresholds(await svc.evaluateAfterUsage({ projectId: p.id, at: AT }))).toEqual([50, 80]);
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]);
    expect(await svc.evaluateAll(AT)).toEqual([]);
    expect(await dbAlerts()).toHaveLength(2);
    expect(instr.activities).toHaveLength(2);
  });

  it('concurrent evaluations never duplicate or throw', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '100' });
    await makeBudget(ctx.prisma, { projectId: null, period: 'MONTHLY', limitUsd: '100' });
    await addUsage(ctx.prisma, p.id, '120', AT);
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => svc.evaluateAfterUsage({ projectId: p.id, at: AT })),
      ...Array.from({ length: 4 }, () => svc.evaluateAll(AT)),
    ]);
    const created = results.flat();
    expect(created).toHaveLength(6); // 3 thresholds x 2 budgets, each returned by exactly one caller
    expect(new Set(created.map(a => a.id)).size).toBe(6);
    expect(await dbAlerts()).toHaveLength(6);
    expect(instr.activities).toHaveLength(6);
  });

  it('the DB unique index is the backstop', async () => {
    const p = await makeProject(ctx.prisma);
    const b = await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '100' });
    const { start, end } = periodBounds('MONTHLY', AT);
    const data = { budgetId: b.id, threshold: 50, periodStart: start, periodEnd: end, spendPico: 1n, limitPico: 2n, percent: 50 };
    await ctx.prisma.budgetAlert.create({ data });
    await expect(ctx.prisma.budgetAlert.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    // pre-existing alert (e.g. from another process) is respected, not duplicated or thrown on
    await addUsage(ctx.prisma, p.id, '60', AT);
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]);
  });

  it('a new period allows new alerts', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'DAILY', limitUsd: '10' });
    const day1 = new Date('2025-03-12T12:00:00Z');
    const day2 = new Date('2025-03-13T12:00:00Z');
    await addUsage(ctx.prisma, p.id, '10', day1);
    expect(thresholds(await svc.evaluateAfterUsage({ projectId: p.id, at: day1 }))).toEqual([50, 80, 100]);
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: day1 })).toEqual([]);
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: day2 })).toEqual([]); // day 2 has no spend yet
    await addUsage(ctx.prisma, p.id, '6', day2);
    const d2 = await svc.evaluateAfterUsage({ projectId: p.id, at: day2 });
    expect(thresholds(d2)).toEqual([50]);
    expect(d2[0].periodStart).toBe('2025-03-13T00:00:00.000Z');
    expect(await dbAlerts()).toHaveLength(4);
  });

  it('usage exactly on a period boundary lands in the new period', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'WEEKLY', limitUsd: '10' });
    await addUsage(ctx.prisma, p.id, '9', new Date('2025-03-16T23:59:59.999Z')); // Sunday: previous week
    await addUsage(ctx.prisma, p.id, '1', new Date('2025-03-17T00:00:00.000Z')); // Monday: new week
    const monday = new Date('2025-03-17T00:00:01Z');
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: monday })).toEqual([]); // only 10% in the new week
    const sunday = new Date('2025-03-16T12:00:00Z');
    expect(thresholds(await svc.evaluateAfterUsage({ projectId: p.id, at: sunday }))).toEqual([50, 80]);
  });
});

describe('scoping', () => {
  it('project budget counts only that project; global counts all projects', async () => {
    const a = await makeProject(ctx.prisma);
    const b = await makeProject(ctx.prisma);
    const ba = await makeBudget(ctx.prisma, { projectId: a.id, period: 'MONTHLY', limitUsd: '100', name: 'A' });
    const bb = await makeBudget(ctx.prisma, { projectId: b.id, period: 'MONTHLY', limitUsd: '100', name: 'B' });
    const g = await makeBudget(ctx.prisma, { projectId: null, period: 'MONTHLY', limitUsd: '100', name: 'G' });
    await addUsage(ctx.prisma, a.id, '30', AT);
    await addUsage(ctx.prisma, b.id, '30', AT);
    const fired = await svc.evaluateAfterUsage({ projectId: a.id, at: AT });
    expect(fired.map(x => [x.budgetId, x.threshold, x.spendUsd])).toEqual([[g.id, 50, '60.000000000000']]); // A=30%, global=60%
    expect((await dbAlerts()).map(x => [x.budgetId, x.threshold])).toEqual([[g.id, 50]]);
    expect(await dbAlerts(ba.id)).toHaveLength(0);
    expect(await dbAlerts(bb.id)).toHaveLength(0);
  });

  it('evaluateAfterUsage evaluates the project\'s budgets + global, not other projects\' budgets', async () => {
    const a = await makeProject(ctx.prisma);
    const b = await makeProject(ctx.prisma);
    const ba = await makeBudget(ctx.prisma, { projectId: a.id, period: 'MONTHLY', limitUsd: '10' });
    const bb = await makeBudget(ctx.prisma, { projectId: b.id, period: 'MONTHLY', limitUsd: '10' });
    await addUsage(ctx.prisma, a.id, '10', AT);
    await addUsage(ctx.prisma, b.id, '10', AT);
    const r = await svc.evaluateAfterUsage({ projectId: a.id, at: AT });
    expect(new Set(r.map(x => x.budgetId))).toEqual(new Set([ba.id]));
    expect(await dbAlerts(bb.id)).toHaveLength(0);
    // evaluateAll covers B too
    const all = await svc.evaluateAll(AT);
    expect(new Set(all.map(x => x.budgetId))).toEqual(new Set([bb.id]));
  });

  it('daily/weekly/monthly budgets on the same project are independent', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'DAILY', limitUsd: '10' });
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'WEEKLY', limitUsd: '100' });
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '1000' });
    await addUsage(ctx.prisma, p.id, '5', AT);                                   // today
    await addUsage(ctx.prisma, p.id, '60', new Date('2025-03-10T09:00:00Z'));   // Monday same week, earlier day
    await addUsage(ctx.prisma, p.id, '600', new Date('2025-03-02T09:00:00Z'));  // earlier in month, other week
    const r = await svc.evaluateAfterUsage({ projectId: p.id, at: AT });
    const by = (period: string) => thresholds(r.filter(x => x.period === period));
    expect(by('DAILY')).toEqual([50]);            // 5/10
    expect(by('WEEKLY')).toEqual([50]);           // 65/100 (Mon + Wed)
    expect(by('MONTHLY')).toEqual([50]);          // 665/1000
  });

  it('inactive budgets are skipped', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '10', active: false });
    await makeBudget(ctx.prisma, { projectId: null, period: 'MONTHLY', limitUsd: '10', active: false });
    await addUsage(ctx.prisma, p.id, '100', AT);
    expect(await svc.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]);
    expect(await svc.evaluateAll(AT)).toEqual([]);
    expect(await dbAlerts()).toHaveLength(0);
  });

  it('budgets of archived projects are dormant', async () => {
    const p = await makeProject(ctx.prisma, undefined, { status: 'ARCHIVED' });
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '10' });
    await addUsage(ctx.prisma, p.id, '100', AT);
    expect(await svc.evaluateAll(AT)).toEqual([]);
    expect(await dbAlerts()).toHaveLength(0);
  });

  it('failed requests still count towards spend', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '10' });
    const ev = await addUsage(ctx.prisma, p.id, '6', AT);
    await ctx.prisma.usageEvent.update({ where: { id: ev.id }, data: { status: 'FAILURE' } });
    expect(thresholds(await svc.evaluateAfterUsage({ projectId: p.id, at: AT }))).toEqual([50]);
  });
});

describe('alert level escalates with the threshold', () => {
  const CASES: [number, string, string, 'INFO' | 'WARN' | 'CRITICAL'][] = [
    [50, '50', 'budget.alert', 'INFO'], [80, '80', 'budget.alert', 'WARN'], [100, '100', 'budget.alert', 'CRITICAL'],
  ];
  for (const [threshold, spend, type, level] of CASES) {
    it(`${threshold}% -> ${level}: DTO, API list, activity and de-duplication`, async () => {
      const p = await makeProject(ctx.prisma);
      const b = await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '100' });
      await addUsage(ctx.prisma, p.id, spend, AT); // crosses exactly this threshold (and none above)
      const created = await svc.evaluateAfterUsage({ projectId: p.id, at: AT });
      expect(created).toHaveLength(threshold === 100 ? 3 : threshold === 80 ? 2 : 1); // lower thresholds fire together with it
      const mine = created.find(a => a.threshold === threshold)!;
      expect(mine.level).toBe(level);
      // exactly one activity of that level for this threshold; INFO/WARN/CRITICAL are never ERROR (no failure semantics)
      const act = instr.activities.filter(a => a.metadata?.threshold === threshold);
      expect(act).toHaveLength(1);
      expect(act[0]).toMatchObject({ type, level, source: 'ACTUAL' });
      expect(instr.activities.every(a => a.level !== 'ERROR')).toBe(true);
      expect(instr.errors).toHaveLength(0);
      // API list exposes the same level
      const res = await request(h.app).get(`/api/budget-alerts?budgetId=${b.id}&threshold=${threshold}`).expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ threshold, level });
      // de-duplication still holds: re-evaluating creates nothing and emits nothing new
      const before = instr.activities.length;
      expect(await svc.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]);
      expect(await svc.evaluateAll(AT)).toEqual([]);
      expect(instr.activities).toHaveLength(before);
      expect(await dbAlerts(b.id)).toHaveLength(created.length);
    });
  }

  it('alertLevelFor maps every threshold (and in-between values) to the right level', () => {
    expect([50, 80, 100].map(alertLevelFor)).toEqual(['INFO', 'WARN', 'CRITICAL']);
    expect([0, 49, 79, 99].map(alertLevelFor)).toEqual(['INFO', 'INFO', 'INFO', 'WARN']);
    expect(alertLevelFor(150)).toBe('CRITICAL');
  });

  it('the export mapper (logging/mappers) derives the same level from the stored threshold', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '100' });
    await addUsage(ctx.prisma, p.id, '100', AT);
    await svc.evaluateAfterUsage({ projectId: p.id, at: AT });
    const rows = await ctx.prisma.budgetAlert.findMany({ include: { budget: { include: { project: { select: { name: true } } } } } });
    expect(rows.map(r => toLogAlertDto(r).level).sort()).toEqual(['CRITICAL', 'INFO', 'WARN']);
    expect(Object.keys(toLogAlertDto(rows[0]))).toContain('level');
  });
});

describe('instrumentation', () => {
  it('emits exactly one activity and one bus publish per new alert, source ACTUAL, level escalating 50% INFO / 80% WARN / 100% CRITICAL, and no ERROR/FAILURE log', async () => {
    const p = await makeProject(ctx.prisma);
    const b = await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '100' });
    await addUsage(ctx.prisma, p.id, '110', AT);
    const alerts = await svc.evaluateAfterUsage({ projectId: p.id, at: AT, traceId: 'trace-1', spanId: 'span-1' });
    expect(alerts).toHaveLength(3);
    expect(instr.activities.map(a => [a.type, a.level, a.source])).toEqual([
      ['budget.alert', 'INFO', 'ACTUAL'], ['budget.alert', 'WARN', 'ACTUAL'], ['budget.alert', 'CRITICAL', 'ACTUAL'],
    ]);
    expect(instr.activities.map(a => a.metadata?.level)).toEqual(['INFO', 'WARN', 'CRITICAL']);
    const a100 = instr.activities[2];
    expect(a100).toMatchObject({ traceId: 'trace-1', projectId: p.id });
    expect(a100.metadata).toMatchObject({ threshold: 100, percent: 110, budgetId: b.id });
    expect(instr.bus).toHaveLength(3);
    expect(instr.bus[0]).toMatchObject({
      source: 'ACTUAL', operationName: 'budget.alert.publish', operationType: 'PUBLISH', eventName: 'budget.threshold.crossed',
      success: true, traceId: 'trace-1', projectId: p.id,
    });
    expect(instr.logs).toHaveLength(0); // activity/bus already mirror into ExecutionLog
    expect(instr.errors).toHaveLength(0);
  });

  it('records an error only when alert creation itself throws', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '10' });
    await addUsage(ctx.prisma, p.id, '10', AT);
    const failing = {
      ...ctx.prisma,
      usageEvent: ctx.prisma.usageEvent, budget: ctx.prisma.budget,
      budgetAlert: { ...ctx.prisma.budgetAlert, findMany: ctx.prisma.budgetAlert.findMany.bind(ctx.prisma.budgetAlert), create: async () => { throw Object.assign(new Error('disk full'), { code: 'X1' }); } },
    } as unknown as typeof ctx.prisma;
    const s = createBudgetService(failing, instr);
    await expect(s.evaluateAfterUsage({ projectId: p.id, at: AT })).rejects.toThrow('disk full');
    expect(instr.errors).toHaveLength(1);
    expect(instr.errors[0]).toMatchObject({ category: 'DATABASE', operation: 'budget.alert.create', source: 'ACTUAL' });
    expect(instr.activities).toHaveLength(0);
  });

  it('a global budget alert is correlated with the triggering project', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: null, period: 'MONTHLY', limitUsd: '10' });
    await addUsage(ctx.prisma, p.id, '6', AT);
    await svc.evaluateAfterUsage({ projectId: p.id, at: AT });
    expect(instr.activities[0].projectId).toBe(p.id);
  });

  it('instrumentation failures never break alert creation', async () => {
    const boom = createRecordingInstr({
      recordActivity: async () => { throw new Error('x'); }, recordBus: async () => { throw new Error('x'); }, log: async () => { throw new Error('x'); },
    });
    const s = createBudgetService(ctx.prisma, boom);
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '10' });
    await addUsage(ctx.prisma, p.id, '10', AT);
    expect(thresholds(await s.evaluateAfterUsage({ projectId: p.id, at: AT }))).toEqual([50, 80, 100]);
  });
});

describe('persistence across restart', () => {
  it('alerts survive a restart and are not re-created', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '10' });
    await addUsage(ctx.prisma, p.id, '9', AT);
    expect(thresholds(await svc.evaluateAfterUsage({ projectId: p.id, at: AT }))).toEqual([50, 80]);

    const ctx2 = await ctx.restart();
    try {
      const h2 = createHarness(ctx2);
      expect(await h2.deps.budgets.evaluateAfterUsage({ projectId: p.id, at: AT })).toEqual([]);
      const list = await request(h2.app).get('/api/budget-alerts');
      expect(list.status).toBe(200);
      expect(list.body.data.map((a: BudgetAlertDto) => a.threshold).sort()).toEqual([50, 80]);
      await addUsage(ctx2.prisma, p.id, '1', AT);
      expect(thresholds(await h2.deps.budgets.evaluateAfterUsage({ projectId: p.id, at: AT }))).toEqual([100]);
    } finally {
      await ctx2.close();
      ctx = await createTestApp({ dir: ctx.dir }); // re-open for subsequent tests (old client was disconnected by restart())
    }
  });
});

describe('REST: CRUD', () => {
  const post = (b: Record<string, unknown>) => request(h.app).post('/api/budgets').send(b);

  it('creates, lists, patches and deletes', async () => {
    const p = await makeProject(ctx.prisma);
    const c = await post({ projectId: p.id, name: 'Proj monthly', period: 'MONTHLY', limitUsd: '25.5' });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ projectId: p.id, projectName: p.name, name: 'Proj monthly', period: 'MONTHLY', limitUsd: '25.500000000000', active: true });
    const id = c.body.data.id;

    const g = await post({ name: 'Global daily', period: 'DAILY', limitUsd: '0.000000000001' });
    expect(g.status).toBe(201);
    expect(g.body.data).toMatchObject({ projectId: null, projectName: null, limitUsd: '0.000000000001' });

    const list = await request(h.app).get('/api/budgets');
    expect(list.body.data).toHaveLength(2);
    const filtered = await request(h.app).get(`/api/budgets?projectId=${p.id}`);
    expect(filtered.body.data.map((b: BudgetDto) => b.id)).toEqual([id]);
    expect((await request(h.app).get('/api/budgets?projectId=')).body.data).toHaveLength(2);

    const patch = await request(h.app).patch(`/api/budgets/${id}`).send({ name: 'Renamed', limitUsd: '30', active: false });
    expect(patch.status).toBe(200);
    expect(patch.body.data).toMatchObject({ name: 'Renamed', limitUsd: '30.000000000000', active: false, period: 'MONTHLY' });

    expect((await request(h.app).delete(`/api/budgets/${id}`)).status).toBe(204);
    expect((await request(h.app).delete(`/api/budgets/${id}`)).status).toBe(404);
    expect((await request(h.app).patch(`/api/budgets/${id}`).send({ name: 'x' })).status).toBe(404);
    expect((await request(h.app).get('/api/budgets')).body.data).toHaveLength(1);
  });

  it('enforces uniqueness per (project|global, period) with 409', async () => {
    const p1 = await makeProject(ctx.prisma);
    const p2 = await makeProject(ctx.prisma);
    expect((await post({ projectId: p1.id, name: 'a', period: 'DAILY', limitUsd: '1' })).status).toBe(201);
    const dup = await post({ projectId: p1.id, name: 'b', period: 'DAILY', limitUsd: '2' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    expect((await post({ projectId: p1.id, name: 'c', period: 'WEEKLY', limitUsd: '1' })).status).toBe(201);
    expect((await post({ projectId: p2.id, name: 'd', period: 'DAILY', limitUsd: '1' })).status).toBe(201);
    expect((await post({ name: 'g', period: 'DAILY', limitUsd: '1' })).status).toBe(201);
    const gdup = await post({ projectId: null, name: 'g2', period: 'DAILY', limitUsd: '1' });
    expect(gdup.status).toBe(409);
    // inactive budgets still occupy their slot
    const inactive = await post({ name: 'gi', period: 'MONTHLY', limitUsd: '1', active: false });
    expect(inactive.status).toBe(201);
    expect((await post({ name: 'gi2', period: 'MONTHLY', limitUsd: '1' })).status).toBe(409);
  });

  it('concurrent creates of the same slot yield exactly one 201', async () => {
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => post({ name: `n${i}`, period: 'WEEKLY', limitUsd: '5' })));
    expect(res.filter(r => r.status === 201)).toHaveLength(1);
    expect(res.filter(r => r.status === 409)).toHaveLength(4);
    expect(await ctx.prisma.budget.count()).toBe(1);
  });

  it.each([
    ['zero limit', { limitUsd: '0' }],
    ['zero with decimals', { limitUsd: '0.000000000000' }],
    ['negative limit', { limitUsd: '-5' }],
    ['13 decimals', { limitUsd: '1.0000000000001' }],
    ['non-decimal', { limitUsd: '1e3' }],
    ['numeric limit', { limitUsd: 5 }],
    ['empty name', { name: '' }],
    ['overlong name', { name: 'x'.repeat(81) }],
    ['bad period', { period: 'YEARLY' }],
  ])('rejects %s', async (_n, patch) => {
    const r = await post({ name: 'n', period: 'DAILY', limitUsd: '1', ...patch });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('404 for an unknown project; empty PATCH is a 400', async () => {
    expect((await post({ projectId: 'does-not-exist', name: 'n', period: 'DAILY', limitUsd: '1' })).status).toBe(404);
    const b = await makeBudget(ctx.prisma, { period: 'DAILY', limitUsd: '1' });
    expect((await request(h.app).patch(`/api/budgets/${b.id}`).send({})).status).toBe(400);
    expect((await request(h.app).patch(`/api/budgets/${b.id}`).send({ limitUsd: '0' })).status).toBe(400);
  });

  it('deleting a budget cascades its alerts', async () => {
    const p = await makeProject(ctx.prisma);
    const b = await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '10' });
    await addUsage(ctx.prisma, p.id, '10', AT);
    await svc.evaluateAll(AT);
    expect(await dbAlerts(b.id)).toHaveLength(3);
    expect((await request(h.app).delete(`/api/budgets/${b.id}`)).status).toBe(204);
    expect(await dbAlerts()).toHaveLength(0);
  });
});

describe('REST: utilization, evaluate, alerts', () => {
  it('/budgets/utilization and /budgets/evaluate are not shadowed by /budgets/:id', async () => {
    const u = await request(h.app).get('/api/budgets/utilization');
    expect(u.status).toBe(200);
    expect(Array.isArray(u.body.data)).toBe(true);
    const e = await request(h.app).post('/api/budgets/evaluate');
    expect(e.status).toBe(200);
    expect(e.body.data).toEqual([]);
  });

  it('GET /budgets/utilization reports the current period spend, percent and highest threshold', async () => {
    const p = await makeProject(ctx.prisma);
    const q = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '100' });
    await makeBudget(ctx.prisma, { projectId: q.id, period: 'MONTHLY', limitUsd: '100' });
    const now = new Date();
    await addUsage(ctx.prisma, p.id, '82.5', now);
    await addUsage(ctx.prisma, q.id, '1', now);
    const all = await request(h.app).get('/api/budgets/utilization');
    expect(all.body.data).toHaveLength(2);
    const one = await request(h.app).get(`/api/budgets/utilization?projectId=${p.id}`);
    const [u]: BudgetUtilization[] = one.body.data;
    expect(one.body.data).toHaveLength(1);
    expect(u).toMatchObject({ spendUsd: '82.500000000000', limitUsd: '100.000000000000', percent: 82.5, highestThresholdReached: 80 });
    const { start, end } = periodBounds('MONTHLY', now);
    expect([u.periodStart, u.periodEnd]).toEqual([start.toISOString(), end.toISOString()]);
    expect(u.budget.projectId).toBe(p.id);
  });

  it('percent is reported with 2 dp and can exceed 100', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '3' });
    await addUsage(ctx.prisma, p.id, '1', new Date());
    await addUsage(ctx.prisma, p.id, '3.5', new Date());
    const [u]: BudgetUtilization[] = (await request(h.app).get(`/api/budgets/utilization?projectId=${p.id}`)).body.data;
    expect(u.percent).toBe(150);
    expect(u.highestThresholdReached).toBe(100);
    const q = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: q.id, period: 'MONTHLY', limitUsd: '3' });
    await addUsage(ctx.prisma, q.id, '1', new Date());
    const [u2]: BudgetUtilization[] = (await request(h.app).get(`/api/budgets/utilization?projectId=${q.id}`)).body.data;
    expect(u2.percent).toBe(33.33);
    expect(u2.highestThresholdReached).toBeNull();
  });

  it('GET /budgets/:id/utilization returns previous periods (oldest first)', async () => {
    const p = await makeProject(ctx.prisma);
    const b = await makeBudget(ctx.prisma, { projectId: p.id, period: 'DAILY', limitUsd: '10' });
    const today = periodBounds('DAILY', new Date()).start.getTime();
    const DAY = 86_400_000;
    await addUsage(ctx.prisma, p.id, '2', new Date(today));              // today
    await addUsage(ctx.prisma, p.id, '5', new Date(today - DAY / 2));    // yesterday noon
    await addUsage(ctx.prisma, p.id, '1', new Date(today - 1));          // yesterday last ms
    await addUsage(ctx.prisma, p.id, '7.5', new Date(today - 2 * DAY));  // 2 days ago 00:00 (inclusive start)
    const r = await request(h.app).get(`/api/budgets/${b.id}/utilization?periods=3`);
    expect(r.status).toBe(200);
    const d: BudgetUtilizationDetail = r.body.data;
    expect(d.spendUsd).toBe('2.000000000000');
    expect(d.percent).toBe(20);
    expect(d.history).toHaveLength(3);
    expect(d.history.map(x => x.spendUsd)).toEqual(['0.000000000000', '7.500000000000', '6.000000000000']);
    expect(d.history.map(x => x.percent)).toEqual([0, 75, 60]);
    expect(d.history[2].periodStart).toBe(new Date(today - DAY).toISOString());
    expect(d.history[2].periodEnd).toBe(new Date(today).toISOString());
    // default 6 periods; 0 allowed; invalid rejected; unknown 404
    expect((await request(h.app).get(`/api/budgets/${b.id}/utilization`)).body.data.history).toHaveLength(6);
    expect((await request(h.app).get(`/api/budgets/${b.id}/utilization?periods=0`)).body.data.history).toHaveLength(0);
    expect((await request(h.app).get(`/api/budgets/${b.id}/utilization?periods=-1`)).status).toBe(400);
    expect((await request(h.app).get('/api/budgets/nope/utilization')).status).toBe(404);
  });

  it('monthly history crosses month and year boundaries correctly', async () => {
    const p = await makeProject(ctx.prisma);
    const b = await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '100' });
    const cur = periodBounds('MONTHLY', new Date()).start;
    const prev = (n: number) => new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - n, 15));
    await addUsage(ctx.prisma, p.id, '10', prev(1));
    await addUsage(ctx.prisma, p.id, '20', prev(2));
    await addUsage(ctx.prisma, p.id, '30', prev(15));
    const d: BudgetUtilizationDetail = (await request(h.app).get(`/api/budgets/${b.id}/utilization?periods=15`)).body.data;
    expect(d.history).toHaveLength(15);
    expect(d.history[14].spendUsd).toBe('10.000000000000');
    expect(d.history[13].spendUsd).toBe('20.000000000000');
    expect(d.history[0].spendUsd).toBe('30.000000000000'); // 15 months back
    const starts = d.history.map(x => x.periodStart);
    expect(new Set(starts).size).toBe(15);
    expect(starts).toEqual([...starts].sort());
  });

  it('POST /budgets/evaluate records a BUDGET_EVALUATION task and returns only new alerts', async () => {
    const p = await makeProject(ctx.prisma);
    await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '10' });
    await addUsage(ctx.prisma, p.id, '9', new Date());
    const r1 = await request(h.app).post('/api/budgets/evaluate');
    expect(r1.status).toBe(200);
    expect(thresholds(r1.body.data)).toEqual([50, 80]);
    const r2 = await request(h.app).post('/api/budgets/evaluate');
    expect(r2.body.data).toEqual([]);
    expect(instr.tasks).toHaveLength(2);
    expect(instr.tasks[0]).toMatchObject({ kind: 'BUDGET_EVALUATION', source: 'ACTUAL' });
    expect(instr.tasks[0].succeeded).toMatchObject({ alertsCreated: 2, budgetsEvaluated: 1 });
    expect(instr.tasks[1].succeeded).toMatchObject({ alertsCreated: 0 });
  });

  it('POST /budgets/evaluate marks the task failed when evaluation throws', async () => {
    const failing = createRecordingInstr();
    const hh = createHarness(ctx, failing);
    hh.deps.budgets.evaluateAll = async () => { throw new Error('kaput'); };
    const r = await request(hh.app).post('/api/budgets/evaluate');
    expect(r.status).toBe(500);
    expect(failing.tasks[0].failed).toBeTruthy();
  });

  it('GET /budget-alerts filters and paginates (newest first)', async () => {
    const p = await makeProject(ctx.prisma);
    const q = await makeProject(ctx.prisma);
    const bp = await makeBudget(ctx.prisma, { projectId: p.id, period: 'MONTHLY', limitUsd: '10' });
    const bq = await makeBudget(ctx.prisma, { projectId: q.id, period: 'MONTHLY', limitUsd: '10' });
    await addUsage(ctx.prisma, p.id, '10', AT);
    await addUsage(ctx.prisma, q.id, '5', AT);
    await svc.evaluateAll(AT);
    const all = await request(h.app).get('/api/budget-alerts');
    expect(all.status).toBe(200);
    expect(all.body.pagination).toEqual({ page: 1, pageSize: 25, total: 4, totalPages: 1 });
    const times = all.body.data.map((a: BudgetAlertDto) => a.createdAt);
    expect(times).toEqual([...times].sort().reverse());

    const byBudget = await request(h.app).get(`/api/budget-alerts?budgetId=${bq.id}`);
    expect(thresholds(byBudget.body.data)).toEqual([50]);
    const byProject = await request(h.app).get(`/api/budget-alerts?projectId=${p.id}`);
    expect(byProject.body.pagination.total).toBe(3);
    expect(byProject.body.data.every((a: BudgetAlertDto) => a.budgetId === bp.id && a.projectName === p.name)).toBe(true);
    const byThreshold = await request(h.app).get('/api/budget-alerts?threshold=50');
    expect(byThreshold.body.pagination.total).toBe(2);
    expect((await request(h.app).get('/api/budget-alerts?threshold=75')).status).toBe(400);

    const page1 = await request(h.app).get('/api/budget-alerts?pageSize=3&page=1');
    const page2 = await request(h.app).get('/api/budget-alerts?pageSize=3&page=2');
    expect(page1.body.data).toHaveLength(3);
    expect(page2.body.data).toHaveLength(1);
    expect(page1.body.pagination).toEqual({ page: 1, pageSize: 3, total: 4, totalPages: 2 });
    const ids = [...page1.body.data, ...page2.body.data].map((a: BudgetAlertDto) => a.id);
    expect(new Set(ids).size).toBe(4);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await request(h.app).get(`/api/budget-alerts?from=${encodeURIComponent(future)}`)).body.pagination.total).toBe(0);
    expect((await request(h.app).get(`/api/budget-alerts?to=${encodeURIComponent(future)}`)).body.pagination.total).toBe(4);
    const today = new Date().toISOString().slice(0, 10);
    expect((await request(h.app).get(`/api/budget-alerts?from=${today}&to=${today}`)).body.pagination.total).toBe(4); // date-only `to` is inclusive
    expect((await request(h.app).get('/api/budget-alerts?pageSize=500')).status).toBe(400);
  });
});
