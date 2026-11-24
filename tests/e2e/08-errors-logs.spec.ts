import { test, expect } from './support/test';
import { apiCreateProject, apiGet, apiRequest, downloadText, fetchExport, jsonlLines, parseCsv, uniq, watchConsole } from './support/helpers';

let projectName = '';
let projectId = '';
let failTrace = '';
let failRequestId = '';
let okTrace = '';

test.beforeAll(async ({ request }) => {
  const p = await apiCreateProject(request, uniq('ErrLog Proj'));
  projectName = p.name; projectId = p.id;
  const ok = await apiRequest(request, p.id, { prompt: 'logs ok', simulateAgentActivity: true });
  okTrace = ok.traceId;
  const f1 = await apiRequest(request, p.id, { simulateFailure: 'error', prompt: 'err 1' });
  await apiRequest(request, p.id, { simulateFailure: 'timeout', prompt: 'err 2' });
  failTrace = f1.traceId; failRequestId = f1.requestId;
  await request.post('/api/simulations/agent-run', { data: { projectId: p.id, simulateFailure: 'error' } });
  // a real validation error (ACTUAL) from the API itself
  await request.post('/api/providers/requests', { data: { projectId: p.id, provider: 'openai' } });
});

test.describe('error log', () => {
  test('lists failures with category, operation, trace link and an expandable stack trace', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/errors');
    await expect(page.getByTestId('error-groups')).toBeVisible();
    await expect(page.getByTestId('error-groups').locator('.recharts-wrapper svg.recharts-surface').first()).toBeVisible();
    await page.getByTestId('error-filter-trace').fill(failTrace);
    const rows = page.getByTestId('error-row');
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasNotText: 'PROVIDER' })).toHaveCount(0);
    // the trace produces the provider failure itself and the trace-level failure
    const mock = rows.filter({ hasText: 'provider.mock' });
    await expect(mock).toHaveCount(1);
    await expect(rows.filter({ hasText: 'provider.request' })).toHaveCount(1);
    await expect(mock).toContainText('DEMO / SIMULATED'); // provider failure = simulation
    await expect(mock).not.toContainText('ACTUAL');
    await expect(rows.filter({ hasText: 'provider.request' })).toContainText('ACTUAL'); // the real trace lifecycle failure stays ACTUAL
    await expect(mock.getByTestId('trace-link')).toHaveAttribute('href', `/traces/${failTrace}`);

    await mock.getByTestId('error-row-toggle').click();
    const detail = page.getByTestId('error-row-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('error-message')).not.toBeEmpty();
    await expect(detail.getByTestId('error-stack')).toContainText(/Error|at /);
    await expect(detail).toContainText(failRequestId);
    await expect(detail.getByTestId('error-attributes')).toContainText('"provider"');
    await mock.getByTestId('error-row-toggle').click();
    await expect(page.getByTestId('error-row-detail')).toHaveCount(0);
    expect(errors.filter(e => !/400/.test(e)), errors.join('\n')).toEqual([]);
  });

  test('filters: category chip + select, source, search, trace id, reset', async ({ page }) => {
    await page.goto('/errors');
    const rows = page.getByTestId('error-row');
    await expect(rows.first()).toBeVisible();
    const all = await apiGet(page.request, '/api/observability/errors/groups');
    const cats = all.map((g: any) => g.category);
    expect(cats).toEqual(expect.arrayContaining(['PROVIDER', 'TIMEOUT']));

    // chip
    await page.locator('[data-testid="error-group-chip"][data-category="TIMEOUT"]').click();
    await expect(page.getByTestId('error-filter-category')).toHaveValue('TIMEOUT');
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasNotText: 'TIMEOUT' })).toHaveCount(0);
    // select
    await page.getByTestId('error-filter-category').selectOption('PROVIDER');
    await expect(rows.filter({ hasNotText: 'PROVIDER' })).toHaveCount(0);
    await expect(rows.first()).toBeVisible();
    // category + source
    await page.getByTestId('error-filter-source').selectOption('SIMULATED');
    await expect(page.getByTestId('error-table').getByTestId('empty-state').or(rows.first())).toBeVisible();
    await page.getByTestId('error-filter-category').selectOption('');
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasText: 'ACTUAL (instrumented)' })).toHaveCount(0);
    await page.getByTestId('error-filter-source').selectOption('ACTUAL');
    await expect(rows.filter({ hasNotText: 'ACTUAL (instrumented)' })).toHaveCount(0);
    await expect(rows.first()).toBeVisible();
    // the mock provider's failures are a simulation: never listed as ACTUAL
    await page.getByTestId('error-filter-search').fill('provider.mock');
    await expect(page.getByTestId('error-table').getByTestId('empty-state').or(rows.first())).toBeVisible();
    await expect(rows.filter({ hasText: 'provider.mock' })).toHaveCount(0);
    // search (provider.mock rows live under SIMULATED)
    await page.getByTestId('error-filter-source').selectOption('SIMULATED');
    await page.getByTestId('error-filter-search').fill('provider.mock');
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasNotText: 'provider.mock' })).toHaveCount(0);
    await page.getByTestId('error-filter-search').fill('nothing-matches-this-zzz');
    await expect(page.getByTestId('error-table').getByTestId('empty-state')).toContainText('No errors match these filters');
    await page.getByTestId('filter-bar').getByTestId('filter-reset').click();
    await expect(page.getByTestId('error-filter-search')).toHaveValue('');
    await expect(rows.first()).toBeVisible();
  });

  test('export links return JSONL / CSV that honour the active filters', async ({ page }) => {
    await page.goto('/errors');
    await page.getByTestId('error-filter-category').selectOption('TIMEOUT');
    await expect(page.getByTestId('error-row').first()).toBeVisible();
    await expect(page.getByTestId('error-row').filter({ hasNotText: 'TIMEOUT' })).toHaveCount(0);
    // wait for the debounced params to reach the link
    await expect.poll(async () => (await page.getByTestId('export-errors-jsonl').locator('xpath=ancestor-or-self::a').getAttribute('href')) ?? '').toContain('category=TIMEOUT');
    const jl = await fetchExport(page, 'export-errors-jsonl');
    const objs = jsonlLines(jl.text);
    expect(objs.length).toBeGreaterThan(0);
    expect(objs.every(o => o.errorCategory === 'TIMEOUT' && (o.level === 'ERROR' || o.status === 'FAILURE'))).toBe(true);
    const csv = await fetchExport(page, 'export-errors-csv');
    const rows = parseCsv(csv.text);
    expect(rows[0]).toContain('errorCategory');
    expect(rows.length - 1).toBe(objs.length);
    expect(rows.slice(1).every(r => r[rows[0].indexOf('errorCategory')] === 'TIMEOUT')).toBe(true);
  });
});

