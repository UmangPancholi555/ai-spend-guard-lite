/**
 * Execution timeline builder (pure; no DB). Merges a trace's spans, typed events (memory/bus/tool/context) and
 * ExecutionLogs into one chronologically sorted TimelineEntry[].
 *
 * DEDUPE RULES (deterministic; applied in this order)
 *  R1  Trace row -> `execution.started` (at trace.startedAt) and, when finished, `execution.completed` | `execution.failed`
 *      (at trace.endedAt; failed when trace.status = ERROR, carrying trace.errorMessage). The ROOT span (parentSpanId = null,
 *      earliest startedAt) is represented by these two entries and never emitted as a separate `span` row.
 *  R2  Typed events are the source of truth for memory/bus/tool/context. A (non-root) span referenced by `spanId` from at least one
 *      typed event is MERGED into that event (its name/kind go into details; its duration/error fill gaps) and is NOT emitted again.
 *      Spans no typed event points to stay as `span` rows (or `response.generated` for successful PROVIDER / `response*` spans).
 *  R3  ExecutionLogs mirror every typed record. A log is dropped when it matches a typed event of the same kind:
 *        1) by key found in log.attributes: memory -> operationId (+phase from eventType suffix .started/.completed/.failed),
 *           bus -> operationId, tool -> toolCallId (a tool row absorbs any number of logs: initiated + result),
 *           context -> contextId (+version when present);
 *        2) else by identical non-null spanId within 5s (memory also requires compatible phase).
 *      Keyed matches are 1:1 (closest timestamp wins, ties by id) except tool rows.
 *  R4  Lifecycle logs (execution.* / request.* / trace.* eventTypes) duplicate R1 and are dropped.
 *  R5  A log whose errorMessage equals the errorMessage of an already emitted non-log entry on the same non-null spanId, or equals the
 *      trace's errorMessage (with spanId null or = root span), duplicates that failure and is dropped.
 *  R6  A `response.generated` log is dropped when a response.generated entry already exists for the same non-null spanId.
 *  Anything left (e.g. REQUEST/BUDGET/PROVIDER logs, or logs without a typed twin) is kept so nothing real is hidden;
 *  its step comes from log.eventType when that is one of the contract steps, else `other`.
 *
 * ORDER: ts asc, then step rank (started -> ... -> completed/failed), then refKind/refId/label for full determinism.
 * Failed entries always have status FAILURE and carry errorMessage. Every entry carries `source`.
 */
import type {
  BusEventDto, ContextEventDto, ExecutionLogDto, MemoryEventDto, SpanDto, TimelineEntry, ToolCallEventDto, TraceDto,
} from '../../../../shared/types';

export interface TimelineInput {
  trace: TraceDto; spans: SpanDto[]; memory: MemoryEventDto[]; bus: BusEventDto[]; tools: ToolCallEventDto[];
  contexts: ContextEventDto[]; logs: ExecutionLogDto[];
}
type Step = TimelineEntry['step'];

const STEP_RANK: Record<Step, number> = {
  'execution.started': 0, 'context.initialized': 1, 'memory.injection.started': 2, 'memory.injection.completed': 3,
  'memory.injection.failed': 3, 'bus.operation': 4, 'tool.call.initiated': 5, 'tool.call.completed': 6, 'tool.call.failed': 6,
  'context.event': 7, span: 8, other: 8, 'response.generated': 9, 'execution.completed': 10, 'execution.failed': 10,
};
const CONTRACT_STEPS = new Set<string>(Object.keys(STEP_RANK).filter(s => s !== 'span' && s !== 'other'));
const LIFECYCLE_EVENT_TYPES = new Set([
  'execution.started', 'execution.completed', 'execution.failed', 'request.started', 'request.completed', 'request.failed',
  'trace.started', 'trace.completed', 'trace.failed', 'trace.ended',
]);
const LOG_KIND: Record<string, 'memory' | 'bus' | 'tool' | 'context'> = { MEMORY: 'memory', BUS: 'bus', TOOL: 'tool', CONTEXT: 'context' };
const SPAN_MATCH_WINDOW_MS = 5000;

