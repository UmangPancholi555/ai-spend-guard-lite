import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { cleanupTestDir } from '../helpers/testApp';
import { createCoreCtx, insertUsage, insertProject, type CoreCtx } from '../core/coreHelpers';

let ctx: CoreCtx;
beforeAll(async () => { ctx = await createCoreCtx(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const post = (url: string, body?: object) => request(ctx.api).post(url).send(body);

describe('projects: create / read / validation', () => {
  it('creates a project (201) with zeroed usage summary and emits project.created (ACTUAL)', async () => {
    const res = await post('/api/projects', { name: '  Alpha  ', description: 'first', isTest: true });
    expect(res.status).toBe(201);
    const p = res.body.data;
    expect(p).toMatchObject({ name: 'Alpha', description: 'first', status: 'ACTIVE', isTest: true, archivedAt: null });
    expect(p.usage).toEqual({
      requests: 0, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0,
      costUsd: '0.000000000000', lastActivityAt: null,
    });
    const call = ctx.recorded.find(c => c.type === 'project.created' && c.projectId === p.id);
    expect(call).toBeTruthy();
    expect(call!.source).toBe('ACTUAL');
    expect(call!.metadata).toMatchObject({ name: 'Alpha', isTest: true });
  });

  it('defaults isTest=false and description=null', async () => {
    const res = await post('/api/projects', { name: 'Beta' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ isTest: false, description: null });
  });

  it.each([
    ['empty name', { name: '' }],
    ['whitespace name', { name: '   ' }],
    ['missing name', {}],
    ['81 chars', { name: 'x'.repeat(81) }],
    ['non-string name', { name: 5 }],
    ['non-boolean isTest', { name: 'ok', isTest: 'yes' }],
  ])('rejects invalid input: %s (400)', async (_l, body) => {
    const res = await post('/api/projects', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts exactly 80 chars', async () => {
    const res = await post('/api/projects', { name: 'n'.repeat(80) });
    expect(res.status).toBe(201);
  });

  it('rejects duplicate names case-insensitively with 409', async () => {
    await post('/api/projects', { name: 'Dup Name' });
    const res = await post('/api/projects', { name: 'dUP nAME ' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('duplicate check includes archived projects', async () => {
    const a = (await post('/api/projects', { name: 'Archived Dup' })).body.data;
    await post(`/api/projects/${a.id}/archive`);
    expect((await post('/api/projects', { name: 'archived dup' })).status).toBe(409);
  });

  it('GET /projects/:id returns project, 404 for unknown', async () => {
    const p = (await post('/api/projects', { name: 'Gettable' })).body.data;
    const ok = await request(ctx.api).get(`/api/projects/${p.id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.id).toBe(p.id);
    const nf = await request(ctx.api).get('/api/projects/does-not-exist');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
  });
});

describe('projects: update', () => {
  it('updates name/description/isTest and emits project.updated', async () => {
    const p = (await post('/api/projects', { name: 'Upd' })).body.data;
    const res = await request(ctx.api).patch(`/api/projects/${p.id}`).send({ name: 'Upd2', description: 'd', isTest: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Upd2', description: 'd', isTest: true });
    const call = ctx.recorded.find(c => c.type === 'project.updated' && c.projectId === p.id);
    expect(call!.source).toBe('ACTUAL');
    expect(call!.metadata).toMatchObject({ changedFields: ['name', 'description', 'isTest'], previousName: 'Upd' });
  });

  it('description can be cleared with null', async () => {
    const p = (await post('/api/projects', { name: 'Clearable', description: 'x' })).body.data;
    const res = await request(ctx.api).patch(`/api/projects/${p.id}`).send({ description: null });
    expect(res.body.data.description).toBeNull();
  });

  it('allows renaming to a differently-cased version of its own name, rejects other projects names', async () => {
    const a = (await post('/api/projects', { name: 'Case Self' })).body.data;
    await post('/api/projects', { name: 'Taken Name' });
    const same = await request(ctx.api).patch(`/api/projects/${a.id}`).send({ name: 'CASE SELF' });
    expect(same.status).toBe(200);
    expect(same.body.data.name).toBe('CASE SELF');
    const clash = await request(ctx.api).patch(`/api/projects/${a.id}`).send({ name: 'taken name' });
    expect(clash.status).toBe(409);
  });

  it('validates update input and 404s unknown id', async () => {
    const p = (await post('/api/projects', { name: 'ValidateUpd' })).body.data;
    expect((await request(ctx.api).patch(`/api/projects/${p.id}`).send({ name: '' })).status).toBe(400);
    expect((await request(ctx.api).patch(`/api/projects/${p.id}`).send({ name: 'y'.repeat(81) })).status).toBe(400);
    expect((await request(ctx.api).patch('/api/projects/nope').send({ name: 'z' })).status).toBe(404);
  });

  it('is allowed on archived projects; no-op patch emits nothing', async () => {
    const p = (await post('/api/projects', { name: 'ArchUpd' })).body.data;
    await post(`/api/projects/${p.id}/archive`);
    const before = ctx.recorded.length;
    const noop = await request(ctx.api).patch(`/api/projects/${p.id}`).send({ name: 'ArchUpd' });
    expect(noop.status).toBe(200);
    expect(ctx.recorded.length).toBe(before);
    const res = await request(ctx.api).patch(`/api/projects/${p.id}`).send({ description: 'still editable' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ARCHIVED');
  });
});

describe('projects: archive / unarchive', () => {
  it('archives then unarchives, setting archivedAt, emitting events', async () => {
    const p = (await post('/api/projects', { name: 'Lifecycle' })).body.data;
    const a = await post(`/api/projects/${p.id}/archive`);
    expect(a.status).toBe(200);
    expect(a.body.data.status).toBe('ARCHIVED');
    expect(a.body.data.archivedAt).toEqual(expect.any(String));
    const u = await post(`/api/projects/${p.id}/unarchive`);
    expect(u.body.data.status).toBe('ACTIVE');
    expect(u.body.data.archivedAt).toBeNull();
    const types = ctx.recorded.filter(c => c.projectId === p.id).map(c => c.type);
    expect(types).toEqual(['project.created', 'project.archived', 'project.unarchived']);
  });

  it('is idempotent and emits no duplicate events', async () => {
    const p = (await post('/api/projects', { name: 'Idem' })).body.data;
    await post(`/api/projects/${p.id}/archive`);
    const again = await post(`/api/projects/${p.id}/archive`);
    expect(again.status).toBe(200);
    expect(ctx.recorded.filter(c => c.projectId === p.id && c.type === 'project.archived')).toHaveLength(1);
  });

  it('404 for unknown project', async () => {
    expect((await post('/api/projects/nope/archive')).status).toBe(404);
    expect((await post('/api/projects/nope/unarchive')).status).toBe(404);
  });
});

describe('projects: list', () => {
  let ids: Record<string, string>;
  beforeAll(async () => {
    const mk = async (name: string, o: { isTest?: boolean; archived?: boolean } = {}) => {
      const p = (await post('/api/projects', { name, isTest: o.isTest })).body.data;
      if (o.archived) await post(`/api/projects/${p.id}/archive`);
      return p.id as string;
    };
    ids = {
      a: await mk('ListZed Active'),
      b: await mk('ListZed Test', { isTest: true }),
      c: await mk('ListZed Archived', { archived: true }),
      d: await mk('ListOther Active'),
    };
  });

  it('filters by status, includeTest and search; pagination envelope', async () => {
    const all = await request(ctx.api).get('/api/projects?search=ListZed');
    expect(all.body.data.map((p: { id: string }) => p.id).sort()).toEqual([ids.a, ids.b, ids.c].sort());
    expect(all.body.pagination).toMatchObject({ page: 1, pageSize: 25, total: 3, totalPages: 1 });

    const active = await request(ctx.api).get('/api/projects?search=listzed&status=ACTIVE'); // case-insensitive search
    expect(active.body.data.map((p: { id: string }) => p.id).sort()).toEqual([ids.a, ids.b].sort());

    const archived = await request(ctx.api).get('/api/projects?search=ListZed&status=ARCHIVED');
    expect(archived.body.data.map((p: { id: string }) => p.id)).toEqual([ids.c]);

    const noTest = await request(ctx.api).get('/api/projects?search=ListZed&includeTest=false');
    expect(noTest.body.data.map((p: { id: string }) => p.id).sort()).toEqual([ids.a, ids.c].sort());
    expect(noTest.body.data.every((p: { isTest: boolean }) => !p.isTest)).toBe(true);

    const explicitTrue = await request(ctx.api).get('/api/projects?search=ListZed&includeTest=true');
    expect(explicitTrue.body.pagination.total).toBe(3);
  });

  it('search treats % and _ literally', async () => {
    await post('/api/projects', { name: 'Wild 50%_off' });
    await post('/api/projects', { name: 'Wild 50xyoff' });
    const lit = await request(ctx.api).get('/api/projects?search=' + encodeURIComponent('50%_off'));
    expect(lit.body.data.map((p: { name: string }) => p.name)).toEqual(['Wild 50%_off']);
    const wild = await request(ctx.api).get('/api/projects?search=Wild');
    expect(wild.body.pagination.total).toBe(2);
  });

  it('paginates (newest first) and validates query', async () => {
    const p1 = await request(ctx.api).get('/api/projects?search=ListZed&pageSize=2&page=1');
    const p2 = await request(ctx.api).get('/api/projects?search=ListZed&pageSize=2&page=2');
    expect(p1.body.data).toHaveLength(2);
    expect(p2.body.data).toHaveLength(1);
    expect(p1.body.pagination).toMatchObject({ total: 3, totalPages: 2 });
    const stamps = [...p1.body.data, ...p2.body.data].map((p: { createdAt: string }) => p.createdAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    expect((await request(ctx.api).get('/api/projects?status=NOPE')).status).toBe(400);
    expect((await request(ctx.api).get('/api/projects?pageSize=201')).status).toBe(400);
    expect((await request(ctx.api).get('/api/projects?includeTest=maybe')).status).toBe(400);
  });
});

describe('projects: usage summary', () => {
  it('sums requests/successes/failures/tokens/cost exactly (BigInt) and reports lastActivityAt', async () => {
    const p = (await post('/api/projects', { name: 'Usage Sum' })).body.data;
    const t1 = new Date('2025-03-01T10:00:00.000Z');
    const t2 = new Date('2025-03-02T11:30:00.000Z');
    await insertUsage(ctx.prisma, { projectId: p.id, costPico: 123_456_789_012n, inputTokens: 10, outputTokens: 20, cachedTokens: 1, createdAt: t1 });
    await insertUsage(ctx.prisma, { projectId: p.id, costPico: 1n, inputTokens: 5, outputTokens: 0, cachedTokens: 0, status: 'FAILURE', createdAt: t2 });
    await insertUsage(ctx.prisma, { projectId: p.id, costPico: 9_007_199_254_740_993n, inputTokens: 1, outputTokens: 2, cachedTokens: 3, createdAt: t1 }); // > 2^53
    const res = await request(ctx.api).get(`/api/projects/${p.id}`);
    expect(res.body.data.usage).toEqual({
      requests: 3, successes: 2, failures: 1, inputTokens: 16, outputTokens: 22, cachedTokens: 4,
      costUsd: '9007.322711530006',
      lastActivityAt: t2.toISOString(),
    });
  });

  it('list items carry per-project usage and are not mixed between projects', async () => {
    const a = (await post('/api/projects', { name: 'Mix A' })).body.data;
    const b = (await post('/api/projects', { name: 'Mix B' })).body.data;
    await insertUsage(ctx.prisma, { projectId: a.id, costPico: 2_000_000_000_000n });
    await insertUsage(ctx.prisma, { projectId: b.id, costPico: 500_000_000_000n });
    await insertUsage(ctx.prisma, { projectId: b.id, costPico: 500_000_000_000n });
    const res = await request(ctx.api).get('/api/projects?search=Mix ');
    const byName = Object.fromEntries(res.body.data.map((p: { name: string; usage: unknown }) => [p.name, p.usage]));
    expect(byName['Mix A']).toMatchObject({ requests: 1, costUsd: '2.000000000000' });
    expect(byName['Mix B']).toMatchObject({ requests: 2, costUsd: '1.000000000000' });
  });
});

describe('projects: delete (test projects only) + cascade', () => {
  it('rejects deleting a non-test project with 409 and keeps it', async () => {
    const p = (await post('/api/projects', { name: 'Real Project' })).body.data;
    const res = await request(ctx.api).delete(`/api/projects/${p.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(await ctx.prisma.project.count({ where: { id: p.id } })).toBe(1);
  });

  it('404 when deleting an unknown project', async () => {
    expect((await request(ctx.api).delete('/api/projects/nope')).status).toBe(404);
  });

  it('deletes a test project (204), cascades usage/budgets/alerts, keeps activity rows with projectId NULL', async () => {
    const p = (await post('/api/projects', { name: 'Cascade Test', isTest: true })).body.data;
    const other = await insertProject(ctx.prisma, 'Cascade Survivor');
    await insertUsage(ctx.prisma, { projectId: p.id });
    await insertUsage(ctx.prisma, { projectId: p.id, status: 'FAILURE' });
    const survivorUsage = await insertUsage(ctx.prisma, { projectId: other.id });
    const budget = await ctx.prisma.budget.create({ data: { projectId: p.id, name: 'b', period: 'DAILY', limitPico: 1000n } });
    const survivorBudget = await ctx.prisma.budget.create({ data: { projectId: other.id, name: 'b2', period: 'DAILY', limitPico: 1000n } });
    const alert = await ctx.prisma.budgetAlert.create({
      data: { budgetId: budget.id, threshold: 50, periodStart: new Date(0), periodEnd: new Date(1), spendPico: 600n, limitPico: 1000n, percent: 60 },
    });
    const act = await ctx.prisma.activityEvent.create({ data: { type: 'usage.recorded', level: 'INFO', message: 'm', source: 'ACTUAL', projectId: p.id } });

    const res = await request(ctx.api).delete(`/api/projects/${p.id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    expect(await ctx.prisma.project.count({ where: { id: p.id } })).toBe(0);
    expect(await ctx.prisma.usageEvent.count({ where: { projectId: p.id } })).toBe(0);
    expect(await ctx.prisma.budget.count({ where: { id: budget.id } })).toBe(0);
    expect(await ctx.prisma.budgetAlert.count({ where: { id: alert.id } })).toBe(0);
    // untouched data of other projects
    expect(await ctx.prisma.usageEvent.count({ where: { id: survivorUsage.id } })).toBe(1);
    expect(await ctx.prisma.budget.count({ where: { id: survivorBudget.id } })).toBe(1);
    // activity kept, project link nulled
    const kept = await ctx.prisma.activityEvent.findUnique({ where: { id: act.id } });
    expect(kept).not.toBeNull();
    expect(kept!.projectId).toBeNull();
    const createdEvt = await ctx.prisma.activityEvent.findFirst({ where: { type: 'project.created', message: { contains: 'Cascade Test' } } });
    expect(createdEvt).not.toBeNull();
    expect(createdEvt!.projectId).toBeNull();

    // project.deleted emitted with identity in metadata (row no longer exists)
    const del = ctx.recorded.find(c => c.type === 'project.deleted' && (c.metadata as { projectId?: string }).projectId === p.id);
    expect(del).toBeTruthy();
    expect(del!.source).toBe('ACTUAL');
    expect(del!.metadata).toMatchObject({ name: 'Cascade Test' });
    expect((await request(ctx.api).get(`/api/projects/${p.id}`)).status).toBe(404);
  });

  it('can delete an archived test project; a project flipped to non-test can no longer be deleted', async () => {
    const p = (await post('/api/projects', { name: 'Arch Test', isTest: true })).body.data;
    await post(`/api/projects/${p.id}/archive`);
    expect((await request(ctx.api).delete(`/api/projects/${p.id}`)).status).toBe(204);
    const q = (await post('/api/projects', { name: 'Flip', isTest: true })).body.data;
    await request(ctx.api).patch(`/api/projects/${q.id}`).send({ isTest: false });
    expect((await request(ctx.api).delete(`/api/projects/${q.id}`)).status).toBe(409);
  });
});

describe('projects: activity history', () => {
  it('lists the project activity newest first with pagination, project name and parsed metadata', async () => {
    const p = (await post('/api/projects', { name: 'Hist' })).body.data;
    await request(ctx.api).patch(`/api/projects/${p.id}`).send({ description: 'x' });
    await post(`/api/projects/${p.id}/archive`);
    await post(`/api/projects/${p.id}/unarchive`);
    const other = (await post('/api/projects', { name: 'Hist Other' })).body.data;

    const res = await request(ctx.api).get(`/api/projects/${p.id}/activity`);
    expect(res.status).toBe(200);
    const types = res.body.data.map((e: { type: string }) => e.type);
    expect(types).toEqual(['project.unarchived', 'project.archived', 'project.updated', 'project.created']);
    expect(res.body.data.every((e: { projectId: string; projectName: string; source: string }) => e.projectId === p.id && e.projectName === 'Hist' && e.source === 'ACTUAL')).toBe(true);
    expect(res.body.data[3].metadata).toMatchObject({ name: 'Hist' });
    expect(res.body.pagination).toMatchObject({ total: 4, page: 1 });
    expect(res.body.data.find((e: { projectId: string }) => e.projectId === other.id)).toBeUndefined();

    const pg = await request(ctx.api).get(`/api/projects/${p.id}/activity?pageSize=3&page=2`);
    expect(pg.body.data.map((e: { type: string }) => e.type)).toEqual(['project.created']);
    expect(pg.body.pagination).toMatchObject({ total: 4, totalPages: 2 });
  });

  it('404 for unknown project, 400 for bad pagination', async () => {
    expect((await request(ctx.api).get('/api/projects/nope/activity')).status).toBe(404);
    const p = (await post('/api/projects', { name: 'Hist Bad' })).body.data;
    expect((await request(ctx.api).get(`/api/projects/${p.id}/activity?page=0`)).status).toBe(400);
  });
});

describe('projects: instrumentation failure isolation', () => {
  it('does not fail the request if activity recording throws', async () => {
    const { buildApp } = await import('../../src/app');
    const app = buildApp({ ...ctx.deps, instr: { ...ctx.deps.instr, recordActivity: async () => { throw new Error('boom'); } } });
    const res = await request(app).post('/api/projects').send({ name: 'Resilient' });
    expect(res.status).toBe(201);
  });
});
