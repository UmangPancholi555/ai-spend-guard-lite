import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { cleanupTestDir } from '../helpers/testApp';
import { createCoreCtx, insertUsage, insertProject, type CoreCtx } from '../core/coreHelpers';

let ctx: CoreCtx;
let pA: string; let pB: string;
const ids: Record<string, string> = {};
const reqIds: Record<string, string> = {};
const get = (url: string) => request(ctx.api).get(url);
const day = (d: string) => new Date(`${d}T12:00:00.000Z`);

beforeAll(async () => {
  ctx = await createCoreCtx();
  pA = (await insertProject(ctx.prisma, 'Apollo Search')).id;
  pB = (await insertProject(ctx.prisma, 'Borealis')).id;
  const rows: [string, Parameters<typeof insertUsage>[1]][] = [
    ['e1', { projectId: pA, provider: 'openai', model: 'gpt-4o-mini', costPico: 3_000_000_000n, durationMs: 300, createdAt: day('2025-01-01'), requestId: 'req_alpha_1', traceId: 'trace111aaa' }],
    ['e2', { projectId: pA, provider: 'openai', model: 'gpt-4o', costPico: 10_000_000_000n, durationMs: 100, createdAt: day('2025-01-02'), requestId: 'req_alpha_2' }],
    ['e3', { projectId: pB, provider: 'anthropic', model: 'claude-sonnet', costPico: 1_000_000_000n, durationMs: 900, status: 'FAILURE', errorCode: 'PROVIDER_ERROR', errorMessage: 'upstream exploded: 500', createdAt: day('2025-01-03'), requestId: 'req_beta_3', traceId: 'trace333ccc' }],
    ['e4', { projectId: pB, provider: 'anthropic', model: 'claude-haiku', costPico: 2_000_000_000n, durationMs: 200, createdAt: day('2025-01-04'), requestId: 'req_beta_4' }],
    ['e5', { projectId: pB, provider: 'openai', model: 'gpt-4o-mini', costPico: 5_000_000_000n, durationMs: 50, createdAt: day('2025-01-05'), requestId: 'req_beta_5', status: 'FAILURE', errorMessage: 'rate limited' }],
  ];
  for (const [k, r] of rows) { const e = await insertUsage(ctx.prisma, r); ids[k] = e.id; reqIds[k] = e.requestId; }
});
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const reqs = (res: request.Response) => res.body.data.map((e: { requestId: string }) => e.requestId);

