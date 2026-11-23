import { Prisma, type PrismaClient } from '@prisma/client';

/** Prisma `contains` maps to LIKE without ESCAPE, so `%` and `_` typed by a user act as wildcards. */
export const hasLikeWildcard = (s: string) => /[%_\\]/.test(s);
const escapeLike = (s: string) => s.replace(/[\\%_]/g, m => `\\${m}`);

/** ids of project rows whose name contains `term` literally (case-insensitive for ASCII, like SQLite LIKE) */
export async function projectIdsByName(prisma: PrismaClient, term: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM "Project" WHERE name LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`);
  return rows.map(r => r.id);
}

/** ids of usage events with a literal (wildcard-safe) match on any searchable column or project name */
export async function usageIdsBySearch(prisma: PrismaClient, term: string): Promise<string[]> {
  const pat = `%${escapeLike(term)}%`;
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT u.id FROM "UsageEvent" u JOIN "Project" p ON p.id = u.projectId
    WHERE u.requestId LIKE ${pat} ESCAPE '\\' OR u.modelName LIKE ${pat} ESCAPE '\\' OR u.providerKey LIKE ${pat} ESCAPE '\\'
       OR u.errorMessage LIKE ${pat} ESCAPE '\\' OR u.traceId LIKE ${pat} ESCAPE '\\' OR p.name LIKE ${pat} ESCAPE '\\'`);
  return rows.map(r => r.id);
}