const ms = (iso: string) => new Date(iso).getTime();
const fromMs = (n: number) => new Date(n).toISOString();
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

interface Typed { kind: 'memory' | 'bus' | 'tool' | 'context'; id: string; tsMs: number; spanId: string | null; key: string; phase?: string; version?: number; used: boolean }

export function buildTimeline(inp: TimelineInput): TimelineEntry[] {
  const { trace } = inp;
  const out: TimelineEntry[] = [];
  const spanById = new Map(inp.spans.map(s => [s.spanId, s]));
  const root = [...inp.spans].filter(s => !s.parentSpanId).sort((a, b) => ms(a.startedAt) - ms(b.startedAt) || a.spanId.localeCompare(b.spanId))[0] ?? null;
  const claimed = new Set<string>();
  /** R2: returns the non-root span a typed event points to and marks it merged */
  const merge = (spanId: string | null) => {
    if (!spanId || spanId === root?.spanId) return null;
    const s = spanById.get(spanId) ?? null;
    if (s) claimed.add(s.spanId);
    return s;
  };
  const spanDetails = (s: ReturnType<typeof merge>) => (s ? { spanName: s.name, spanKind: s.kind } : {});

  // R1 ------------------------------------------------------------
  out.push({
    ts: trace.startedAt, step: 'execution.started', label: `Execution started: ${trace.name}`, status: 'STARTED', source: trace.source,
    durationMs: null, spanId: root?.spanId ?? null, refKind: 'span', refId: root?.spanId ?? null, errorMessage: null,
    details: { traceName: trace.name, requestId: trace.requestId, projectId: trace.projectId },
  });
  if (trace.status !== 'RUNNING') {
    const failed = trace.status === 'ERROR';
    const endTs = trace.endedAt ?? (trace.durationMs !== null ? fromMs(ms(trace.startedAt) + trace.durationMs) : trace.startedAt);
    out.push({
      ts: endTs, step: failed ? 'execution.failed' : 'execution.completed',
      label: failed ? `Execution failed: ${trace.name}` : `Execution completed: ${trace.name}`,
      status: failed ? 'FAILURE' : 'SUCCESS', source: trace.source, durationMs: trace.durationMs, spanId: root?.spanId ?? null,
      refKind: 'span', refId: root?.spanId ?? null, errorMessage: failed ? trace.errorMessage ?? root?.errorMessage ?? null : null,
      details: { traceName: trace.name },
    });
  }

  // R2: typed events ------------------------------------------------
  const typed: Typed[] = [];
  for (const m of inp.memory) {
    const sp = merge(m.spanId);
    const step: Step = m.phase === 'STARTED' ? 'memory.injection.started' : m.phase === 'COMPLETED' ? 'memory.injection.completed' : 'memory.injection.failed';
    const status: TimelineEntry['status'] = m.phase === 'FAILED' ? 'FAILURE' : m.phase === 'STARTED' ? 'STARTED' : m.status === 'FAILURE' ? 'FAILURE' : 'SUCCESS';
    const label = m.phase === 'STARTED' ? `Memory injection started (${m.memorySource}/${m.category})`
      : m.phase === 'COMPLETED' ? `Memory injection completed: ${m.itemCount} items, ~${m.estimatedTokens} tokens`
        : `Memory injection failed (${m.memorySource}/${m.category})`;
    out.push({
      ts: m.createdAt, step, label, status, source: m.source, durationMs: m.durationMs ?? (m.phase !== 'STARTED' ? sp?.durationMs ?? null : null),
      spanId: m.spanId, refKind: 'memory', refId: m.id,
      errorMessage: status === 'FAILURE' ? m.errorMessage ?? sp?.errorMessage ?? null : null,
      details: { operationId: m.operationId, phase: m.phase, memorySource: m.memorySource, category: m.category, itemCount: m.itemCount, estimatedTokens: m.estimatedTokens, payloadBytes: m.payloadBytes, ...spanDetails(sp) },
    });
    typed.push({ kind: 'memory', id: m.id, tsMs: ms(m.createdAt), spanId: m.spanId, key: m.operationId, phase: m.phase, used: false });
  }
  for (const b of inp.bus) {
    const sp = merge(b.spanId);
    const failed = b.status === 'FAILURE';
    out.push({
      ts: b.createdAt, step: 'bus.operation', label: `Bus ${b.operationType} ${b.eventName} (${b.operationName})`, status: failed ? 'FAILURE' : 'SUCCESS',
      source: b.source, durationMs: b.durationMs ?? sp?.durationMs ?? null, spanId: b.spanId, refKind: 'bus', refId: b.id,
      errorMessage: failed ? b.errorMessage ?? sp?.errorMessage ?? null : null,
      details: { operationId: b.operationId, operationName: b.operationName, operationType: b.operationType, eventName: b.eventName, outputStatus: b.outputStatus, inputMeta: b.inputMeta, ...spanDetails(sp) },
    });
    typed.push({ kind: 'bus', id: b.id, tsMs: ms(b.createdAt), spanId: b.spanId, key: b.operationId, used: false });
  }
  for (const t of inp.tools) {
    const sp = merge(t.spanId);
    const failed = t.status === 'FAILURE';
    const startMs = ms(t.startedAt);
    const dur = t.durationMs ?? sp?.durationMs ?? null;
    const endMs = Math.max(startMs, t.endedAt ? ms(t.endedAt) : dur !== null ? startMs + dur : ms(t.createdAt));
    const attempt = t.maxRetries > 0 ? ` (attempt ${t.retryCount + 1}/${t.maxRetries + 1})` : '';
    const common = { source: t.source, spanId: t.spanId, refKind: 'tool' as const, refId: t.id };
    out.push({
      ...common, ts: t.startedAt, step: 'tool.call.initiated', label: `Tool call initiated: ${t.toolName}${attempt}`, status: 'STARTED', durationMs: null,
      errorMessage: null, details: { toolCallId: t.toolCallId, toolName: t.toolName, retryCount: t.retryCount, maxRetries: t.maxRetries, inputMeta: t.inputMeta, ...spanDetails(sp) },
    });
    out.push({
      ...common, ts: fromMs(endMs), step: failed ? 'tool.call.failed' : 'tool.call.completed',
      label: `Tool call ${failed ? 'failed' : 'completed'}: ${t.toolName}${attempt}`, status: failed ? 'FAILURE' : 'SUCCESS', durationMs: dur,
      errorMessage: failed ? t.errorMessage ?? sp?.errorMessage ?? null : null,
      details: { toolCallId: t.toolCallId, toolName: t.toolName, retryCount: t.retryCount, maxRetries: t.maxRetries, outputMeta: t.outputMeta, ...spanDetails(sp) },
    });
    typed.push({ kind: 'tool', id: t.id, tsMs: startMs, spanId: t.spanId, key: t.toolCallId, used: false });
  }
  for (const c of inp.contexts) {
    const sp = merge(c.spanId);
    const failed = c.status === 'FAILURE';
    const init = c.operation === 'CREATED';
    out.push({
      ts: c.createdAt, step: init ? 'context.initialized' : 'context.event',
      label: init ? `Context initialized (${c.contextSource})` : `Context ${c.operation.toLowerCase()} v${c.version} (${c.contextSource})`,
      status: failed ? 'FAILURE' : 'SUCCESS', source: c.source, durationMs: c.durationMs ?? sp?.durationMs ?? null, spanId: c.spanId, refKind: 'context', refId: c.id,
      errorMessage: failed ? c.errorMessage ?? sp?.errorMessage ?? null : null,
      details: { contextId: c.contextId, operation: c.operation, contextSource: c.contextSource, sizeBytes: c.sizeBytes, estimatedTokens: c.estimatedTokens, version: c.version, ...spanDetails(sp) },
    });
    typed.push({ kind: 'context', id: c.id, tsMs: ms(c.createdAt), spanId: c.spanId, key: c.contextId, version: c.version, used: false });
  }

  // remaining spans ---------------------------------------------------
  for (const s of inp.spans) {
    if (s === root || claimed.has(s.spanId)) continue;
    const isResponse = s.status === 'OK' && (s.kind === 'PROVIDER' || /^response/i.test(s.name));
    const status: TimelineEntry['status'] = s.status === 'ERROR' ? 'FAILURE' : s.status === 'RUNNING' ? 'STARTED' : 'SUCCESS';
    out.push({
      ts: isResponse ? s.endedAt ?? s.startedAt : s.startedAt, step: isResponse ? 'response.generated' : 'span',
      label: isResponse ? `Response generated (${s.name})` : s.name, status, source: s.source, durationMs: s.durationMs, spanId: s.spanId,
      refKind: 'span', refId: s.spanId, errorMessage: status === 'FAILURE' ? s.errorMessage : null,
      details: { name: s.name, kind: s.kind, parentSpanId: s.parentSpanId, attributes: s.attributes },
    });
  }

  // logs (R3-R6) --------------------------------------------------------
  const nonLog = [...out];
  const logs = [...inp.logs].sort((a, b) => ms(a.ts) - ms(b.ts) || a.id.localeCompare(b.id));
  for (const l of logs) {
    if (LIFECYCLE_EVENT_TYPES.has(l.eventType)) continue; // R4
    if (matchTyped(l, typed)) continue; // R3
    if (l.errorMessage) { // R5
      const dupSpan = l.spanId && nonLog.some(e => e.spanId === l.spanId && e.errorMessage === l.errorMessage);
      const dupTrace = trace.errorMessage === l.errorMessage && (!l.spanId || l.spanId === root?.spanId);
      if (dupSpan || dupTrace) continue;
    }
    const step: Step = CONTRACT_STEPS.has(l.eventType) ? (l.eventType as Step) : l.eventType === 'context.updated' ? 'context.event' : 'other';
    if (step === 'response.generated' && l.spanId && out.some(e => e.step === 'response.generated' && e.spanId === l.spanId)) continue; // R6
    const failed = l.status === 'FAILURE' || l.level === 'ERROR';
    out.push({
      ts: l.ts, step, label: l.message || l.operation, status: failed ? 'FAILURE' : l.status, source: l.source, durationMs: l.durationMs,
      spanId: l.spanId, refKind: 'log', refId: l.id, errorMessage: failed ? l.errorMessage : null,
      details: { eventType: l.eventType, category: l.category, level: l.level, operation: l.operation, errorCategory: l.errorCategory, attributes: l.attributes },
    });
  }

  return out.sort((a, b) =>
    ms(a.ts) - ms(b.ts) || STEP_RANK[a.step] - STEP_RANK[b.step] ||
    a.refKind.localeCompare(b.refKind) || (a.refId ?? '').localeCompare(b.refId ?? '') || a.label.localeCompare(b.label));
}

