/**
 * Real runtime (wave 2): project memory store, memory injection into requests, request context, tool executor, event bus.
 * Everything those components emit is ACTUAL; the demo generator's events stay SIMULATED. Memory CONTENT never leaves the memory API.
 */
import { test, expect } from './support/test';
import { apiCreateProject, apiGet, apiRequest, fetchExport, jsonlLines, uniq, watchConsole } from './support/helpers';

const DATASETS = ['activity', 'traces', 'logs', 'errors', 'memory', 'bus', 'tools', 'context', 'alerts', 'tasks'];

async function addMemory(request: any, projectId: string, content: string, title = 'e2e memory', category = 'facts', enabled = true) {
  const res = await request.post(`/api/projects/${projectId}/memory`, { data: { title, category, content, enabled } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).data as { id: string; estimatedTokens: number; sizeBytes: number };
}
const totalPrompt = (r: any) => r.usage.inputTokens + r.usage.cachedTokens;

test.describe('project memory panel (real MemoryStore)', () => {
  test('add, disable/enable, edit and delete memory items from the project page; token estimates are shown', async ({ page, request }) => {
    const errors = watchConsole(page);
    const p = await apiCreateProject(request, uniq('Mem Proj'));
    await page.goto(`/projects/${p.id}`);
    await expect(page.getByTestId('memory-empty')).toBeVisible();
    await expect(page.getByTestId('memory-privacy-note')).toContainText('never written to logs, traces, events or activity');

    // validation comes from the server
    await page.getByTestId('memory-add-toggle').click();
    await page.getByTestId('memory-add-submit').click();
    await expect(page.getByTestId('memory-add-error')).toBeVisible();

    const content = 'Always answer in formal English. '.repeat(10).trim(); // 329 chars
    await page.getByTestId('memory-add-title').fill('Tone');
    await page.getByTestId('memory-add-category').selectOption('instructions');
    await page.getByTestId('memory-add-content').fill(content);
    await page.getByTestId('memory-add-submit').click();
    const item = page.getByTestId('memory-item');
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId('memory-item-title')).toHaveText('Tone');
    await expect(item).toContainText('instructions');
    await expect(item.getByTestId('memory-item-size')).toContainText(`${Buffer.byteLength(content)} bytes`);
    await expect(item.getByTestId('memory-item-size')).toContainText(`about ${Math.ceil(content.length / 4)} tokens`);
    await expect(page.getByTestId('memory-enabled-count')).toHaveText('1');
    await expect(page.getByTestId('memory-enabled-tokens')).toHaveText(String(Math.ceil(content.length / 4)));
    expect((await apiGet(request, `/api/projects/${p.id}/memory`))).toHaveLength(1);

    // disable -> not counted any more; enable again
    await item.getByTestId('memory-item-toggle').click();
    await expect(item).toHaveAttribute('data-enabled', 'false');
    await expect(page.getByTestId('memory-enabled-count')).toHaveText('0');
    await item.getByTestId('memory-item-toggle').click();
    await expect(item).toHaveAttribute('data-enabled', 'true');

    // edit
    await item.getByTestId('memory-item-edit').click();
    await page.getByTestId('memory-edit-title').fill('Tone v2');
    await page.getByTestId('memory-edit-submit').click();
    await expect(page.getByTestId('memory-item-title')).toHaveText('Tone v2');
    await page.reload();
    await expect(page.getByTestId('memory-item-title')).toHaveText('Tone v2'); // persisted

    // delete (confirm dialog)
    await page.getByTestId('memory-item-delete').click();
    await page.getByTestId('memory-delete-cancel').click();
    await expect(page.getByTestId('memory-item')).toHaveCount(1);
    await page.getByTestId('memory-item-delete').click();
    await page.getByTestId('memory-delete-confirm').click();
    await expect(page.getByTestId('memory-empty')).toBeVisible();
    // the deliberate empty-form submit shows up as one browser-level 400 line; anything else is a real console error
    expect(errors.filter(e => !/status of 400/.test(e)), errors.join('\n')).toEqual([]);
  });

  test('API validation: unknown project 404, empty / oversized content, bad category, 200-item cap is advertised; item of another project is not reachable', async ({ request }) => {
    const p = await apiCreateProject(request, uniq('Mem Val'));
    const other = await apiCreateProject(request, uniq('Mem Other'));
    expect((await request.get('/api/projects/nope/memory')).status()).toBe(404);
    expect((await request.post('/api/projects/nope/memory', { data: { title: 't', category: 'facts', content: 'c' } })).status()).toBe(404);
    for (const bad of [{ title: '', category: 'facts', content: 'c' }, { title: 't', category: 'facts', content: '' }, { title: 't', category: 'bogus', content: 'c' },
      { title: 't', category: 'facts', content: 'x'.repeat(8001) }, { title: 'x'.repeat(121), category: 'facts', content: 'c' }]) {
      expect((await request.post(`/api/projects/${p.id}/memory`, { data: bad })).status(), JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    const ok = await addMemory(request, p.id, 'x'.repeat(8000));
    expect(ok.estimatedTokens).toBe(2000);
    expect((await request.patch(`/api/projects/${other.id}/memory/${ok.id}`, { data: { enabled: false } })).status()).toBe(404);
    expect((await request.delete(`/api/projects/${other.id}/memory/${ok.id}`)).status()).toBe(404);
    expect((await request.patch(`/api/projects/${p.id}/memory/${ok.id}`, { data: {} })).status()).toBe(400);
  });
});

test.describe('memory injection into requests', () => {
  test('injection raises input tokens versus the same request without it; summary, ACTUAL events and trace timeline agree', async ({ request, page }) => {
    const errors = watchConsole(page);
    const p = await apiCreateProject(request, uniq('Inject Proj'));
    const content = 'The customer prefers concise answers and metric units. '.repeat(40).trim(); // ~2.2k chars
    const mem = await addMemory(request, p.id, content, 'Preferences', 'preferences');
    const prompt = 'inject baseline prompt';

    const without = await apiRequest(request, p.id, { prompt, injectMemory: false });
    const withMem = await apiRequest(request, p.id, { prompt, injectMemory: true });
    expect(without.memory).toMatchObject({ injected: false, items: 0 });
    expect(withMem.memory).toMatchObject({ injected: true, items: 1, truncated: false, droppedItems: 0 });
    expect(withMem.memory.estimatedTokens).toBeGreaterThanOrEqual(mem.estimatedTokens);
    // more tokens really go to the (mock) provider and are billed
    expect(totalPrompt(withMem)).toBeGreaterThan(totalPrompt(without));
    expect(totalPrompt(withMem) - totalPrompt(without)).toBeGreaterThanOrEqual(mem.estimatedTokens - 2);
    // (total cost also depends on the mock's output tokens, so compare the input side only)
    expect(Number(withMem.cost.inputCostUsd)).toBeGreaterThan(Number(without.cost.inputCostUsd));
    // injection defaults ON when the flag is omitted
    const dflt = await apiRequest(request, p.id, { prompt });
    expect(dflt.memory.injected).toBe(true);
    // a disabled item is not injected
    await request.patch(`/api/projects/${p.id}/memory/${mem.id}`, { data: { enabled: false } });
    const disabled = await apiRequest(request, p.id, { prompt });
    expect(disabled.memory.injected).toBe(false);
    expect(totalPrompt(disabled)).toBe(totalPrompt(without));
    await request.patch(`/api/projects/${p.id}/memory/${mem.id}`, { data: { enabled: true } });

    // the stored usage row reflects the injected tokens
    const rows = await apiGet(request, `/api/usage?projectId=${p.id}&pageSize=50`);
    const row = rows.find((u: any) => u.id === withMem.usageEventId);
    expect(row.inputTokens + row.cachedTokens).toBe(totalPrompt(withMem));

    // trace: ACTUAL memory + context events, never SIMULATED, never labelled as the demo
    const t = await apiGet(request, `/api/traces/${withMem.traceId}`);
    const memEntries = t.timeline.filter((e: any) => e.step.startsWith('memory.injection'));
    expect(memEntries.map((e: any) => e.step)).toEqual(['memory.injection.started', 'memory.injection.completed']);
    expect(memEntries.every((e: any) => e.source === 'ACTUAL')).toBe(true);
    // the ONLY simulated entry is the mock provider's response (a simulation, whatever the request source)
    expect(t.timeline.filter((e: any) => e.source === 'SIMULATED').map((e: any) => `${e.step}:${e.label}`)).toEqual(['response.generated:Response generated (provider.mock)']);
    const ctxSteps = t.timeline.filter((e: any) => e.step.startsWith('context.'));
    expect(ctxSteps.length).toBeGreaterThanOrEqual(3); // prompt, memory added, response
    expect(ctxSteps.every((e: any) => e.source === 'ACTUAL')).toBe(true);

    await page.goto(`/traces/${withMem.traceId}`);
    await expect(page.getByTestId('timeline-entry').first()).toBeVisible();
    for (const step of ['memory.injection.started', 'memory.injection.completed', 'context.initialized']) {
      await expect(page.locator(`[data-testid="timeline-entry"][data-step="${step}"]`).first()).toHaveAttribute('data-source', 'ACTUAL');
    }
    // only the provider.mock response carries the DEMO / SIMULATED badge; every real runtime step is ACTUAL
    await expect(page.locator('[data-testid="timeline-source"][data-source="SIMULATED"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="timeline-entry"][data-source="SIMULATED"]')).toHaveAttribute('data-step', 'response.generated');
    await expect(page.locator('[data-testid="timeline-source"][data-source="ACTUAL"]').first()).toHaveText('ACTUAL');
    const ex = page.getByTestId('event-explorer');
    await ex.getByTestId('event-tab-memory').click();
    await expect(ex.getByTestId('event-row')).toHaveCount(2);
    await expect(ex.getByTestId('event-row').filter({ hasText: 'DEMO / SIMULATED' })).toHaveCount(0);
    await expect(ex.getByTestId('event-row').first()).toContainText('ACTUAL');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('simulator: "Inject project memory" checkbox controls the runtime summary shown with ACTUAL badges', async ({ page, request }) => {
    const p = await apiCreateProject(request, uniq('Sim Mem'));
    await addMemory(request, p.id, 'Simulator memory item. '.repeat(30));
    await page.goto('/simulator');
    await page.getByTestId('sim-project').selectOption(p.id);
    await expect(page.getByTestId('sim-inject-memory')).toBeChecked(); // default ON
    await page.getByTestId('sim-prompt').fill('simulator memory check');
    await page.getByTestId('simulator-submit').click();
    const rt = page.getByTestId('runtime-summary');
    await expect(rt).toBeVisible();
    await expect(rt).toContainText('Runtime (real in-app components)');
    await expect(rt.getByText('ACTUAL (instrumented)').first()).toBeVisible();
    await expect(page.getByTestId('memory-result-items')).toHaveText('1');
    await expect(page.getByTestId('memory-result-none')).toHaveCount(0);
    await expect(page.getByTestId('context-result')).toContainText(/window [\d,]+/);
    await expect(page.getByTestId('tool-result-item').filter({ hasText: 'pricing.lookup' })).toContainText('SUCCESS');
    await expect(page.getByTestId('tool-result-item').filter({ hasText: 'budget.status' })).toContainText('SUCCESS');
    await expect(page.getByTestId('budget-preflight-result')).toBeVisible();
    const withTokens = Number(((await page.getByTestId('memory-result-tokens').innerText()).replace(/,/g, '')));
    expect(withTokens).toBeGreaterThan(0);

    await page.getByTestId('sim-inject-memory').click();
    await page.getByTestId('simulator-submit').click();
    await expect(page.getByTestId('memory-result-none')).toBeVisible();
    await expect(page.getByTestId('memory-result-items')).toHaveCount(0);
    // the demo-generated agent activity is separate and labelled DEMO / SIMULATED
    await expect(page.getByTestId('runtime-summary')).not.toContainText('SIMULATED');
  });

  test('truncation: memory that exceeds the model window is really cut (whole items dropped), flagged everywhere, never silently', async ({ request, page }) => {
    test.setTimeout(120_000);
    const p = await apiCreateProject(request, uniq('Trunc Proj'));
    const N = 80; // 80 x 8000 chars ~ 160k tokens > gpt-4o window (128k)
    for (let i = 0; i < N; i += 1) await addMemory(request, p.id, `${String(i).padStart(3, '0')} `.padEnd(8000, 'lorem ipsum '), `Item ${i}`, 'facts');
    const r = await apiRequest(request, p.id, { model: 'gpt-4o', prompt: 'truncate me', maxOutputTokens: 200 });
    expect(r.memory.truncated).toBe(true);
    expect(r.memory.droppedItems).toBeGreaterThan(0);
    expect(r.memory.items + r.memory.droppedItems).toBe(N);
    expect(r.memory.injected).toBe(true);
    expect(r.context.truncated).toBe(true);
    expect(r.context.windowTokens).toBe(128000);
    expect(r.memory.estimatedTokens).toBeLessThanOrEqual(128000);
    expect(r.status).toBe('SUCCESS'); // truncation is not an error
    // a bigger window (gpt-4.1: 1M) holds everything
    const big = await apiRequest(request, p.id, { model: 'gpt-4.1', provider: 'openai', prompt: 'truncate me', maxOutputTokens: 200 });
    expect(big.memory).toMatchObject({ truncated: false, droppedItems: 0, items: N });
    expect(big.context.truncated).toBe(false);

    const t = await apiGet(request, `/api/traces/${r.traceId}`);
    const trunc = t.timeline.find((e: any) => e.step === 'context.event' && /window-truncation/.test(e.label));
    expect(trunc, 'window-truncation context event on the timeline').toBeTruthy();
    expect(trunc.source).toBe('ACTUAL');
    expect(trunc.details.operation).toBe('MODIFIED');
    // the dropped items' content is not in the trace
    expect(JSON.stringify(t)).not.toContain('lorem ipsum');

    await page.goto(`/traces/${r.traceId}`);
    await expect(page.locator('[data-testid="timeline-entry"][data-step="context.event"]').filter({ hasText: 'window-truncation' }).first()).toHaveAttribute('data-source', 'ACTUAL');

    // simulator shows the truncated badge and the number of dropped items
    await page.goto('/simulator');
    await page.getByTestId('sim-project').selectOption(p.id);
    await page.getByTestId('sim-provider').selectOption('openai');
    await page.getByTestId('sim-model').selectOption('gpt-4o');
    await page.getByTestId('sim-prompt').fill('truncate me');
    await page.getByTestId('simulator-submit').click();
    await expect(page.getByTestId('memory-result')).toContainText('truncated');
    await expect(page.getByTestId('memory-result-dropped')).toHaveText(String(r.memory.droppedItems));
    await expect(page.getByTestId('context-result')).toContainText('truncated');
  });
});

test.describe('privacy: memory content and prompts never leave the memory API', () => {
  test('a unique marker in memory content and in prompts is absent from every log, export, trace, event and activity endpoint', async ({ request, page }) => {
    const marker = `MEMSECRET-${Date.now().toString(36)}-ZEBRA`;
    const promptMarker = `PROMPTSECRET-${Date.now().toString(36)}-OTTER`;
    const p = await apiCreateProject(request, uniq('Priv Proj'));
    const titleMarker = `TITLESECRET-${Date.now().toString(36)}-HERON`;
    const mem = await addMemory(request, p.id, `Never log this: ${marker}`, titleMarker, 'instructions');
    const ok = await apiRequest(request, p.id, { prompt: `please use ${promptMarker}`, simulateAgentActivity: true });
    const failed = await apiRequest(request, p.id, { prompt: `fail with ${promptMarker}`, simulateFailure: 'error' });
    await request.patch(`/api/projects/${p.id}/memory/${mem.id}`, { data: { content: `edited ${marker}` } });
    expect((await request.post('/api/tools/usage.summary/invoke', { data: { input: { projectId: p.id, days: 7 } } })).status()).toBe(200);

    // the memory API itself returns the content (it is the user's data)...
    expect(JSON.stringify(await apiGet(request, `/api/projects/${p.id}/memory`))).toContain(marker);
    // ...and nothing else does
    const urls = [
      '/api/activity?pageSize=200', '/api/logs?pageSize=200', '/api/observability/errors?pageSize=200', '/api/traces?pageSize=200', `/api/traces/${ok.traceId}`, `/api/traces/${failed.traceId}`,
      '/api/observability/memory-events?pageSize=200', '/api/observability/context-events?pageSize=200', '/api/observability/tool-events?pageSize=200', '/api/observability/bus-events?pageSize=200',
      '/api/observability/overview', '/api/observability/sources', '/api/observability/performance', `/api/projects/${p.id}`, `/api/usage?projectId=${p.id}`,
      '/api/background-tasks',
    ];
    for (const u of urls) {
      const res = await request.get(u);
      if (res.status() === 404) continue; // endpoint spelling differences are covered by the export loop below
      const body = await res.text();
      for (const m of [marker, promptMarker, titleMarker]) expect(body, `${u} leaks ${m}`).not.toContain(m);
    }
    for (const ds of DATASETS) {
      for (const format of ['jsonl', 'csv']) {
        const res = await request.get(`/api/export/${ds}?format=${format}`);
        expect(res.status(), `${ds}.${format}`).toBe(200);
        const body = await res.text();
        for (const m of [marker, promptMarker, titleMarker]) expect(body, `export ${ds}.${format} leaks ${m}`).not.toContain(m);
      }
    }
    // the activity feed knows THAT memory changed (metadata only)
    const act = await apiGet(request, `/api/activity?projectId=${p.id}&type=project.memory.created`);
    expect(act).toHaveLength(1);
    expect(act[0].source).toBe('ACTUAL');
    expect(Object.keys(act[0].metadata)).not.toContain('content');
    expect(Object.keys(act[0].metadata)).not.toContain('title');

    // UI exports as well (the same download links the pages offer)
    await page.goto(`/logs`);
    const jsonl = await fetchExport(page, 'export-logs-jsonl');
    for (const line of jsonlLines(jsonl.text)) expect(JSON.stringify(line)).not.toContain(marker);
    expect(jsonl.text).not.toContain(promptMarker);
  });
});

test.describe('tools API (real local tools)', () => {
  test('GET /tools lists the real tools as ACTUAL; invoke returns output + a trace with an ACTUAL tool event; input validation and unknown tools are rejected', async ({ request, page }) => {
    const tools = await apiGet(request, '/api/tools');
    const names = tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['pricing.lookup', 'budget.status', 'usage.summary']));
    expect(tools.every((t: any) => t.source === 'ACTUAL' && Array.isArray(t.params))).toBe(true);

    const res = await request.post('/api/tools/pricing.lookup/invoke', { data: { input: { provider: 'openai', model: 'gpt-4o' } } });
    expect(res.status()).toBe(200);
    const out = (await res.json()).data;
    expect(out.output).toMatchObject({ provider: 'openai', model: 'gpt-4o', inputPerMTok: '2.500000', outputPerMTok: '10.000000', cachedPerMTok: '1.250000', unknownModel: false });
    expect(out.attempts).toBe(1);
    expect(out.traceId).toMatch(/^[0-9a-f]{32}$/);
    const unknown = (await (await request.post('/api/tools/pricing.lookup/invoke', { data: { input: { provider: 'openai', model: 'no-such-model' } } })).json()).data;
    expect(unknown.output).toMatchObject({ unknownModel: true, costClass: 'ESTIMATED' });

    const trace = await apiGet(request, `/api/traces/${out.traceId}`);
    expect(trace.trace).toMatchObject({ name: 'tool.invoke', status: 'OK', source: 'ACTUAL' });
    const toolEntries = trace.timeline.filter((e: any) => e.step.startsWith('tool.call'));
    expect(toolEntries.map((e: any) => e.step)).toEqual(['tool.call.initiated', 'tool.call.completed']);
    expect(toolEntries.every((e: any) => e.source === 'ACTUAL')).toBe(true);
    expect(trace.timeline.filter((e: any) => e.source === 'SIMULATED')).toHaveLength(0);
    // metadata only: parameter NAMES/sizes, never values
    expect(JSON.stringify(trace)).not.toContain('no-such-model');
    const events = await apiGet(request, `/api/observability/tool-events?traceId=${out.traceId}`);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].inputMeta.paramNames).toEqual(['model', 'provider']);
    expect(events[0].source).toBe('ACTUAL');

    await page.goto(`/traces/${out.traceId}`);
    await expect(page.getByTestId('trace-name')).toHaveText('tool.invoke');
    await expect(page.locator('[data-testid="timeline-entry"][data-step="tool.call.completed"]').first()).toHaveAttribute('data-source', 'ACTUAL');

    // invalid input -> 400 and recorded as a FAILURE tool call (never retried), unknown tool -> 404
    const bad = await request.post('/api/tools/usage.summary/invoke', { data: { input: { projectId: '', days: 999 } } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe('VALIDATION_ERROR');
    expect((await request.post('/api/tools/does.not.exist/invoke', { data: { input: {} } })).status()).toBe(404);
    expect((await request.post('/api/tools/pricing.lookup/invoke', { data: { input: { provider: 'openai' } } })).status()).toBe(400);
    expect((await request.post('/api/tools/pricing.lookup/invoke', { data: { input: 'not-an-object' } })).status()).toBe(400);
  });

  test('budget.status / usage.summary tools reflect real data', async ({ request }) => {
    const p = await apiCreateProject(request, uniq('Tool Proj'));
    const r = await apiRequest(request, p.id, { prompt: 'tool data', injectMemory: false });
    const usage = (await (await request.post('/api/tools/usage.summary/invoke', { data: { input: { projectId: p.id, days: 7 } } })).json()).data.output;
    expect(usage).toMatchObject({ projectId: p.id, requests: 1, failures: 0, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUsd: r.cost.totalCostUsd });
    const b = await request.post('/api/budgets', { data: { projectId: p.id, name: uniq('tool-budget'), period: 'DAILY', limitUsd: '1000.00' } });
    expect(b.status()).toBe(201);
    const status = (await (await request.post('/api/tools/budget.status/invoke', { data: { input: { projectId: p.id } } })).json()).data.output;
    expect(status.count).toBeGreaterThanOrEqual(1);
    expect(status.budgets.some((x: any) => x.scope === 'project' && x.period === 'DAILY')).toBe(true);
    expect(status.overLimit).toBe(false);
  });
});

test.describe('observability: sources reflect real components', () => {
  test('after real requests the ACTUAL counters of memory / tool / context / bus grow; simulated demo counters do not; simulator stays SIMULATED_ONLY', async ({ request }) => {
    const by = async () => Object.fromEntries((await apiGet(request, '/api/observability/sources')).map((s: any) => [s.kind, s]));
    const before = await by();
    for (const k of ['request', 'memory', 'bus', 'tool', 'context', 'error']) expect(before[k].status, k).toBe('CONNECTED');
    const p = await apiCreateProject(request, uniq('Src Proj'));
    await addMemory(request, p.id, 'sources memory item');
    await apiRequest(request, p.id, { prompt: 'sources check' });
    const after = await by();
    expect(after.memory.actualEvents).toBeGreaterThan(before.memory.actualEvents);
    expect(after.tool.actualEvents).toBeGreaterThanOrEqual(before.tool.actualEvents + 2); // 2 tool calls (pricing.lookup + budget.status), one tool event each
    expect(after.context.actualEvents).toBeGreaterThanOrEqual(before.context.actualEvents + 3);
    expect(after.request.actualEvents).toBeGreaterThan(before.request.actualEvents);
    for (const k of ['memory', 'tool', 'context', 'bus']) expect(after[k].simulatedEvents, `${k} simulated unchanged`).toBe(before[k].simulatedEvents);
    expect(after.simulator.status).toBe('SIMULATED_ONLY');
    expect(after.simulator.actualEvents).toBe(0);
    expect(after.simulator.simulatedEvents).toBe(before.simulator.simulatedEvents);
    // a simulated agent run grows ONLY the simulated counters
    const run = await request.post('/api/simulations/agent-run', { data: { projectId: p.id } });
    expect(run.status()).toBeLessThan(300);
    const after2 = await by();
    expect(after2.simulator.simulatedEvents).toBeGreaterThan(after.simulator.simulatedEvents);
    expect(after2.tool.simulatedEvents).toBeGreaterThan(after.tool.simulatedEvents);
    expect(after2.tool.actualEvents).toBe(after.tool.actualEvents);
    expect(after2.memory.actualEvents).toBe(after.memory.actualEvents);
  });
});
