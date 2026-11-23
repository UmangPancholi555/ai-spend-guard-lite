import type { Instrumentation, SpanHandle, TraceHandle } from './instrumentation';
import { newSpanId, newTraceId } from '../utils/ids';

/** In-memory no-op Instrumentation for early unit tests. Real one: modules/instrumentation. */
export function createNoopInstrumentation(): Instrumentation {
  const span = (traceId: string): SpanHandle => {
    const h: SpanHandle = {
      spanId: newSpanId(), traceId,
      startSpan: async () => span(traceId),
      end: async () => 0,
    };
    return h;
  };
  return {
    startTrace: async () => {
      const traceId = newTraceId();
      const root = span(traceId);
      const t: TraceHandle = { traceId, rootSpan: root, startSpan: async () => span(traceId), end: async () => 0 };
      return t;
    },
    recordMemory: async i => i.operationId ?? 'noop',
    recordBus: async i => i.operationId ?? 'noop',
    recordTool: async () => {}, recordContext: async () => {}, recordActivity: async () => {},
    recordError: async () => {}, log: async () => {},
    startTask: async () => ({ id: 'noop', succeed: async () => {}, fail: async () => {} }),
    withSpan: async (_p, _n, _k, fn) => fn(span('noop')),
  };
}
