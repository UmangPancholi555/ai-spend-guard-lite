import { test, expect } from '@playwright/test';
import { apiCreateProject, apiGet, downloadText, parseCsv, slug, uniq, usdToPico, watchConsole } from './support/helpers';

test.describe('request simulator -> usage', () => {
  test('sends a mock request, shows the DEMO / SIMULATED response, and the request appears in Usage with a details drawer', async ({ page }) => {
    const errors = watchConsole(page);
    const project = uniq('Sim Proj');
    await page.goto('/simulator');
    await expect(page.getByTestId('demo-banner')).toContainText('No external AI vendor is contacted');

    // quick-create a project right from the simulator
    await page.getByTestId('sim-quick-toggle').click();
    await page.getByTestId('sim-quick-name').fill(project);
    await page.getByTestId('sim-quick-submit').click();
    await expect(page.getByTestId('sim-project')).toContainText(project);
    await expect(page.getByTestId('sim-quick-form')).toBeHidden();

    await page.getByTestId('sim-provider').selectOption('openai');
    await page.getByTestId('sim-model').selectOption('gpt-4o-mini');
    await page.getByTestId('sim-prompt').fill('E2E_PROMPT_MARKER please summarise');
    await page.getByTestId('sim-max-tokens').fill('120');
    await page.getByTestId('simulator-submit').click();

    const result = page.getByTestId('simulator-result');
    await expect(result).toBeVisible();
    await expect(page.getByTestId('simulator-result-banner')).toContainText('DEMO / SIMULATED');
    await expect(page.getByText('DEMO / SIMULATED', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('simulator-result-status')).toHaveText('SUCCESS');
    const content = await page.getByTestId('simulator-result-content').innerText();
    expect(content).toContain('[DEMO / SIMULATED]');
    expect(content).not.toContain('E2E_PROMPT_MARKER'); // prompt is never echoed
    const inTok = Number((await page.getByTestId('simulator-result-input').innerText()).replace(/,/g, ''));
    const outTok = Number((await page.getByTestId('simulator-result-output').innerText()).replace(/,/g, ''));
    expect(outTok).toBeGreaterThan(0);
    expect(outTok).toBeLessThanOrEqual(120);
    await expect(page.getByTestId('simulator-result-cost').getByTestId('cost-total')).toHaveText(/^\$0\.\d{6,12}$|^\$0\.\d{2,12}$/);
    await expect(page.getByTestId('cost-class-explanation').first()).toContainText('SIMULATED');
    await expect(page.getByTestId('simulator-no-alerts')).toBeVisible();

    // ground truth from the API
    const usage = await apiGet(page.request, `/api/usage?search=${encodeURIComponent(project)}`);
    expect(usage).toHaveLength(1);
    expect(usage[0].inputTokens).toBe(inTok);
    expect(usage[0].outputTokens).toBe(outTok);
    const reqId = usage[0].requestId as string;
    await expect(result).toContainText(reqId);

    // jump to details drawer from the response panel
    await page.getByTestId('simulator-usage-link').click();
    await expect(page).toHaveURL(/\/usage\?detail=/);
    const drawer = page.getByTestId('usage-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('DEMO / SIMULATED');
    await expect(page.getByTestId('drawer-request-id')).toHaveText(reqId);
    await expect(page.getByTestId('drawer-status')).toHaveText('SUCCESS');
    await expect(drawer).toContainText('Prompt (not stored)');
    await expect(drawer).toContainText(/SHA-256/);
    await expect(drawer.getByTestId('cost-pricing-version')).toHaveText(/^v\d+$/);
    const meta = JSON.parse(await page.getByTestId('drawer-metadata').innerText());
    expect(meta.simulated).toBe(true);
    expect(meta.model).toBe('gpt-4o-mini');
    expect(JSON.stringify(meta)).not.toContain('E2E_PROMPT_MARKER');
    await expect(page.getByTestId('drawer-trace-link')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/detail=/);

    // the Usage table lists it (filter by project via UI)
    await page.getByTestId('usage-search').fill(reqId);
    await expect(page.getByTestId('usage-row')).toHaveCount(1);
    const row = page.getByTestId('usage-row');
    await expect(row).toContainText(project);
    await expect(row).toContainText('gpt-4o-mini');
    await expect(row).toContainText('SUCCESS');
    await expect(row).toContainText('SIMULATED');
    await row.click();
    await expect(page.getByTestId('drawer-request-id')).toHaveText(reqId);
    await page.getByTestId('modal-close').click();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('unknown/custom model is accepted and labelled ESTIMATED with fallback pricing', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Est Proj'));
    await page.goto('/simulator');
    await page.getByTestId('sim-project').selectOption(p.id);
    await page.getByTestId('sim-model').selectOption('__custom__');
    await page.getByTestId('sim-custom-model').fill('my-experimental-model');
    await page.getByTestId('simulator-submit').click();
    const cost = page.getByTestId('simulator-result-cost');
    await expect(cost).toBeVisible();
    await expect(cost).toContainText('ESTIMATED');
    await expect(cost.getByTestId('cost-class-explanation')).toContainText('fallback pricing');
    await expect(cost.getByTestId('cost-pricing-version')).toHaveText(/^v\d+$|fallback/);
    // persisted as ESTIMATED and shown as an amber ESTIMATED badge in the Usage table
    await page.goto(`/usage?projectId=${p.id}`);
    const row = page.getByTestId('usage-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('my-experimental-model');
    await expect(row.getByText('ESTIMATED')).toBeVisible();
    const [u] = await apiGet(request, `/api/usage?projectId=${p.id}`);
    expect(u.costClass).toBe('ESTIMATED');
  });

  test('simulated failures (error / timeout / rate limit) are recorded as FAILURE with error details', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Fail Proj'));
    await page.goto('/simulator');
    await page.getByTestId('sim-project').selectOption(p.id);
    for (const mode of ['error', 'timeout', 'rate_limit']) {
      await page.getByTestId('sim-failure').selectOption(mode);
      await page.getByTestId('sim-prompt').fill(`failure mode ${mode}`);
      await page.getByTestId('simulator-submit').click();
      await expect(page.getByTestId('simulator-result-status')).toHaveText('FAILURE');
      await expect(page.getByTestId('simulator-result-error')).toBeVisible();
      await expect(page.getByTestId('simulator-result-content')).toHaveCount(0);
      await expect(page.getByTestId('simulator-result')).toContainText('No content (request failed)');
    }
    await page.goto(`/usage?projectId=${p.id}&status=FAILURE`);
    await expect(page.getByTestId('usage-row')).toHaveCount(3);
    await page.getByTestId('usage-row').first().click();
    await expect(page.getByTestId('drawer-error')).toBeVisible();
    await expect(page.getByTestId('drawer-status')).toHaveText('FAILURE');
  });

  test('client-side validation and archived projects are not offered', async ({ page, request }) => {
    const archived = await apiCreateProject(request, uniq('Archived Sim'));
    await request.post(`/api/projects/${archived.id}/archive`);
    await page.goto('/simulator');
    await expect(page.getByTestId('sim-project').locator(`option[value="${archived.id}"]`)).toHaveCount(0);
    await page.getByTestId('sim-prompt').fill('   ');
    await page.getByTestId('simulator-submit').click();
    await expect(page.getByTestId('simulator-error')).toHaveText('Prompt is required.');
    await page.getByTestId('sim-prompt').fill('ok');
    await page.getByTestId('sim-max-tokens').fill('0');
    await page.getByTestId('simulator-submit').click();
    await expect(page.getByTestId('simulator-error')).toContainText('Max output tokens');
    await page.getByTestId('sim-max-tokens').fill('50');
    await page.getByTestId('sim-temperature').fill('5');
    await page.getByTestId('simulator-submit').click();
    await expect(page.getByTestId('simulator-error')).toContainText('Temperature');
  });

  test('usage page: filters, sorting, URL state and CSV export (downloaded file is valid and matches the filtered table)', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Csv Proj'));
    const mk = (extra: Record<string, unknown>) => request.post('/api/providers/requests', { data: { projectId: p.id, prompt: `csv ${JSON.stringify(extra)}`, provider: 'openai', model: 'gpt-4o', ...extra } });
    for (const extra of [{}, { model: 'gpt-4o-mini' }, { provider: 'anthropic', model: 'claude-haiku' }, { simulateFailure: 'error' }, { model: 'weird-model-x' }]) expect((await mk(extra)).status()).toBe(201);

    await page.goto('/usage');
    await page.getByTestId('usage-project').selectOption(p.id);
    await expect(page.getByTestId('usage-row')).toHaveCount(5);
    await expect(page).toHaveURL(new RegExp(`projectId=${p.id}`));

    // CSV of everything for this project
    const { text, filename } = await downloadText(page, () => page.getByTestId('usage-export').click());
    expect(filename).toMatch(/^usage-export-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = parseCsv(text);
    const [header, ...data] = rows;
    expect(header).toEqual(['request_id', 'created_at', 'project_id', 'project_name', 'provider', 'model', 'status', 'error_code', 'input_tokens',
      'output_tokens', 'cached_tokens', 'cost_usd', 'cost_class', 'pricing_version', 'duration_ms', 'trace_id', 'simulated']);
    expect(data).toHaveLength(5);
    expect(new Set(data.map(r => r[header.indexOf('project_id')]))).toEqual(new Set([p.id]));
    expect(data.filter(r => r[header.indexOf('status')] === 'FAILURE')).toHaveLength(1);
    expect(data.filter(r => r[header.indexOf('cost_class')] === 'ESTIMATED')).toHaveLength(1);
    expect(data.every(r => /^\d+\.\d{12}$/.test(r[header.indexOf('cost_usd')]) && r[header.indexOf('simulated')] === 'true')).toBe(true);
    const api = await apiGet(request, `/api/usage?projectId=${p.id}`);
    const sum = (xs: string[]) => xs.reduce((s, x) => s + usdToPico(x), 0n);
    expect(sum(data.map(r => r[header.indexOf('cost_usd')]))).toBe(sum(api.map((u: any) => u.costUsd)));

    // status filter -> table + CSV agree
    await page.getByTestId('usage-status').selectOption('FAILURE');
    await expect(page.getByTestId('usage-row')).toHaveCount(1);
    const failCsv = await downloadText(page, () => page.getByTestId('usage-export').click());
    expect(parseCsv(failCsv.text)).toHaveLength(2); // header + 1 row
    await page.getByTestId('usage-status').selectOption('');

    // provider -> model dependency, sort by cost
    await page.getByTestId('usage-provider').selectOption('anthropic');
    await expect(page.getByTestId('usage-row')).toHaveCount(1);
    await expect(page.getByTestId('usage-model').locator('option')).toContainText(['All models', 'claude-haiku']);
    await page.getByTestId('usage-clear').click();
    await expect(page).not.toHaveURL(/projectId=/);
    await page.getByTestId('usage-project').selectOption(p.id);
    await page.getByTestId('usage-sort').selectOption('costUsd');
    await page.getByTestId('usage-order').selectOption('asc');
    await expect(page.getByTestId('usage-row')).toHaveCount(5);
    const [first, last] = [(await apiGet(request, `/api/usage?projectId=${p.id}&sort=costUsd&order=asc&pageSize=1`))[0], (await apiGet(request, `/api/usage?projectId=${p.id}&sort=costUsd&order=desc&pageSize=1`))[0]];
    await expect(page.getByTestId('usage-row').first()).toContainText(first.model);
    await expect(page.getByTestId('usage-row').last()).toContainText(last.model);

    // search with no matches
    await page.getByTestId('usage-search').fill('no-such-thing-zzz');
    await expect(page.getByTestId('empty-state')).toContainText('No usage events match these filters');
    // shareable URL restores state
    await page.getByTestId('usage-search').fill(slug(p.name).slice(0, 8));
    await page.reload();
    await expect(page.getByTestId('usage-project')).toHaveValue(p.id);
  });

  test('simulated agent execution run from the simulator links to its trace', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Agent Proj'));
    await page.goto('/simulator');
    await page.getByTestId('sim-project').selectOption(p.id);
    await page.getByTestId('agent-fail').check();
    await page.getByTestId('simulator-agent-run').click();
    const link = page.getByTestId('simulator-agent-trace-link');
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/traces\/[0-9a-f]{32}$/);
    await expect(page.getByTestId('trace-status')).toHaveText('ERROR');
    await expect(page.getByTestId('timeline-entry-failed').first()).toBeVisible();
  });

  test('seed demo data from the simulator (small batch) reports the number created', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Seed Proj'));
    await page.goto('/simulator');
    await page.getByTestId('sim-project').selectOption(p.id);
    await page.getByTestId('seed-requests').fill('15');
    await page.getByTestId('seed-days').fill('5');
    await page.getByTestId('simulator-seed').click();
    await expect(page.getByTestId('simulator-seed-result')).toContainText('Created 15 simulated requests');
    const rows = await apiGet(request, `/api/usage?projectId=${p.id}&pageSize=100`);
    expect(rows).toHaveLength(15);
    const tasks = await apiGet(request, '/api/background-tasks?kind=DEMO_SEED');
    expect(tasks.some((t: any) => t.status === 'SUCCEEDED' && t.source === 'SIMULATED')).toBe(true);
  });
});
