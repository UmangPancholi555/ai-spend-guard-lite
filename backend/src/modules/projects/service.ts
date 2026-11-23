import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppDeps } from '../../contracts/services';
import type { ProjectUsageSummary, ProjectWithUsage } from '../../../../shared/types';
import { conflict, notFound } from '../../utils/errors';
import { picoToUsd } from '../../utils/money';
import { toProjectDto } from './mappers';
import { hasLikeWildcard, projectIdsBySearch } from '../usage/search';

const EMPTY_USAGE: ProjectUsageSummary = {
  requests: 0, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0,
  costUsd: picoToUsd(0n), lastActivityAt: null,
};

/** Per-project usage summaries computed from persisted usage events (BigInt pico sum -> 12dp string). */
export async function summarizeUsage(prisma: PrismaClient, projectIds: string[]): Promise<Map<string, ProjectUsageSummary>> {
  const out = new Map<string, ProjectUsageSummary>();
  if (projectIds.length === 0) return out;
  const groups = await prisma.usageEvent.groupBy({
    by: ['projectId', 'status'],
    where: { projectId: { in: projectIds } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, cachedTokens: true, costPico: true },
    _max: { createdAt: true },
  });
  const acc = new Map<string, { s: Omit<ProjectUsageSummary, 'costUsd'>; pico: bigint; last: Date | null }>();
  for (const g of groups) {
    const cur = acc.get(g.projectId) ?? {
      s: { requests: 0, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, lastActivityAt: null },
      pico: 0n, last: null,
    };
    cur.s.requests += g._count._all;
    if (g.status === 'SUCCESS') cur.s.successes += g._count._all;
    else cur.s.failures += g._count._all;
    cur.s.inputTokens += g._sum.inputTokens ?? 0;
    cur.s.outputTokens += g._sum.outputTokens ?? 0;
    cur.s.cachedTokens += g._sum.cachedTokens ?? 0;
    cur.pico += g._sum.costPico ?? 0n;
    const m = g._max.createdAt;
    if (m && (!cur.last || m > cur.last)) cur.last = m;
    acc.set(g.projectId, cur);
  }
  for (const [id, v] of acc) {
    out.set(id, { ...v.s, costUsd: picoToUsd(v.pico), lastActivityAt: v.last ? v.last.toISOString() : null });
  }
  return out;
}

