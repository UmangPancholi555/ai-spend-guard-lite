import type { CostService, BudgetService, AppDeps } from '../../src/contracts/services';
import type { Instrumentation, SpanHandle, TraceHandle } from '../../src/contracts/instrumentation';
import type { BudgetAlertDto, Source } from '../../../shared/types';
import { PRICING } from '../../src/database/catalog';
import { parsePriceToMicro, picoToUsd, tokenCostPico } from '../../src/utils/money';
import { newSpanId, newTraceId } from '../../src/utils/ids';
import type { PrismaClient } from '@prisma/client';

/** Small BigInt-based fake CostService (catalog prices, no DB). */
export function fakeCost(): CostService & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async calculate(input) {
      calls.push(input);
      const rows = PRICING.filter(p => p.provider === input.provider && p.model === input.model);
      const row = rows.sort((a, b) => b.version - a.version)[0];
      const fb = PRICING.find(p => p.provider === '*')!;
      const used = row ?? fb;
      const inM = parsePriceToMicro(used.input), outM = parsePriceToMicro(used.output), caM = parsePriceToMicro(used.cached);
      const inputCostPico = tokenCostPico(input.inputTokens, inM);
      const outputCostPico = tokenCostPico(input.outputTokens, outM);
      const cachedCostPico = tokenCostPico(input.cachedTokens ?? 0, caM);
      const totalCostPico = inputCostPico + outputCostPico + cachedCostPico;
      return {
        currency: 'USD' as const,
        inputCostUsd: picoToUsd(inputCostPico), outputCostUsd: picoToUsd(outputCostPico), cachedCostUsd: picoToUsd(cachedCostPico), totalCostUsd: picoToUsd(totalCostPico),
        costClass: row ? 'SIMULATED' as const : 'ESTIMATED' as const, unknownModel: !row,
        pricingConfigId: null, pricingVersion: used.version,
        pricing: { inputPerMTok: used.input, outputPerMTok: used.output, cachedPerMTok: used.cached },
        totalCostPico, inputCostPico, outputCostPico, cachedCostPico,
      };
    },
  };
}

export interface FakeBudgets extends BudgetService { calls: { projectId: string; at: Date; traceId?: string; spanId?: string }[]; alerts: BudgetAlertDto[] }
export function fakeBudgets(alerts: BudgetAlertDto[] = []): FakeBudgets {
  const calls: FakeBudgets['calls'] = [];
  return { calls, alerts, evaluateAfterUsage: async i => { calls.push(i); return alerts; }, evaluateAll: async () => [] };
}

export interface Rec { fn: string; [k: string]: unknown }
export interface RecordingInstr extends Instrumentation {
  calls: Rec[];
  names(): string[];
  spans: { spanId: string; traceId: string; parentSpanId: string | null; name: string; kind: string; source: Source; attributes: Record<string, unknown>; error?: unknown; endAttrs?: unknown }[];
  traces: { traceId: string; name: string; source: Source; projectId?: string; requestId?: string; endError?: unknown; ended: boolean }[];
  tasks: { name: string; kind: string; source: string; result?: unknown; error?: unknown; status: string }[];
}

