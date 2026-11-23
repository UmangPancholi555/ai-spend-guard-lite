import { test, expect } from '@playwright/test';
import { apiCreateProject, apiGet, apiRequest, fetchExport, jsonlLines, parseCsv, uniq, watchConsole } from './support/helpers';

test.describe('traces & execution timeline', () => {
  test('a request with agent activity shows a correlated timeline with ACTUAL and DEMO / SIMULATED badges', async ({ page, request }) => {
    const errors = watchConsole(page);
    const p = await apiCreateProject(request, uniq('Trace Proj'));
    const r = await apiRequest(request, p.id, { model: 'gpt-4o-mini', simulateAgentActivity: true, prompt: 'trace ok' });
    const api = await apiGet(request, `/api/traces/${r.traceId}`);

    // find it from the traces list through the search box
    await page.goto('/traces');
    await page.getByTestId('trace-filter-search').fill(r.requestId);
    const row = page.getByTestId('trace-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('provider.request');
    await expect(row).toContainText('OK');
    await expect(row).toContainText('ACTUAL');
    await expect(row).toContainText(String(api.trace.spanCount));
    await row.getByTestId('trace-open').click();
    await expect(page).toHaveURL(new RegExp(`/traces/${r.traceId}$`));

    // header
    await expect(page.getByTestId('trace-name')).toHaveText('provider.request');
    await expect(page.getByTestId('trace-status')).toHaveText('OK');
    await expect(page.getByTestId('trace-request-id')).toHaveText(r.requestId);
    await expect(page.getByTestId('trace-error')).toHaveCount(0);

    // timeline mirrors the API entry for entry
    const entries = page.getByTestId('timeline-entry');
    await expect(entries).toHaveCount(api.timeline.length);
    const actual = api.timeline.filter((e: any) => e.source === 'ACTUAL').length;
    const simulated = api.timeline.filter((e: any) => e.source === 'SIMULATED').length;
    expect(actual).toBeGreaterThan(0);
    expect(simulated).toBeGreaterThan(0);
    await expect(page.locator('[data-testid="timeline-source"][data-source="ACTUAL"]')).toHaveCount(actual);
    await expect(page.locator('[data-testid="timeline-source"][data-source="SIMULATED"]')).toHaveCount(simulated);
    await expect(page.locator('[data-testid="timeline-source"][data-source="ACTUAL"]').first()).toHaveText('ACTUAL');
    await expect(page.locator('[data-testid="timeline-source"][data-source="SIMULATED"]').first()).toHaveText('DEMO / SIMULATED');
    await expect(page.getByTestId('timeline-simulated-note')).toContainText(`${simulated} of ${api.timeline.length} entries are DEMO / SIMULATED`);

    // the correlated steps are all there, simulated ones never labelled ACTUAL
    const steps = page.getByTestId('timeline-step');
    for (const label of ['Execution started', 'Context initialized', 'Memory injection started', 'Memory injection completed', 'Bus operation executed',
      'Tool call initiated', 'Tool call failed', 'Tool call completed', 'Response generated', 'Execution completed']) {
      await expect(steps.filter({ hasText: new RegExp(`^${label}$`) }).first(), label).toBeVisible();
    }
    for (const step of ['context.initialized', 'memory.injection.started', 'bus.operation', 'tool.call.initiated']) {
      await expect(page.locator(`[data-testid="timeline-entry"][data-step="${step}"]`).first()).toHaveAttribute('data-source', 'SIMULATED');
    }
    for (const step of ['execution.started', 'execution.completed', 'response.generated']) {
      await expect(page.locator(`[data-testid="timeline-entry"][data-step="${step}"]`).first()).toHaveAttribute('data-source', 'ACTUAL');
    }
    // the retried tool call fails once (a FAILED marker) but the trace itself is OK
    await expect(page.getByTestId('timeline-entry-failed')).toHaveCount(api.timeline.filter((e: any) => e.status === 'FAILURE').length);
    await expect(page.getByTestId('trace-status')).toHaveText('OK');

    // expanding an entry reveals metadata-only details
    await entries.nth(1).getByTestId('timeline-entry-toggle').click();
    await expect(page.getByTestId('timeline-details')).toBeVisible();
    await expect(page.getByTestId('timeline-details')).toContainText('metadata only');

    // span waterfall: parent/child nesting and simulated spans
    const spans = page.getByTestId('span-tree').locator('[data-testid^="span-row"]');
    await expect(spans).toHaveCount(api.spans.length);
    await expect(spans.first()).toHaveAttribute('data-depth', '0');
    await expect(page.locator('[data-testid="span-row"][data-depth="1"]').first()).toBeVisible();
    await expect(page.getByTestId('span-bar').first()).toBeVisible();
    await spans.first().getByRole('button').click();
    await expect(page.getByTestId('span-detail')).toBeVisible();

    // correlated events panel (compact, scoped to this trace)
    const explorer = page.getByTestId('event-explorer');
    await expect(explorer.getByTestId('event-panel-memory')).toBeVisible();
    await expect(explorer.getByTestId('event-row')).toHaveCount(2); // STARTED + COMPLETED
    await expect(explorer.getByTestId('event-row').first()).toContainText('DEMO / SIMULATED');
    await explorer.getByTestId('event-tab-tool').click();
    await expect(explorer.getByTestId('event-row')).toHaveCount(3); // web_search x2 attempts + read_file
    await explorer.getByTestId('event-tab-context').click();
    await expect(explorer.getByTestId('event-row')).toHaveCount(4);
    await explorer.getByTestId('event-tab-bus').click();
    await expect(explorer.getByTestId('event-row')).toHaveCount(2);
    for (const t of ['bus', 'tool', 'context', 'memory']) {
      await explorer.getByTestId(`event-tab-${t}`).click();
      await expect(explorer.getByTestId('event-row').first()).toContainText('DEMO / SIMULATED');
      await expect(explorer.getByTestId('event-row').first()).not.toContainText('ACTUAL');
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a failed request highlights the failed timeline entry, shows the error and a stack toggle', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Trace Fail Proj'));
    const r = await apiRequest(request, p.id, { simulateFailure: 'rate_limit', simulateAgentActivity: true, prompt: 'trace fail' });
    expect(r.status).toBe('FAILURE');
    const api = await apiGet(request, `/api/traces/${r.traceId}`);
    expect(api.trace.status).toBe('ERROR');

    await page.goto(`/traces/${r.traceId}`);
    await expect(page.getByTestId('trace-status')).toHaveText('ERROR');
    const err = page.getByTestId('trace-error');
    await expect(err).toBeVisible();
    await expect(err).toContainText(api.trace.errorMessage);
    if (api.trace.stack) {
      await page.getByTestId('trace-stack-toggle').click();
      await expect(page.getByTestId('trace-stack')).toContainText(/Error|at /);
      await page.getByTestId('trace-stack-toggle').click();
      await expect(page.getByTestId('trace-stack')).toHaveCount(0);
    }

    const failed = page.getByTestId('timeline-entry-failed');
    const expectedFailed = api.timeline.filter((e: any) => e.status === 'FAILURE').length;
    expect(expectedFailed).toBeGreaterThanOrEqual(2); // provider failure + simulated bus failure (+ tool retry failure)
    await expect(failed).toHaveCount(expectedFailed);
    // each highlighted entry has the red treatment, an error message, a FAILURE status and a provenance badge
    const failedEntries = page.locator('[data-testid="timeline-entry"][data-status="FAILURE"]');
    await expect(failedEntries).toHaveCount(expectedFailed);
    for (const e of await failedEntries.all()) {
      await expect(e).toHaveClass(/bg-red-50/);
      await expect(e.getByTestId('timeline-entry-failed')).toHaveText('FAILED');
      await expect(e.getByTestId('timeline-source')).toBeVisible();
    }
    // simulated bus failure is SIMULATED, provider failure (the app's real request lifecycle) is ACTUAL
    await expect(page.locator('[data-testid="timeline-entry"][data-status="FAILURE"][data-source="SIMULATED"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="timeline-entry"][data-status="FAILURE"][data-source="ACTUAL"]').first()).toBeVisible();
    await expect(page.getByTestId('timeline-error').first()).toContainText(/rate limit|Simulated/i);
    // failed span rows in the waterfall
    await expect(page.getByTestId('span-row-failed').first()).toBeVisible();
    // trace-level list marks the error
    await page.goto('/traces');
    await page.getByTestId('trace-filter-search').fill(r.traceId);
    await expect(page.getByTestId('trace-row')).toHaveCount(1);
    await expect(page.getByTestId('trace-row')).toHaveAttribute('data-status', 'ERROR');
    await expect(page.getByTestId('trace-error-indicator')).toBeVisible();
  });

  test('standalone simulated agent run is a SIMULATED trace (no usage); filters by status/source/search/project work', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Trace Filter Proj'));
    const run = await request.post('/api/simulations/agent-run', { data: { projectId: p.id, simulateFailure: 'timeout' } });
    expect(run.status()).toBe(201);
    const traceId = (await run.json()).data.traceId as string;
    const ok = await apiRequest(request, p.id, { prompt: 'filter ok' });

    await page.goto('/traces');
    await page.getByTestId('trace-filter-project').selectOption(p.id);
    await expect(page.getByTestId('trace-row')).toHaveCount(2);
    await page.getByTestId('trace-filter-source').selectOption('SIMULATED');
    await expect(page.getByTestId('trace-row')).toHaveCount(1);
    await expect(page.getByTestId('trace-row')).toContainText('DEMO / SIMULATED');
    await expect(page.getByTestId('trace-row')).toHaveAttribute('data-status', 'ERROR');
    await page.getByTestId('trace-filter-source').selectOption('ACTUAL');
    await expect(page.getByTestId('trace-row')).toHaveCount(1);
    await expect(page.getByTestId('trace-row').getByTestId('trace-open')).toHaveAttribute('href', `/traces/${ok.traceId}`);
    await page.getByTestId('filter-bar').first().getByTestId('filter-reset').click();
    await expect(page.getByTestId('trace-filter-source')).toHaveValue('');
    await page.getByTestId('trace-filter-project').selectOption(p.id);
    await page.getByTestId('trace-filter-status').selectOption('ERROR');
    await expect(page.getByTestId('trace-row')).toHaveCount(1);
    await expect(page.getByTestId('trace-row').getByTestId('trace-open')).toHaveAttribute('href', `/traces/${traceId}`);
    await page.getByTestId('trace-filter-search').fill('does-not-exist-zzz');
    await expect(page.getByTestId('trace-table').getByTestId('empty-state')).toContainText('No traces match these filters');

    await page.goto(`/traces/${traceId}`);
    await expect(page.locator('[data-testid="timeline-source"][data-source="ACTUAL"]')).toHaveCount(0);
    await expect(page.getByTestId('timeline-simulated-note')).toBeVisible();
    // trace has no usage event: usage search for it finds nothing
    const usage = await apiGet(request, `/api/usage?search=${traceId}`);
    expect(usage).toHaveLength(0);
  });

  test('trace export links return valid JSONL and CSV; unknown trace id shows a not-found page', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Trace Export Proj'));
    const r = await apiRequest(request, p.id, { prompt: 'export me' });
    await page.goto('/traces');
    await page.getByTestId('trace-filter-project').selectOption(p.id);
    await expect(page.getByTestId('trace-row')).toHaveCount(1);

    const jl = await fetchExport(page, 'export-traces-jsonl');
    expect(jl.status).toBe(200);
    expect(jl.href).toContain(`projectId=${p.id}`);
    expect(jl.disposition).toMatch(/attachment; filename="spendguard-traces-.*\.jsonl"/);
    const objs = jsonlLines(jl.text);
    expect(objs).toHaveLength(1);
    expect(objs[0]).toMatchObject({ traceId: r.traceId, name: 'provider.request', status: 'OK', source: 'ACTUAL', requestId: r.requestId });

    const csv = await fetchExport(page, 'export-traces-csv');
    expect(csv.contentType).toMatch(/text\/csv/);
    const rows = parseCsv(csv.text);
    expect(rows[0]).toEqual(['traceId', 'name', 'projectId', 'requestId', 'status', 'source', 'startedAt', 'endedAt', 'durationMs', 'errorMessage', 'stack', 'spanCount']);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe(r.traceId);

    await page.goto('/traces/ffffffffffffffffffffffffffffffff');
    await expect(page.getByTestId('trace-not-found')).toBeVisible();
  });

  test('background tasks panel lists seed / retention / evaluation tasks with source labels', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Task Proj'));
    expect((await request.post('/api/simulations/seed', { data: { projectId: p.id, requests: 3, spreadDays: 2 } })).status()).toBeLessThan(300);
    await request.post('/api/budgets/evaluate');
    await page.goto('/traces');
    const panel = page.getByTestId('task-table');
    await expect(panel).toBeVisible();
    await page.getByTestId('task-filter-kind').selectOption('DEMO_SEED');
    await expect(page.getByTestId('task-row').filter({ hasNotText: 'DEMO_SEED' })).toHaveCount(0);
    await expect(page.getByTestId('task-row').first()).toContainText('SUCCEEDED');
    await expect(page.getByTestId('task-row').first()).toContainText('DEMO / SIMULATED');
    await page.getByTestId('task-filter-kind').selectOption('BUDGET_EVALUATION');
    await expect(page.getByTestId('task-row').filter({ hasNotText: 'BUDGET_EVALUATION' })).toHaveCount(0);
    await expect(page.getByTestId('task-row').first()).toContainText('ACTUAL');
    await page.getByTestId('task-row-toggle').first().click();
    await expect(page.getByTestId('task-row-detail')).toBeVisible();
    await expect(page.getByTestId('export-tasks-jsonl')).toBeVisible();
  });
});
