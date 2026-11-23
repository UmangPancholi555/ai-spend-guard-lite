import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { TestCtx } from '../helpers/testApp';

export async function makeProject(prisma: PrismaClient, name = `p-${Math.random().toString(36).slice(2, 8)}`, status = 'ACTIVE') {
  return prisma.project.create({ data: { name, status, archivedAt: status === 'ARCHIVED' ? new Date() : null } });
}

/** stringify rows of every table (BigInt safe), optionally skipping tables (e.g. ProjectMemoryItem, which legitimately holds content) */
export async function dumpTables(prisma: PrismaClient, skip: string[] = []): Promise<string> {
  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_prisma%' AND name NOT LIKE 'sqlite_%'");
  let out = '';
  for (const t of tables) {
    if (skip.includes(t.name)) continue;
    const rows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${t.name}"`);
    out += JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
  return out;
}

export function allJsonl(ctx: TestCtx): string {
  const dir = ctx.deps.config.logDir;
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}

/** wait until `fn` returns truthy (async log writes) */
export async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('until(): timeout');
    await new Promise(r => setTimeout(r, 25));
  }
}