test.describe('execution logs', () => {
  test('filters (category, status, level, source, event type, operation, trace) and expandable rows', async ({ page }) => {
    await page.goto('/logs');
    const rows = page.getByTestId('log-row');
    await expect(rows.first()).toBeVisible();

    await page.getByTestId('log-filter-trace').fill(okTrace);
    await expect(rows.first()).toBeVisible();
    const logs = await apiGet(page.request, `/api/logs?traceId=${okTrace}&pageSize=200`);
    await expect(rows).toHaveCount(Math.min(logs.length, 25)); // first page (25 rows per page); the real runtime adds ACTUAL logs per request

    await page.getByTestId('log-filter-category').selectOption('MEMORY');
    await expect(rows.filter({ hasNotText: 'memory.injection' })).toHaveCount(0);
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasNotText: 'DEMO / SIMULATED' })).toHaveCount(0);
    await page.getByTestId('log-filter-category').selectOption('TOOL');
    await page.getByTestId('log-filter-status').selectOption('FAILURE');
    await expect(rows).toHaveCount(1); // the transient web_search failure (retried)
    await expect(rows.first()).toContainText('FAILURE');
    await rows.first().getByTestId('log-row-toggle').click();
    await expect(page.getByTestId('log-row-detail')).toContainText('Attributes (metadata only)');
    await expect(page.getByTestId('log-attributes')).toBeVisible();
    await page.getByTestId('filter-reset').click();

    await page.getByTestId('log-filter-source').selectOption('ACTUAL');
    await page.getByTestId('log-filter-level').selectOption('ERROR');
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasNotText: 'ERROR' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'DEMO / SIMULATED' })).toHaveCount(0);
    await page.getByTestId('log-filter-level').selectOption('');
    await page.getByTestId('log-filter-source').selectOption('');
    await page.getByTestId('log-filter-event-type').fill('request.completed');
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasNotText: 'request.completed' })).toHaveCount(0);
    await page.getByTestId('log-filter-search').fill('POST /api/providers/requests');
    await expect(rows.first()).toContainText('POST /api/providers/requests');
    await expect(rows.filter({ hasNotText: 'POST /api/providers/requests' })).toHaveCount(0);
    await page.getByTestId('log-filter-search').fill('zzz-nothing');
    await expect(page.getByTestId('log-table').getByTestId('empty-state')).toContainText('No execution logs match these filters');
  });

  test('JSONL and CSV exports are valid, honour filters and contain no prompt content', async ({ page }) => {
    await page.goto('/logs');
    await page.getByTestId('log-filter-trace').fill(okTrace);
    await expect.poll(async () => (await page.getByTestId('export-logs-jsonl').locator('xpath=ancestor-or-self::a').getAttribute('href')) ?? '').toContain(`traceId=${okTrace}`);
    const expected = await apiGet(page.request, `/api/logs?traceId=${okTrace}&pageSize=200`);

    const jl = await fetchExport(page, 'export-logs-jsonl');
    expect(jl.status).toBe(200);
    expect(jl.contentType).toMatch(/ndjson|json/);
    expect(jl.disposition).toMatch(/attachment; filename="spendguard-logs-\d{8}-\d{6}Z\.jsonl"/);
    const lines = jsonlLines(jl.text);
    expect(lines).toHaveLength(expected.length);
    expect(new Set(lines.map(l => l.id))).toEqual(new Set(expected.map((l: any) => l.id)));
    for (const l of lines) {
      expect(Object.keys(l)).toEqual(expect.arrayContaining(['id', 'ts', 'level', 'eventType', 'category', 'operation', 'status', 'source', 'traceId', 'message', 'attributes']));
      expect(l.traceId).toBe(okTrace);
    }
    expect(jl.text).not.toContain('logs ok'); // the prompt text never reaches logs

    const csv = await fetchExport(page, 'export-logs-csv');
    expect(csv.contentType).toMatch(/text\/csv/);
    const rows = parseCsv(csv.text);
    expect(rows[0]).toEqual(['id', 'ts', 'level', 'eventType', 'category', 'operation', 'status', 'source', 'traceId', 'spanId', 'requestId', 'projectId',
      'durationMs', 'message', 'attributes', 'errorCategory', 'errorMessage', 'stack']);
    expect(rows).toHaveLength(expected.length + 1);
    expect(rows.every(r => r.length === rows[0].length)).toBe(true);

    // real browser download through the link
    const dl = await downloadText(page, () => page.getByTestId('export-logs-csv').click());
    expect(dl.filename).toMatch(/^spendguard-logs-.*\.csv$/);
    expect(parseCsv(dl.text)).toHaveLength(expected.length + 1);
  });

  test('activity page shows ACTUAL events with metadata, filters and exports', async ({ page }) => {
    await page.goto('/activity');
    await page.getByTestId('activity-filter-project').selectOption(projectId);
    const rows = page.getByTestId('activity-row');
    await expect(rows.first()).toBeVisible();
    await page.getByTestId('activity-filter-source').selectOption('ACTUAL');
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasNotText: 'ACTUAL (instrumented)' })).toHaveCount(0);
    await page.getByTestId('activity-filter-source').selectOption('SIMULATED');
    await expect(rows.filter({ hasText: 'ACTUAL (instrumented)' })).toHaveCount(0);
    await page.getByTestId('activity-filter-source').selectOption('ACTUAL');
    await page.getByTestId('activity-filter-type').fill('request.failed');
    await expect(rows.filter({ hasNotText: 'request.failed' })).toHaveCount(0);
    await expect(rows).toHaveCount(2);
    await expect(rows.first().getByTestId('activity-type')).toHaveText('request.failed');
    await expect(rows.first()).toContainText('ERROR');
    await rows.first().getByTestId('activity-row-toggle').click();
    await expect(page.getByTestId('activity-metadata')).toContainText('simulated');
    await page.getByTestId('activity-filter-type').fill('');
    await page.getByTestId('activity-filter-search').fill(failRequestId);
    await expect(rows).toHaveCount(1);
    await expect.poll(async () => (await page.getByTestId('export-activity-csv').locator('xpath=ancestor-or-self::a').getAttribute('href')) ?? '').toContain('search=');
    const csv = await fetchExport(page, 'export-activity-csv');
    const parsed = parseCsv(csv.text);
    expect(parsed[0]).toEqual(['id', 'createdAt', 'type', 'level', 'message', 'source', 'projectId', 'projectName', 'traceId', 'requestId', 'metadata']);
    expect(parsed).toHaveLength(2);
    expect(parsed[1][parsed[0].indexOf('requestId')]).toBe(failRequestId);
    expect(parsed[1][parsed[0].indexOf('projectName')]).toBe(projectName);
  });
});
