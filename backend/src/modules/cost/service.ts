import type { PrismaClient } from '@prisma/client';
import type { CostBreakdown, CostCalculateInput } from '../../../../shared/types';
import type { CostService } from '../../contracts/services';
import { badRequest } from '../../utils/errors';
import { parsePriceToMicro, tokenCostPico, picoToUsd } from '../../utils/money';
import { resolvePricing } from './pricing';

export type CostResult = Awaited<ReturnType<CostService['calculate']>>;

/** micro-USD per MTok -> canonical 6-dp decimal string ("2500000" -> "2.500000") */
export function microToPriceString(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

function checkTokens(name: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw badRequest(`${name} must be a non-negative safe integer`, { field: name, value: v });
  }
  return v;
}

/** Strip BigInt helper fields so the result is JSON-serialisable (CostBreakdown only). */
export function toBreakdown(r: CostResult): CostBreakdown {
  const { totalCostPico: _t, inputCostPico: _i, outputCostPico: _o, cachedCostPico: _c, ...rest } = r;
  return rest;
}

/**
 * Cost engine. BigInt-only math: costPico = tokens * priceMicroPerMTok (exact, see utils/money.ts).
 *
 * TOKEN SEMANTICS: `inputTokens` = NON-cached input tokens, billed at the input rate.
 * `cachedTokens` = cached input tokens, billed separately at the cached rate (they are NOT a subset of
 * inputTokens, so they are not subtracted from it). total = input + output + cached cost.
 */
export function createCostService(prisma: PrismaClient): CostService {
  return {
    async calculate(input: CostCalculateInput): Promise<CostResult> {
      const inputTokens = checkTokens('inputTokens', input.inputTokens);
      const outputTokens = checkTokens('outputTokens', input.outputTokens);
      const cachedTokens = checkTokens('cachedTokens', input.cachedTokens ?? 0);
      if (typeof input.provider !== 'string' || !input.provider.trim()) throw badRequest('provider is required');
      if (typeof input.model !== 'string' || !input.model.trim()) throw badRequest('model is required');
      let at = new Date();
      if (input.at !== undefined) {
        at = new Date(input.at);
        if (Number.isNaN(at.getTime())) throw badRequest('at must be a valid ISO date', { field: 'at', value: input.at });
      }

      const { row, fallback } = await resolvePricing(prisma, input.provider.trim().toLowerCase(), input.model.trim(), at);

      const inMicro = parsePriceToMicro(row.inputPerMTok);
      const outMicro = parsePriceToMicro(row.outputPerMTok);
      const cachedMicro = parsePriceToMicro(row.cachedPerMTok);

      const inputCostPico = tokenCostPico(inputTokens, inMicro);
      const outputCostPico = tokenCostPico(outputTokens, outMicro);
      const cachedCostPico = tokenCostPico(cachedTokens, cachedMicro);
      const totalCostPico = inputCostPico + outputCostPico + cachedCostPico;

      return {
        currency: 'USD',
        inputCostUsd: picoToUsd(inputCostPico),
        outputCostUsd: picoToUsd(outputCostPico),
        cachedCostUsd: picoToUsd(cachedCostPico),
        totalCostUsd: picoToUsd(totalCostPico),
        costClass: fallback ? 'ESTIMATED' : 'SIMULATED',
        unknownModel: fallback,
        pricingConfigId: row.id,
        pricingVersion: row.version,
        pricing: {
          inputPerMTok: microToPriceString(inMicro),
          outputPerMTok: microToPriceString(outMicro),
          cachedPerMTok: microToPriceString(cachedMicro),
        },
        totalCostPico, inputCostPico, outputCostPico, cachedCostPico,
      };
    },
  };
}
