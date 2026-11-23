import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';
import { createPrisma } from '../../src/database/client';
import { seedCatalog } from '../../src/database/catalog';
import { buildApp, createDeps } from '../../src/app';
import { loadConfig, REPO_ROOT } from '../../src/config';
import type { AppDeps } from '../../src/contracts/services';

export interface TestCtx {
  dir: string; dbPath: string; databaseUrl: string; prisma: PrismaClient; deps: AppDeps;
  app: ReturnType<typeof buildApp>;
  /** simulate an app restart: new PrismaClient + deps + app on the SAME db file/log dir */
  restart(): Promise<TestCtx>;
  close(): Promise<void>;
}

/** Creates an isolated temp SQLite DB (all migrations applied, catalog seeded) and a fully wired Express app. */
export async function createTestApp(existing?: { dir?: string; auth?: boolean }): Promise<TestCtx> {
  const dir = existing?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'spendguard-test-'));
  const dbPath = path.join(dir, 'test.db');
  const databaseUrl = `file:${dbPath}`;
  if (!fs.existsSync(dbPath)) {
    execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', path.join(REPO_ROOT, 'prisma', 'schema.prisma')], {
      cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
    });
  }
  const prisma = createPrisma(databaseUrl);
  await seedCatalog(prisma);
  const config = loadConfig({ databaseUrl, logDir: path.join(dir, 'logs'), frontendDist: null,
    // legacy suites run with auth OFF; pass { auth: true } for auth-specific suites. Rate limiting off in tests.
    auth: { enabled: existing?.auth ?? false, sessionTtlHours: 12, cookieSecure: false },
    security: { rateLimitPerMinute: 0 } });
  fs.mkdirSync(config.logDir, { recursive: true });
  const deps = createDeps(prisma, config);
  const app = buildApp(deps);
  const ctx: TestCtx = {
    dir, dbPath, databaseUrl, prisma, deps, app,
    restart: async () => { await prisma.$disconnect(); return createTestApp({ dir, auth: existing?.auth }); },
    close: async () => { await prisma.$disconnect(); },
  };
  return ctx;
}
export function cleanupTestDir(dir: string) { fs.rmSync(dir, { recursive: true, force: true }); }
