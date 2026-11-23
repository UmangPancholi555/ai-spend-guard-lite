import { test, expect } from './support/test';
import { apiGet, watchConsole } from './support/helpers';

test.describe('dashboard', () => {
  test('empty dashboard -> "Generate demo data" seeds simulated requests; cards, charts and tables reflect them', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('dashboard-empty')).toBeVisible();
    await page.getByTestId('dashboard-seed').click();
    await expect(page.getByTestId('dashboard-empty')).toBeHidden({ timeout: 30_000 });

    const dash = await apiGet(request, '/api/dashboard?days=30');
    expect(dash.totals.requests).toBe(200);
    expect(dash.totals.failures).toBeGreaterThan(0);
    expect(dash.label).toBe('DEMO / SIMULATED');

    // cards mirror the API numbers
    await expect(page.getByTestId('dashboard-total-requests')).toHaveText('200');
    const spend = page.getByTestId('dashboard-total-spend');
    await expect(spend).toHaveText(/^\$\d[\d,]*\.\d{2,6}$/);
    await expect(spend).not.toHaveText('$0.00');
    const num = (n: number) => n.toLocaleString('en-US');
    await expect(page.getByTestId('dashboard-input-tokens')).toHaveText(num(dash.totals.inputTokens));
    await expect(page.getByTestId('dashboard-output-tokens')).toHaveText(num(dash.totals.outputTokens));
    await expect(page.getByTestId('dashboard-cached-tokens')).toHaveText(num(dash.totals.cachedTokens));
    await expect(page.getByTestId('dashboard-success-rate')).toContainText(`${(dash.totals.successRate * 100).toFixed(1)}%`);
    await expect(page.getByTestId('dashboard-success-rate')).toBeVisible();
    await expect(page.getByText(`${num(dash.totals.successes)} ok / ${num(dash.totals.failures)} failed`)).toBeVisible();

    // charts actually render SVG content (recharts), not just empty boxes
    for (const id of ['chart-daily-spend', 'chart-success-failure', 'chart-provider-cost']) {
      const chart = page.getByTestId(id);
      await expect(chart).toBeVisible();
      await expect(chart.locator('.recharts-wrapper > svg.recharts-surface')).toBeVisible();
      const box = await chart.boundingBox();
      expect(box!.width).toBeGreaterThan(100);
      expect(box!.height).toBeGreaterThan(100);
    }
    await expect(page.getByTestId('chart-daily-spend').locator('path.recharts-area-area, path.recharts-area-curve').first()).toBeAttached();
    await expect(page.getByTestId('chart-success-failure').locator('.recharts-bar-rectangle').first()).toBeAttached();
    await expect(page.getByTestId('chart-provider-cost').locator('.recharts-bar-rectangle').first()).toBeAttached();

    // tables
    await expect(page.getByTestId('provider-row')).toHaveCount(dash.providerBreakdown.length);
    await expect(page.getByTestId('model-row')).toHaveCount(dash.modelBreakdown.length);
    await expect(page.getByTestId('recent-activity')).toBeVisible();
    await expect(page.getByTestId('recent-error-item').first()).toBeVisible();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('range selector re-queries the API and zero-fills days', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('dashboard-total-requests')).toHaveText('200');
    const [resp] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/dashboard') && r.url().includes('days=7')),
      page.getByTestId('dashboard-range').selectOption('7'),
    ]);
    const body = await resp.json();
    expect(body.data.dailySpend).toHaveLength(7);
    await expect(page.getByTestId('dashboard-total-requests')).toHaveText(body.data.totals.requests.toLocaleString('en-US'));
    await page.getByTestId('dashboard-range').selectOption('30');
    await expect(page.getByTestId('dashboard-total-requests')).toHaveText('200');
  });

  test('refresh button reloads data (new request appears without a page reload)', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId('dashboard-total-requests')).toHaveText('200');
    const projects = await apiGet(request, '/api/projects?pageSize=1');
    const r = await request.post('/api/providers/requests', { data: { projectId: projects[0].id, provider: 'openai', model: 'gpt-4o-mini', prompt: 'refresh test' } });
    expect(r.status()).toBe(201);
    await page.getByTestId('dashboard-refresh').click();
    await expect(page.getByTestId('dashboard-total-requests')).toHaveText('201');
  });

  test('recent error links lead to request details and traces', async ({ page }) => {
    await page.goto('/');
    const first = page.getByTestId('recent-error-item').first();
    await first.getByRole('link', { name: 'request details' }).click();
    await expect(page).toHaveURL(/\/usage\?detail=/);
    await expect(page.getByTestId('usage-drawer')).toBeVisible();
    await expect(page.getByTestId('drawer-status')).toHaveText('FAILURE');
    await expect(page.getByTestId('drawer-error')).toBeVisible();
  });
});
