import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { cleanupTestDir } from '../helpers/testApp';
import { createCoreCtx, insertProject, type CoreCtx } from '../core/coreHelpers';
import { safeStringify } from '../../src/utils/serialize';
import { projectIdsBySearch, MAX_SEARCH_MATCHES } from '../../src/modules/usage/search';

const N = 10_050; // > MAX_SEARCH_MATCHES, > 20 export batches of 500
let ctx: CoreCtx;
let pid: string;
let expectedPico = 0n;
const get = (url: string) => request(ctx.api).get(url);

beforeAll(async () => {
  ctx = await createCoreCtx();
  pid = (await insertProject(ctx.prisma, 'Bulk Project')).id;
  const base = Date.UTC(2025, 2, 10, 0, 0, 0); // groups of 7 rows share one timestamp => exercises (createdAt, id) keyset tie-breaking
  const rows = Array.from({ length: N }, (_, i) => {
    const costPico = BigInt(i) * 1_000_003n + 1n;
    expectedPico += costPico;
    return {
      requestId: `req_bulk_${String(i).padStart(5, '0')}`, projectId: pid, providerKey: i % 2 ? 'openai' : 'anthropic',
      modelName: i === 3 ? '\t=1+1' : i === 4 ? '@SUM(A1)' : 'm', status: i % 10 === 0 ? 'FAILURE' : 'SUCCESS',
      errorCode: i === 5 ? '\rX' : null, errorMessage: null, inputTokens: 1, outputTokens: 2, cachedTokens: 0,
      costPico, inputCostPico: costPico, outputCostPico: 0n, cachedCostPico: 0n, costClass: 'SIMULATED', pricingVersion: 1,
      durationMs: 5, traceId: null, promptHash: 'h'.repeat(64), promptChars: 1, responseText: null,
      metadata: safeStringify({}), createdAt: new Date(base + Math.floor(i / 7) * 15 * 60_000),
    };
  });
  for (let i = 0; i < rows.length; i += 1000) await ctx.prisma.usageEvent.createMany({ data: rows.slice(i, i + 1000) });
}, 120_000);
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

