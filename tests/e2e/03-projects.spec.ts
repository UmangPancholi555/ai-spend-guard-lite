import type { Page } from '@playwright/test';
import { test, expect } from './support/test';
import { apiCreateProject, apiRequest, slug, uniq, watchConsole } from './support/helpers';

async function createViaUi(page: Page, name: string, opts: { description?: string; isTest?: boolean } = {}) {
  await page.getByTestId('project-create-open').click();
  const dlg = page.getByTestId('project-create-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('project-name-input').fill(name);
  if (opts.description) await dlg.getByTestId('project-description-input').fill(opts.description);
  if (opts.isTest) await dlg.getByTestId('project-test-checkbox').check();
  await dlg.getByTestId('project-create-submit').click();
}

test.describe('projects', () => {
  test('create, edit, archive, unarchive and delete a test project through the UI', async ({ page }) => {
    const errors = watchConsole(page);
    const name = uniq('Proj UI');
    const s = slug(name);
    await page.goto('/projects');

    // create
    await createViaUi(page, name, { description: 'created by e2e', isTest: true });
    const row = page.getByTestId(`project-row-${s}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('ACTIVE');
    await expect(row).toContainText('test');
    await expect(row).toContainText('created by e2e');
    await expect(page.getByTestId('project-create-dialog')).toBeHidden();

    // edit
    const renamed = `${name} renamed`;
    await page.getByTestId(`project-edit-${s}`).click();
    const edit = page.getByTestId('project-edit-dialog');
    await expect(edit.getByTestId('project-name-input')).toHaveValue(name);
    await edit.getByTestId('project-name-input').fill(renamed);
    await edit.getByTestId('project-description-input').fill('edited description');
    await edit.getByTestId('project-edit-submit').click();
    const s2 = slug(renamed);
    await expect(page.getByTestId(`project-row-${s2}`)).toContainText('edited description');
    await expect(page.getByTestId(`project-row-${s}`)).toHaveCount(0);

    // archive -> status badge changes + filter
    await page.getByTestId(`project-archive-${s2}`).click();
    await expect(page.getByTestId(`project-row-${s2}`)).toContainText('ARCHIVED');
    await expect(page.getByTestId(`project-unarchive-${s2}`)).toBeVisible();
    await page.getByTestId('project-status-filter').selectOption('ACTIVE');
    await expect(page.getByTestId(`project-row-${s2}`)).toHaveCount(0);
    await page.getByTestId('project-status-filter').selectOption('ARCHIVED');
    await expect(page.getByTestId(`project-row-${s2}`)).toBeVisible();

    // unarchive
    await page.getByTestId(`project-unarchive-${s2}`).click();
    await expect(page.getByTestId(`project-row-${s2}`)).toHaveCount(0); // filtered view (ARCHIVED) no longer includes it
    await page.getByTestId('project-status-filter').selectOption('');
    await expect(page.getByTestId(`project-row-${s2}`)).toContainText('ACTIVE');

    // delete: cancel first, then confirm
    await page.getByTestId(`project-delete-${s2}`).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText(renamed);
    await page.getByTestId('project-delete-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toBeHidden();
    await expect(page.getByTestId(`project-row-${s2}`)).toBeVisible();
    await page.getByTestId(`project-delete-${s2}`).click();
    await page.getByTestId('project-delete-confirm').click();
    await expect(page.getByTestId(`project-row-${s2}`)).toHaveCount(0);
    expect(errors.filter(e => !/40[49]|Failed to load resource/.test(e)), errors.join('\n')).toEqual([]);
  });

  test('non-test projects cannot be deleted (button disabled, API 409), and flipping isTest enables deletion', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Real Proj'), false);
    const s = slug(p.name);
    await page.goto('/projects');
    const del = page.getByTestId(`project-delete-${s}`);
    await expect(del).toBeVisible();
    await expect(del).toBeDisabled();
    await expect(del).toHaveAttribute('title', /Only test projects can be deleted/);
    expect((await request.delete(`/api/projects/${p.id}`)).status()).toBe(409);

    // mark it as test through the edit dialog -> delete becomes available
    await page.getByTestId(`project-edit-${s}`).click();
    await page.getByTestId('project-test-checkbox').check();
    await page.getByTestId('project-edit-submit').click();
    await expect(page.getByTestId(`project-delete-${s}`)).toBeEnabled();
    await page.getByTestId(`project-delete-${s}`).click();
    await page.getByTestId('project-delete-confirm').click();
    await expect(page.getByTestId(`project-row-${s}`)).toHaveCount(0);
    expect((await request.get(`/api/projects/${p.id}`)).status()).toBe(404);
  });

  test('form validation: empty name, >80 chars, duplicate name (case-insensitive) show inline errors', async ({ page, request }) => {
    const existing = await apiCreateProject(request, uniq('Dup Name'));
    await page.goto('/projects');
    await page.getByTestId('project-create-open').click();
    const dlg = page.getByTestId('project-create-dialog');
    await dlg.getByTestId('project-create-submit').click();
    await expect(dlg.getByTestId('project-name-error')).toHaveText('Name is required.');
    await dlg.getByTestId('project-name-input').fill('x'.repeat(81));
    await dlg.getByTestId('project-create-submit').click();
    await expect(dlg.getByTestId('project-name-error')).toContainText('80 characters');
    await dlg.getByTestId('project-name-input').fill(existing.name.toUpperCase());
    await dlg.getByTestId('project-create-submit').click();
    await expect(dlg.getByTestId('project-form-error')).toContainText(/already exists|unique|conflict|exists/i);
    await expect(dlg).toBeVisible(); // dialog stays open so the user can fix the name
    await dlg.getByTestId('project-form-cancel').click();
    await expect(dlg).toBeHidden();
    // Escape also closes dialogs
    await page.getByTestId('project-create-open').click();
    await expect(page.getByTestId('project-create-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('project-create-dialog')).toBeHidden();
  });

  test('search and include-test filters', async ({ page, request }) => {
    const tag = uniq('findme');
    const a = await apiCreateProject(request, `${tag} alpha`, true);
    const b = await apiCreateProject(request, `${tag} beta`, false);
    await page.goto('/projects');
    await page.getByTestId('project-search').fill(tag);
    await expect(page.getByTestId(`project-row-${slug(a.name)}`)).toBeVisible();
    await expect(page.getByTestId(`project-row-${slug(b.name)}`)).toBeVisible();
    await page.getByTestId('project-include-test').uncheck();
    await expect(page.getByTestId(`project-row-${slug(a.name)}`)).toHaveCount(0);
    await expect(page.getByTestId(`project-row-${slug(b.name)}`)).toBeVisible();
    await page.getByTestId('project-include-test').check();
    await page.getByTestId('project-search').fill('zzz-no-such-project-zzz');
    await expect(page.getByTestId('empty-state')).toContainText('No projects match');
  });

  test('detail page shows usage, budgets and activity; archive from the detail page blocks new requests', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Detail Proj'));
    const r = await apiRequest(request, p.id, { model: 'gpt-4o-mini' });
    await apiRequest(request, p.id, { simulateFailure: 'error', prompt: 'fail please' });
    await page.goto('/projects');
    await page.getByTestId(`project-link-${slug(p.name)}`).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${p.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: p.name })).toBeVisible();
    await expect(page.getByTestId('project-total-requests')).toHaveText('2');
    await expect(page.getByTestId('project-total-cost')).not.toHaveText('$0.00');
    await expect(page.getByTestId('project-success-rate')).toContainText('50.0%');
    await expect(page.getByTestId('project-usage-row')).toHaveCount(2);
    await expect(page.getByTestId('project-budgets-empty')).toBeVisible();
    const items = page.getByTestId('project-activity-item');
    await expect(items.filter({ hasText: 'project.created' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'usage.recorded' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'request.failed' })).toHaveCount(1);
    await page.getByTestId('project-usage-link').click();
    await expect(page).toHaveURL(new RegExp(`/usage\\?projectId=${p.id}`));
    await expect(page.getByTestId('usage-row')).toHaveCount(2);

    await page.goto(`/projects/${p.id}`);
    await page.getByTestId('project-detail-archive').click();
    await expect(page.getByText('This project is archived and rejects new provider requests')).toBeVisible();
    const blocked = await request.post('/api/providers/requests', { data: { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'x' } });
    expect(blocked.status()).toBe(409);
    await page.getByTestId('project-detail-archive').click();
    await expect(page.getByText('This project is archived')).toHaveCount(0);
    // delete from detail page goes back to the list
    await page.getByTestId('project-detail-delete').click();
    await page.getByTestId('project-delete-confirm').click();
    await expect(page).toHaveURL(/\/projects$/);
    expect((await request.get(`/api/usage/${r.requestId}`)).status()).toBe(404); // usage cascaded
  });

  test('project detail for an unknown id shows an error, not a crash', async ({ page }) => {
    await page.goto('/projects/does-not-exist');
    await expect(page.getByRole('alert')).toContainText(/not found/i);
  });
});