function logPhase(eventType: string): string | null {
  if (eventType.endsWith('.started')) return 'STARTED';
  if (eventType.endsWith('.completed')) return 'COMPLETED';
  if (eventType.endsWith('.failed')) return 'FAILED';
  return null;
}

/** R3: find (and consume) the typed event this mirror log duplicates */
function matchTyped(l: ExecutionLogDto, typed: Typed[]): boolean {
  const kind = LOG_KIND[l.category];
  if (!kind) return false;
  const phase = kind === 'memory' ? logPhase(l.eventType) : null;
  const keyName = kind === 'memory' || kind === 'bus' ? 'operationId' : kind === 'tool' ? 'toolCallId' : 'contextId';
  const key = str(l.attributes[keyName]);
  const lMs = ms(l.ts);
  const pool = typed.filter(t => t.kind === kind && (kind === 'tool' || !t.used));
  let cands: Typed[];
  if (key) {
    cands = pool.filter(t => t.key === key && (!phase || !t.phase || t.phase === phase));
    if (kind === 'context' && typeof l.attributes.version === 'number') cands = cands.filter(t => t.version === l.attributes.version);
  } else {
    cands = pool.filter(t => l.spanId !== null && t.spanId === l.spanId && Math.abs(t.tsMs - lMs) <= SPAN_MATCH_WINDOW_MS && (!phase || !t.phase || t.phase === phase));
  }
  if (!cands.length) return false;
  cands.sort((a, b) => Math.abs(a.tsMs - lMs) - Math.abs(b.tsMs - lMs) || a.id.localeCompare(b.id));
  if (kind !== 'tool') cands[0].used = true;
  return true;
}
