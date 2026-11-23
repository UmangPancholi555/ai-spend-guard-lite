import fs from 'node:fs';
import { loadConfig } from './config';
import { createPrisma } from './database/client';
import { seedCatalog } from './database/catalog';
import { buildApp, createDeps } from './app';

async function main() {
  const config = loadConfig();
  fs.mkdirSync(config.logDir, { recursive: true });
  const prisma = createPrisma();
  await seedCatalog(prisma);
  const deps = createDeps(prisma, config);
  const app = buildApp(deps);
  const server = app.listen(config.port, process.env.HOST ?? '127.0.0.1', () => {
    console.log(`AI Spend Guard Lite API listening on http://${process.env.HOST ?? '127.0.0.1'}:${config.port}  [DEMO / SIMULATED - no external AI requests]`);
  });
  const shutdown = async () => { server.close(); await prisma.$disconnect(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch(e => { console.error(e); process.exit(1); });
