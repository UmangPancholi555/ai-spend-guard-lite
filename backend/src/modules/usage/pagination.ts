import { z } from 'zod';
import { paginationQuery } from '../../utils/http';

/** Upper bound on `page` so skip/offset stays sane (10_000 pages x 200 = 2M rows) and never overflows an Int. */
export const MAX_PAGE = 10_000;

export const boundedPagination = paginationQuery.extend({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
});
