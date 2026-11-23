import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { createHarness, makeProject, addUsage, type Harness } from '../budgets/helpers';
import { selectPricingVersion } from '../../src/modules/cost';
import type { CostBreakdown, PricingDto } from '../../../shared/types';

let ctx: TestCtx;
let h: Harness;
beforeAll(async () => { ctx = await createTestApp(); h = createHarness(ctx); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const calc = (body: Record<string, unknown>) => request(h.app).post('/api/cost/calculate').send(body);
const ok = async (body: Record<string, unknown>): Promise<CostBreakdown> => {
  const r = await calc(body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};
const postPricing = (body: Record<string, unknown>) => request(h.app).post('/api/cost/pricing').send(body);

describe('cost math (exact BigInt)', () => {
  it('prices each token class at its own rate (gpt-4o, current pricing)', async () => {
    const r = await ok({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500, cachedTokens: 200 });
    expect(r.inputCostUsd).toBe('0.002500000000');
    expect(r.outputCostUsd).toBe('0.005000000000');
    expect(r.cachedCostUsd).toBe('0.000250000000');
    expect(r.totalCostUsd).toBe('0.007750000000');
    expect(r.currency).toBe('USD');
    expect(r.costClass).toBe('SIMULATED');
    expect(r.unknownModel).toBe(false);
    expect(r.pricing).toEqual({ inputPerMTok: '2.500000', outputPerMTok: '10.000000', cachedPerMTok: '1.250000' });
    expect(r.pricingVersion).toBe(1);
    expect(r.pricingConfigId).toEqual(expect.any(String));
  });

  it('cachedTokens are billed separately from inputTokens (not subtracted)', async () => {
    const onlyIn = await ok({ provider: 'anthropic', model: 'claude-sonnet', inputTokens: 1_000_000, outputTokens: 0 });
    const onlyCached = await ok({ provider: 'anthropic', model: 'claude-sonnet', inputTokens: 0, outputTokens: 0, cachedTokens: 1_000_000 });
    const both = await ok({ provider: 'anthropic', model: 'claude-sonnet', inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 });
    expect(onlyIn.totalCostUsd).toBe('3.000000000000');
    expect(onlyCached.totalCostUsd).toBe('0.300000000000');
    expect(both.totalCostUsd).toBe('3.300000000000');
  });

  it('float trap: 3 tokens at 0.15/MTok = 0.00000045 exactly', async () => {
    const r = await ok({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 3, outputTokens: 0, at: '2024-06-01T00:00:00Z' });
    expect(r.pricingVersion).toBe(1);
    expect(r.inputCostUsd).toBe('0.000000450000');
    expect(r.totalCostUsd).toBe('0.000000450000');
  });

  it('float trap: 1_000_003 tokens at 0.15/MTok', async () => {
    const r = await ok({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1_000_003, outputTokens: 0, at: '2024-06-01T00:00:00Z' });
    expect(r.inputCostUsd).toBe('0.150000450000');
  });

  it('float trap: 0.1 + 0.2 style prices sum to exactly 0.0000003', async () => {
    const p = await postPricing({ provider: 'trapprov', model: 'trap-model', inputPerMTok: '0.1', outputPerMTok: '0.2', cachedPerMTok: '0.3', effectiveFrom: '2020-01-01T00:00:00Z' });
    expect(p.status).toBe(201);
    const r = await ok({ provider: 'trapprov', model: 'trap-model', inputTokens: 1, outputTokens: 1 });
    expect(r.inputCostUsd).toBe('0.000000100000');
    expect(r.outputCostUsd).toBe('0.000000200000');
    expect(r.totalCostUsd).toBe('0.000000300000');
    const many = await ok({ provider: 'trapprov', model: 'trap-model', inputTokens: 10, outputTokens: 10, cachedTokens: 10 });
    expect(many.totalCostUsd).toBe('0.000006000000');
  });

  it('zero tokens cost exactly zero with 12 fraction digits', async () => {
    const r = await ok({ provider: 'openai', model: 'gpt-4o', inputTokens: 0, outputTokens: 0 });
    expect(r.inputCostUsd).toBe('0.000000000000');
    expect(r.outputCostUsd).toBe('0.000000000000');
    expect(r.cachedCostUsd).toBe('0.000000000000');
    expect(r.totalCostUsd).toBe('0.000000000000');
  });

  it('handles very large token counts without precision loss', async () => {
    const r = await ok({ provider: 'anthropic', model: 'claude-opus', inputTokens: 1_000_000_000_000, outputTokens: 1, cachedTokens: 0 });
    expect(r.inputCostUsd).toBe('15000000.000000000000');
    expect(r.outputCostUsd).toBe('0.000075000000');
    expect(r.totalCostUsd).toBe('15000000.000075000000');
    const big = await ok({ provider: 'anthropic', model: 'claude-opus', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
    // 9007199254740991 * 15 / 1e6 = 135107988821.114865 USD
    expect(big.inputCostUsd).toBe('135107988821.114865000000');
  });

  it('formats to 12 fraction digits for sub-cent amounts', async () => {
    const r = await ok({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1, outputTokens: 1, cachedTokens: 1, at: '2024-06-01T00:00:00Z' });
    expect(r.inputCostUsd).toBe('0.000000150000');
    expect(r.outputCostUsd).toBe('0.000000600000');
    expect(r.cachedCostUsd).toBe('0.000000075000');
    expect(r.totalCostUsd).toBe('0.000000825000');
  });

  it('is reproducible: identical input twice => identical output', async () => {
    const input = { provider: 'openai', model: 'gpt-4.1', inputTokens: 12345, outputTokens: 6789, cachedTokens: 321, at: '2025-03-03T03:03:03Z' };
    expect(await ok(input)).toEqual(await ok(input));
  });

  it('normalises provider case', async () => {
    const r = await ok({ provider: 'OpenAI', model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 0 });
    expect(r.unknownModel).toBe(false);
    expect(r.inputCostUsd).toBe('2.500000000000');
  });

  it('service returns BigInt pico fields consistent with the strings', async () => {
    const r = await h.deps.cost.calculate({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500, cachedTokens: 200 });
    expect(r.inputCostPico).toBe(2_500_000_000n);
    expect(r.outputCostPico).toBe(5_000_000_000n);
    expect(r.cachedCostPico).toBe(250_000_000n);
    expect(r.totalCostPico).toBe(7_750_000_000n);
  });
});

describe('unknown models => ESTIMATED via fallback', () => {
  it('unknown model on a known provider', async () => {
    const r = await ok({ provider: 'openai', model: 'gpt-99-turbo', inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 1_000_000 });
    expect(r.costClass).toBe('ESTIMATED');
    expect(r.unknownModel).toBe(true);
    expect(r.inputCostUsd).toBe('5.000000000000');
    expect(r.outputCostUsd).toBe('15.000000000000');
    expect(r.cachedCostUsd).toBe('2.500000000000');
    expect(r.totalCostUsd).toBe('22.500000000000');
    expect(r.pricingVersion).toBe(1);
    expect(r.pricingConfigId).toEqual(expect.any(String));
  });
  it('unknown provider', async () => {
    const r = await ok({ provider: 'mystery', model: 'x', inputTokens: 10, outputTokens: 0 });
    expect(r.costClass).toBe('ESTIMATED');
    expect(r.unknownModel).toBe(true);
  });
  it('known model before its first effective version falls back to ESTIMATED', async () => {
    const r = await ok({ provider: 'openai', model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 0, at: '2023-06-01T00:00:00Z' });
    expect(r.costClass).toBe('ESTIMATED');
    expect(r.inputCostUsd).toBe('5.000000000000'); // fallback v1 used even though its effectiveFrom is later (lowest version)
  });
});

describe('pricing versions', () => {
  it('selects the highest version effective at `at` (inclusive boundary)', async () => {
    const before = await ok({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0, at: '2024-12-31T23:59:59.999Z' });
    expect(before.pricingVersion).toBe(1);
    expect(before.inputCostUsd).toBe('0.150000000000');
    const at = await ok({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0, at: '2025-01-01T00:00:00.000Z' });
    expect(at.pricingVersion).toBe(2);
    expect(at.inputCostUsd).toBe('0.120000000000');
  });

  it('selectPricingVersion is pure and ignores not-yet-effective versions', () => {
    const rows = [
      { version: 1, effectiveFrom: new Date('2024-01-01') },
      { version: 3, effectiveFrom: new Date('2026-01-01') },
      { version: 2, effectiveFrom: new Date('2025-01-01') },
    ];
    expect(selectPricingVersion(rows, new Date('2025-06-01'))?.version).toBe(2);
    expect(selectPricingVersion(rows, new Date('2027-01-01'))?.version).toBe(3);
    expect(selectPricingVersion(rows, new Date('2023-01-01'))).toBeNull();
  });

  it('a new version created via the API does not change older results nor stored usage costs', async () => {
    const project = await makeProject(ctx.prisma);
    const old = await ok({ provider: 'anthropic', model: 'claude-haiku', inputTokens: 1_000_000, outputTokens: 1_000_000, at: '2025-06-01T00:00:00Z' });
    expect(old.pricingVersion).toBe(1);
    const stored = await addUsage(ctx.prisma, project.id, old.totalCostUsd, new Date('2025-06-01T00:00:00Z'));

    const created = await postPricing({ provider: 'anthropic', model: 'claude-haiku', inputPerMTok: '1.000000', outputPerMTok: '5.000000', cachedPerMTok: '0.100000', note: 'new price' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ providerKey: 'anthropic', modelName: 'claude-haiku', version: 2, isCurrent: true, note: 'new price', currency: 'USD' });

    const again = await ok({ provider: 'anthropic', model: 'claude-haiku', inputTokens: 1_000_000, outputTokens: 1_000_000, at: '2025-06-01T00:00:00Z' });
    expect(again).toEqual(old);
    const now = await ok({ provider: 'anthropic', model: 'claude-haiku', inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(now.pricingVersion).toBe(2);
    expect(now.totalCostUsd).toBe('6.000000000000');

    const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { id: stored.id } });
    expect(row.costPico).toBe(stored.costPico);
    const v1 = await ctx.prisma.pricingConfig.findFirstOrThrow({ where: { providerKey: 'anthropic', modelName: 'claude-haiku', version: 1 } });
    expect(v1.inputPerMTok).toBe('0.800000'); // immutable
  });

  it('versions increment per (provider, model) = max + 1, also under concurrency', async () => {
    const base = { provider: 'conc', model: 'm1', inputPerMTok: '1', outputPerMTok: '2', cachedPerMTok: '0.5' };
    const res = await Promise.all([1, 2, 3, 4].map(() => postPricing(base)));
    expect(res.map(r => r.status)).toEqual([201, 201, 201, 201]);
    expect(res.map(r => r.body.data.version).sort()).toEqual([1, 2, 3, 4]);
    const other = await postPricing({ ...base, model: 'm2' });
    expect(other.body.data.version).toBe(1);
  });

  it('normalises price strings to 6 dp and defaults effectiveFrom to now', async () => {
    const t0 = Date.now();
    const r = await postPricing({ provider: 'norm', model: 'n1', inputPerMTok: '2.5', outputPerMTok: '10', cachedPerMTok: '0.000001' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ inputPerMTok: '2.500000', outputPerMTok: '10.000000', cachedPerMTok: '0.000001' });
    expect(Date.parse(r.body.data.effectiveFrom)).toBeGreaterThanOrEqual(t0 - 1);
  });

  it('GET /cost/pricing: history flag and isCurrent', async () => {
    const all = await request(h.app).get('/api/cost/pricing?provider=openai&model=gpt-4o-mini&history=true');
    expect(all.status).toBe(200);
    const rows: PricingDto[] = all.body.data;
    expect(rows.map(x => [x.version, x.isCurrent])).toEqual([[2, true], [1, false]]);
    const cur = await request(h.app).get('/api/cost/pricing?provider=openai&model=gpt-4o-mini&history=false');
    expect(cur.body.data.map((x: PricingDto) => x.version)).toEqual([2]);
    const everything = await request(h.app).get('/api/cost/pricing?history=false');
    const keys = everything.body.data.map((x: PricingDto) => `${x.providerKey}/${x.modelName}`);
    expect(new Set(keys).size).toBe(keys.length); // one current row per model
    expect(keys).toContain('*/*');
  });

  it('future-dated version is listed but not current, and not used before it becomes effective', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const c = await postPricing({ provider: 'openai', model: 'o3-mini', inputPerMTok: '9', outputPerMTok: '9', cachedPerMTok: '9', effectiveFrom: future });
    expect(c.status).toBe(201);
    expect(c.body.data.isCurrent).toBe(false);
    const now = await ok({ provider: 'openai', model: 'o3-mini', inputTokens: 1_000_000, outputTokens: 0 });
    expect(now.pricingVersion).toBe(1);
    const later = await ok({ provider: 'openai', model: 'o3-mini', inputTokens: 1_000_000, outputTokens: 0, at: future });
    expect(later.pricingVersion).toBe(2);
    expect(later.inputCostUsd).toBe('9.000000000000');
    const cur = await request(h.app).get('/api/cost/pricing?provider=openai&model=o3-mini&history=false');
    expect(cur.body.data.map((x: PricingDto) => x.version)).toEqual([1]);
  });

  it('rejects backdating a new version before the latest existing effectiveFrom', async () => {
    const r = await postPricing({ provider: 'openai', model: 'gpt-4o-mini', inputPerMTok: '1', outputPerMTok: '1', cachedPerMTok: '1', effectiveFrom: '2024-06-01T00:00:00Z' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('validation', () => {
  const base = { provider: 'openai', model: 'gpt-4o', inputTokens: 1, outputTokens: 1 };
  it.each([
    ['negative inputTokens', { inputTokens: -1 }],
    ['fractional outputTokens', { outputTokens: 1.5 }],
    ['string tokens', { inputTokens: '10' }],
    ['unsafe tokens', { inputTokens: Number.MAX_SAFE_INTEGER + 2 }],
    ['negative cachedTokens', { cachedTokens: -5 }],
    ['NaN-ish tokens (null)', { outputTokens: null }],
    ['missing model', { model: undefined }],
    ['empty provider', { provider: '' }],
    ['bad at', { at: 'not-a-date' }],
  ])('POST /cost/calculate rejects %s', async (_n, patch) => {
    const r = await calc({ ...base, ...patch });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('service validates tokens too (non-HTTP callers)', async () => {
    await expect(h.deps.cost.calculate({ ...base, inputTokens: -1 })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    await expect(h.deps.cost.calculate({ ...base, outputTokens: 0.5 })).rejects.toMatchObject({ status: 400 });
    await expect(h.deps.cost.calculate({ ...base, cachedTokens: Number.NaN })).rejects.toMatchObject({ status: 400 });
  });

  const price = { inputPerMTok: '1', outputPerMTok: '1', cachedPerMTok: '1' };
  it.each([
    ['7 decimal places', { provider: 'v', model: 'm', ...price, inputPerMTok: '1.1234567' }],
    ['negative price', { provider: 'v', model: 'm', ...price, outputPerMTok: '-1' }],
    ['non-numeric price', { provider: 'v', model: 'm', ...price, cachedPerMTok: 'abc' }],
    ['number instead of string', { provider: 'v', model: 'm', ...price, inputPerMTok: 1 }],
    ['uppercase provider', { provider: 'OpenAI', model: 'm', ...price }],
    ['provider with spaces', { provider: 'my prov', model: 'm', ...price }],
    ['wildcard provider with real model', { provider: '*', model: 'm', ...price }],
    ['real provider with wildcard model', { provider: 'p', model: '*', ...price }],
    ['bad effectiveFrom', { provider: 'v', model: 'm', ...price, effectiveFrom: 'yesterday-ish' }],
    ['missing price', { provider: 'v', model: 'm', inputPerMTok: '1', outputPerMTok: '1' }],
  ])('POST /cost/pricing rejects %s', async (_n, body) => {
    const r = await postPricing(body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('throws a clear error when the fallback pricing row is missing', async () => {
    const c2 = await createTestApp();
    try {
      await c2.prisma.pricingConfig.deleteMany({ where: { providerKey: '*', modelName: '*' } });
      const h2 = createHarness(c2);
      const known = await request(h2.app).post('/api/cost/calculate').send(base);
      expect(known.status).toBe(200); // known models do not need the fallback
      const unknown = await request(h2.app).post('/api/cost/calculate').send({ ...base, model: 'nope' });
      expect(unknown.status).toBe(500);
      expect(unknown.body.error.code).toBe('PRICING_UNAVAILABLE');
      expect(unknown.body.error.message).toMatch(/fallback/i);
    } finally { await c2.close(); cleanupTestDir(c2.dir); }
  });
});
