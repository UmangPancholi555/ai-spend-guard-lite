import { test, expect } from './support/test';
import { apiCreateProject, apiGet, apiRequest, uniq, watchConsole } from './support/helpers';

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

test.describe('observability', () => {
  test.beforeAll(async ({ request }) => {
    // guarantee SIMULATED memory/tool/context/bus data, a failure and some ACTUAL traffic regardless of spec order
    const p = await apiCreateProject(request, uniq('Obs Proj'));
    await apiRequest(request, p.id, { simulateAgentActivity: true, prompt: 'obs ok' });
    await apiRequest(request, p.id, { simulateAgentActivity: true, simulateFailure: 'timeout', prompt: 'obs fail' });
    await request.post('/api/simulations/agent-run', { data: { projectId: p.id, simulateFailure: 'error' } });
  });

  test('overview counts, actual/simulated split and recent lists match the API', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.goto('/observability');
    await expect(page.getByTestId('obs-overview')).toBeVisible();
    const ov = await apiGet(request, `/api/observability/overview?from=${encodeURIComponent(iso(7))}`);
    const num = (n: number) => n.toLocaleString('en-US');

    // event-derived counters are not perturbed by the page's own HTTP traffic
    await expect(page.getByTestId('obs-memory-injections')).toHaveText(num(ov.totals.memoryInjections));
    await expect(page.getByTestId('obs-bus-operations')).toHaveText(num(ov.totals.busOperations));
    await expect(page.getByTestId('obs-tool-calls')).toHaveText(num(ov.totals.toolCalls));
    await expect(page.getByTestId('obs-context-updates')).toHaveText(num(ov.totals.contextUpdates));
    expect(ov.totals.memoryInjections).toBeGreaterThan(0);
    expect(ov.totals.toolCalls).toBeGreaterThan(0);
    await expect(page.getByTestId('obs-simulated-count')).toHaveText(num(ov.bySource.simulated));
    expect(ov.bySource.simulated).toBeGreaterThan(0);
    expect(ov.bySource.actual).toBeGreaterThan(0);
    const actualShown = Number((await page.getByTestId('obs-actual-count').innerText()).replace(/,/g, ''));
    expect(actualShown).toBeGreaterThanOrEqual(ov.bySource.actual); // page traffic only ever adds ACTUAL operations
    await expect(page.getByTestId('obs-source-bar')).toHaveAttribute('aria-label', /actual, .* simulated/);
    await expect(page.getByTestId('obs-failed-operations')).not.toHaveText('0');
    await expect(page.getByTestId('obs-failure-rate')).toHaveText(/^\d+\.\d%$/);
    await expect(page.getByTestId('obs-error-item').first()).toBeVisible();
    await expect(page.getByTestId('obs-trace-item').first()).toBeVisible();
    await expect(page.getByText('Simulated counts come from the demo generator; they are not real memory, tool or context activity.')).toBeVisible();

    // range + refresh re-query the API
    const [r1] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/observability/overview')),
      page.getByTestId('obs-range').selectOption('30'),
    ]);
    expect(r1.status()).toBe(200);
    const [r2] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/observability/overview')),
      page.getByTestId('obs-refresh').click(),
    ]);
    expect(r2.status()).toBe(200);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('instrumentation sources panel: CONNECTED = a real component is registered; ACTUAL vs SIMULATED counts are split; the demo simulator is SIMULATED_ONLY', async ({ page, request }) => {
    await page.goto('/observability');
    const sources = await apiGet(request, '/api/observability/sources');
    const panel = page.getByTestId('sources-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('source-card')).toHaveCount(sources.length);

    // real runtime components (request lifecycle, error handling, memory, tools, context, event bus) are CONNECTED
    for (const kind of ['request', 'error', 'memory', 'tool', 'context', 'bus']) {
      await expect(page.locator(`[data-testid="source-card"][data-kind="${kind}"]`), kind).toHaveAttribute('data-status', 'CONNECTED');
      await expect(page.getByTestId(`source-status-${kind}`)).toHaveText('CONNECTED');
      const s = sources.find((x: any) => x.kind === kind);
      await expect(page.getByTestId(`source-actual-${kind}`)).toHaveText(s.actualEvents.toLocaleString('en-US'));
      await expect(page.getByTestId(`source-simulated-${kind}`)).toHaveText(s.simulatedEvents.toLocaleString('en-US'));
    }
    // the demo seed produced SIMULATED memory/tool/context events: they are counted, but never as actual
    for (const kind of ['memory', 'tool', 'context']) {
      expect(sources.find((s: any) => s.kind === kind).simulatedEvents, kind).toBeGreaterThan(0);
    }
    await expect(page.getByTestId('source-actual-request')).not.toHaveText('0');
    // the DEMO simulator is its own entry: always SIMULATED_ONLY, never any ACTUAL events
    const sim = page.locator('[data-testid="source-card"][data-kind="simulator"]');
    await expect(sim).toHaveAttribute('data-status', 'SIMULATED_ONLY');
    await expect(page.getByTestId('source-status-simulator')).toHaveText('SIMULATED_ONLY');
    await expect(page.getByTestId('source-actual-simulator')).toHaveText('0');
    const simApi = sources.find((s: any) => s.kind === 'simulator');
    expect(simApi.status).toBe('SIMULATED_ONLY');
    expect(simApi.actualEvents).toBe(0);
    await expect(page.getByTestId('source-simulated-simulator')).toHaveText(simApi.simulatedEvents.toLocaleString('en-US'));
    await expect(sim).toContainText('DEMO / SIMULATED generator');
    // each status is explained to the user
    await expect(panel).toContainText('A real instrumented component of this app emits these events');
    await expect(panel).toContainText('DEMO / SIMULATED generator');
  });

  test('event explorer tabs list events with source labels, filters and expandable details', async ({ page }) => {
    await page.goto('/observability');
    const ex = page.getByTestId('event-explorer');
    for (const tab of ['memory', 'bus', 'tool', 'context']) {
      await ex.getByTestId(`event-tab-${tab}`).click();
      await expect(ex.getByTestId(`event-panel-${tab}`)).toBeVisible();
      await expect(ex.getByTestId('event-row').first()).toBeVisible();
      // every row carries an honest source label: ACTUAL (real runtime) or DEMO / SIMULATED (generator), never neither
      await expect(ex.getByTestId('event-row').filter({ hasNotText: /ACTUAL|DEMO \/ SIMULATED/ })).toHaveCount(0);
    }
    await ex.getByTestId('event-tab-tool').click();
    await ex.getByTestId('event-filter-status').selectOption('FAILURE');
    await expect(ex.getByTestId('event-row').filter({ hasNotText: 'FAILURE' })).toHaveCount(0);
    await expect(ex.getByTestId('event-row').first()).toContainText('web_search');
    await ex.getByTestId('event-row-toggle').first().click();
    await expect(ex.getByTestId('event-row-detail')).toContainText('Input metadata');
    await ex.getByTestId('event-filter-source').selectOption('ACTUAL');
    // ACTUAL filter: either an empty state (no real tool calls yet) or only ACTUAL rows - simulated rows are never shown as actual
    await expect(ex.getByTestId('event-row').filter({ hasText: 'DEMO / SIMULATED' })).toHaveCount(0);
    await ex.getByTestId('filter-reset').click();
    await ex.getByTestId('event-filter-search').fill('read_file');
    await expect(ex.getByTestId('event-row').filter({ hasNotText: 'read_file' })).toHaveCount(0);
    await expect(ex.getByTestId('event-row').first()).toBeVisible();
    await expect(ex.getByTestId('export-tools-jsonl')).toBeVisible();
  });

  test('performance panel renders latency cards, charts and per-operation stats', async ({ page }) => {
    await page.goto('/observability');
    const perf = page.getByTestId('performance-panel');
    await expect(perf).toBeVisible();
    await expect(page.getByTestId('perf-request-avg')).not.toHaveText('-');
    await expect(page.getByTestId('perf-tool-avg')).not.toHaveText('-');
    await expect(page.getByTestId('perf-memory-avg')).not.toHaveText('-');
    await expect(perf.locator('.recharts-wrapper svg.recharts-surface').first()).toBeVisible();
    await expect(page.getByTestId('op-stat-row').first()).toBeVisible();
    await expect(page.getByTestId('op-stat-row').filter({ hasText: 'provider.request' }).first()).toBeVisible();
  });
});
