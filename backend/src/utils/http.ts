import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, ZodTypeAny } from 'zod';
import { AppError } from './errors';
import type { Pagination } from '../../../shared/types';

/** wrap async route handlers so rejections reach the error middleware */
export const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

/** parse+validate with zod; throws AppError(400 VALIDATION_ERROR) */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', r.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export const dateQuery = z.string().refine(s => !Number.isNaN(Date.parse(s)), 'invalid date').transform(s => new Date(s));

export function pageOf(total: number, page: number, pageSize: number): Pagination {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
/** CSV cell escape (RFC 4180) + formula-injection guard */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if ((/^[=+\-@]/.test(s) && Number.isNaN(Number(s))) || /^[\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n') + '\n';
}
