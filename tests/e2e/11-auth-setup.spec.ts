/**
 * First-run flow: a SEPARATE server + DB (port E2E_SETUP_PORT, default 4301) started WITHOUT ADMIN_USERNAME/ADMIN_PASSWORD,
 * so the app really has zero users. The main E2E server is untouched.
 */
import { test, expect } from './support/test';
import { SETUP_DIR, SETUP_PORT } from './support/env';
import { makeServer } from './support/server';
import { STRONG_PASSWORD, anonymousClient, errorCode, sessionCookieOf } from './support/auth';

const server = makeServer({
  port: SETUP_PORT, dir: SETUP_DIR,
  env: { AUTH_ENABLED: 'true', ADMIN_USERNAME: undefined, ADMIN_PASSWORD: undefined, RATE_LIMIT_PER_MINUTE: '0', AUTH_LOGIN_IP_LIMIT_PER_MINUTE: '1000' },
});

test.describe('first-run setup (no users yet)', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ auth: 'none', baseURL: server.baseUrl });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await server.stop().catch(() => {});
    server.prepareFreshDatabase();
    await server.start();
  });
  test.afterAll(async () => {
    await server.stop().catch(() => {});
    server.remove();
  });

  test('status says setup is required; every route redirects to /setup; the API refuses everything but setup/status/health', async ({ page, playwright }) => {
    const anon = await anonymousClient(playwright, server.baseUrl);
    expect((await (await anon.get('/api/auth/status')).json()).data).toMatchObject({ authEnabled: true, setupRequired: true, authenticated: false });
    expect((await anon.get('/api/projects')).status()).toBe(401);
    expect((await anon.get('/api/health')).status()).toBe(200);
    await anon.dispose();

    for (const p of ['/', '/projects', '/login', '/settings?x=1']) {
      await page.goto(p);
      await expect(page, p).toHaveURL(/\/setup$/);
      await expect(page.getByRole('heading', { name: 'Create the first administrator' })).toBeVisible();
    }
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
  });

  test('validation: mismatch, too short, username inside the password, common password, bad username; nothing is created until it is valid', async ({ page, playwright }) => {
    await page.goto('/setup');
    const submit = page.getByTestId('setup-submit');
    await expect(submit).toBeDisabled();
    const fill = async (u: string, p: string, c: string) => {
      await page.getByTestId('setup-username').fill(u);
      await page.getByTestId('setup-password').fill(p);
      await page.getByTestId('setup-confirm').fill(c);
    };
    await fill('founder', 'Tangerine-Moss-Harbor-31', 'Tangerine-Moss-Harbor-32');
    await submit.click();
    await expect(page.getByTestId('setup-error')).toContainText(/do not match/i);
    await fill('founder', 'short', 'short');
    await submit.click();
    await expect(page.getByTestId('setup-error')).toContainText(/at least 12/i);
    await fill('founder', 'my-founder-password-1', 'my-founder-password-1');
    await submit.click();
    await expect(page.getByTestId('setup-error')).toContainText(/username/i);
    await fill('founder', 'password1234', 'password1234');
    await submit.click();
    await expect(page.getByTestId('setup-error')).toContainText(/common/i);
    await fill('Bad Name!', STRONG_PASSWORD, STRONG_PASSWORD);
    await submit.click();
    await expect(page.getByTestId('setup-error')).toContainText(/username/i);
    await expect(page).toHaveURL(/\/setup$/);
    expect(await sessionCookieOf(page)).toBeUndefined();
    const anon = await anonymousClient(playwright, server.baseUrl);
    expect((await (await anon.get('/api/auth/status')).json()).data.setupRequired).toBe(true);
    await anon.dispose();
  });

  test('creating the first administrator signs in, lands on the dashboard, and closes /setup for good', async ({ page, playwright }) => {
    await page.goto('/setup');
    await page.getByTestId('setup-username').fill('Founder'); // normalised to lower case
    await page.getByTestId('setup-password').fill(STRONG_PASSWORD);
    await page.getByTestId('setup-confirm').fill(STRONG_PASSWORD);
    await page.getByTestId('setup-submit').click();
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('user-menu-username')).toHaveText('founder');
    await expect(page.getByTestId('user-menu-role')).toHaveText('ADMIN');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    // setup is closed: UI redirects away, API answers 409 SETUP_COMPLETE
    await page.goto('/setup');
    await expect(page).not.toHaveURL(/\/setup/);
    const anon = await anonymousClient(playwright, server.baseUrl);
    const again = await anon.post('/api/auth/setup', { username: 'intruder', password: STRONG_PASSWORD });
    expect(again.status()).toBe(409);
    expect(await errorCode(again)).toBe('SETUP_COMPLETE');
    expect((await (await anon.get('/api/auth/status')).json()).data).toMatchObject({ setupRequired: false, authenticated: false });
    await anon.dispose();

    // the new admin works end to end: create a project, log out, log back in
    await page.goto('/projects');
    await page.getByTestId('project-create-open').click();
    await page.getByTestId('project-name-input').fill('Setup Smoke');
    await page.getByTestId('project-create-submit').click();
    await expect(page.getByTestId('project-row-setup-smoke')).toBeVisible();
    await page.getByTestId('logout-button').click();
    await expect(page).toHaveURL(/\/login$/); // setup is complete: login, not setup
    await page.getByTestId('login-username').fill('founder');
    await page.getByTestId('login-password').fill(STRONG_PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('user-menu')).toBeVisible();
  });

  test('setup survives a server restart: still no setup page, session cookie still valid', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-username').fill('founder');
    await page.getByTestId('login-password').fill(STRONG_PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await server.restart();
    await page.goto('/projects');
    await expect(page.getByTestId('user-menu-username')).toHaveText('founder'); // sessions are stored in SQLite
    await expect(page.getByTestId('project-row-setup-smoke')).toBeVisible();
  });
});
