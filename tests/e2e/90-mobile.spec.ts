import { test, expect } from './support/test';
import { NAV, expectNoHorizontalOverflow, watchConsole, apiCreateProject, apiGet, apiRequest, uniq } from './support/helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test.describe('mobile viewport (390px)', () => {
  test.beforeAll(async ({ request }) => {
    const p = await apiCreateProject(request, uniq('Mobile Proj'));
    await apiRequest(request, p.id, { simulateAgentActivity: true });
  });

  test('sidebar is collapsed behind a menu button, opens, navigates and closes; the page has no horizontal overflow', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');
    const sidebar = page.getByTestId('sidebar');
    const menu = page.getByRole('button', { name: 'Open menu' });
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('sim-banner')).toBeHidden(); // desktop-only banner; the in-page DemoBanner still shows
    await expect(page.getByTestId('demo-banner')).toBeVisible();
    // off-canvas: translated fully outside the viewport
    expect((await sidebar.boundingBox())!.x + (await sidebar.boundingBox())!.width).toBeLessThanOrEqual(1);
    await expectNoHorizontalOverflow(page);

    await menu.click();
    await expect.poll(async () => (await sidebar.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await sidebar.getByRole('link', { name: 'Usage', exact: true }).click();
    await expect(page).toHaveURL(/\/usage$/);
    await expect.poll(async () => { const b = (await sidebar.boundingBox())!; return b.x + b.width; }).toBeLessThanOrEqual(1); // closes on navigation
    await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();

    // backdrop click closes it too
    await menu.click();
    await expect.poll(async () => (await sidebar.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await page.mouse.click(380, 400);
    await expect.poll(async () => { const b = (await sidebar.boundingBox())!; return b.x + b.width; }).toBeLessThanOrEqual(1);

    // theme toggle remains reachable
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByTestId('theme-toggle').click();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('every page fits the viewport width (wide tables scroll inside their own container)', async ({ page }) => {
    for (const item of NAV) {
      await page.goto(item.path);
      await expect(page.getByRole('heading', { level: 1, name: item.heading })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: /^Loading/ })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    }
  });

  test('trace detail and forms are usable at 390px', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Mobile Trace'));
    const r = await apiRequest(request, p.id, { simulateAgentActivity: true, simulateFailure: 'rate_limit' });
    await page.goto(`/traces/${r.traceId}`);
    await expect(page.getByTestId('timeline-entry-failed').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto(`/projects/${p.id}`);
    await expect(page.getByTestId('project-total-requests')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto(`/usage?detail=${(await apiGet(request, `/api/usage?projectId=${p.id}`))[0].id}`);
    await expect(page.getByTestId('usage-drawer')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto('/simulator');
    await expect(page.getByTestId('simulator-submit')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto('/projects');
    await page.getByTestId('project-create-open').click();
    await expect(page.getByTestId('project-create-dialog')).toBeVisible();
    const box = (await page.getByTestId('project-create-dialog').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expectNoHorizontalOverflow(page);
  });
});
