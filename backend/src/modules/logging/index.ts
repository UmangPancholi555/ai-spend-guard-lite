import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../contracts/services';
import { ah, pageOf, paginationQuery, parse, csvCell, toCsv } from '../../utils/http';
import { AppError, notFound } from '../../utils/errors';
import { safeStringify } from '../../utils/serialize';
import { DATASETS, logsDataset, type Dataset } from './datasets';
import { toLogDto } from './mappers';
import { runRetentionSweep } from './retention';
import { getSettings, settingsUpdateSchema, updateSettings } from './settings';

export { getSettings, DEFAULT_SETTINGS } from './settings';
export { startRetentionScheduler } from './scheduler';
export type { RetentionScheduler, RetentionSchedulerOptions } from './scheduler';

const BATCH = 500;
/** Hard cap on rows in one export (override with env EXPORT_MAX_ROWS or createLoggingRouter's 2nd arg). Memory is bounded by BATCH regardless. */
export const DEFAULT_MAX_EXPORT_ROWS = 250_000;

export interface LoggingRouterOptions { maxExportRows?: number }

/** drop empty-string query params so `?search=` behaves as "not provided" */
function cleanQuery(q: Request['query']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) if (v !== '' && v !== undefined) out[k] = v;
  return out;
}

/** CSV cell with formula-injection guard (utils csvCell guards = + - @; we also guard leading TAB/CR) */
function cell(v: unknown): string {
  if (typeof v === 'string' && /^[\t\r]/.test(v)) v = `'${v}`;
  return csvCell(v);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');

async function write(res: Response, chunk: string): Promise<boolean> {
  if (res.destroyed) return false;
  if (!res.write(chunk)) {
    await new Promise<void>(resolve => { res.once('drain', resolve); res.once('close', resolve); });
  }
  return !res.destroyed;
}

async function streamExport(
  deps: AppDeps, res: Response, ds: Dataset, query: unknown, format: 'jsonl' | 'csv', maxRows: number, limit: number | undefined,
) {
  const q = parse(ds.filterSchema, query);
  const where = ds.where(q);
  const delegate = ds.delegate(deps.prisma);
  // Guard BEFORE any download header is sent: refuse (400) when the filter matches more than the cap, unless the caller
  // explicitly asks for the newest `limit` rows (limit <= cap).
  const total = await delegate.count({ where });
  if (limit === undefined && total > maxRows) {
    throw new AppError(400, 'VALIDATION_ERROR', `Export would contain ${total} rows (max ${maxRows}). Narrow the filters (from/to, status, ...) or pass limit=<n> (<= ${maxRows}) to export the newest n rows.`, { total, maxRows });
  }
  let remaining = Math.min(limit ?? maxRows, total);
  res.setHeader('X-Total-Rows', String(Math.min(total, limit ?? total)));
  const filename = `spendguard-${ds.name}-${stamp()}.${format}`;
  res.status(200);
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (format === 'csv') await write(res, toCsv(ds.headers, []));

  let cursor: string | undefined;
  while (remaining > 0) {
    const rows = await delegate.findMany({
      where, orderBy: ds.orderBy, take: Math.min(BATCH, remaining), ...(ds.include ? { include: ds.include } : {}),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    const dtos = rows.map(r => ds.toDto(r));
    const chunk = format === 'csv'
      ? dtos.map(d => `${ds.toRow(d).map(cell).join(',')}\n`).join('')
      : dtos.map(d => `${safeStringify(d)}\n`).join('');
    if (!(await write(res, chunk))) return;
    remaining -= rows.length;
    if (rows.length < BATCH) break;
    cursor = rows[rows.length - 1].id;
  }
  res.end();
}

export function createLoggingRouter(deps: AppDeps, options: LoggingRouterOptions = {}): Router {
  const r = Router();
  const envMax = Number(process.env.EXPORT_MAX_ROWS);
  const maxExportRows = options.maxExportRows ?? (Number.isInteger(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_EXPORT_ROWS);
  const { prisma } = deps;

  r.get('/logs', ah(async (req, res) => {
    const { page, pageSize } = parse(paginationQuery, cleanQuery(req.query));
    const q = parse(logsDataset.filterSchema, cleanQuery(req.query));
    const where = logsDataset.where(q);
    const [total, rows] = await Promise.all([
      prisma.executionLog.count({ where }),
      prisma.executionLog.findMany({ where, orderBy: [{ ts: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    res.json({ data: rows.map(toLogDto), pagination: pageOf(total, page, pageSize) });
  }));

  r.get('/logs/:id', ah(async (req, res) => {
    const row = await prisma.executionLog.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('Log entry');
    res.json({ data: toLogDto(row) });
  }));

  r.get('/export/:dataset', ah(async (req, res) => {
    const ds = DATASETS[req.params.dataset];
    if (!ds || !Object.prototype.hasOwnProperty.call(DATASETS, req.params.dataset)) throw notFound(`Dataset "${req.params.dataset}"`);
    const query = cleanQuery(req.query);
    const { format, limit } = parse(z.object({
      format: z.enum(['jsonl', 'csv']).default('jsonl'), limit: z.coerce.number().int().min(1).max(maxExportRows).optional(),
    }), query);
    try {
      await streamExport(deps, res, ds, query, format, maxExportRows, limit);
    } catch (e) {
      if (res.headersSent) { res.destroy(e instanceof Error ? e : undefined); return; }
      throw e;
    }
  }));

  r.get('/settings', ah(async (_req, res) => {
    res.json({ data: await getSettings(prisma) });
  }));

  r.put('/settings', ah(async (req, res) => {
    const patch = parse(settingsUpdateSchema, req.body ?? {});
    const before = await getSettings(prisma);
    const after = await updateSettings(prisma, patch);
    const changed = (['retentionDays', 'slowOperationMs'] as const).filter(k => before[k] !== after[k]);
    if (changed.length) {
      await deps.instr.recordActivity({
        type: 'settings.updated', message: `Settings updated: ${changed.join(', ')}`, source: 'ACTUAL',
        metadata: { changed, retentionDays: after.retentionDays, slowOperationMs: after.slowOperationMs },
        requestId: (res.locals as { requestId?: string }).requestId,
      });
    }
    res.json({ data: after });
  }));

  r.post('/logging/retention/run', ah(async (_req, res) => {
    const task = await runRetentionSweep(prisma, deps.instr, deps.config.logDir);
    res.json({ data: task });
  }));

  return r;
}
