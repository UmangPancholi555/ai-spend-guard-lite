import { Prisma, type PrismaClient } from '@prisma/client';
import type { UsageFilters } from './schemas';
import { escapeLike } from './search';

/**
 * Filters are rendered as ONE SQL fragment (parameterised) used for the count, the page of ids and the CSV export,
 * so every endpoint filters identically. `%`, `_` and `\` in the search term are matched literally (LIKE ... ESCAPE),
 * which Prisma's `contains` cannot do. Rows themselves are hydrated through Prisma by id (<= 500 ids per call).
 */
const JOIN = Prisma.sql`JOIN "Project" p ON p.id = u.projectId`;
const FROM = Prisma.sql`FROM "UsageEvent" u`;

export interface UsageQuery { from: Prisma.Sql; where: Prisma.Sql }

export function usageQuery(f: UsageFilters, extra?: Prisma.Sql): UsageQuery {
  const c: Prisma.Sql[] = [];
  if (f.provider) c.push(Prisma.sql`u.providerKey = ${f.provider}`);
  if (f.model) c.push(Prisma.sql`u.modelName = ${f.model}`);
  if (f.projectId) c.push(Prisma.sql`u.projectId = ${f.projectId}`);
  if (f.status) c.push(Prisma.sql`u.status = ${f.status}`);
  if (f.from) c.push(Prisma.sql`u.createdAt >= ${f.from}`);
  if (f.to) c.push(Prisma.sql`u.createdAt <= ${f.to}`);
  if (f.search) {
    const pat = `%${escapeLike(f.search)}%`;
    c.push(Prisma.sql`(u.requestId LIKE ${pat} ESCAPE '\\' OR u.modelName LIKE ${pat} ESCAPE '\\' OR u.providerKey LIKE ${pat} ESCAPE '\\'
      OR u.errorMessage LIKE ${pat} ESCAPE '\\' OR u.traceId LIKE ${pat} ESCAPE '\\' OR p.name LIKE ${pat} ESCAPE '\\')`);
  }
  if (extra) c.push(extra);
  return {
    from: f.search ? Prisma.sql`${FROM} ${JOIN}` : FROM, // the project join is only needed to search by project name
    where: c.length ? Prisma.sql`WHERE ${Prisma.join(c, ' AND ')}` : Prisma.empty,
  };
}

export async function countUsage(prisma: PrismaClient, q: UsageQuery): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*) AS n ${q.from} ${q.where}`);
  return Number(rows[0]?.n ?? 0n);
}

const ORDER_COLUMN = { createdAt: 'u.createdAt', costUsd: 'u.costPico', durationMs: 'u.durationMs' } as const;

/** ids of one page, in display order. Sort column / direction come from a whitelist, never from raw input. */
export async function pageUsageIds(
  prisma: PrismaClient, q: UsageQuery,
  o: { sort: keyof typeof ORDER_COLUMN; order: 'asc' | 'desc'; limit: number; offset: number },
): Promise<string[]> {
  const col = Prisma.raw(ORDER_COLUMN[o.sort]);
  const dir = Prisma.raw(o.order === 'asc' ? 'ASC' : 'DESC');
  const tie = o.sort === 'createdAt' ? Prisma.empty : Prisma.sql`, u.createdAt DESC`;
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT u.id ${q.from} ${q.where} ORDER BY ${col} ${dir}${tie}, u.id DESC LIMIT ${o.limit} OFFSET ${o.offset}`);
  return rows.map(r => r.id);
}

/** newest-first keyset batch (createdAt desc, id desc) strictly after `last` */
export async function exportBatchIds(
  prisma: PrismaClient, f: UsageFilters, last: { createdAt: Date; id: string } | undefined, limit: number,
): Promise<string[]> {
  const after = last
    ? Prisma.sql`(u.createdAt < ${last.createdAt} OR (u.createdAt = ${last.createdAt} AND u.id < ${last.id}))`
    : undefined;
  const q = usageQuery(f, after);
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT u.id ${q.from} ${q.where} ORDER BY u.createdAt DESC, u.id DESC LIMIT ${limit}`);
  return rows.map(r => r.id);
}

/** hydrate rows (with project name) for the given ids, preserving the order of `ids` */
export async function hydrateUsage(prisma: PrismaClient, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await prisma.usageEvent.findMany({ where: { id: { in: ids } }, include: { project: { select: { name: true } } } });
  const byId = new Map(rows.map(r => [r.id, r]));
  return ids.flatMap(id => { const r = byId.get(id); return r ? [r] : []; });
}
