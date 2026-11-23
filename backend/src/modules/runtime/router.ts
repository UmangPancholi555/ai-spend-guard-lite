import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../contracts/services';
import { toErrorInfo } from '../../contracts/instrumentation';
import { ah, parse } from '../../utils/http';
import { notFound } from '../../utils/errors';
import { memoryCreateSchema, memoryItemMeta, memoryUpdateSchema, toMemoryDto } from './memory';
import { getRuntime } from './index';
import { makeClock } from './clock';
import type { ToolInvokeResult } from '../../../../shared/runtime';

const invokeSchema = z.object({ input: z.record(z.unknown()).default({}) });

export function createRuntimeRouter(deps: AppDeps): Router {
  const router = Router();
  getRuntime(deps); // wire + register the real components at startup (registry backs /observability/sources)
  const rt = () => getRuntime(deps);

  // ---------------------------------------------------------------- project memory (real MemoryStore)
  router.get('/projects/:id/memory', ah(async (req, res) => {
    res.json({ data: await rt().memory.list(String(req.params.id)) });
  }));

  router.post('/projects/:id/memory', ah(async (req, res) => {
    const projectId = String(req.params.id);
    const input = parse(memoryCreateSchema, req.body);
    const row = await rt().memory.create(projectId, input);
    (res.locals as { projectId?: string }).projectId = projectId;
    await deps.instr.recordActivity({
      type: 'project.memory.created', level: 'INFO', source: 'ACTUAL', projectId, message: 'Project memory item created',
      metadata: { ...memoryItemMeta(row), requestId: res.locals.requestId },
    });
    res.status(201).json({ data: toMemoryDto(row) });
  }));

  router.patch('/projects/:id/memory/:itemId', ah(async (req, res) => {
    const projectId = String(req.params.id);
    const input = parse(memoryUpdateSchema, req.body);
    const row = await rt().memory.update(projectId, String(req.params.itemId), input);
    (res.locals as { projectId?: string }).projectId = projectId;
    await deps.instr.recordActivity({
      type: 'project.memory.updated', level: 'INFO', source: 'ACTUAL', projectId, message: 'Project memory item updated',
      metadata: { ...memoryItemMeta(row), changedFields: Object.keys(input).sort() },
    });
    res.json({ data: toMemoryDto(row) });
  }));

  router.delete('/projects/:id/memory/:itemId', ah(async (req, res) => {
    const projectId = String(req.params.id);
    const row = await rt().memory.remove(projectId, String(req.params.itemId));
    (res.locals as { projectId?: string }).projectId = projectId;
    await deps.instr.recordActivity({
      type: 'project.memory.deleted', level: 'INFO', source: 'ACTUAL', projectId, message: 'Project memory item deleted',
      metadata: memoryItemMeta(row),
    });
    res.status(204).end();
  }));

  // ---------------------------------------------------------------- tools (real local tools)
  router.get('/tools', ah(async (_req, res) => {
    res.json({ data: rt().tools.list() });
  }));

  router.post('/tools/:name/invoke', ah(async (req, res) => {
    const name = String(req.params.name);
    const { input } = parse(invokeSchema, req.body ?? {});
    const runtime = rt();
    if (!runtime.tools.has(name)) throw notFound(`Tool "${name}"`);
    const projectId = typeof input.projectId === 'string' ? input.projectId : undefined;
    const at = new Date();
    const trace = await deps.instr.startTrace({
      name: 'tool.invoke', projectId, source: 'ACTUAL', at,
      attributes: { toolName: name, httpRequestId: res.locals.requestId },
    });
    const clock = makeClock(at);
    (res.locals as { traceId?: string }).traceId = trace.traceId;
    try {
      const r = await runtime.tools.execute(name, input, { trace, traceId: trace.traceId, projectId, clock });
      await trace.end();
      const body: ToolInvokeResult = { output: r.output, traceId: trace.traceId, toolCallId: r.toolCallId, attempts: r.attempts, durationMs: r.durationMs };
      res.json({ data: body });
    } catch (e) {
      await trace.end(toErrorInfo(e));
      throw e;
    }
  }));

  return router;
}
