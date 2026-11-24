import type { Page } from '@playwright/test';
import { test, expect } from './support/test';
import { apiBudget, apiCreateProject, apiGet, apiRequest, picoToUsd, uniq, usdToPico, watchConsole } from './support/helpers';

const PROMPT = 'budget e2e prompt '.repeat(8);
const req = { prompt: PROMPT, model: 'gpt-4o', maxOutputTokens: 200 };

/** exact cost of one identical request (deterministic mock), measured in a throw-away project */
async function unitCost(request: Parameters<typeof apiCreateProject>[0]): Promise<bigint> {
  const probe = await apiCreateProject(request, uniq('Budget Probe'));
  const r = await apiRequest(request, probe.id, req);
  return usdToPico(r.cost.totalCostUsd);
}

async function createBudgetViaUi(page: Page, o: { scope: string; name: string; period: string; limit: string }) {
  await page.getByTestId('budget-create-project').selectOption(o.scope);
  await page.getByTestId('budget-create-name').fill(o.name);
  await page.getByTestId('budget-create-period').selectOption(o.period);
  await page.getByTestId('budget-create-limit').fill(o.limit);
  await page.getByTestId('budget-create-submit').click();
}

test.describe('budgets & alerts', () => {
  test('create via UI; requests cross 50/80/100% -> exactly one alert row per threshold, none duplicated', async ({ page, request }) => {
    const errors = watchConsole(page);
    const c = await unitCost(request);
    const p = await apiCreateProject(request, uniq('Budget Proj'));
    const name = uniq('UI Budget');
    const limit = picoToUsd(c * 10n);

    await page.goto('/budgets');
    await createBudgetViaUi(page, { scope: p.id, name, period: 'MONTHLY', limit });
    await expect(page.getByTestId('budget-create-success')).toContainText(`Created "${name}"`);
    const row = page.getByTestId('budget-row').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('budget-percent')).toContainText('0.00%');
    await expect(row.getByTestId('budget-percent')).toContainText('Within budget');
    const budgetId = (await row.getAttribute('data-budget-id'))!;

    const alertsFor = () => page.getByTestId('alert-row').filter({ hasText: name });
    const sendAndExpect = async (n: number, expectPct: string, expectState: string) => {
      for (let i = 0; i < n; i++) await apiRequest(request, p.id, req);
      await page.getByTestId('budgets-evaluate').click(); // also reloads the page data
      await expect(page.getByTestId('evaluate-result')).toBeVisible();
      await expect(row.getByTestId('budget-percent')).toContainText(expectPct);
      await expect(row.getByTestId('budget-percent')).toContainText(expectState);
    };

    await sendAndExpect(4, '40.00%', 'Within budget');
    await expect(alertsFor()).toHaveCount(0);
    await expect(page.getByTestId('evaluate-count')).toHaveText('0'); // alerts were already created by the pipeline, nothing new for "evaluate"

    await sendAndExpect(1, '50.00%', 'Over 50%');
    await expect(alertsFor()).toHaveCount(1);
    await expect(alertsFor().first()).toHaveAttribute('data-threshold', '50');

    await sendAndExpect(3, '80.00%', 'Over 80%');
    await expect(alertsFor()).toHaveCount(2);

    await sendAndExpect(2, '100.00%', 'Limit reached');
    await expect(alertsFor()).toHaveCount(3);
    expect(await alertsFor().evaluateAll(els => els.map(e => e.getAttribute('data-threshold')).sort())).toEqual(['100', '50', '80']);
    // the alert level escalates with the threshold and is shown in the alert list: 50% INFO, 80% WARN, 100% CRITICAL
    for (const [threshold, level] of [['50', 'INFO'], ['80', 'WARN'], ['100', 'CRITICAL']]) {
      const lr = page.locator(`[data-testid="alert-row"][data-threshold="${threshold}"]`).filter({ hasText: name });
      await expect(lr).toHaveAttribute('data-level', level);
      await expect(lr.getByTestId('alert-level')).toHaveText(level);
    }
    await expect(row.getByTestId('utilization-bar')).toHaveAttribute('data-state', 'exceeded');

    // more spend past 100% and repeated evaluation never add rows
    await sendAndExpect(3, '130.00%', 'Limit reached');
    await expect(alertsFor()).toHaveCount(3);
    await page.getByTestId('budgets-evaluate').click();
    await expect(page.getByTestId('evaluate-count')).toHaveText('0');
    await expect(alertsFor()).toHaveCount(3);

    // spend column shows exact values from the API
    const alerts = await apiGet(request, `/api/budget-alerts?budgetId=${budgetId}`);
    expect(alerts).toHaveLength(3);
    const a50 = alerts.find((a: any) => a.threshold === 50);
    expect(usdToPico(a50.spendUsd)).toBe(c * 5n);
    await expect(page.locator('[data-testid="alert-row"][data-threshold="50"]').filter({ hasText: name })).toHaveCount(1);

    // alert history filters
    await page.getByTestId('alert-filter-budget').selectOption(budgetId);
    await expect(page.getByTestId('alert-row')).toHaveCount(3);
    await page.getByTestId('alert-filter-threshold').selectOption('80');
    await expect(page.getByTestId('alert-row')).toHaveCount(1);
    await expect(page.getByTestId('alert-row')).toHaveAttribute('data-threshold', '80');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a request sent from the simulator that crosses thresholds shows the new alerts in the response panel and on the dashboard', async ({ page, request }) => {
    const c = await unitCost(request);
    const p = await apiCreateProject(request, uniq('Sim Budget Proj'));
    await apiBudget(request, p.id, picoToUsd(c), 'DAILY', uniq('one-shot')); // one request == 100%
    await page.goto('/simulator');
    await page.getByTestId('sim-project').selectOption(p.id);
    await page.getByTestId('sim-provider').selectOption('openai');
    await page.getByTestId('sim-model').selectOption('gpt-4o');
    await page.getByTestId('sim-prompt').fill(PROMPT);
    await page.getByTestId('sim-max-tokens').fill('200');
    await page.getByTestId('sim-temperature').fill('');
    await page.getByTestId('simulator-submit').click();
    const alerts = page.getByTestId('simulator-alerts');
    await expect(alerts).toBeVisible();
    await expect(alerts.locator('li')).toHaveCount(3);
    for (const t of ['50%', '80%', '100%']) await expect(alerts).toContainText(t);
    await page.goto('/');
    await expect(page.getByTestId('recent-alerts')).toBeVisible();
    await expect(page.getByTestId('recent-alerts')).toContainText('100%');
    // dashboard shows each alert's level (existing level badge styling)
    await expect(page.getByTestId('recent-alerts').locator('[data-testid="alert-level"][data-level="CRITICAL"]').first()).toHaveText('CRITICAL');
    await expect(page.getByTestId('recent-alerts').locator('[data-testid="alert-level"][data-level="INFO"]').first()).toHaveText('INFO');
    await expect(page.getByTestId('budget-utilization-item').first()).toBeVisible();
  });

  test('concurrent requests never duplicate alerts', async ({ page, request }) => {
    const c = await unitCost(request);
    const p = await apiCreateProject(request, uniq('Concurrent Proj'));
    const name = uniq('conc-budget');
    await apiBudget(request, p.id, picoToUsd(c * 10n), 'WEEKLY', name);
    const rs = await Promise.all(Array.from({ length: 12 }, () => request.post('/api/providers/requests', { data: { projectId: p.id, provider: 'openai', ...req } })));
    expect(rs.map(r => r.status())).toEqual(Array(12).fill(201));
    await page.goto('/budgets');
    await expect(page.getByTestId('alert-row').filter({ hasText: name })).toHaveCount(3);
    await expect(page.getByTestId('budget-row').filter({ hasText: name }).getByTestId('budget-percent')).toContainText('120.00%');
  });

  test('validation: bad names/limits are blocked inline; duplicate scope+period is rejected by the API with a message', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Validation Proj'));
    await apiBudget(request, p.id, '5.00', 'MONTHLY', uniq('first'));
    await page.goto('/budgets');
    await page.getByTestId('budget-create-submit').click();
    await expect(page.getByTestId('budget-create-name-error')).toBeVisible();
    await expect(page.getByTestId('budget-create-limit-error')).toBeVisible();
    await page.getByTestId('budget-create-name').fill('x');
    for (const bad of ['0', '-5', 'abc', '1e3', '1.1234567890123']) {
      await page.getByTestId('budget-create-limit').fill(bad);
      await page.getByTestId('budget-create-submit').click();
      await expect(page.getByTestId('budget-create-limit-error'), `limit "${bad}"`).toBeVisible();
    }
    await createBudgetViaUi(page, { scope: p.id, name: 'dup', period: 'MONTHLY', limit: '9.99' });
    await expect(page.getByTestId('budget-create-error')).toContainText(/already|exists|unique|conflict/i);
  });

  test('edit limit, deactivate/activate, history toggle and delete (with confirm) a budget', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Edit Budget Proj'));
    const name = uniq('Editable');
    const b = await apiBudget(request, p.id, '10.00', 'DAILY', name);
    await page.goto('/budgets');
    const row = page.getByTestId('budget-row').filter({ hasText: name });
    await expect(row.getByTestId('budget-limit')).toHaveText('$10.00');

    await row.getByTestId('budget-edit').click();
    await row.getByTestId('budget-edit-limit').fill('-3');
    await expect(row.getByTestId('budget-edit-limit-error')).toBeVisible();
    await expect(row.getByTestId('budget-edit-save')).toBeDisabled();
    await row.getByTestId('budget-edit-limit').fill('12.5');
    await row.getByTestId('budget-edit-name').fill(`${name} v2`);
    await row.getByTestId('budget-edit-save').click();
    const row2 = page.getByTestId('budget-row').filter({ hasText: `${name} v2` });
    await expect(row2.getByTestId('budget-limit')).toHaveText('$12.50');
    expect((await apiGet(request, '/api/budgets?projectId=' + p.id))[0].limitUsd).toBe('12.500000000000');

    await row2.getByTestId('budget-toggle-active').click();
    await expect(row2).toHaveAttribute('data-active', 'false');
    await expect(row2).toContainText('Inactive');
    await row2.getByTestId('budget-toggle-active').click();
    await expect(row2).toHaveAttribute('data-active', 'true');

    await row2.getByTestId('budget-history-toggle').click();
    await expect(row2.getByTestId('utilization-history')).toBeVisible();

    await row2.getByTestId('budget-delete').click();
    await row2.getByTestId('budget-delete-cancel').click();
    await expect(row2).toBeVisible();
    await row2.getByTestId('budget-delete').click();
    await row2.getByTestId('budget-delete-confirm').click();
    await expect(page.getByTestId('budget-row').filter({ hasText: name })).toHaveCount(0);
    expect((await request.get(`/api/budgets/${b.id}/utilization`)).status()).toBe(404);
  });

  test('global budgets, project filter and alert export links', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Filter Budget Proj'));
    const name = uniq('Global One');
    await page.goto('/budgets');
    await createBudgetViaUi(page, { scope: '', name, period: 'WEEKLY', limit: '1000.00' });
    const row = page.getByTestId('budget-row').filter({ hasText: name });
    await expect(row).toContainText('Global');
    await page.getByTestId('budgets-filter-project').selectOption(p.id);
    await expect(page.getByTestId('budget-row').filter({ hasText: name })).toHaveCount(0);
    await page.getByTestId('budgets-filter-project').selectOption('');
    await expect(row).toBeVisible();
    await expect(page.getByTestId('export-alerts-jsonl')).toBeVisible();
    await expect(page.getByTestId('export-alerts-csv')).toBeVisible();
    await row.getByTestId('budget-delete').click();
    await row.getByTestId('budget-delete-confirm').click();
    await expect(row).toHaveCount(0);
  });
});
