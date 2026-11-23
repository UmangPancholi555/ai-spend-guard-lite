import type { PrismaClient } from '@prisma/client';
import type { InstrumentationSourceDto } from '../../../../shared/types';
import { ERROR_WHERE } from './overview';
import { runtimeRegistry, type RuntimeRegistry } from '../runtime/registry';

type Counts = { actual: number; simulated: number; last: Date | null };

function groupCounts(
  rows: { source: string; _count: { _all: number }; _max: Record<string, Date | null> }[], tsKey: string,
): Counts {
  const c: Counts = { actual: 0, simulated: 0, last: null };
  for (const r of rows) {
    if (r.source === 'ACTUAL') c.actual += r._count._all; else c.simulated += r._count._all;
    const m = r._max[tsKey];
    if (m && (!c.last || m > c.last)) c.last = m;
  }
  return c;
}

/**
 * Honest instrumentation registry. Counts always come from the DB (ACTUAL vs SIMULATED split by the `source` column).
 * Status rules (kind -> status), driven by the runtime component registry (modules/runtime/registry):
 *  - a kind is CONNECTED only if a REAL in-app component registered itself for it (even with zero events; the note says so).
 *    request: lifecycle middleware; bus/memory/tool/context: the runtime EventBus / MemoryStore / ToolExecutor / ContextManager;
 *    error: error recording of the HTTP error handler + request pipeline.
 *  - an unregistered kind is never CONNECTED: SIMULATED_ONLY when only simulator rows exist, otherwise UNAVAILABLE
 *    (rows labelled ACTUAL without a registered component are flagged as unverified).
 *  - the DEMO simulator is reported as its own entry (always SIMULATED_ONLY; counts = every SIMULATED row of the typed event tables).
 */
export async function getSources(prisma: PrismaClient, registry: RuntimeRegistry = runtimeRegistry): Promise<InstrumentationSourceDto[]> {
  const [req, err, mem, bus, tool, ctx] = await Promise.all([
    prisma.executionLog.groupBy({ by: ['source'], where: { category: { in: ['REQUEST', 'PROVIDER'] } }, _count: { _all: true }, _max: { ts: true } }),
    prisma.executionLog.groupBy({ by: ['source'], where: ERROR_WHERE, _count: { _all: true }, _max: { ts: true } }),
    prisma.memoryEvent.groupBy({ by: ['source'], where: { phase: { in: ['COMPLETED', 'FAILED'] } }, _count: { _all: true }, _max: { createdAt: true } }),
    prisma.busEvent.groupBy({ by: ['source'], _count: { _all: true }, _max: { createdAt: true } }),
    prisma.toolCallEvent.groupBy({ by: ['source'], _count: { _all: true }, _max: { createdAt: true } }),
    prisma.contextEvent.groupBy({ by: ['source'], _count: { _all: true }, _max: { createdAt: true } }),
  ]);
  const rq = groupCounts(req, 'ts'), er = groupCounts(err, 'ts'), me = groupCounts(mem, 'createdAt');
  const bu = groupCounts(bus, 'createdAt'), to = groupCounts(tool, 'createdAt'), cx = groupCounts(ctx, 'createdAt');

  const entry = (
    id: string, kind: InstrumentationSourceDto['kind'], name: string, c: Counts, status: InstrumentationSourceDto['status'], notes: string,
  ): InstrumentationSourceDto => ({
    id, kind, name, status, actualEvents: c.actual, simulatedEvents: c.simulated, lastEventAt: c.last ? c.last.toISOString() : null, notes,
  });

  /** registry-driven entry */
  const driven = (id: string, kind: Exclude<InstrumentationSourceDto['kind'], 'simulator'>, name: string, c: Counts): InstrumentationSourceDto => {
    const comp = registry.get(kind);
    if (comp) {
      const none = c.actual + c.simulated === 0;
      const sim = c.simulated > 0 ? ` ${c.simulated} DEMO/SIMULATED event(s) from the simulator are counted separately.` : '';
      return entry(id, kind, name, c, 'CONNECTED', `Real: ${comp.description}${none ? ' No events recorded yet.' : ''}${sim}`);
    }
    const status: InstrumentationSourceDto['status'] = c.actual + c.simulated > 0 ? 'SIMULATED_ONLY' : 'UNAVAILABLE';
    const unverified = c.actual > 0 ? ` WARNING: ${c.actual} row(s) are labelled ACTUAL but no real ${kind} component is registered in this app; treat them as unverified.` : '';
    return entry(id, kind, name, c, status, `No real ${kind} component is registered in this app; only the DEMO simulator can emit these events.${unverified}`);
  };

  const simLast = await Promise.all([
    prisma.memoryEvent.aggregate({ where: { source: 'SIMULATED' }, _max: { createdAt: true } }),
    prisma.busEvent.aggregate({ where: { source: 'SIMULATED' }, _max: { createdAt: true } }),
    prisma.toolCallEvent.aggregate({ where: { source: 'SIMULATED' }, _max: { createdAt: true } }),
    prisma.contextEvent.aggregate({ where: { source: 'SIMULATED' }, _max: { createdAt: true } }),
  ]);
  const simCounts: Counts = {
    actual: 0, simulated: me.simulated + bu.simulated + to.simulated + cx.simulated,
    last: simLast.map(r => r._max.createdAt).reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null),
  };

  return [
    driven('request-lifecycle', 'request', 'Request lifecycle', rq),
    driven('memory-injection', 'memory', 'Memory injection', me),
    driven('event-bus', 'bus', 'Event bus', bu),
    driven('tool-calls', 'tool', 'Tool calls', to),
    driven('context-lifecycle', 'context', 'Context lifecycle', cx),
    driven('error-handler', 'error', 'Error handling', er),
    entry('demo-simulator', 'simulator', 'DEMO simulator', simCounts, 'SIMULATED_ONLY',
      'DEMO / SIMULATED generator (POST /simulations/agent-run, simulateAgentActivity, demo seeding). Its events are labelled SIMULATED and never counted as actual; counts = simulated memory + bus + tool + context events.'),
  ];
}
