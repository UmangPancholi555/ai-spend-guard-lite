import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from './contracts/services';

const root = path.resolve(__dirname, '..', '..'); // repo root (works for src/ and dist/backend/src)
function findRoot(): string {
  let d = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, 'prisma', 'schema.prisma'))) return d;
    d = path.dirname(d);
  }
  return root;
}
export const REPO_ROOT = findRoot();

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dist = path.join(REPO_ROOT, 'frontend', 'dist');
  return {
    port: Number(process.env.PORT ?? 4000),
    databaseUrl: process.env.DATABASE_URL ?? 'file:./spendguard.db',
    logDir: path.resolve(REPO_ROOT, process.env.LOG_DIR ?? './data/logs'),
    frontendDist: fs.existsSync(dist) ? dist : null,
    ...overrides,
  };
}
