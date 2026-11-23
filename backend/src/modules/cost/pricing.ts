import type { PrismaClient, PricingConfig } from '@prisma/client';
import { AppError } from '../../utils/errors';

export const FALLBACK_KEY = '*';

/**
 * Pure: pick the pricing row effective at `at` from rows of ONE (provider, model):
 * the highest `version` whose effectiveFrom <= at. Returns null if none is effective yet.
 */
export function selectPricingVersion<T extends { version: number; effectiveFrom: Date }>(rows: T[], at: Date): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.effectiveFrom.getTime() > at.getTime()) continue;
    if (!best || r.version > best.version) best = r;
  }
  return best;
}

export interface ResolvedPricing {
  row: PricingConfig;
  /** true when the (provider, model) pair had no usable pricing and the "*"/"*" fallback row was used */
  fallback: boolean;
}

/**
 * Resolve pricing for (provider, model) at `at`.
 *  - known pair with a version effective at `at` -> that row (fallback=false)
 *  - otherwise (unknown pair, or `at` earlier than every version) -> fallback row "*"/"*" (fallback=true)
 *    The fallback itself is picked with the same rule; if `at` predates all fallback versions the lowest version is used
 *    so that the result stays deterministic.
 */
export async function resolvePricing(prisma: PrismaClient, providerKey: string, modelName: string, at: Date): Promise<ResolvedPricing> {
  const own = await prisma.pricingConfig.findMany({ where: { providerKey, modelName } });
  const hit = selectPricingVersion(own, at);
  if (hit) return { row: hit, fallback: false };

  const fb = await prisma.pricingConfig.findMany({ where: { providerKey: FALLBACK_KEY, modelName: FALLBACK_KEY } });
  if (fb.length === 0) {
    throw new AppError(500, 'PRICING_UNAVAILABLE',
      `No pricing found for ${providerKey}/${modelName} and the fallback pricing row (*/*) is missing`);
  }
  const row = selectPricingVersion(fb, at) ?? [...fb].sort((a, b) => a.version - b.version)[0];
  return { row, fallback: true };
}
