import { test, expect } from './support/test';
import { STRONG_PASSWORD, anonymousClient, createUser, errorCode, loginClient, uniqUser } from './support/auth';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_PASSWORD, LOG_DIR } from './support/env';
import { restartServer } from './support/server';
import { apiBudget, apiCreateProject, apiGet, apiRequest, jsonlLines, picoToUsd, slug, uniq, usdToPico } from './support/helpers';

test.describe('restart persistence (backend process stopped and started on the same DB)', () => {
  test('projects, usage, budgets, alerts, traces, logs, settings and tasks survive a backend restart; JSONL file is preserved', async ({ page, request, playwright }) => {
    test.setTimeout(120_000);
    // --- build up state through the real API ---
    const p = await apiCreateProject(request, uniq('Persist Proj'));
    const probe = await apiRequest(request, p.id, { prompt: 'persist probe' });
    const c = usdToPico(probe.cost.totalCostUsd);
    const b = await apiBudget(request, p.id, picoToUsd(c * 2n), 'MONTHLY', uniq('persist-budget')); // 1 request so far = 50% (alert already raised by pipeline? budget created after) -> next request crosses
    const r2 = await apiRequest(request, p.id, { prompt: 'persist probe' });
    expect(r2.budgetAlerts.length).toBeGreaterThan(0);
    const fail = await apiRequest(request, p.id, { prompt: 'persist fail', simulateFailure: 'error', simulateAgentActivity: true });
    expect((await request.put('/api/settings', { data: { retentionDays: 77, slowOperationMs: 321 } })).status()).toBe(200);
    expect((await request.post('/api/logging/retention/run')).status()).toBe(200);

    const snap = async () => ({
      project: await apiGet(request, `/api/projects/${p.id}`),
      usage: await apiGet(request, `/api/usage?projectId=${p.id}&pageSize=100`),
      budgets: await apiGet(request, `/api/budgets?projectId=${p.id}`),
      alerts: await apiGet(request, `/api/budget-alerts?budgetId=${b.id}`),
      trace: await apiGet(request, `/api/traces/${fail.traceId}`),
      traceList: await apiGet(request, `/api/traces?projectId=${p.id}&pageSize=100`),
      logs: await apiGet(request, `/api/logs?traceId=${fail.traceId}&pageSize=200`),
      activity: await apiGet(request, `/api/activity?projectId=${p.id}&pageSize=200`),
      settings: await apiGet(request, '/api/settings'),
      tasks: await apiGet(request, '/api/background-tasks?kind=RETENTION_SWEEP'),
      dashboard: (await apiGet(request, '/api/dashboard?days=30')).totals,
    });
    const before = await snap();
    expect(before.usage).toHaveLength(3);
    expect(before.alerts.length).toBeGreaterThan(0);
    const logFilesBefore = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl'));
    expect(logFilesBefore.length).toBeGreaterThan(0);
    const readLines = (f: string) => fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean);
    const linesBefore = Object.fromEntries(logFilesBefore.map(f => [f, readLines(f)]));
    const sizeBefore = Object.fromEntries(logFilesBefore.map(f => [f, fs.statSync(path.join(LOG_DIR, f)).size]));

    // --- stop the backend: the app really is down ---
    await restartServer.stop();
    await expect.poll(async () => { try { await fetch('http://localhost:4300/api/health', { signal: AbortSignal.timeout(500) }); return 'up'; } catch { return 'down'; } }).toBe('down');
    // the browser sees an error page/state, not a hang
    await page.goto('/').catch(() => {});
    await restartServer.start();

    // --- sessions are stored in SQLite: the logged-in session (storage state + CSRF token) is still valid, no re-login needed ---
    const meAfter = await request.get('/api/auth/me');
    expect(meAfter.status()).toBe(200);
    expect((await meAfter.json()).data.user.role).toBe('ADMIN');
    await page.goto('/projects');
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
    // a brand new login works on the restarted server too
    const fresh = await loginClient(playwright, 'e2e-admin', ADMIN_PASSWORD);
    expect((await fresh.get('/api/auth/me')).status()).toBe(200);
    await fresh.dispose();

    // --- everything is back ---
    const after = await snap();
    expect(after.project).toEqual(before.project);
    expect(after.usage).toEqual(before.usage);
    expect(after.budgets).toEqual(before.budgets);
    expect(after.alerts).toEqual(before.alerts);
    expect(after.trace).toEqual(before.trace);
    expect(after.traceList).toEqual(before.traceList);
    expect(after.settings).toEqual({ retentionDays: 77, slowOperationMs: 321, captureContentPlaintext: false });
    expect(after.tasks).toEqual(before.tasks);
    expect(after.dashboard).toEqual(before.dashboard);
    const logIds = new Set(after.logs.map((l: any) => l.id));
    for (const l of before.logs) expect(logIds.has(l.id)).toBe(true);
    const actIds = new Set(after.activity.map((a: any) => a.id));
    for (const a of before.activity) expect(actIds.has(a.id)).toBe(true);

    // JSONL files preserved: same files, old lines intact, only grown
    for (const f of logFilesBefore) expect(fs.statSync(path.join(LOG_DIR, f)).size).toBeGreaterThanOrEqual(sizeBefore[f]);
    for (const f of logFilesBefore) {
      const now = readLines(f);
      expect(now.slice(0, linesBefore[f].length), `${f}: earlier lines unchanged`).toEqual(linesBefore[f]);
      expect(jsonlLines(now.join('\n'))).toHaveLength(now.length); // every line still valid JSON
    }

    // --- the UI shows the restored data ---
    await page.goto('/projects');
    const row = page.getByTestId(`project-row-${slug(p.name)}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('3'); // requests
    await page.goto(`/usage?projectId=${p.id}`);
    await expect(page.getByTestId('usage-row')).toHaveCount(3);
    await page.goto(`/traces/${fail.traceId}`);
    await expect(page.getByTestId('trace-status')).toHaveText('ERROR');
    await expect(page.getByTestId('timeline-entry-failed').first()).toBeVisible();
    await expect(page.locator('[data-testid="timeline-source"][data-source="SIMULATED"]').first()).toBeVisible();
    await page.goto('/budgets');
    await expect(page.getByTestId('alert-row').filter({ hasText: b.name }).first()).toBeVisible();
    await page.goto('/settings');
    await expect(page.getByTestId('settings-retention-input')).toHaveValue('77');
    await page.goto('/logs');
    await page.getByTestId('log-filter-trace').fill(fail.traceId);
    await expect(page.getByTestId('log-row')).toHaveCount(Math.min(after.logs.length, 25)); // first page of 25

    // --- the restarted backend keeps working and does not duplicate alerts ---
    const next = await apiRequest(request, p.id, { prompt: 'after restart' });
    expect(next.status).toBe('SUCCESS');
    const alertsAfter = await apiGet(request, `/api/budget-alerts?budgetId=${b.id}`);
    const keys = alertsAfter.map((a: any) => `${a.threshold}|${a.periodStart}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect((await request.post('/api/providers/requests', { data: { projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'x' } })).status()).toBe(201);
    // new requests keep appending to the (same) JSONL files after the restart
    const totalAfter = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl')).reduce((n, f) => n + fs.statSync(path.join(LOG_DIR, f)).size, 0);
    expect(totalAfter).toBeGreaterThan(Object.values(sizeBefore).reduce((a, b) => a + b, 0));
  });

  test('failed-login counter and a revoked session also survive a restart (stored in SQLite, not memory)', async ({ request, playwright }) => {
    test.setTimeout(120_000);
    const username = uniqUser('rst');
    const user = await createUser(request, username, STRONG_PASSWORD, 'VIEWER');
    const anon = await anonymousClient(playwright);
    for (let i = 0; i < 3; i += 1) expect((await anon.post('/api/auth/login', { username, password: `wrong-${i}-password` })).status()).toBe(401);
    const live = await loginClient(playwright, username, STRONG_PASSWORD); // success resets the counter ...
    const revoked = await loginClient(playwright, username, STRONG_PASSWORD);
    const sessions = await (await revoked.get('/api/auth/sessions')).json();
    expect((await revoked.del(`/api/auth/sessions/${sessions.data.find((s: any) => s.current).id}`)).status()).toBe(204);
    for (let i = 0; i < 4; i += 1) expect((await anon.post('/api/auth/login', { username, password: `wrong-b-${i}-password` })).status()).toBe(401);

    const failedAttempts = async () => (await (await request.get('/api/auth/users')).json()).data.find((u: any) => u.id === user.id).failedAttempts;
    expect(await failedAttempts()).toBe(4);

    await restartServer();

    expect((await live.get('/api/auth/me')).status()).toBe(200); // still logged in
    expect((await revoked.get('/api/auth/me')).status()).toBe(401); // revoked stays revoked
    // the per-user failure counter (global ceiling) is stored in SQLite and survived; the per-(user, address) lock is in memory by design
    expect(await failedAttempts()).toBe(4);
    expect((await anon.post('/api/auth/login', { username, password: 'wrong-c-password' })).status()).toBe(401);
    expect(await failedAttempts()).toBe(5);
    // admin unlock still works afterwards and resets the counter
    expect((await request.patch(`/api/auth/users/${user.id}`, { data: { unlock: true } })).status()).toBe(200);
    expect(await failedAttempts()).toBe(0);
    expect((await anon.post('/api/auth/login', { username, password: STRONG_PASSWORD })).status()).toBe(200);
    await anon.dispose(); await live.dispose(); await revoked.dispose();
  });
});
