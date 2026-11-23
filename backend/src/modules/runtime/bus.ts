/**
 * Real in-process event bus with instrumented operations (all recorded as ACTUAL bus events):
 *  - publish(event, payload): synchronously delivers to every subscriber (isolated: one failing subscriber never stops the others
 *    or the publisher). Records one PUBLISH op + one SUBSCRIBE op per delivery.
 *  - dispatch(event, payload): same fan-out but asynchronous (queued on setImmediate). Records DISPATCH (+ SUBSCRIBE per delivery).
 *  - request(event, payload): request/response to exactly one responder; records REQUEST; failures are recorded then rethrown.
 * Payload VALUES are never recorded; only key names, byte size and subscriber counts.
 */
import type { Instrumentation, SpanHandle, TraceHandle, ErrorInfo } from '../../contracts/instrumentation';
import type { BusOperationType } from '../../../../shared/types';
import { safeStringify } from '../../utils/serialize';
import { toErrorInfo } from '../../contracts/instrumentation';

export interface Scope {
  traceId?: string; projectId?: string; requestId?: string;
  /** trace + parent for child spans (optional) */
  trace?: TraceHandle; parentSpan?: SpanHandle;
  /** event clock (stays within the trace window); default real time */
  clock?: () => Date;
}
export const scopeClock = (s: Scope | undefined): Date => (s?.clock ? s.clock() : new Date());

type Handler = (payload: unknown, scope: Scope) => unknown | Promise<unknown>;
interface Sub { name: string; handler: Handler }

function payloadMeta(payload: unknown): { payloadKeys: string[]; payloadBytes: number } {
  let keys: string[] = [];
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) keys = Object.keys(payload as object).slice(0, 30).map(k => k.slice(0, 64));
  let bytes = 0;
  try { bytes = Buffer.byteLength(safeStringify(payload) ?? '', 'utf8'); } catch { bytes = 0; }
  return { payloadKeys: keys, payloadBytes: bytes };
}

export class EventBus {
  private subs = new Map<string, Sub[]>();
  private responders = new Map<string, Sub>();

  constructor(private readonly instr: Instrumentation) {}

  subscribe(event: string, name: string, handler: Handler): () => void {
    const list = this.subs.get(event) ?? [];
    const sub = { name, handler };
    list.push(sub);
    this.subs.set(event, list);
    return () => { const l = this.subs.get(event); if (l) this.subs.set(event, l.filter(s => s !== sub)); };
  }

  respond(event: string, name: string, handler: Handler): void {
    this.responders.set(event, { name, handler });
  }

  subscriberCount(event: string): number { return this.subs.get(event)?.length ?? 0; }

  private async span(scope: Scope, name: string, attrs: Record<string, unknown>): Promise<SpanHandle | undefined> {
    if (!scope.trace) return undefined;
    return (scope.parentSpan ?? scope.trace.rootSpan).startSpan(name, 'BUS', attrs, { source: 'ACTUAL' });
  }

  private corr(scope: Scope, span?: SpanHandle) {
    return { traceId: scope.traceId ?? scope.trace?.traceId, spanId: span?.spanId, projectId: scope.projectId, requestId: scope.requestId, at: scopeClock(scope) };
  }

  private async record(type: BusOperationType, event: string, scope: Scope, span: SpanHandle | undefined, rec: {
    name: string; success: boolean; outputStatus: string; durationMs: number; meta: Record<string, unknown>; error?: ErrorInfo;
  }) {
    await this.instr.recordBus({
      ...this.corr(scope, span), source: 'ACTUAL', operationName: `event-bus.${rec.name}`, operationType: type, eventName: event,
      inputMeta: rec.meta, outputStatus: rec.outputStatus, success: rec.success, durationMs: rec.durationMs,
      errorMessage: rec.error?.message, stack: rec.error?.stack,
    });
  }

