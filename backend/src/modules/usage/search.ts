import { Prisma, type PrismaClient } from '@prisma/client';
import { badRequest } from '../../utils/errors';

/** Prisma `contains` maps to LIKE without ESCAPE, so `%` and `_` typed by a user act as wildcards. */
export const hasLikeWildcard = (s: string) => /[%_\\]/.test(s);
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, m => `\\${m}`);

/**
 * Project searches with wildcard characters resolve to an id list first, so the list must stay bounded (SQLite
 * bound-variable limit, memory). A term matching more projects than this is rejected instead of silently truncated.
 * (Usage search does not need this: see query.ts.)
 */
export const MAX_SEARCH_MATCHES = 10_000;

function bounded(ids: { id: string }[], cap: number): string[] {
  if (ids.length > cap) throw badRequest(`Search term is too broad (more than ${cap} matches); refine it`, { field: 'search' });
  return ids.map(r => r.id);
}

/** ids of projects whose name OR description contains `term` literally (case-insensitive for ASCII, like SQLite LIKE) */
export async function projectIdsBySearch(prisma: PrismaClient, term: string, cap = MAX_SEARCH_MATCHES): Promise<string[]> {
  const pat = `%${escapeLike(term)}%`;
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "Project" WHERE name LIKE ${pat} ESCAPE '\\' OR description LIKE ${pat} ESCAPE '\\' LIMIT ${cap + 1}`);
  return bounded(rows, cap);
}
