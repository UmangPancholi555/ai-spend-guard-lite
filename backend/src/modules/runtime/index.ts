/**
 * Runtime module (wave 2): REAL in-app components - MemoryStore, ContextManager, ToolExecutor, EventBus - instrumented as ACTUAL.
 * `getRuntime(deps)` wires (and caches per deps object) the components and registers them in the runtime registry that backs
 * GET /observability/sources. `getRuntime(deps, {silent:true})` shares the same behaviour but records nothing (bulk demo seeding).
 */
import type { AppDeps } from '../../contracts/services';
import { createNoopInstrumentation } from '../../contracts/noop';
import type { Instrumentation } from '../../contracts/instrumentation';
import { EventBus } from './bus';
import { MemoryStore } from './memory';
import { ContextManager } from './context';
import { ToolExecutor } from './tools';
import { runtimeRegistry } from './registry';

export interface Runtime {
  readonly instr: Instrumentation;
  readonly bus: EventBus;
  readonly memory: MemoryStore;
  readonly contexts: ContextManager;
  readonly tools: ToolExecutor;
  readonly silent: boolean;
}

const cache = new WeakMap<AppDeps, { full?: Runtime; silent?: Runtime }>();

function build(deps: AppDeps, silent: boolean): Runtime {
  const instr = silent ? createNoopInstrumentation() : deps.instr;
  const bus = new EventBus(instr);
  const rt: Runtime = {
    instr, bus, silent,
    memory: new MemoryStore(deps.prisma),
    contexts: new ContextManager(instr),
    tools: new ToolExecutor(instr, { prisma: deps.prisma, cost: deps.cost }),
  };
  // real subscribers / responders of the request pipeline events
  const activity = async (p: unknown) => { await instr.recordActivity(p as Parameters<Instrumentation['recordActivity']>[0]); };
  bus.subscribe('usage.recorded', 'activity-recorder', activity);
  bus.subscribe('request.failed', 'activity-recorder', activity);
  bus.respond('budget.evaluate', 'budget-engine', async p => deps.budgets.evaluateAfterUsage(p as Parameters<AppDeps['budgets']['evaluateAfterUsage']>[0]));
  return rt;
}

export function getRuntime(deps: AppDeps, opts: { silent?: boolean } = {}): Runtime {
  const entry = cache.get(deps) ?? {};
  cache.set(deps, entry);
  if (opts.silent) return (entry.silent ??= build(deps, true));
  if (!entry.full) {
    entry.full = build(deps, false);
    registerRuntimeComponents();
  }
  return entry.full;
}

/** Register the REAL components that exist in this app (idempotent). Only call for components that are really wired. */
export function registerRuntimeComponents(): void {
  const r = runtimeRegistry;
  r.register({ kind: 'bus', name: 'In-process event bus', description: 'Real in-process pub/sub (publish/subscribe/request/dispatch). The request pipeline publishes usage.recorded/request.failed and requests budget.evaluate over it.' });
  r.register({ kind: 'memory', name: 'Project memory store', description: 'Real SQLite-backed project memory; enabled items are injected into the request context. Content is never logged.' });
  r.register({ kind: 'context', name: 'Request context manager', description: 'Real per-request context (prompt + injected memory + response usage) with versioned lifecycle events and window truncation.' });
  r.register({ kind: 'tool', name: 'Local tool executor', description: 'Real local tools (pricing.lookup, budget.status, usage.summary) invoked by the pipeline and via POST /tools/:name/invoke.' });
  r.register({ kind: 'error', name: 'Error recording', description: 'Real error recording: the HTTP error handler and the request pipeline record ACTUAL error events.' });
}

export { createRuntimeRouter } from './router';
export { runtimeRegistry, RuntimeRegistry } from './registry';
export type { RuntimeKind } from './registry';
export { EventBus } from './bus';
export type { Scope } from './bus';
export { MemoryStore, planInjection, fitToBudget } from './memory';
export { ContextManager, RequestContext } from './context';
export { ToolExecutor, TransientToolError, BUILTIN_TOOLS } from './tools';
export type { ToolDef } from './tools';
export { makeClock } from './clock';
