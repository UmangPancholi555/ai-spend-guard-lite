import type { PrismaClient } from '@prisma/client';

/**
 * Local catalog of SIMULATED providers/models and ILLUSTRATIVE pricing (USD per 1M tokens).
 * These are demo numbers, NOT real provider price lists.
 */
export const PROVIDERS = [
  { key: 'openai', displayName: 'Mock OpenAI' },
  { key: 'anthropic', displayName: 'Mock Anthropic' },
] as const;

export const MODELS = [
  { provider: 'openai', name: 'gpt-4o', displayName: 'GPT-4o (mock)', contextWindow: 128000 },
  { provider: 'openai', name: 'gpt-4o-mini', displayName: 'GPT-4o mini (mock)', contextWindow: 128000 },
  { provider: 'openai', name: 'gpt-4.1', displayName: 'GPT-4.1 (mock)', contextWindow: 1000000 },
  { provider: 'openai', name: 'o3-mini', displayName: 'o3-mini (mock)', contextWindow: 200000 },
  { provider: 'anthropic', name: 'claude-opus', displayName: 'Claude Opus (mock)', contextWindow: 200000 },
  { provider: 'anthropic', name: 'claude-sonnet', displayName: 'Claude Sonnet (mock)', contextWindow: 200000 },
  { provider: 'anthropic', name: 'claude-haiku', displayName: 'Claude Haiku (mock)', contextWindow: 200000 },
] as const;

interface PriceRow { provider: string; model: string; version: number; input: string; output: string; cached: string; from: string; note: string }
export const PRICING: PriceRow[] = [
  { provider: 'openai', model: 'gpt-4o', version: 1, input: '2.500000', output: '10.000000', cached: '1.250000', from: '2024-01-01T00:00:00.000Z', note: 'illustrative v1' },
  { provider: 'openai', model: 'gpt-4o-mini', version: 1, input: '0.150000', output: '0.600000', cached: '0.075000', from: '2024-01-01T00:00:00.000Z', note: 'illustrative v1' },
  { provider: 'openai', model: 'gpt-4o-mini', version: 2, input: '0.120000', output: '0.500000', cached: '0.060000', from: '2025-01-01T00:00:00.000Z', note: 'illustrative v2 price cut' },
  { provider: 'openai', model: 'gpt-4.1', version: 1, input: '2.000000', output: '8.000000', cached: '0.500000', from: '2024-01-01T00:00:00.000Z', note: 'illustrative v1' },
  { provider: 'openai', model: 'o3-mini', version: 1, input: '1.100000', output: '4.400000', cached: '0.550000', from: '2024-01-01T00:00:00.000Z', note: 'illustrative v1' },
  { provider: 'anthropic', model: 'claude-opus', version: 1, input: '15.000000', output: '75.000000', cached: '1.500000', from: '2024-01-01T00:00:00.000Z', note: 'illustrative v1' },
  { provider: 'anthropic', model: 'claude-sonnet', version: 1, input: '3.000000', output: '15.000000', cached: '0.300000', from: '2024-01-01T00:00:00.000Z', note: 'illustrative v1' },
  { provider: 'anthropic', model: 'claude-haiku', version: 1, input: '0.800000', output: '4.000000', cached: '0.080000', from: '2024-01-01T00:00:00.000Z', note: 'illustrative v1' },
  // fallback used for unknown models => cost class ESTIMATED
  { provider: '*', model: '*', version: 1, input: '5.000000', output: '15.000000', cached: '2.500000', from: '2024-01-01T00:00:00.000Z', note: 'fallback estimate for unknown models' },
];

/** Idempotent: safe to call on every startup. */
export async function seedCatalog(prisma: PrismaClient): Promise<void> {
  for (const p of PROVIDERS) {
    await prisma.provider.upsert({ where: { key: p.key }, update: {}, create: { key: p.key, displayName: p.displayName, isSimulated: true } });
  }
  for (const m of MODELS) {
    const provider = await prisma.provider.findUniqueOrThrow({ where: { key: m.provider } });
    await prisma.model.upsert({
      where: { providerId_name: { providerId: provider.id, name: m.name } },
      update: {},
      create: { providerId: provider.id, name: m.name, displayName: m.displayName, contextWindow: m.contextWindow },
    });
  }
  for (const r of PRICING) {
    await prisma.pricingConfig.upsert({
      where: { providerKey_modelName_version: { providerKey: r.provider, modelName: r.model, version: r.version } },
      update: {},
      create: {
        providerKey: r.provider, modelName: r.model, version: r.version,
        inputPerMTok: r.input, outputPerMTok: r.output, cachedPerMTok: r.cached,
        effectiveFrom: new Date(r.from), note: r.note,
      },
    });
  }
}
