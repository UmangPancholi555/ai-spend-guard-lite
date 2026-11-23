import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './tests/e2e/support/env';

/**
 * E2E against a FRESH, isolated app instance:
 *  - global-setup builds frontend/dist once, creates a temp SQLite DB (prisma migrate deploy) + temp LOG_DIR under os.tmpdir()
 *    and launches `npx tsx backend/src/server.ts` on PORT=4300 (the backend serves frontend/dist, so baseURL = :4300)
 *  - global-teardown stops it and deletes the temp dir (E2E_KEEP=1 keeps it)
 * Env knobs: E2E_PORT, E2E_DIR, E2E_SKIP_BUILD=1, E2E_KEEP=1
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts/,
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './tests/e2e/support/global-setup.ts',
  globalTeardown: './tests/e2e/support/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
