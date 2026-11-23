import { test, expect } from '@playwright/test';
import { NAV, watchConsole } from './support/helpers';

// Runs first, against a brand-new empty DB: also proves every page renders its empty state without errors.
test.describe('app shell', () => {
  test('loads, shows the DEMO / SIMULATED banners and navigates to every page via the sidebar without console errors', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');
    await expect(page).toHaveTitle(/AI Spend Guard Lite/);
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toContainText('Demo / Simulated');
    await expect(page.getByTestId('sim-banner')).toContainText('simulated');
    await expect(page.getByTestId('sim-banner')).toContainText('no external AI requests');
    await expect(page.getByTestId('demo-banner')).toContainText('DEMO / SIMULATED');

    for (const item of NAV) {
      await sidebar.getByRole('link', { name: item.label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${item.path === '/' ? '/$' : `${item.path}$`}`));
      await expect(page.getByRole('heading', { level: 1, name: item.heading })).toBeVisible();
      await expect(page.getByTestId('sim-banner')).toBeVisible();
      // no stuck spinners / error boxes once the page settled
      await expect(page.getByRole('status').filter({ hasText: /^Loading/ })).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('active nav item is highlighted and deep links work (reload keeps the page)', async ({ page }) => {
    await page.goto('/budgets');
    await expect(page.getByRole('heading', { level: 1, name: 'Budgets & Alerts' })).toBeVisible();
    await expect(page.getByTestId('sidebar').getByRole('link', { name: 'Budgets & Alerts' })).toHaveClass(/bg-brand-50/);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Budgets & Alerts' })).toBeVisible();
  });

  test('unknown client route renders a not-found message inside the shell; unknown API route is a JSON 404', async ({ page, request }) => {
    await page.goto('/definitely/not/a/page');
    await expect(page.getByText('Page not found')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    const res = await request.get('/api/nope');
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  test('demo banners are present on the simulated-data pages', async ({ page }) => {
    for (const path of ['/', '/usage', '/simulator']) {
      await page.goto(path);
      await expect(page.getByTestId('demo-banner')).toBeVisible();
      await expect(page.getByTestId('demo-banner')).toContainText('DEMO / SIMULATED');
    }
  });

  test('theme toggle switches light/dark and persists across reloads', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    const html = page.locator('html');
    const toggle = page.getByTestId('theme-toggle');
    await expect(html).not.toHaveClass(/dark/);
    await expect(toggle).toHaveText('Dark mode');

    await toggle.click();
    await expect(html).toHaveClass(/dark/);
    await expect(toggle).toHaveText('Light mode');
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.reload();
    await expect(html).toHaveClass(/dark/);
    await expect(toggle).toHaveText('Light mode');
    await page.getByTestId('sidebar').getByRole('link', { name: 'Projects' }).click();
    await expect(html).toHaveClass(/dark/); // survives client-side navigation too

    await toggle.click();
    await expect(html).not.toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(lightBg).not.toBe(darkBg);
    await page.reload();
    await expect(html).not.toHaveClass(/dark/);
    await expect(page.getByTestId('theme-toggle')).toHaveText('Dark mode');
  });

  test('explicit stored theme wins over the OS preference', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.goto('/');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });
});

test.describe('empty states on a fresh database', () => {
  test('dashboard offers demo data; usage/traces/errors/logs/budgets show friendly empty states', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('dashboard-empty')).toBeVisible();
    await expect(page.getByTestId('dashboard-seed')).toBeVisible();
    await expect(page.getByTestId('dashboard-total-requests')).toHaveText('0');
    await page.goto('/usage');
    await expect(page.getByTestId('empty-state')).toContainText('No usage recorded yet');
    await page.goto('/budgets');
    await expect(page.getByTestId('budget-empty').or(page.getByText('No budgets yet'))).toBeVisible();
    await page.goto('/errors');
    await expect(page.getByTestId('empty-state').first()).toBeVisible();
    await page.goto('/projects');
    await expect(page.getByTestId('empty-state')).toContainText('No projects match');
  });
});
