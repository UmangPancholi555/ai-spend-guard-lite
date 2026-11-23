/**
 * Project `test` / `expect`. Auth is ON in the E2E server, so every spec runs logged in by default:
 *  - `auth: 'admin'`  (default) storage state of the bootstrapped admin + X-CSRF-Token header on page AND request contexts
 *  - `auth: 'viewer'` read-only account
 *  - `auth: 'none'`   anonymous (no cookies, no CSRF header)
 * Override per file/describe with `test.use({ auth: 'none' })`.
 * extraHTTPHeaders also applies to the `request` fixture, so API seeding calls (`request.post(...)`) are authenticated + CSRF-safe.
 */
import fs from 'node:fs';
import { test as base, expect } from '@playwright/test';
import { ADMIN_CSRF_FILE, ADMIN_STATE, VIEWER_CSRF_FILE, VIEWER_STATE } from './env';

export type AuthRole = 'admin' | 'viewer' | 'none';

export const test = base.extend<{ auth: AuthRole }>({
  auth: ['admin', { option: true }],
  storageState: async ({ auth }, use) => {
    await use(auth === 'none' ? { cookies: [], origins: [] } : auth === 'viewer' ? VIEWER_STATE : ADMIN_STATE);
  },
  extraHTTPHeaders: async ({ auth }, use) => {
    if (auth === 'none') return use({});
    await use({ 'X-CSRF-Token': fs.readFileSync(auth === 'viewer' ? VIEWER_CSRF_FILE : ADMIN_CSRF_FILE, 'utf8').trim() });
  },
});
export { expect };
