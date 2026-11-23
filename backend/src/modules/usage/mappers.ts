import type { UsageEvent } from '@prisma/client';
import type { CostClass, UsageEventDetail, UsageEventDto, UsageStatus } from '../../../../shared/types';
import { picoToUsd } from '../../utils/money';
import { parseJson } from '../../utils/serialize';

type Row = UsageEvent & { project?: { name: string } | null };

/** Convert BigInt pico columns to 12dp USD strings. Never goes through Number. */
export const usd = (pico: bigint | null | undefined): string => picoToUsd(pico ?? 0n);

export function toUsageEventDto(r: Row): UsageEventDto {
  const dto: UsageEventDto = {
    id: r.id,
    requestId: r.requestId,
    projectId: r.projectId,
    provider: r.providerKey,
    model: r.modelName,
    status: r.status as UsageStatus,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedTokens: r.cachedTokens,
    costUsd: usd(r.costPico),
    costClass: r.costClass as CostClass,
    pricingVersion: r.pricingVersion,
    durationMs: r.durationMs,
    simulated: true,
    label: 'DEMO / SIMULATED',
    traceId: r.traceId,
    createdAt: r.createdAt.toISOString(),
  };
  if (r.project) dto.projectName = r.project.name;
  return dto;
}

export function toUsageEventDetail(r: Row): UsageEventDetail {
  return {
    ...toUsageEventDto(r),
    inputCostUsd: usd(r.inputCostPico),
    outputCostUsd: usd(r.outputCostPico),
    cachedCostUsd: usd(r.cachedCostPico),
    pricingConfigId: r.pricingConfigId,
    promptHash: r.promptHash,
    promptChars: r.promptChars,
    responseText: r.responseText,
    metadata: parseJson(r.metadata),
  };
}