describe('usage CSV export streams every row in keyset batches', () => {
  it('exports all rows exactly once, newest first, with a single header', async () => {
    const res = await get('/api/usage/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="usage-export-/);
    expect(res.headers['cache-control']).toBe('no-store');
    // all-in-one-chunk or chunked transfer: either way the body is the complete CSV
    const text = res.text;
    const lines = text.split('\n');
    expect(lines.at(-1)).toBe('');
    const body = lines.slice(1, -1);
    // injection cells contain \r / quoted fields; count records by request id instead of raw lines
    const ids = [...text.matchAll(/^(req_bulk_\d{5}),/gm)].map(m => m[1]);
    expect(lines[0].startsWith('request_id,created_at')).toBe(true);
    expect(ids).toHaveLength(N);
    expect(new Set(ids).size).toBe(N);
    expect(body.length).toBeGreaterThanOrEqual(N);
    // ordering: createdAt desc (groups of 7 descending), ids desc within a tie
    const stamps = [...text.matchAll(/^req_bulk_\d{5},([^,]+),/gm)].map(m => m[1]);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  }, 60_000);

  it('neutralises TAB / CR / formula prefixed cells', async () => {
    const text = (await get('/api/usage/export.csv?search=req_bulk_0000')).text; // rows 00000..00009
    expect(text).toContain(`'\t=1+1`);
    expect(text).toContain(`'@SUM(A1)`);
    expect(text).toContain(`"'\rX"`);
    for (const rec of text.split('\n').slice(1)) {
      // no unquoted cell may begin with a raw trigger char
      expect(rec).not.toMatch(/(^|,)[=+@\t]/);
    }
  });

  it('honours filters while streaming', async () => {
    const text = (await get('/api/usage/export.csv?status=FAILURE&provider=anthropic')).text;
    const ids = [...text.matchAll(/^(req_bulk_\d{5}),/gm)].map(m => m[1]);
    expect(ids).toHaveLength(Math.ceil(N / 10)); // i % 10 === 0 -> even index -> anthropic
    expect(ids.every(id => Number(id.slice(-5)) % 10 === 0)).toBe(true);
  });

  it('rejects invalid filters with a JSON error before streaming starts', async () => {
    const res = await get('/api/usage/export.csv?status=NOPE');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('search / pagination bounds', () => {
  it('wildcard-character searches are literal, paginated and never build an id list (no cap, no 400)', async () => {
    const underscore = await get('/api/usage?search=_&pageSize=5&page=2000'); // every request id contains "_"
    expect(underscore.status).toBe(200);
    expect(underscore.body.pagination.total).toBe(N);
    expect(underscore.body.data).toHaveLength(5);
    const pct = await get('/api/usage?search=%25');
    expect(pct.status).toBe(200);
    expect(pct.body.pagination.total).toBe(0);
    expect((await get('/api/usage/export.csv?search=%25')).text.trim().split('\n')).toHaveLength(1);
    const narrow = await get('/api/usage?search=req_bulk_0000');
    expect(narrow.body.pagination.total).toBe(10);
  });

  it('project wildcard id-list search is capped (rejects instead of truncating)', async () => {
    await expect(projectIdsBySearch(ctx.prisma, 'Bulk', 0)).rejects.toThrow(/too broad/);
    expect(MAX_SEARCH_MATCHES).toBe(10_000);
  });

  it('plain (non-wildcard) searches stay paginated and counted over the full table', async () => {
    const res = await get('/api/usage?search=req_bulk&pageSize=200&page=51');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 51, pageSize: 200, total: N, totalPages: Math.ceil(N / 200) });
    expect(res.body.data).toHaveLength(N - 50 * 200);
  });

  it('bounds page and rejects array params', async () => {
    expect((await get('/api/usage?page=10001')).status).toBe(400);
    expect((await get('/api/usage?page=1e30')).status).toBe(400);
    expect((await get('/api/usage?provider=a&provider=b')).status).toBe(400);
    expect((await get('/api/usage?search[x]=1')).status).toBe(400);
  });
});

describe('dashboard over a large table', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('SQL daily buckets sum exactly to the totals (BigInt, no float drift)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-03-26T12:00:00Z'));
    const d = (await get('/api/dashboard?days=30')).body.data;
    vi.useRealTimers();
    expect(d.dailySpend).toHaveLength(30);
    const failures = Math.ceil(N / 10);
    expect(d.totals).toMatchObject({ requests: N, failures, successes: N - failures, inputTokens: N, outputTokens: 2 * N });
    const toUsd = (p: bigint) => `${p / 1_000_000_000_000n}.${(p % 1_000_000_000_000n).toString().padStart(12, '0')}`;
    expect(d.totals.spendUsd).toBe(toUsd(expectedPico));
    const toPico = (u: string) => BigInt(u.replace('.', ''));
    const dailyPico = d.dailySpend.reduce((a: bigint, p: { costUsd: string }) => a + toPico(p.costUsd), 0n);
    expect(dailyPico).toBe(expectedPico);
    expect(d.dailySpend.reduce((a: number, p: { requests: number }) => a + p.requests, 0)).toBe(N);
    expect(d.dailySpend.reduce((a: number, p: { failures: number }) => a + p.failures, 0)).toBe(failures);
    expect(d.dailySpend.filter((p: { requests: number }) => p.requests > 0).length).toBeGreaterThan(10);
    expect(d.providerBreakdown.reduce((a: number, p: { requests: number }) => a + p.requests, 0)).toBe(N);
  });

  it('project-filtered buckets use the same totals', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-03-26T12:00:00Z'));
    const d = (await get(`/api/dashboard?days=30&projectId=${pid}`)).body.data;
    vi.useRealTimers();
    expect(d.totals.requests).toBe(N);
  });
});