  /** deliver to each subscriber in order; failures are recorded and isolated */
  private async deliver(event: string, payload: unknown, scope: Scope, span: SpanHandle | undefined, subs: Sub[]) {
    const failures: { name: string; error: ErrorInfo }[] = [];
    for (const s of subs) {
      const t0 = scopeClock(scope);
      try {
        await s.handler(payload, scope);
        await this.record('SUBSCRIBE', event, scope, span, { name: 'subscriber', success: true, outputStatus: 'handled', durationMs: Math.max(0, scopeClock(scope).getTime() - t0.getTime()), meta: { subscriber: s.name } });
      } catch (e) {
        const error = toErrorInfo(e);
        failures.push({ name: s.name, error });
        await this.record('SUBSCRIBE', event, scope, span, { name: 'subscriber', success: false, outputStatus: 'error', durationMs: Math.max(0, scopeClock(scope).getTime() - t0.getTime()), meta: { subscriber: s.name }, error });
      }
    }
    return failures;
  }

  async publish(event: string, payload: unknown, scope: Scope = {}): Promise<{ delivered: number; failed: number }> {
    const subs = [...(this.subs.get(event) ?? [])];
    const t0 = scopeClock(scope);
    const span = await this.span(scope, `bus.publish`, { eventName: event, subscribers: subs.length });
    const failures = await this.deliver(event, payload, scope, span, subs);
    const error = failures.length ? { message: `${failures.length} of ${subs.length} subscriber(s) failed: ${failures.map(f => f.name).join(', ')}`, category: 'BUS' as const } : undefined;
    await this.record('PUBLISH', event, scope, span, {
      name: 'publish', success: !error, outputStatus: subs.length === 0 ? 'no-subscribers' : error ? 'partial-failure' : 'delivered',
      durationMs: Math.max(0, scopeClock(scope).getTime() - t0.getTime()), meta: { ...payloadMeta(payload), subscribers: subs.length }, error,
    });
    await span?.end(error, { delivered: subs.length - failures.length, failed: failures.length });
    return { delivered: subs.length - failures.length, failed: failures.length };
  }

  /** asynchronous fan-out; resolves `settled` once every subscriber has run */
  dispatch(event: string, payload: unknown, scope: Scope = {}): { queued: Promise<void>; settled: Promise<{ delivered: number; failed: number }> } {
    const subs = [...(this.subs.get(event) ?? [])];
    const queued = this.record('DISPATCH', event, scope, undefined, {
      name: 'dispatch', success: true, outputStatus: subs.length === 0 ? 'no-subscribers' : 'queued', durationMs: 0, meta: { ...payloadMeta(payload), subscribers: subs.length },
    });
    const settled = (async () => {
      await queued;
      await new Promise<void>(r => setImmediate(r));
      const failures = await this.deliver(event, payload, scope, undefined, subs);
      return { delivered: subs.length - failures.length, failed: failures.length };
    })();
    return { queued, settled };
  }

  async request<R = unknown>(event: string, payload: unknown, scope: Scope = {}): Promise<R> {
    const responder = this.responders.get(event);
    const t0 = scopeClock(scope);
    const span = await this.span(scope, 'bus.request', { eventName: event });
    const meta = { ...payloadMeta(payload), responder: responder?.name ?? null };
    try {
      if (!responder) throw new Error(`No responder registered for bus event "${event}"`);
      const out = (await responder.handler(payload, scope)) as R;
      await this.record('REQUEST', event, scope, span, { name: 'request', success: true, outputStatus: 'responded', durationMs: Math.max(0, scopeClock(scope).getTime() - t0.getTime()), meta });
      await span?.end();
      return out;
    } catch (e) {
      const error = toErrorInfo(e);
      await this.record('REQUEST', event, scope, span, { name: 'request', success: false, outputStatus: 'error', durationMs: Math.max(0, scopeClock(scope).getTime() - t0.getTime()), meta, error: { ...error, category: 'BUS' } });
      await span?.end({ ...error, category: 'BUS' });
      throw e;
    }
  }
}
