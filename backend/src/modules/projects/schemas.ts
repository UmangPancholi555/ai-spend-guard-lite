import { z } from 'zod';
import { boundedPagination } from '../usage/pagination';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_WS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const name = z.string().trim().min(1, 'name is required').max(80, 'name must be at most 80 characters')
  .refine(v => !CONTROL.test(v), 'name must not contain control characters');
const description = z.string().trim().max(1000, 'description must be at most 1000 characters')
  .refine(v => !CONTROL_EXCEPT_WS.test(v), 'description must not contain control characters');
const boolQuery = z.enum(['true', 'false']).transform(v => v === 'true');

export const projectCreateSchema = z.object({
  name,
  description: description.optional(),
  isTest: z.boolean().optional(),
});

export const projectUpdateSchema = z.object({
  name: name.optional(),
  description: description.nullable().optional(),
  isTest: z.boolean().optional(),
});

export const projectListQuery = boundedPagination.extend({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  includeTest: boolQuery.default('true'),
  search: z.string().trim().max(200).optional(),
});

export const idParam = z.object({ id: z.string().min(1).max(100) });
