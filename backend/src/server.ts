import fs from 'node:fs';
import { loadConfig } from './config';
import { createPrisma } from './database/client';
import { seedCatalog } from './database/catalog';
import { buildApp, createDeps } from './app';
import { bootstrapAdmin } from './modules/auth';
import { startRetentionScheduler } from './modules/logging';

const isLoopback = (h: string) => h === '127.0.0.1' || h === 'localhost' || h === '::1';

async function main() {
  const config = loadConfig();
  const host = process.env.HOST ?? '127.0.0.1';
  fs.mkdirSync(config.logDir, { recursive: true });
  const prisma = createPrisma();
  await seedCatalog(prisma);
  const deps = createDeps(prisma, config);

  if (config.auth.enabled) {
    const b = await bootstrapAdmin(prisma, process.env, deps.instr);
    if (b.status === 'created') console.log(`[auth] initial admin "${b.username}" created from ADMIN_USERNAME/ADMIN_PASSWORD (you may now remove ADMIN_PASSWORD from the environment).`);
    else if ((await prisma.user.count()) === 0) console.log('[auth] no users yet: open the app and create the first admin on /setup, or run `npm run user:create`.');
    if (!isLoopback(host) && !config.auth.cookieSecure) console.warn('[auth] WARNING: listening on a non-loopback address with COOKIE_SECURE=false. Put the app behind HTTPS and set COOKIE_SECURE=true.');
  } else {
    const bar = '!'.repeat(78);
    console.warn(`\n${bar}\n!! WARNING: AUTH_ENABLED=false - authentication is DISABLED. Every API endpoint is open to anyone who can reach this server.\n!! Use only for local development/tests.${isLoopback(host) ? '' : ` You are listening on ${host}: THE API IS EXPOSED WITHOUT LOGIN.`}\n${bar}\n`);
  }

  const app = buildApp(deps);
  const server = app.listen(config.port, host, () => {
    console.log(`AI Spend Guard Lite API listening on http://${host}:${config.port}  [DEMO / SIMULATED - no external AI requests]  auth=${config.auth.enabled ? 'on' : 'OFF'}`);
  });
  const retention = startRetentionScheduler(deps);
  const shutdown = async () => { retention.stop(); server.close(); await prisma.$disconnect(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