/** Recording fake Instrumentation (no persistence). */
export function recordingInstr(): RecordingInstr {
  const calls: Rec[] = [];
  const spans: RecordingInstr['spans'] = [];
  const traces: RecordingInstr['traces'] = [];
  const tasks: RecordingInstr['tasks'] = [];
  const mkSpan = (traceId: string, parentSpanId: string | null, name: string, kind: string, source: Source, attributes: Record<string, unknown>, silent = false): SpanHandle => {
    const rec = { spanId: newSpanId(), traceId, parentSpanId, name, kind, source, attributes } as RecordingInstr['spans'][number];
    if (!silent) { spans.push(rec); calls.push({ fn: 'span.start', name, spanId: rec.spanId }); }
    let ended = false;
    const h: SpanHandle = {
      spanId: rec.spanId, traceId,
      startSpan: async (n, k, a = {}, o = {}) => mkSpan(traceId, rec.spanId, n, k, o.source ?? source, a),
      end: async (error, endAttrs) => { if (!ended) { ended = true; rec.error = error; rec.endAttrs = endAttrs; if (!silent) calls.push({ fn: 'span.end', name, spanId: rec.spanId, error: !!error }); } return 1; },
    };
    return h;
  };
  const instr: RecordingInstr = {
    calls, spans, traces, tasks,
    names: () => calls.map(c => (c.fn === 'span.start' || c.fn === 'span.end') ? `${c.fn}:${c.name}` : c.fn === 'recordActivity' ? `recordActivity:${c.type}` : c.fn),
    startTrace: async i => {
      const traceId = newTraceId();
      const t = { traceId, name: i.name, source: i.source, projectId: i.projectId, requestId: i.requestId, ended: false } as RecordingInstr['traces'][number];
      traces.push(t);
      calls.push({ fn: 'startTrace', name: i.name, traceId });
      const root = mkSpan(traceId, null, 'root:' + i.name, 'REQUEST', i.source, {}, true); // root not part of order checks
      const rootSpanId = root.spanId;
      const h: TraceHandle = {
        traceId, rootSpan: root,
        startSpan: async (n, k, a = {}, o = {}) => mkSpan(traceId, o.parent?.spanId ?? rootSpanId, n, k, o.source ?? i.source, a),
        end: async error => { if (!t.ended) { t.ended = true; t.endError = error; calls.push({ fn: 'trace.end', error: !!error, errorInfo: error }); } return 1; },
      };
      return h;
    },
    recordMemory: async i => { calls.push({ fn: 'recordMemory', ...i }); return i.operationId ?? `mem_${calls.length}`; },
    recordBus: async i => { calls.push({ fn: 'recordBus', ...i }); return i.operationId ?? `bus_${calls.length}`; },
    recordTool: async i => { calls.push({ fn: 'recordTool', ...i }); },
    recordContext: async i => { calls.push({ fn: 'recordContext', ...i }); },
    recordActivity: async i => { calls.push({ fn: 'recordActivity', ...i }); },
    recordError: async i => { calls.push({ fn: 'recordError', ...i }); },
    log: async i => { calls.push({ fn: 'log', ...i }); },
    startTask: async i => {
      const t = { name: i.name, kind: i.kind, source: i.source, status: 'RUNNING' } as RecordingInstr['tasks'][number];
      tasks.push(t);
      calls.push({ fn: 'startTask', kind: i.kind });
      return { id: `task_${tasks.length}`, succeed: async r => { t.status = 'SUCCEEDED'; t.result = r; }, fail: async e => { t.status = 'FAILED'; t.error = e; } };
    },
    withSpan: async (parent, name, kind, fn, o) => {
      const s = await parent.startSpan(name, kind, o?.attributes, { source: o?.source });
      try { const r = await fn(s); await s.end(); return r; } catch (e) { await s.end(e); throw e; }
    },
  };
  return instr;
}

export function fakeDeps(prisma: PrismaClient, base: AppDeps, over: Partial<AppDeps> = {}): AppDeps {
  return { ...base, cost: fakeCost(), budgets: fakeBudgets(), instr: recordingInstr(), ...over };
}

export async function makeProject(prisma: PrismaClient, name = `p-${Math.random().toString(36).slice(2, 8)}`, status = 'ACTIVE') {
  return prisma.project.create({ data: { name, status, archivedAt: status === 'ARCHIVED' ? new Date() : null } });
}

/** stringify every row of every table (BigInt safe) for privacy greps */
export async function dumpAllTables(prisma: PrismaClient): Promise<string> {
  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_prisma%' AND name NOT LIKE 'sqlite_%'");
  let out = '';
  for (const t of tables) {
    const rows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${t.name}"`);
    out += JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
  return out;
}