describe('usage list', () => {
  it('returns DTOs with simulated flag, label, project name and 12dp cost, newest first', async () => {
    const res = await get('/api/usage');
    expect(res.status).toBe(200);
    expect(reqs(res)).toEqual(['req_beta_5', 'req_beta_4', 'req_beta_3', 'req_alpha_2', 'req_alpha_1']);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 25, total: 5, totalPages: 1 });
    const e = res.body.data[4];
    expect(e).toMatchObject({
      id: ids.e1, requestId: 'req_alpha_1', projectId: pA, projectName: 'Apollo Search', provider: 'openai', model: 'gpt-4o-mini',
      status: 'SUCCESS', errorCode: null, costUsd: '0.003000000000', costClass: 'SIMULATED', simulated: true,
      label: 'DEMO / SIMULATED', traceId: 'trace111aaa', durationMs: 300, createdAt: '2025-01-01T12:00:00.000Z',
    });
    expect(e.metadata).toBeUndefined();
  });

  it.each([
    ['provider', 'provider=anthropic', ['req_beta_4', 'req_beta_3']],
    ['model', 'model=gpt-4o-mini', ['req_beta_5', 'req_alpha_1']],
    ['projectId A', () => `projectId=${pA}`, ['req_alpha_2', 'req_alpha_1']],
    ['status FAILURE', 'status=FAILURE', ['req_beta_5', 'req_beta_3']],
    ['status SUCCESS', 'status=SUCCESS', ['req_beta_4', 'req_alpha_2', 'req_alpha_1']],
    ['combined', () => `provider=openai&status=FAILURE&projectId=${pB}`, ['req_beta_5']],
    ['from', 'from=2025-01-04T00:00:00.000Z', ['req_beta_5', 'req_beta_4']],
    ['to ISO (inclusive)', 'to=2025-01-02T12:00:00.000Z', ['req_alpha_2', 'req_alpha_1']],
    ['from+to range', 'from=2025-01-02T00:00:00Z&to=2025-01-03T23:59:59Z', ['req_beta_3', 'req_alpha_2']],
    ['date-only to covers the whole day', 'from=2025-01-03&to=2025-01-03', ['req_beta_3']],
  ])('filter: %s', async (_l, q, expected) => {
    const res = await get(`/api/usage?${typeof q === 'function' ? q() : q}`);
    expect(res.status).toBe(200);
    expect(reqs(res)).toEqual(expected);
    expect(res.body.pagination.total).toBe(expected.length);
  });

  it.each([
    ['requestId', 'req_alpha_2', ['req_alpha_2']],
    ['model', 'claude-haiku', ['req_beta_4']],
    ['provider', 'anthropic', ['req_beta_4', 'req_beta_3']],
    ['project name', 'borealis', ['req_beta_5', 'req_beta_4', 'req_beta_3']],
    ['errorMessage', 'exploded', ['req_beta_3']],
    ['traceId', 'trace111', ['req_alpha_1']],
    ['no match', 'zzz-nothing', []],
  ])('search matches %s', async (_l, s, expected) => {
    const res = await get(`/api/usage?search=${encodeURIComponent(s)}`);
    expect(reqs(res)).toEqual(expected);
  });

  it('sorts by createdAt/costUsd/durationMs asc and desc (costUsd sorts by exact pico)', async () => {
    expect(reqs(await get('/api/usage?sort=createdAt&order=asc'))).toEqual(['req_alpha_1', 'req_alpha_2', 'req_beta_3', 'req_beta_4', 'req_beta_5']);
    expect(reqs(await get('/api/usage?sort=costUsd&order=desc'))).toEqual(['req_alpha_2', 'req_beta_5', 'req_alpha_1', 'req_beta_4', 'req_beta_3']);
    expect(reqs(await get('/api/usage?sort=costUsd&order=asc'))).toEqual(['req_beta_3', 'req_beta_4', 'req_alpha_1', 'req_beta_5', 'req_alpha_2']);
    expect(reqs(await get('/api/usage?sort=durationMs&order=desc'))).toEqual(['req_beta_3', 'req_alpha_1', 'req_beta_4', 'req_alpha_2', 'req_beta_5']);
    expect(reqs(await get('/api/usage?sort=durationMs&order=asc'))).toEqual(['req_beta_5', 'req_alpha_2', 'req_beta_4', 'req_alpha_1', 'req_beta_3']);
  });

  it('paginates across pages with stable ordering and correct totals', async () => {
    const p1 = await get('/api/usage?pageSize=2&page=1');
    const p2 = await get('/api/usage?pageSize=2&page=2');
    const p3 = await get('/api/usage?pageSize=2&page=3');
    const p4 = await get('/api/usage?pageSize=2&page=4');
    expect([...reqs(p1), ...reqs(p2), ...reqs(p3)]).toEqual(['req_beta_5', 'req_beta_4', 'req_beta_3', 'req_alpha_2', 'req_alpha_1']);
    expect(p1.body.pagination).toEqual({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
    expect(p4.body.data).toEqual([]);
  });

  it('breaks sort ties deterministically', async () => {
    const t = day('2025-02-01');
    const a = await insertUsage(ctx.prisma, { projectId: pA, costPico: 7n, createdAt: t, requestId: 'req_tie_a' });
    const b = await insertUsage(ctx.prisma, { projectId: pA, costPico: 7n, createdAt: t, requestId: 'req_tie_b' });
    const res = await get('/api/usage?search=req_tie_&sort=costUsd');
    const expected = [a.id, b.id].sort().reverse();
    expect(res.body.data.map((e: { id: string }) => e.id)).toEqual(expected);
    await ctx.prisma.usageEvent.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });

  it.each([
    'status=BAD', 'sort=bogus', 'order=sideways', 'page=0', 'pageSize=500', 'from=not-a-date',
    'to=garbage', 'from=2025-02-01&to=2025-01-01',
  ])('validates query: %s -> 400', async q => {
    const res = await get(`/api/usage?${q}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('treats % and _ in search literally (not as LIKE wildcards)', async () => {
    const odd = await insertProject(ctx.prisma, '100%_odd');
    const e = await insertUsage(ctx.prisma, { projectId: odd.id, requestId: 'req_wild_x', createdAt: day('2026-06-01') });
    expect(reqs(await get('/api/usage?search=' + encodeURIComponent('req_alpha_%')))).toEqual([]);
    expect(reqs(await get('/api/usage?search=%25'))).toEqual(['req_wild_x']);        // only the project named "100%_odd"
    expect(reqs(await get('/api/usage?search=' + encodeURIComponent('0%_o')))).toEqual(['req_wild_x']);
    expect(reqs(await get('/api/usage?search=' + encodeURIComponent('req_wild_')))).toEqual(['req_wild_x']);
    expect(reqs(await get('/api/usage?search=' + encodeURIComponent('req\\alpha')))).toEqual([]);
    await ctx.prisma.usageEvent.delete({ where: { id: e.id } });
  });
});

describe('usage filters', () => {
  it('returns distinct providers and (provider, model) pairs from usage and the active catalog', async () => {
    const res = await get('/api/usage/filters');
    expect(res.status).toBe(200);
    const { providers, models } = res.body.data;
    expect(providers).toEqual(expect.arrayContaining(['openai', 'anthropic']));
    expect([...providers].sort()).toEqual(providers);
    for (const pair of [['openai', 'gpt-4o-mini'], ['openai', 'gpt-4o'], ['anthropic', 'claude-sonnet'], ['anthropic', 'claude-haiku']]) {
      expect(models).toContainEqual({ provider: pair[0], model: pair[1] });
    }
    const keys = models.map((m: { provider: string; model: string }) => `${m.provider}/${m.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('includes unknown models found only in usage events', async () => {
    await insertUsage(ctx.prisma, { projectId: pA, provider: 'openai', model: 'mystery-model-9', requestId: 'req_mystery' });
    const res = await get('/api/usage/filters');
    expect(res.body.data.models).toContainEqual({ provider: 'openai', model: 'mystery-model-9' });
    await ctx.prisma.usageEvent.delete({ where: { requestId: 'req_mystery' } });
  });
});

describe('usage detail', () => {
  it('resolves by id and by requestId with parsed metadata and cost breakdown', async () => {
    const e = await insertUsage(ctx.prisma, {
      projectId: pA, requestId: 'req_detail_1', costPico: 1_234_567_891_011n, metadata: { simulated: true, temperature: 0.2, keys: ['a'] },
      responseText: 'hello mock', traceId: 'tracedetail',
    });
    for (const key of [e.id, 'req_detail_1']) {
      const res = await get(`/api/usage/${key}`);
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d).toMatchObject({
        id: e.id, requestId: 'req_detail_1', projectName: 'Apollo Search', costUsd: '1.234567891011', simulated: true,
        label: 'DEMO / SIMULATED', promptHash: 'a'.repeat(64), promptChars: 42, responseText: 'hello mock', pricingConfigId: null,
        inputCostUsd: '0.617283945505', outputCostUsd: '0.617283945506', cachedCostUsd: '0.000000000000',
      });
      expect(d.metadata).toEqual({ simulated: true, temperature: 0.2, keys: ['a'] });
    }
  });

  it('tolerates corrupt metadata JSON (-> {})', async () => {
    const e = await insertUsage(ctx.prisma, { projectId: pA, requestId: 'req_badmeta' });
    await ctx.prisma.usageEvent.update({ where: { id: e.id }, data: { metadata: '{not json' } });
    const res = await get('/api/usage/req_badmeta');
    expect(res.body.data.metadata).toEqual({});
  });

  it('404 for unknown id; /usage/filters and /usage/export.csv are not captured by :id', async () => {
    const res = await get('/api/usage/req_does_not_exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await get('/api/usage/filters')).body.data.providers).toBeDefined();
    expect((await get('/api/usage/export.csv')).headers['content-type']).toContain('text/csv');
  });
});

describe('usage CSV export', () => {
  const parseLines = (t: string) => t.trimEnd().split('\n');

  it('exports all matching rows (not paginated) with attachment headers and exact columns', async () => {
    const res = await get('/api/usage/export.csv?pageSize=1&page=2&from=2025-01-01&to=2025-01-31');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="usage-export-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = parseLines(res.text);
    expect(lines[0]).toBe('request_id,created_at,project_id,project_name,provider,model,status,error_code,input_tokens,output_tokens,cached_tokens,cost_usd,cost_class,pricing_version,duration_ms,trace_id,simulated');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe(`req_beta_5,2025-01-05T12:00:00.000Z,${pB},Borealis,openai,gpt-4o-mini,FAILURE,,100,50,10,0.005000000000,SIMULATED,1,50,,true`);
    expect(lines[5]).toBe(`req_alpha_1,2025-01-01T12:00:00.000Z,${pA},Apollo Search,openai,gpt-4o-mini,SUCCESS,,100,50,10,0.003000000000,SIMULATED,1,300,trace111aaa,true`);
  });

  it('applies the same filters as the list', async () => {
    const res = await get(`/api/usage/export.csv?status=FAILURE&projectId=${pB}`);
    const lines = parseLines(res.text);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('req_beta_5');
    expect(lines[2]).toContain('req_beta_3');
    expect(lines[2]).toContain('PROVIDER_ERROR');
    expect(parseLines((await get('/api/usage/export.csv?search=nothing-here')).text)).toHaveLength(1); // header only
    expect((await get('/api/usage/export.csv?status=BAD')).status).toBe(400);
  });

  it('escapes commas/quotes/newlines and neutralises formula injection in text cells', async () => {
    const evil = await insertProject(ctx.prisma, '=HYPERLINK("http://evil","x"),with "quotes"');
    const evil2 = await insertProject(ctx.prisma, '@cmd|calc');
    const e1 = await insertUsage(ctx.prisma, { projectId: evil.id, requestId: 'req_csv_1', createdAt: day('2026-05-01'), model: '+SUM(1,2)', traceId: '-2+3' });
    const e2 = await insertUsage(ctx.prisma, { projectId: evil2.id, requestId: 'req_csv_2', createdAt: day('2026-05-02'), model: 'line\nbreak', errorCode: 'E,1', status: 'FAILURE' });
    const res = await get('/api/usage/export.csv?from=2026-05-01&to=2026-05-02');
    const text: string = res.text;
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x""),with ""quotes"""`);
    expect(text).toContain(`'@cmd|calc`);
    expect(text).toContain(`"'+SUM(1,2)"`);
    expect(text).toContain(`'-2+3`);
    expect(text).toContain('"line\nbreak"');
    expect(text).toContain('"E,1"');
    // no cell starts with a raw formula trigger
    for (const line of text.split('\n').slice(1)) expect(line).not.toMatch(/(^|,)[=+@]/);
    await ctx.prisma.usageEvent.deleteMany({ where: { id: { in: [e1.id, e2.id] } } });
  });
});

describe('usage persistence across restart', () => {
  it('usage rows (and big pico sums) survive ctx.restart()', async () => {
    const p = await insertProject(ctx.prisma, 'Restart Usage');
    const big = 9_007_199_254_740_993n;
    await insertUsage(ctx.prisma, { projectId: p.id, costPico: big, requestId: 'req_restart_u' });
    const ctx2 = await ctx.restart();
    try {
      const app = (await import('../../src/app')).buildApp(ctx2.deps);
      const res = await request(app).get('/api/usage/req_restart_u');
      expect(res.status).toBe(200);
      expect(res.body.data.costUsd).toBe('9007.199254740993');
      const list = await request(app).get('/api/usage?search=req_restart_u');
      expect(list.body.pagination.total).toBe(1);
    } finally {
      await ctx2.close();
    }
    // keep module-level ctx usable for later describes (its prisma was disconnected; reconnects lazily)
  });
});