export function createProjectsService(deps: AppDeps) {
  const { prisma } = deps;

  async function emit(type: string, message: string, projectId: string | null, metadata: Record<string, unknown>) {
    try {
      await deps.instr.recordActivity({ type, level: 'INFO', message, source: 'ACTUAL', projectId: projectId ?? undefined, metadata });
    } catch {
      // activity emission must never fail the user-facing operation
    }
  }

  async function withUsage(projects: Parameters<typeof toProjectDto>[0][]): Promise<ProjectWithUsage[]> {
    const usage = await summarizeUsage(prisma, projects.map(p => p.id));
    return projects.map(p => ({ ...toProjectDto(p), usage: usage.get(p.id) ?? { ...EMPTY_USAGE } }));
  }

  async function getRow(id: string) {
    const p = await prisma.project.findUnique({ where: { id } });
    if (!p) throw notFound('Project');
    return p;
  }

  /** SQLite has no case-insensitive unique index on Project.name, so check-then-write must be serialized within the process
   *  (otherwise concurrent identical creates / double-clicked submits all pass the check). */
  let nameLock: Promise<unknown> = Promise.resolve();
  function withNameLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = nameLock.then(fn, fn);
    nameLock = run.catch(() => undefined);
    return run;
  }

  /** names are unique case-insensitively across ALL projects (incl. archived) */
  async function assertNameFree(name: string, exceptId?: string) {
    const lower = name.toLowerCase();
    const all = await prisma.project.findMany({ select: { id: true, name: true } });
    const clash = all.find(p => p.id !== exceptId && p.name.trim().toLowerCase() === lower);
    if (clash) throw conflict(`A project named "${clash.name}" already exists`, { field: 'name' });
  }

  return {
    async list(q: { status?: 'ACTIVE' | 'ARCHIVED'; includeTest: boolean; search?: string; page: number; pageSize: number }) {
      const where: Prisma.ProjectWhereInput = {};
      if (q.status) where.status = q.status;
      if (!q.includeTest) where.isTest = false;
      if (q.search) {
        // name OR description; wildcard characters typed by the user are matched literally
        where.OR = hasLikeWildcard(q.search)
          ? [{ id: { in: await projectIdsBySearch(prisma, q.search) } }]
          : [{ name: { contains: q.search } }, { description: { contains: q.search } }];
      }
      const [total, rows] = await Promise.all([
        prisma.project.count({ where }),
        prisma.project.findMany({
          where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        }),
      ]);
      return { total, items: await withUsage(rows) };
    },

    async get(id: string): Promise<ProjectWithUsage> {
      return (await withUsage([await getRow(id)]))[0];
    },

    async create(input: { name: string; description?: string; isTest?: boolean }): Promise<ProjectWithUsage> {
      const p = await withNameLock(async () => {
        await assertNameFree(input.name);
        return prisma.project.create({
          data: { name: input.name, description: input.description ? input.description : null, isTest: input.isTest ?? false },
        });
      });
      await emit('project.created', `Project "${p.name}" created`, p.id, { projectId: p.id, name: p.name, isTest: p.isTest });
      return (await withUsage([p]))[0];
    },

    async update(id: string, input: { name?: string; description?: string | null; isTest?: boolean }): Promise<ProjectWithUsage> {
      const cur = await getRow(id);
      const data: Prisma.ProjectUpdateInput = {};
      const changed: string[] = [];
      const renaming = input.name !== undefined && input.name !== cur.name;
      if (renaming) { data.name = input.name; changed.push('name'); }
      if (input.description !== undefined) {
        const d = input.description === null || input.description === '' ? null : input.description;
        if (d !== cur.description) { data.description = d; changed.push('description'); }
      }
      if (input.isTest !== undefined && input.isTest !== cur.isTest) { data.isTest = input.isTest; changed.push('isTest'); }
      if (changed.length === 0) return (await withUsage([cur]))[0];
      const p = await withNameLock(async () => {
        if (renaming) await assertNameFree(input.name!, id);
        return prisma.project.update({ where: { id }, data });
      });
      await emit('project.updated', `Project "${p.name}" updated (${changed.join(', ')})`, p.id,
        { projectId: p.id, name: p.name, changedFields: changed, previousName: cur.name });
      return (await withUsage([p]))[0];
    },

    /** idempotent: archiving an already archived project returns it unchanged (no new activity event) */
    async setArchived(id: string, archived: boolean): Promise<ProjectWithUsage> {
      const cur = await getRow(id);
      const target = archived ? 'ARCHIVED' : 'ACTIVE';
      if (cur.status === target) return (await withUsage([cur]))[0];
      const p = await prisma.project.update({ where: { id }, data: { status: target, archivedAt: archived ? new Date() : null } });
      await emit(archived ? 'project.archived' : 'project.unarchived',
        `Project "${p.name}" ${archived ? 'archived' : 'unarchived'}`, p.id, { projectId: p.id, name: p.name });
      return (await withUsage([p]))[0];
    },

    async remove(id: string): Promise<void> {
      const cur = await getRow(id);
      if (!cur.isTest) throw conflict('Only test projects can be deleted; archive this project instead', { isTest: false });
      await prisma.project.delete({ where: { id } }); // cascades usage events, budgets (+alerts); activity/trace projectId -> NULL
      // emitted after delete: the project row no longer exists, identity is kept in metadata
      await emit('project.deleted', `Test project "${cur.name}" deleted`, null, { projectId: id, name: cur.name });
    },

    async activity(id: string, page: number, pageSize: number) {
      await getRow(id);
      const where = { projectId: id };
      const [total, rows] = await Promise.all([
        prisma.activityEvent.count({ where }),
        prisma.activityEvent.findMany({
          where, include: { project: { select: { name: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
        }),
      ]);
      return { total, rows };
    },
  };
}
