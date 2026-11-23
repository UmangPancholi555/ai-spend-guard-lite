import { test, expect } from '@playwright/test';
import { apiGet, watchConsole } from './support/helpers';

test.describe('settings', () => {
  // keep specs independent: always put the defaults back
  test.afterEach(async ({ request }) => {
    await request.put('/api/settings', { data: { retentionDays: 30, slowOperationMs: 500 } });
  });

  test('updating retention and slow-operation threshold persists after reload (and server-side)', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.goto('/settings');
    const retention = page.getByTestId('settings-retention-input');
    const slow = page.getByTestId('settings-slow-input');
    const save = page.getByTestId('settings-save');
    await expect(retention).toHaveValue('30');
    await expect(slow).toHaveValue('500');
    await expect(save).toBeDisabled(); // nothing changed yet

    await retention.fill('45');
    await slow.fill('1234');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId('settings-saved')).toBeVisible();

    expect(await apiGet(request, '/api/settings')).toEqual({ retentionDays: 45, slowOperationMs: 1234, captureContentPlaintext: false });
    await page.reload();
    await expect(page.getByTestId('settings-retention-input')).toHaveValue('45');
    await expect(page.getByTestId('settings-slow-input')).toHaveValue('1234');

    // the slow threshold is used by Observability ("over 1.23s")
    await page.goto('/observability');
    await expect(page.getByText('over 1.23s')).toBeVisible();

    // the change is recorded in the activity feed
    const act = await apiGet(request, '/api/activity?type=settings.updated');
    expect(act.length).toBeGreaterThan(0);
    expect(act[0].source).toBe('ACTUAL');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('validation: non-numeric / out-of-range values are rejected inline and cannot be saved', async ({ page, request }) => {
    await page.goto('/settings');
    const save = page.getByTestId('settings-save');
    await page.getByTestId('settings-retention-input').fill('abc');
    await expect(page.getByTestId('settings-retention-error')).toContainText('whole number');
    await expect(save).toBeDisabled();
    await page.getByTestId('settings-retention-input').fill('99999');
    await expect(page.getByTestId('settings-retention-error')).toContainText('between 0 and 3650');
    await page.getByTestId('settings-retention-input').fill('-1');
    await expect(page.getByTestId('settings-retention-error')).toBeVisible();
    await page.getByTestId('settings-retention-input').fill('30');
    await expect(page.getByTestId('settings-retention-error')).toHaveCount(0);
    await page.getByTestId('settings-slow-input').fill('0');
    await expect(page.getByTestId('settings-slow-error')).toContainText('between 1 and 600000');
    await expect(save).toBeDisabled();
    await page.getByTestId('settings-slow-input').fill('');
    await expect(save).toBeDisabled();
    // nothing was persisted
    expect(await apiGet(request, '/api/settings')).toEqual({ retentionDays: 30, slowOperationMs: 500, captureContentPlaintext: false });
    // the API itself rejects bad values
    expect((await request.put('/api/settings', { data: { retentionDays: -5 } })).status()).toBe(400);
    expect((await request.put('/api/settings', { data: { slowOperationMs: 700000 } })).status()).toBe(400);
  });

  test('plaintext capture is permanently OFF in the UI and cannot be enabled through the API', async ({ page, request }) => {
    await page.goto('/settings');
    await expect(page.getByTestId('settings-capture-plaintext')).toBeDisabled();
    await expect(page.getByTestId('settings-capture-plaintext')).not.toBeChecked();
    await expect(page.getByTestId('settings-capture-plaintext-state')).toContainText('OFF');
    await request.put('/api/settings', { data: { captureContentPlaintext: true } });
    expect((await apiGet(request, '/api/settings')).captureContentPlaintext).toBe(false);
    await expect(page.getByTestId('settings-explainer')).toContainText('No real AI vendor is ever called');
    await expect(page.getByTestId('settings-explainer')).toContainText('never stored in plaintext');
  });

  test('retention sweep deletes old log rows only (usage is untouched) and reports a RETENTION_SWEEP task', async ({ page, request }) => {
    const usageBefore = (await (await request.get('/api/usage?pageSize=1')).json()).pagination.total;
    await page.goto('/settings');
    await page.getByTestId('settings-retention-run').click();
    const res = page.getByTestId('retention-result');
    await expect(res).toBeVisible();
    await expect(res).toContainText('SUCCEEDED');
    await expect(res).toContainText('ACTUAL');
    await expect(page.getByTestId('retention-result-json')).toBeVisible();
    const tasks = await apiGet(request, '/api/background-tasks?kind=RETENTION_SWEEP');
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0].status).toBe('SUCCEEDED');
    const usageAfter = (await (await request.get('/api/usage?pageSize=1')).json()).pagination.total;
    expect(usageAfter).toBe(usageBefore);
  });
});
