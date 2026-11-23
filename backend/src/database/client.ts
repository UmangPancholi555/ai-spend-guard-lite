import { PrismaClient } from '@prisma/client';

/** Create a PrismaClient. `databaseUrl` overrides env (used by tests: file:/abs/path.db). */
export function createPrisma(databaseUrl?: string): PrismaClient {
  return new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : undefined);
}
