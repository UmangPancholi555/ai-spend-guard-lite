import { z } from 'zod';
import { paginationQuery } from '../../utils/http';

const name = z.string().trim().min(1, 'name is required').max(80, 'name must be at most 80 characters');
const description = z.string().trim().max(1000, 'description must be at most 1000 characters');
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

export const projectListQuery = paginationQuery.extend({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  includeTest: boolQuery.default('true'),
  search: z.string().trim().max(200).optional(),
});

export const idParam = z.object({ id: z.string().min(1).max(100) });
