/**
 * Real request ContextManager. Builds the actual context object of ONE provider request (prompt + injected memory + response
 * usage) and records every real mutation as an ACTUAL context event with strictly increasing versions:
 *   CREATED  v1  prompt received (size/tokens)
 *   ADDED    v2  project memory injected (size/tokens of the memory block)
 *   MODIFIED v3  only when the context really was truncated to fit the model window (memory items dropped)
 *   UPDATED  vN  response/usage appended after the provider call
 * Context CONTENT is held in memory only for the duration of the request and is never persisted or logged.
 */
import type { Instrumentation, SpanHandle } from '../../contracts/instrumentation';
import { newRequestId } from '../../utils/ids';
import { estimateTokens } from '../providers/mock/engine';
import { scopeClock, type Scope } from './bus';

export class RequestContext {
  readonly contextId = newRequestId('ctx');
  version = 0;
  sizeBytes = 0;
  estimatedTokens = 0;
  truncated = false;
  windowTokens = 0;

  constructor(private readonly instr: Instrumentation, private readonly scope: Scope) {}

  private async emit(operation: 'CREATED' | 'UPDATED' | 'ADDED' | 'MODIFIED', contextSource: string, attrs: Record<string, unknown>, failure?: string) {
    this.version += 1;
    const t0 = scopeClock(this.scope);
    const parent = this.scope.parentSpan ?? this.scope.trace?.rootSpan;
    const span: SpanHandle | undefined = parent
      ? await parent.startSpan(`context.${operation.toLowerCase()}`, 'CONTEXT', { contextId: this.contextId, version: this.version, sizeBytes: this.sizeBytes, ...attrs }, { source: 'ACTUAL' })
      : undefined;
    await this.instr.recordContext({
      traceId: this.scope.traceId ?? this.scope.trace?.traceId, spanId: span?.spanId, projectId: this.scope.projectId, requestId: this.scope.requestId,
      at: scopeClock(this.scope), source: 'ACTUAL', contextId: this.contextId, operation, contextSource,
      sizeBytes: this.sizeBytes, estimatedTokens: this.estimatedTokens, version: this.version,
      success: failure === undefined, errorMessage: failure, durationMs: Math.max(0, scopeClock(this.scope).getTime() - t0.getTime()),
    });
    await span?.end(failure ? { message: failure, category: 'CONTEXT' } : undefined);
  }

  /** v1: the request prompt */
  async create(prompt: { chars: number; bytes: number }): Promise<void> {
    this.sizeBytes = prompt.bytes;
    this.estimatedTokens = estimateTokens(prompt.chars);
    await this.emit('CREATED', 'request-prompt', { promptChars: prompt.chars });
  }

  /** memory block added to the context */
  async addMemory(m: { bytes: number; tokens: number; items: number }): Promise<void> {
    this.sizeBytes += m.bytes;
    this.estimatedTokens += m.tokens;
    await this.emit('ADDED', 'project-memory', { items: m.items, addedTokens: m.tokens });
  }

  /** memory trimmed to fit the model window */
  async truncate(t: { removedBytes: number; removedTokens: number; droppedItems: number; windowTokens: number }): Promise<void> {
    this.sizeBytes = Math.max(0, this.sizeBytes - t.removedBytes);
    this.estimatedTokens = Math.max(0, this.estimatedTokens - t.removedTokens);
    this.truncated = true;
    await this.emit('MODIFIED', 'window-truncation', { droppedItems: t.droppedItems, removedTokens: t.removedTokens, windowTokens: t.windowTokens });
  }

  /** response + usage appended once the provider call returned (or failed: size stays, usage only) */
  async appendResponse(r: { bytes: number; outputTokens: number; failed: boolean }): Promise<void> {
    this.sizeBytes += r.bytes;
    this.estimatedTokens += r.outputTokens;
    await this.emit('UPDATED', r.failed ? 'provider-error' : 'provider-response', { outputTokens: r.outputTokens, failed: r.failed });
  }
}

export class ContextManager {
  constructor(private readonly instr: Instrumentation) {}
  forRequest(scope: Scope): RequestContext { return new RequestContext(this.instr, scope); }
}
