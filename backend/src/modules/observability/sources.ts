import type { PrismaClient } from '@prisma/client';
import type { InstrumentationSourceDto } from '../../../../shared/types';
import { ERROR_WHERE } from './overview';

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
 * Honest instrumentation registry. Counts always come from the DB; status rules:
 *  - request, error: CONNECTED. The real request-lifecycle middleware / provider pipeline / error handler are wired into this app
 *    (even if no event has been recorded yet; the note says so).
 *  - bus: CONNECTED only if ACTUAL bus rows exist (in-app budget/alert bus); SIMULATED_ONLY if only simulated rows exist; else UNAVAILABLE.
 *  - memory, tool, context: NEVER CONNECTED (this app has no real memory/tool/context runtime). Any rows -> SIMULATED_ONLY, none -> UNAVAILABLE.
 *    If rows labelled ACTUAL exist anyway they are reported in `actualEvents` and flagged in `notes` as unverified.
 */
export async function getSources(prisma: PrismaClient): Promise<InstrumentationSourceDto[]> {
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
  const simOnly = (c: Counts): InstrumentationSourceDto['status'] => (c.actual + c.simulated > 0 ? 'SIMULATED_ONLY' : 'UNAVAILABLE');
  const unverified = (c: Counts) =>
    c.actual > 0 ? ` WARNING: ${c.actual} row(s) are labelled ACTUAL but this app has no real runtime for it; treat them as unverified.` : '';

  const busStatus: InstrumentationSourceDto['status'] = bu.actual > 0 ? 'CONNECTED' : bu.simulated > 0 ? 'SIMULATED_ONLY' : 'UNAVAILABLE';

  return [
    entry('request-lifecycle', 'request', 'Request lifecycle', rq, 'CONNECTED',
      'Real: API request middleware and the mock provider pipeline emit ACTUAL traces/spans/logs.' + (rq.actual + rq.simulated === 0 ? ' No events recorded yet.' : '')),
    entry('memory-injection', 'memory', 'Memory injection', me, simOnly(me),
      'No real memory runtime exists in this app; only the DEMO simulator emits memory events.' + unverified(me)),
    entry('event-bus', 'bus', 'Event bus', bu, busStatus,
      'CONNECTED only for the in-app budget/alert bus operations this app really emits (ACTUAL); simulated bus operations are SIMULATED.'),
    entry('tool-calls', 'tool', 'Tool calls', to, simOnly(to),
      'No real tool runtime exists in this app; only the DEMO simulator emits tool calls.' + unverified(to)),
    entry('context-lifecycle', 'context', 'Context lifecycle', cx, simOnly(cx),
      'No real context runtime exists in this app; only the DEMO simulator emits context events.' + unverified(cx)),
    entry('error-handler', 'error', 'Error handling', er, 'CONNECTED',
      'Real: error middleware and pipeline failures are recorded as ACTUAL error events.' + (er.actual + er.simulated === 0 ? ' No errors recorded.' : '')),
  ];
}
