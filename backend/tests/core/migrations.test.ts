import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPrisma } from '../../src/database/client';
import { REPO_ROOT } from '../../src/config';

/**
 * Migration 20261124104502_relations_and_indexes rebuilds Span and BackgroundTask to add foreign keys.
 * This test applies every migration BEFORE it, inserts valid rows + orphans through raw SQL, applies the migration and checks that
 * no row is lost, orphans are handled as documented in the migration header, and the new constraints behave (SET NULL / CASCADE).
 */
const NEW_MIGRATION = '20261124104502_relations_and_indexes';
const SRC = path.join(REPO_ROOT, 'prisma');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function deploy(schemaPath: string, databaseUrl: string) {
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', schemaPath], { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' });
}

describe(`migration ${NEW_MIGRATION}`, () => {
  it('keeps every row, clears orphan references explicitly and enforces the new relations', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spendguard-mig-'));
    dirs.push(dir);
    const schemaDir = path.join(dir, 'prisma');
    fs.mkdirSync(path.join(schemaDir, 'migrations'), { recursive: true });
    fs.copyFileSync(path.join(SRC, 'schema.prisma'), path.join(schemaDir, 'schema.prisma'));
    fs.copyFileSync(path.join(SRC, 'migrations', 'migration_lock.toml'), path.join(schemaDir, 'migrations', 'migration_lock.toml'));
    const all = fs.readdirSync(path.join(SRC, 'migrations'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
    expect(all).toContain(NEW_MIGRATION);
    const copy = (name: string) => fs.cpSync(path.join(SRC, 'migrations', name), path.join(schemaDir, 'migrations', name), { recursive: true });
    for (const name of all.filter(n => n < NEW_MIGRATION)) copy(name);

    const databaseUrl = `file:${path.join(dir, 'mig.db')}`;
    const schemaPath = path.join(schemaDir, 'schema.prisma');
    deploy(schemaPath, databaseUrl); // the database as it was BEFORE this migration (no foreign keys on Span.parent / BackgroundTask.trace)

    const prisma = createPrisma(databaseUrl);
    try {
      const now = Date.now();
      const trace = (id: string) => prisma.$executeRawUnsafe(
        `INSERT INTO "Trace" ("id","traceId","name","status","source","startedAt","createdAt") VALUES ('row_${id}','${id}','t','OK','ACTUAL',${now},${now})`);
      const span = (spanId: string, traceId: string, parent: string | null) => prisma.$executeRawUnsafe(
        `INSERT INTO "Span" ("id","spanId","traceId","parentSpanId","name","kind","status","source","startedAt") VALUES ('row_${spanId}','${spanId}','${traceId}',${parent ? `'${parent}'` : 'NULL'},'s','INTERNAL','OK','ACTUAL',${now})`);
      const task = (id: string, traceId: string | null) => prisma.$executeRawUnsafe(
        `INSERT INTO "BackgroundTask" ("id","name","kind","status","source","traceId","createdAt") VALUES ('${id}','n','OTHER','SUCCEEDED','ACTUAL',${traceId ? `'${traceId}'` : 'NULL'},${now})`);
      await trace('t'.repeat(32));
      await span('a'.repeat(16), 't'.repeat(32), null);              // root
      await span('b'.repeat(16), 't'.repeat(32), 'a'.repeat(16));    // valid child
      await span('c'.repeat(16), 't'.repeat(32), 'ffffffffffffffff'); // ORPHAN: parent does not exist
      await task('task_linked', 't'.repeat(32));                      // valid link
      await task('task_orphan', 'e'.repeat(32));                      // ORPHAN: trace was swept by retention
      await task('task_plain', null);

      copy(NEW_MIGRATION);
      deploy(schemaPath, databaseUrl); // apply the migration under test

      // nothing lost
      expect(await prisma.span.count()).toBe(3);
      expect(await prisma.backgroundTask.count()).toBe(3);
      expect(await prisma.trace.count()).toBe(1);
      // valid references untouched, orphan references cleared (rows kept)
      const spans = Object.fromEntries((await prisma.span.findMany()).map(s => [s.spanId[0], s.parentSpanId]));
      expect(spans).toEqual({ a: null, b: 'a'.repeat(16), c: null });
      const tasks = Object.fromEntries((await prisma.backgroundTask.findMany()).map(t => [t.id, t.traceId]));
      expect(tasks).toEqual({ task_linked: 't'.repeat(32), task_orphan: null, task_plain: null });
      // the schema is consistent after the rebuild
      expect(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);

      // the new constraints are live: unknown references are rejected, parent delete -> SET NULL, trace delete -> spans CASCADE + task SET NULL
      await expect(task('task_bad', 'd'.repeat(32))).rejects.toThrow();
      await expect(span('d'.repeat(16), 't'.repeat(32), 'ffffffffffffffff')).rejects.toThrow();
      await prisma.span.delete({ where: { spanId: 'a'.repeat(16) } });
      expect((await prisma.span.findUniqueOrThrow({ where: { spanId: 'b'.repeat(16) } })).parentSpanId).toBeNull();
      await prisma.trace.delete({ where: { traceId: 't'.repeat(32) } });
      expect(await prisma.span.count()).toBe(0);
      expect((await prisma.backgroundTask.findUniqueOrThrow({ where: { id: 'task_linked' } })).traceId).toBeNull();
      expect(await prisma.backgroundTask.count()).toBe(3); // tasks survive trace deletion (retention)
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});
