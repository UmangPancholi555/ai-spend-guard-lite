import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { chromium, request } from '@playwright/test';
import {
  ADMIN_CSRF_FILE, ADMIN_PASSWORD, ADMIN_STATE, ADMIN_USERNAME, BASE_URL, E2E_DIR, PORT, REPO_ROOT,
  VIEWER_CSRF_FILE, VIEWER_PASSWORD, VIEWER_STATE, VIEWER_USERNAME,
} from './env';
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
  await createSessions();
  console.log(`[e2e] backend ready at ${BASE_URL}  (data dir ${E2E_DIR})`);
}

/** Logs in once per role through the real API and stores Playwright storage states + CSRF tokens (specs reuse them). */
async function createSessions() {
  const admin = await request.newContext({ baseURL: BASE_URL });
  const a = await admin.post('/api/auth/login', { data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
  if (!a.ok()) throw new Error(`bootstrap admin login failed: ${a.status()} ${await a.text()}`);
  const adminCsrf: string = (await a.json()).data.csrfToken;
  await admin.storageState({ path: ADMIN_STATE });
  fs.writeFileSync(ADMIN_CSRF_FILE, adminCsrf);

  const mk = await admin.post('/api/auth/users', {
    data: { username: VIEWER_USERNAME, password: VIEWER_PASSWORD, role: 'VIEWER' }, headers: { 'X-CSRF-Token': adminCsrf },
  });
  if (!mk.ok()) throw new Error(`creating the viewer failed: ${mk.status()} ${await mk.text()}`);
  await admin.dispose();

  const viewer = await request.newContext({ baseURL: BASE_URL });
  const v = await viewer.post('/api/auth/login', { data: { username: VIEWER_USERNAME, password: VIEWER_PASSWORD } });
  if (!v.ok()) throw new Error(`viewer login failed: ${v.status()} ${await v.text()}`);
  fs.writeFileSync(VIEWER_CSRF_FILE, (await v.json()).data.csrfToken);
  await viewer.storageState({ path: VIEWER_STATE });
  await viewer.dispose();
}
