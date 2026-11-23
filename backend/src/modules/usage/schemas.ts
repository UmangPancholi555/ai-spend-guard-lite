import { z } from 'zod';
import { dateQuery } from '../../utils/http';
import { boundedPagination } from './pagination';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const optStr = z.string().trim().min(1).max(200).optional();

/** Shared filter set (list + CSV export). `to` is inclusive: a date-only value covers that whole UTC day. */
export const usageFilterQuery = z.object({
  search: optStr,
  provider: optStr,
  model: optStr,
  projectId: optStr,
  status: z.enum(['SUCCESS', 'FAILURE']).optional(),
  from: dateQuery.optional(),
  to: z.string().refine(s => !Number.isNaN(Date.parse(s)), 'invalid date').optional(),
}).transform((q, ctx) => {
  let to: Date | undefined;
  if (q.to !== undefined) {
    to = new Date(q.to);
    if (DATE_ONLY.test(q.to)) to = new Date(to.getTime() + 86_400_000 - 1);
  }
  if (q.from && to && q.from > to) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'from must not be after to' });
    return z.NEVER;
  }
  return { ...q, to };
});
export type UsageFilters = z.infer<typeof usageFilterQuery>;

export const usageListQuery = boundedPagination.extend({
  sort: z.enum(['createdAt', 'costUsd', 'durationMs']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const usageIdParam = z.object({ id: z.string().min(1).max(200) });
