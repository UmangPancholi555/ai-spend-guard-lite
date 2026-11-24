import { describe, it, expect } from 'vitest';
import { buildTimeline, type TimelineInput } from '../../src/modules/traces/timeline';
import type { ExecutionLogDto, MemoryEventDto, SpanDto, TraceDto } from '../../../shared/types';

const trace = (o: Partial<TraceDto> = {}): TraceDto => ({
  traceId: 't1', name: 'run', projectId: null, requestId: null, status: 'OK', source: 'ACTUAL', startedAt: '2025-01-01T00:00:00.000Z',
  endedAt: '2025-01-01T00:00:01.000Z', durationMs: 1000, errorMessage: null, stack: null, spanCount: 0, ...o,
});
const span = (o: Partial<SpanDto>): SpanDto => ({
  spanId: 's', traceId: 't1', parentSpanId: 'root', name: 'n', kind: 'INTERNAL', status: 'OK', source: 'ACTUAL',
  startedAt: '2025-01-01T00:00:00.100Z', endedAt: null, durationMs: null, errorMessage: null, stack: null, attributes: {}, ...o,
});
const log = (o: Partial<ExecutionLogDto>): ExecutionLogDto => ({
  id: 'l1', ts: '2025-01-01T00:00:00.500Z', level: 'INFO', eventType: 'x', category: 'SYSTEM', operation: 'op', status: 'SUCCESS', source: 'ACTUAL',
  traceId: 't1', spanId: null, requestId: null, projectId: null, durationMs: null, message: 'm', attributes: {}, errorCategory: null, errorMessage: null, stack: null, ...o,
});
const mem = (o: Partial<MemoryEventDto>): MemoryEventDto => ({
  id: 'm1', operationId: 'op1', phase: 'COMPLETED', status: 'SUCCESS', source: 'SIMULATED', memorySource: 'ms', category: 'c', itemCount: 1, estimatedTokens: 5,
  payloadBytes: 10, durationMs: 7, errorMessage: null, traceId: 't1', spanId: null, projectId: null, createdAt: '2025-01-01T00:00:00.300Z', ...o,
});
const input = (o: Partial<TimelineInput>): TimelineInput => ({ trace: trace(), spans: [], memory: [], bus: [], tools: [], contexts: [], logs: [], ...o });
const rootSpan = span({ spanId: 'root', parentSpanId: null, name: 'run', kind: 'REQUEST' });

describe('buildTimeline', () => {
  it('emits only execution.started for a RUNNING trace and does not emit the root span separately', () => {
    const tl = buildTimeline(input({ trace: trace({ status: 'RUNNING', endedAt: null, durationMs: null }), spans: [rootSpan] }));
    expect(tl.map(e => e.step)).toEqual(['execution.started']);
    expect(tl[0].spanId).toBe('root');
  });

  it('failed memory injection is FAILURE with errorMessage from event, falling back to the merged span', () => {
    const tl = buildTimeline(input({
      spans: [rootSpan, span({ spanId: 'sm', kind: 'MEMORY', status: 'ERROR', errorMessage: 'span boom', durationMs: 40 })],
      memory: [mem({ phase: 'FAILED', status: 'FAILURE', spanId: 'sm', durationMs: null })],
    }));
    const f = tl.find(e => e.step === 'memory.injection.failed')!;
    expect(f).toMatchObject({ status: 'FAILURE', errorMessage: 'span boom', durationMs: 40, source: 'SIMULATED' });
    expect(tl.some(e => e.step === 'span')).toBe(false);
  });

  it('R3: keyed log matching is 1:1 by operationId+phase; unmatched logs are kept', () => {
    const tl = buildTimeline(input({
      memory: [mem({ id: 'm1', phase: 'COMPLETED', operationId: 'op1' })],
      logs: [
        log({ id: 'a', category: 'MEMORY', eventType: 'memory.injection.completed', attributes: { operationId: 'op1' } }), // matched
        log({ id: 'b', category: 'MEMORY', eventType: 'memory.injection.completed', attributes: { operationId: 'op1' }, ts: '2025-01-01T00:00:00.600Z' }), // second one: no twin left -> kept
        log({ id: 'c', category: 'MEMORY', eventType: 'memory.injection.started', attributes: { operationId: 'op1' } }), // wrong phase -> kept
      ],
    }));
    const kept = tl.filter(e => e.refKind === 'log').map(e => e.refId);
    expect(kept).toEqual(['c', 'b']);
    expect(tl.find(e => e.refId === 'c')!.step).toBe('memory.injection.started');
  });

  it('provenance: a SIMULATED provider span yields a SIMULATED response.generated entry while the ACTUAL trace/spans keep ACTUAL', () => {
    const tl = buildTimeline(input({
      spans: [
        rootSpan,
        span({ spanId: 'p', name: 'provider.mock', kind: 'PROVIDER', source: 'SIMULATED', endedAt: '2025-01-01T00:00:00.400Z' }),
        span({ spanId: 'c', name: 'cost.calculate', kind: 'COST', source: 'ACTUAL' }),
      ],
    }));
    expect(tl.find(e => e.step === 'response.generated')).toMatchObject({ label: 'Response generated (provider.mock)', source: 'SIMULATED' });
    expect(tl.find(e => e.step === 'span' && e.label === 'cost.calculate')!.source).toBe('ACTUAL');
    expect(tl.filter(e => e.step.startsWith('execution.')).every(e => e.source === 'ACTUAL')).toBe(true);
  });

  it('R5/R6: error-log duplicates of the trace failure are dropped, response.generated log deduped by span', () => {
    const tl = buildTimeline(input({
      trace: trace({ status: 'ERROR', errorMessage: 'bad' }),
      spans: [rootSpan, span({ spanId: 'p', kind: 'PROVIDER', endedAt: '2025-01-01T00:00:00.400Z' })],
      logs: [
        log({ id: 'e1', category: 'ERROR', status: 'FAILURE', level: 'ERROR', errorMessage: 'bad', spanId: 'root' }),
        log({ id: 'e2', category: 'ERROR', status: 'FAILURE', level: 'ERROR', errorMessage: 'different', spanId: null }),
        log({ id: 'r1', eventType: 'response.generated', spanId: 'p' }),
        log({ id: 'life', eventType: 'request.completed' }),
      ],
    }));
    expect(tl.filter(e => e.refKind === 'log').map(e => e.refId)).toEqual(['e2']);
    expect(tl.filter(e => e.step === 'response.generated')).toHaveLength(1);
    expect(tl.find(e => e.refId === 'e2')).toMatchObject({ status: 'FAILURE', errorMessage: 'different', step: 'other' });
    expect(tl[tl.length - 1].step).toBe('execution.failed');
  });

  it('is deterministic regardless of input order (ties broken by step rank, then ids)', () => {
    const a = input({ logs: [log({ id: 'z', ts: '2025-01-01T00:00:00.500Z' }), log({ id: 'y', ts: '2025-01-01T00:00:00.500Z' })] });
    const b = input({ logs: [...a.logs].reverse() });
    expect(buildTimeline(a)).toEqual(buildTimeline(b));
  });

  it('tie at the same timestamp: started before others, completed last', () => {
    const t = '2025-01-01T00:00:01.000Z';
    const tl = buildTimeline(input({ trace: trace({ startedAt: t, endedAt: t, durationMs: 0 }), logs: [log({ ts: t })] }));
    expect(tl.map(e => e.step)).toEqual(['execution.started', 'other', 'execution.completed']);
  });
});
