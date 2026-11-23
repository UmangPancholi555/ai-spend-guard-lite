import type { PrismaClient } from '@prisma/client';
import { buildApp } from '../../src/app';
import { createNoopInstrumentation } from '../../src/contracts/noop';
import type { ActivityInput, Instrumentation } from '../../src/contracts/instrumentation';
import { createTestApp, type TestCtx } from '../helpers/testApp';
import { safeStringify } from '../../src/utils/serialize';

export interface CoreCtx extends TestCtx {
  /** app wired with a recording instrumentation (activity calls recorded AND persisted to ActivityEvent) */
  recorded: ActivityInput[];
  api: ReturnType<typeof buildApp>;
}

export function recordingInstr(prisma: PrismaClient, recorded: ActivityInput[]): Instrumentation {
  const base = createNoopInstrumentation();
  return {
    ...base,
    recordActivity: async i => {
      recorded.push(i);
      await prisma.activityEvent.create({
        data: {
          type: i.type, level: i.level ?? 'INFO', message: i.message, source: i.source,
          projectId: i.projectId ?? null, traceId: i.traceId ?? null, requestId: i.requestId ?? null,
          metadata: safeStringify(i.metadata ?? {}),
        },
      });
    },
  };
}

export async function createCoreCtx(existingDir?: string): Promise<CoreCtx> {
  const ctx = await createTestApp(existingDir ? { dir: existingDir } : undefined);
  const recorded: ActivityInput[] = [];
  const api = buildApp({ ...ctx.deps, instr: recordingInstr(ctx.prisma, recorded) });
  return { ...ctx, recorded, api };
}

let seq = 0;
export interface UsageSeed {
  projectId: string; provider?: string; model?: string; status?: 'SUCCESS' | 'FAILURE';
  costPico?: bigint; inputTokens?: number; outputTokens?: number; cachedTokens?: number;
  createdAt?: Date; durationMs?: number; requestId?: string; traceId?: string | null;
  errorCode?: string | null; errorMessage?: string | null; metadata?: Record<string, unknown>;
  responseText?: string | null; costClass?: string;
}

/** Insert a UsageEvent directly (bypasses the providers pipeline). */
export async function insertUsage(prisma: PrismaClient, s: UsageSeed) {
  const n = ++seq;
  const costPico = s.costPico ?? 1_000n;
  return prisma.usageEvent.create({
    data: {
      requestId: s.requestId ?? `req_test_${n}_${Math.random().toString(36).slice(2, 8)}`,
      projectId: s.projectId,
      providerKey: s.provider ?? 'openai',
      modelName: s.model ?? 'gpt-4o-mini',
      status: s.status ?? 'SUCCESS',
      errorCode: s.errorCode ?? null,
      errorMessage: s.errorMessage ?? null,
      inputTokens: s.inputTokens ?? 100,
      outputTokens: s.outputTokens ?? 50,
      cachedTokens: s.cachedTokens ?? 10,
      costPico,
      inputCostPico: costPico / 2n,
      outputCostPico: costPico - costPico / 2n - 0n,
      cachedCostPico: 0n,
      costClass: s.costClass ?? 'SIMULATED',
      pricingVersion: 1,
      durationMs: s.durationMs ?? 120,
      traceId: s.traceId === undefined ? null : s.traceId,
      promptHash: 'a'.repeat(64),
      promptChars: 42,
      responseText: s.responseText === undefined ? 'mock response' : s.responseText,
      metadata: safeStringify(s.metadata ?? { simulated: true, provider: s.provider ?? 'openai' }),
      createdAt: s.createdAt ?? new Date(),
    },
  });
}

export async function insertProject(prisma: PrismaClient, name: string, extra: { isTest?: boolean; status?: string } = {}) {
  return prisma.project.create({ data: { name, isTest: extra.isTest ?? false, status: extra.status ?? 'ACTIVE' } });
}
