import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { BASE_URL, E2E_DIR, PORT, REPO_ROOT } from './env';
import { isUp, prepareFreshDatabase, startServer, stopServer } from './server';

export default async function globalSetup() {
  // 1. browser present? (one-time download, documented in docs/QA-REPORT.md; the app itself never uses the network)
  if (!fs.existsSync(chromium.executablePath())) {
    console.log('[e2e] chromium missing -> npx playwright install chromium');
    execFileSync('npx', ['playwright', 'install', 'chromium'], { cwd: REPO_ROOT, stdio: 'inherit' });
  }

  // 2. a stale server from an aborted run (pid file) must not leak state into this run
  await stopServer().catch(() => {});
  if (await isUp()) {
    throw new Error(`Port ${PORT} is already serving something that is not managed by this E2E run. Stop it or set E2E_PORT.`);
  }

  // 3. build the frontend once (served by the backend from frontend/dist)
  if (process.env.E2E_SKIP_BUILD === '1' && fs.existsSync(`${REPO_ROOT}/frontend/dist/index.html`)) {
    console.log('[e2e] E2E_SKIP_BUILD=1 -> reusing existing frontend/dist');
  } else {
    console.log('[e2e] npm run build -w frontend');
    execFileSync('npm', ['run', 'build', '-w', 'frontend'], { cwd: REPO_ROOT, stdio: 'pipe' });
  }

  // 4. fresh temp SQLite DB + migrations + backend on :PORT
  prepareFreshDatabase();
  await startServer();
  console.log(`[e2e] backend ready at ${BASE_URL}  (data dir ${E2E_DIR})`);
}
