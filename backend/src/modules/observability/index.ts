/**
 * Observability read-side API (module obs-events). Reads rows written by the instrumentation SDK; never writes.
 * Mounted at /api; declares FULL sub-paths (see docs/CONTRACT.md "Observability").
 */
import { Router } from 'express';
import type { AppDeps } from '../../contracts/services';
import { ah, parse } from '../../utils/http';
import { cleanQuery } from './common';
import { getOverview, overviewQuery } from './overview';
import { getPerformance, performanceQuery } from './performance';
import { getSources } from './sources';
import { errorGroups, errorGroupsQuery, errorsQuery, listErrors } from './errors';
import { busEvents, contextEvents, memoryEvents, toolEvents } from './events';

export function createObservabilityRouter(deps: AppDeps): Router {
  const r = Router();
  const { prisma } = deps;

  r.get('/observability/overview', ah(async (req, res) => {
    res.json({ data: await getOverview(prisma, parse(overviewQuery, cleanQuery(req.query))) });
  }));
  r.get('/observability/performance', ah(async (req, res) => {
    res.json({ data: await getPerformance(prisma, parse(performanceQuery, cleanQuery(req.query))) });
  }));
  r.get('/observability/sources', ah(async (_req, res) => {
    res.json({ data: await getSources(prisma) });
  }));
  r.get('/observability/errors/groups', ah(async (req, res) => {
    res.json({ data: await errorGroups(prisma, parse(errorGroupsQuery, cleanQuery(req.query))) });
  }));
  r.get('/observability/errors', ah(async (req, res) => {
    res.json(await listErrors(prisma, parse(errorsQuery, cleanQuery(req.query))));
  }));

  const lists = { 'memory-events': memoryEvents, 'bus-events': busEvents, 'tool-events': toolEvents, 'context-events': contextEvents } as const;
  for (const [path, def] of Object.entries(lists)) {
    r.get(`/observability/${path}`, ah(async (req, res) => {
      // each def has its own zod schema + runner; typed loosely here because the four schemas differ only in the `status` enum
      const d = def as unknown as { schema: Parameters<typeof parse>[0]; run: (p: typeof prisma, q: never) => Promise<unknown> };
      res.json(await d.run(prisma, parse(d.schema, cleanQuery(req.query)) as never));
    }));
  }
  return r;
}
