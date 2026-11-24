import fs from 'node:fs';
import { request as pwRequest, type Locator } from '@playwright/test';
import { test, expect } from './support/test';
import { apiBudget, apiCreateProject, slug, watchConsole, uniq } from './support/helpers';
import {
  OTHER_STRONG_PASSWORD, STRONG_PASSWORD, anonymousClient, createUser, errorCode, loginClient, sessionCookieOf, submitLogin, uiLogin, uniqUser,
} from './support/auth';
import { ADMIN_CSRF_FILE, ADMIN_STATE, ADMIN_USERNAME, BASE_URL } from './support/env';

test.describe('auth: login / logout / redirects', () => {
  test.use({ auth: 'none' });

  test('anonymous visitors are sent to /login?next=..., land back after login; logout returns to /login and re-protects the app', async ({ page, request }) => {
    // `request` is anonymous here too (auth: none) - create the account through a separate admin client
    const admin = await adminRequest(request);
    const username = uniqUser('login');
    await createUser(admin, username, STRONG_PASSWORD, 'ADMIN');
    const errors = watchConsole(page);

    await page.goto('/projects?search=zzz');
    await expect(page).toHaveURL(/\/login\?next=%2Fprojects%3Fsearch%3Dzzz$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByTestId('user-menu')).toHaveCount(0);
    await expect(page.getByTestId('sidebar')).toHaveCount(0); // no app shell for anonymous users

    await submitLogin(page, username, STRONG_PASSWORD);
    await expect(page).toHaveURL(/\/projects\?search=zzz$/);
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await expect(page.getByTestId('user-menu-username')).toHaveText(username);
    await expect(page.getByTestId('user-menu-role')).toHaveText('ADMIN');
    await expect(page.getByTestId('readonly-badge')).toHaveCount(0);
    await expect(page.getByTestId('readonly-banner')).toHaveCount(0);

    // the session cookie is HttpOnly + SameSite=Strict and never visible to page scripts
    const cookie = await sessionCookieOf(page);
    expect(cookie).toBeTruthy();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('Strict');
    expect(await page.evaluate(() => document.cookie)).not.toContain('sg_session');

    await page.getByTestId('logout-button').click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('login-submit')).toBeVisible();
    expect(await sessionCookieOf(page)).toBeUndefined();
    await page.goto('/usage');
    await expect(page).toHaveURL(/\/login\?next=%2Fusage$/);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('wrong password / unknown user show one generic error and keep the user on /login', async ({ page, request }) => {
    const admin = await adminRequest(request);
    const username = uniqUser('wrongpw');
    await createUser(admin, username, STRONG_PASSWORD, 'ADMIN');
    await page.goto('/login');
    await expect(page.getByTestId('login-submit')).toBeDisabled(); // empty form
    await submitLogin(page, username, 'definitely-not-the-password');
    await expect(page.getByTestId('login-error')).toHaveText('Invalid username or password');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('login-password')).toHaveValue(''); // password field is cleared
    await page.getByTestId('login-username').fill(uniqUser('nobody'));
    await page.getByTestId('login-password').fill(STRONG_PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toHaveText('Invalid username or password'); // same message: no user enumeration
    expect(await sessionCookieOf(page)).toBeUndefined();
  });

  test('?next= only accepts same-origin paths (no open redirect, no login loop)', async ({ page, request }) => {
    const admin = await adminRequest(request);
    const username = uniqUser('redir');
    await createUser(admin, username, STRONG_PASSWORD, 'ADMIN');
    for (const bad of ['//evil.example/phish', 'https://evil.example', '/login', '\\\\evil.example']) {
      await page.context().clearCookies();
      await page.goto(`/login?next=${encodeURIComponent(bad)}`);
      await submitLogin(page, username, STRONG_PASSWORD);
      await expect(page.getByTestId('user-menu')).toBeVisible();
      expect(new URL(page.url()).origin, `next=${bad}`).toBe(BASE_URL);
      expect(new URL(page.url()).pathname, `next=${bad}`).toBe('/');
    }
  });

  test('logged-in users visiting /login are sent on; invalid cookie / revoked session -> back to /login', async ({ page, request, context }) => {
    const admin = await adminRequest(request);
    const username = uniqUser('sess');
    await createUser(admin, username, STRONG_PASSWORD, 'ADMIN');
    await uiLogin(page, username, STRONG_PASSWORD);
    await page.goto('/login');
    await expect(page.getByTestId('user-menu')).toBeVisible(); // already signed in: login page redirects to the app
    await expect(page).not.toHaveURL(/\/login/);

    // the session is revoked server-side (own session list): the next in-app navigation lands on /login
    const sessions = await (await page.request.get('/api/auth/sessions')).json();
    const current = sessions.data.find((s: any) => s.current);
    expect(current).toBeTruthy();
    const csrf = (await (await page.request.get('/api/auth/me')).json()).data.csrfToken;
    expect((await page.request.delete(`/api/auth/sessions/${current.id}`, { headers: { 'X-CSRF-Token': csrf } })).status()).toBe(204);
    // in-app navigation (no reload): the API answers 401, the app drops the session and shows /login (synchronous click: the shell may already be unmounting)
    await page.evaluate(() => { (document.querySelector('[data-testid="sidebar"] a[href="/usage"]') as HTMLElement | null)?.click(); }); // the shell may already be gone if a background request saw the 401 first
    await expect(page).toHaveURL(/\/login(\?next=%2Fusage)?$/);
    await expect(page.getByTestId('login-submit')).toBeVisible();

    // a garbage cookie is treated as no session at all
    await context.addCookies([{ name: 'sg_session', value: 'x'.repeat(43), url: BASE_URL, httpOnly: true, sameSite: 'Strict' }]);
    expect((await page.request.get('/api/projects')).status()).toBe(401);
    await page.goto('/traces');
    await expect(page).toHaveURL(/\/login\?next=%2Ftraces$/);
  });

  test('five wrong passwords lock THIS address for that user (429 + Retry-After, even with the right password) without locking the account globally; an admin unlock clears it', async ({ page, request, playwright }) => {
    const admin = await adminRequest(request);
    const username = uniqUser('lock');
    const user = await createUser(admin, username, STRONG_PASSWORD, 'VIEWER');
    await page.goto('/login');
    for (let i = 0; i < 5; i += 1) {
      await submitLogin(page, username, `wrong-password-${i}`);
      await expect(page.getByTestId('login-error')).toHaveText('Invalid username or password');
    }
    // locked: even the correct password is refused, with the same generic wording for real and unknown users
    await submitLogin(page, username, STRONG_PASSWORD);
    await expect(page.getByTestId('login-error')).toContainText('Too many failed attempts');
    await expect(page.getByTestId('user-menu')).toHaveCount(0);
    expect(await sessionCookieOf(page)).toBeUndefined();
    const anon = await anonymousClient(playwright);
    const res = await anon.post('/api/auth/login', { username, password: STRONG_PASSWORD });
    expect(res.status()).toBe(429);
    expect(await errorCode(res)).toBe('ACCOUNT_LOCKED');
    expect(Number(res.headers()['retry-after'])).toBeGreaterThan(0);
    // an unknown user that fails 5 times is locked identically (no user enumeration through the lock)
    const ghost = uniqUser('ghost');
    for (let i = 0; i < 5; i += 1) expect((await anon.post('/api/auth/login', { username: ghost, password: `x-${i}` })).status()).toBe(401);
    expect((await anon.post('/api/auth/login', { username: ghost, password: 'x-final' })).status()).toBe(429);
    await anon.dispose();

    // the lock is per (user, address): the account itself is not globally locked, so admins see it as Active
    const adminCtx = await page.context().browser()!.newContext({ baseURL: BASE_URL, storageState: ADMIN_STATE });
    const ap = await adminCtx.newPage();
    await ap.goto('/account');
    await expect(ap.getByTestId(`account-user-row-${username}`)).toContainText('Active');
    await adminCtx.close();

    // admin unlock (API; clears the address lock too) -> the user can sign in again
    expect((await admin.patch(`/api/auth/users/${user.id}`, { data: { unlock: true } })).status()).toBe(200);
    await page.goto('/login');
    await submitLogin(page, username, STRONG_PASSWORD);
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await expect(page.getByTestId('readonly-badge')).toBeVisible();
  });
});

test.describe('auth: API enforcement', () => {
  test.use({ auth: 'none' });

  test('unauthenticated API access is 401 everywhere except health/status/login/setup; unknown /api paths are 401 too (no route probing)', async ({ playwright }) => {
    const anon = await anonymousClient(playwright);
    for (const p of ['/api/projects', '/api/usage', '/api/dashboard', '/api/budgets', '/api/activity', '/api/traces', '/api/observability/sources',
      '/api/logs', '/api/usage/export.csv', '/api/settings', '/api/tools', '/api/cost/pricing', '/api/auth/me', '/api/auth/users', '/api/does-not-exist']) {
      const res = await anon.get(p);
      expect(res.status(), p).toBe(401);
      expect(await errorCode(res), p).toBe('UNAUTHENTICATED');
    }
    for (const p of ['/api/projects', '/api/providers/requests', '/api/settings', '/api/auth/logout']) {
      const method = p === '/api/settings' ? anon.put(p, {}) : anon.post(p, {});
      expect((await method).status(), p).toBe(401);
    }
    const health = await anon.get('/api/health');
    expect(health.status()).toBe(200);
    const status = await (await anon.get('/api/auth/status')).json();
    expect(status.data).toMatchObject({ authEnabled: true, setupRequired: false, authenticated: false });
    expect(status.data.user).toBeUndefined();
    // malformed logins never 5xx
    for (const body of [{}, { username: 'a' }, { username: 5, password: 5 }, { username: 'x'.repeat(500), password: 'y'.repeat(2000) }]) {
      const r = await anon.post('/api/auth/login', body);
      expect([400, 401], JSON.stringify(body).slice(0, 40)).toContain(r.status());
    }
    await anon.dispose();
  });

  test('state-changing requests need the CSRF token (missing/wrong -> 403 CSRF_INVALID); GET does not; foreign Origin is refused', async ({ request, playwright }) => {
    const admin = await adminRequest(request);
    const username = uniqUser('csrf');
    await createUser(admin, username, STRONG_PASSWORD, 'ADMIN');
    const c = await loginClient(playwright, username, STRONG_PASSWORD);
    expect((await c.get('/api/projects')).status()).toBe(200); // safe method: cookie alone is enough

    const name = uniq('csrf-proj');
    const noToken = await c.ctx.post('/api/projects', { data: { name, isTest: true } });
    expect(noToken.status()).toBe(403);
    expect(await errorCode(noToken)).toBe('CSRF_INVALID');
    const wrong = await c.ctx.post('/api/projects', { data: { name, isTest: true }, headers: { 'X-CSRF-Token': 'A'.repeat(43) } });
    expect(wrong.status()).toBe(403);
    expect(await errorCode(wrong)).toBe('CSRF_INVALID');
    for (const m of ['put', 'patch', 'delete'] as const) {
      const r = await c.ctx[m]('/api/settings', { data: { retentionDays: 31 } });
      expect(r.status(), m).toBe(403);
    }
    // nothing was created / changed by the rejected calls
    expect((await (await c.get(`/api/projects?search=${name}&includeTest=true`)).json()).data).toHaveLength(0);
    expect((await (await c.get('/api/settings')).json()).data.retentionDays).toBe(30);

    expect((await c.post('/api/projects', { name, isTest: true })).status()).toBe(201); // with the token it works

    // the CSRF token of another session is useless
    const other = await loginClient(playwright, username, STRONG_PASSWORD);
    const crossSession = await c.ctx.post('/api/projects', { data: { name: uniq('x'), isTest: true }, headers: { 'X-CSRF-Token': other.csrf! } });
    expect(crossSession.status()).toBe(403);

    // cross-origin guard: a foreign Origin header on a state-changing call is refused before auth even matters
    const evil = await c.post('/api/projects', { name: uniq('evil'), isTest: true }, { Origin: 'https://evil.example' });
    expect(evil.status()).toBe(403);
    expect(await errorCode(evil)).toBe('FORBIDDEN_ORIGIN');
    await c.dispose(); await other.dispose();
  });

  test('responses carry security headers (CSP, nosniff, frame deny, referrer policy); auth responses are never cached; no X-Powered-By', async ({ playwright }) => {
    const anon = await anonymousClient(playwright);
    for (const p of ['/', '/login', '/api/health', '/api/auth/status', '/api/projects']) {
      const res = await anon.get(p);
      const h = res.headers();
      expect(h['x-content-type-options'], p).toBe('nosniff');
      expect(h['x-frame-options'], p).toBe('DENY');
      expect(h['referrer-policy'], p).toBe('no-referrer');
      expect(h['content-security-policy'], p).toContain("default-src 'self'");
      expect(h['content-security-policy'], p).toContain("frame-ancestors 'none'");
      expect(h['content-security-policy'], p).toContain("object-src 'none'");
      expect(h['content-security-policy'], p).not.toMatch(/unsafe-eval/);
      expect(h['content-security-policy'], p).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(h['x-powered-by'], p).toBeUndefined();
    }
    expect((await anon.get('/api/auth/status')).headers()['cache-control']).toContain('no-store');
    const login = await anon.post('/api/auth/login', { username: 'nobody', password: 'x' });
    expect(login.headers()['cache-control']).toContain('no-store');
    await anon.dispose();
  });

  test('the SPA renders under its own CSP without violations or console errors', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', m => { if (/content security policy|refused to/i.test(m.text())) violations.push(m.text()); });
    await page.goto('/login');
    await expect(page.getByTestId('login-submit')).toBeVisible();
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

test.describe('auth: read-only (VIEWER) account', () => {
  test.use({ auth: 'viewer' });

  test('UI shows read-only badge and banner; every mutating control is disabled up front and no write (or 403) ever leaves the browser', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    // every non-GET API call and every 403 the page sees; only the cost calculator may write (it is allowed for VIEWER)
    const writes: string[] = [];
    const forbidden: string[] = [];
    page.on('request', r => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(r.method())) writes.push(`${r.method()} ${u.pathname}`);
    });
    page.on('response', r => { if (r.status() === 403) forbidden.push(`${r.request().method()} ${new URL(r.url()).pathname}`); });

    // data to look at, created by the admin (the viewer cannot)
    const admin = await adminRequest();
    const project = await apiCreateProject(admin, uniq('viewer-ro'), true);
    const budget = await apiBudget(admin, project.id, '5.00');
    expect((await admin.post(`/api/projects/${project.id}/memory`, { data: { title: 'ro-item', category: 'facts', content: 'viewer sees this', enabled: true } })).status()).toBe(201);
    await admin.dispose();

    await page.goto('/projects');
    await expect(page.getByTestId('user-menu-role')).toHaveText('VIEWER');
    await expect(page.getByTestId('readonly-badge')).toBeVisible();
    await expect(page.getByTestId('readonly-banner')).toContainText('Read-only account');
    // reading works everywhere
    for (const p of ['/', '/usage', '/traces', '/observability', '/logs', '/settings', '/pricing', '/account']) {
      await page.goto(p);
      await expect(page.getByTestId('readonly-banner')).toBeVisible();
      await expect(page.getByTestId('user-menu')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${p === '/' ? '/$' : p}$`));
    }
    // user management is for admins only
    await page.goto('/account');
    await expect(page.getByTestId('account-users')).toHaveCount(0);
    await expect(page.getByTestId('account-create-user-form')).toHaveCount(0);
    await expect(page.getByTestId('account-password-form')).toBeVisible(); // own password stays changeable

    // own session list stays usable
    await expect(page.getByTestId('account-session-revoke').first()).toBeEnabled();
    await expect(page.getByTestId('account-password-submit')).not.toHaveAttribute('aria-disabled', 'true');

    // projects: create / rename / archive / delete are visible but disabled; a forced click opens nothing
    const s = slug(project.name);
    await page.goto('/projects');
    await page.getByTestId('project-search').fill(project.name);
    await expect(page.getByTestId(`project-row-${s}`)).toBeVisible();
    for (const id of ['project-create-open', `project-edit-${s}`, `project-archive-${s}`, `project-delete-${s}`]) await expectReadOnlyControl(page.getByTestId(id));
    await page.getByTestId('project-create-open').click({ force: true });
    await expect(page.getByTestId('project-create-dialog')).toHaveCount(0);

    // project detail + memory items
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByTestId('memory-item')).toHaveCount(1);
    for (const id of ['project-detail-edit', 'project-detail-archive', 'project-detail-delete', 'memory-add-toggle', 'memory-item-toggle', 'memory-item-edit', 'memory-item-delete']) {
      await expectReadOnlyControl(page.getByTestId(id));
    }

    // budgets: evaluate, create form, row actions
    await page.goto('/budgets');
    const row = page.getByTestId('budget-row').filter({ hasText: budget.name });
    await expect(row).toBeVisible();
    for (const id of ['budgets-evaluate', 'budget-create-submit']) await expectReadOnlyControl(page.getByTestId(id));
    for (const id of ['budget-toggle-active', 'budget-edit', 'budget-delete']) await expectReadOnlyControl(row.getByTestId(id));
    await expect(page.getByTestId('budget-create-name')).toBeDisabled();
    await expect(row.getByTestId('budget-history-toggle')).toBeEnabled(); // reading stays possible

    // settings + retention run
    await page.goto('/settings');
    await expect(page.getByTestId('settings-retention-input')).toBeDisabled();
    await expect(page.getByTestId('settings-slow-input')).toBeDisabled();
    for (const id of ['settings-save', 'settings-retention-run']) await expectReadOnlyControl(page.getByTestId(id));

    // simulator + seed + agent run; pressing Enter in a field does not submit the form either
    await page.goto('/simulator');
    for (const id of ['simulator-submit', 'simulator-seed', 'simulator-agent-run', 'sim-quick-toggle']) await expectReadOnlyControl(page.getByTestId(id));
    await page.getByTestId('sim-max-tokens').press('Enter');
    await expect(page.getByTestId('simulator-error')).toHaveCount(0);

    // pricing: new versions are admin-only; the calculator still works for VIEWER
    await page.goto('/pricing?tab=new');
    await expectReadOnlyControl(page.getByTestId('pricing-new-submit'));
    await expect(page.getByTestId('pricing-new-preview')).toBeEnabled();
    await page.goto('/pricing');
    await expect(page.getByTestId('pricing-calc-submit')).toBeEnabled();
    await page.getByTestId('pricing-calc-submit').click();
    await expect(page.getByTestId('pricing-total')).toBeVisible();

    expect(forbidden, 'no request was refused with 403').toEqual([]);
    expect(writes.filter(w => w !== 'POST /api/cost/calculate'), 'no write request was sent').toEqual([]);
    expect(writes).toContain('POST /api/cost/calculate');
    expect(errors).toEqual([]);
  });

  test('API: GET is allowed, every write is 403 FORBIDDEN (projects, budgets, settings, requests, memory, tools, exports of nothing changes); calculator and own logout allowed', async ({ request }) => {
    expect((await request.get('/api/projects')).status()).toBe(200);
    expect((await request.get('/api/dashboard')).status()).toBe(200);
    expect((await request.get('/api/tools')).status()).toBe(200);
    expect((await request.get('/api/settings')).status()).toBe(200);
    const denied: Array<[string, string, unknown]> = [
      ['post', '/api/projects', { name: uniq('v'), isTest: true }],
      ['post', '/api/providers/requests', { projectId: 'x', provider: 'openai', model: 'gpt-4o', prompt: 'p' }],
      ['post', '/api/budgets', { projectId: null, name: 'b', period: 'DAILY', limitUsd: '1.00' }],
      ['put', '/api/settings', { retentionDays: 10 }],
      ['post', '/api/simulations/seed', { requests: 5 }],
      ['post', '/api/projects/x/memory', { title: 't', category: 'facts', content: 'c' }],
      ['post', '/api/tools/pricing.lookup/invoke', { input: { provider: 'openai', model: 'gpt-4o' } }],
      ['post', '/api/cost/pricing', { provider: 'openai', model: 'gpt-4o', inputPerMTok: '1', outputPerMTok: '1', cachedPerMTok: '1' }],
      ['post', '/api/auth/users', { username: uniqUser('nope'), password: STRONG_PASSWORD, role: 'ADMIN' }],
    ];
    for (const [m, p, data] of denied) {
      const r = await (request as any)[m](p, { data });
      expect(r.status(), `${m} ${p}`).toBe(403);
      expect(await errorCode(r), `${m} ${p}`).toBe('FORBIDDEN');
    }
    expect((await request.get('/api/auth/users')).status()).toBe(403);
    expect((await request.post('/api/cost/calculate', { data: { provider: 'openai', model: 'gpt-4o', inputTokens: 1, outputTokens: 1 } })).status()).toBe(200);
    expect((await request.get('/api/auth/me')).status()).toBe(200);
    expect((await request.get('/api/usage/export.csv')).status()).toBe(200);
  });
});

test.describe('auth: account page', () => {
  test.use({ auth: 'none' });

  test('changing the password signs out every OTHER session, keeps this one, and the old password stops working', async ({ page, request, playwright }) => {
    const admin = await adminRequest(request);
    const username = uniqUser('chpw');
    await createUser(admin, username, STRONG_PASSWORD, 'ADMIN');
    const other = await loginClient(playwright, username, STRONG_PASSWORD); // a second device
    expect((await other.get('/api/auth/me')).status()).toBe(200);

    await uiLogin(page, username, STRONG_PASSWORD);
    await page.getByTestId('account-link').click();
    await expect(page.getByTestId('account-username')).toHaveText(username);
    await expect(page.getByTestId('account-session-row')).toHaveCount(2);
    await expect(page.locator('[data-testid="account-session-row"][data-current="true"]')).toHaveCount(1);

    // client-side + server-side validation
    await page.getByTestId('account-current-password').fill(STRONG_PASSWORD);
    await page.getByTestId('account-new-password').fill('short');
    await page.getByTestId('account-confirm-password').fill('short');
    await page.getByTestId('account-password-submit').click();
    await expect(page.getByTestId('account-password-error')).toBeVisible();
    await page.getByTestId('account-new-password').fill(OTHER_STRONG_PASSWORD);
    await page.getByTestId('account-confirm-password').fill(`${OTHER_STRONG_PASSWORD}-typo`);
    await page.getByTestId('account-password-submit').click();
    await expect(page.getByTestId('account-password-error')).toContainText(/match/i);
    await page.getByTestId('account-current-password').fill('not-my-current-password');
    await page.getByTestId('account-confirm-password').fill(OTHER_STRONG_PASSWORD);
    await page.getByTestId('account-password-submit').click();
    await expect(page.getByTestId('account-password-error')).toContainText(/current password is incorrect/i);
    expect((await other.get('/api/auth/me')).status()).toBe(200); // nothing changed yet

    // success
    await page.getByTestId('account-current-password').fill(STRONG_PASSWORD);
    await page.getByTestId('account-new-password').fill(OTHER_STRONG_PASSWORD);
    await page.getByTestId('account-confirm-password').fill(OTHER_STRONG_PASSWORD);
    await page.getByTestId('account-password-submit').click();
    await expect(page.getByTestId('account-password-success')).toContainText(/changed/i);
    expect((await other.get('/api/auth/me')).status()).toBe(401); // other device is signed out
    await page.reload();
    await expect(page.getByTestId('user-menu')).toBeVisible(); // this session survives
    await expect(page.getByTestId('account-session-row')).toHaveCount(1);

    const anon = await anonymousClient(playwright);
    expect((await anon.post('/api/auth/login', { username, password: STRONG_PASSWORD })).status()).toBe(401);
    expect((await anon.post('/api/auth/login', { username, password: OTHER_STRONG_PASSWORD })).status()).toBe(200);
    await anon.dispose(); await other.dispose();
  });

  test('you can revoke another session from the sessions list; revoking the current one signs you out', async ({ page, request, playwright }) => {
    const admin = await adminRequest(request);
    const username = uniqUser('revoke');
    await createUser(admin, username, STRONG_PASSWORD, 'VIEWER');
    const other = await loginClient(playwright, username, STRONG_PASSWORD);
    await uiLogin(page, username, STRONG_PASSWORD, '/account');
    await expect(page.getByTestId('account-session-row')).toHaveCount(2);
    await page.locator('[data-testid="account-session-row"][data-current="false"]').getByTestId('account-session-revoke').click();
    await expect(page.getByTestId('account-session-row')).toHaveCount(1);
    expect((await other.get('/api/auth/me')).status()).toBe(401);
    await page.getByTestId('account-session-revoke').click(); // the current session
    await expect(page).toHaveURL(/\/login/);
    await other.dispose();
  });
});

test.describe('auth: user management (admin)', () => {
  // runs as the bootstrapped admin
  test('admin creates users, changes roles, resets passwords (signing them out), unlocks and deletes them; cannot delete self', async ({ page, request, playwright }) => {
    const errors = watchConsole(page);
    const username = uniqUser('mgmt');
    await page.goto('/account');
    await expect(page.getByTestId('account-users')).toBeVisible();
    await expect(page.getByTestId(`account-user-row-${ADMIN_USERNAME}`)).toContainText('you');
    await expect(page.getByTestId(`account-user-delete-${ADMIN_USERNAME}`)).toBeDisabled();

    // validation
    await page.getByTestId('account-new-username').fill(username);
    await page.getByTestId('account-new-user-password').fill('short');
    await page.getByTestId('account-create-user').click();
    await expect(page.getByTestId('account-create-error')).toContainText(/at least 12/i);
    await page.getByTestId('account-new-user-password').fill(`${username}-password-1`);
    await page.getByTestId('account-create-user').click();
    await expect(page.getByTestId('account-create-error')).toContainText(/username/i); // password may not contain the username

    // create a VIEWER
    await page.getByTestId('account-new-user-password').fill(STRONG_PASSWORD);
    await page.getByTestId('account-new-user-role').selectOption('VIEWER');
    await page.getByTestId('account-create-user').click();
    await expect(page.getByTestId('account-users-message')).toContainText(`User "${username}" created`);
    const row = page.getByTestId(`account-user-row-${username}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`account-user-role-${username}`)).toHaveValue('VIEWER');
    // duplicate username
    await page.getByTestId('account-new-username').fill(username);
    await page.getByTestId('account-new-user-password').fill(STRONG_PASSWORD);
    await page.getByTestId('account-create-user').click();
    await expect(page.getByTestId('account-create-error')).toContainText(/already taken/i);

    // the new user is read-only; promote -> can write
    const u = await loginClient(playwright, username, STRONG_PASSWORD);
    expect((await u.post('/api/projects', { name: uniq('rbac'), isTest: true })).status()).toBe(403);
    await page.getByTestId(`account-user-role-${username}`).selectOption('ADMIN');
    await expect(page.getByTestId('account-users-message')).toContainText(`Role of "${username}" set to ADMIN`);
    expect((await u.post('/api/projects', { name: uniq('rbac'), isTest: true })).status()).toBe(201); // role is read per request

    // reset password: old sessions die, old password dies
    await page.getByTestId(`account-user-reset-${username}`).click();
    await page.getByTestId('account-reset-password-input').fill(OTHER_STRONG_PASSWORD);
    await page.getByTestId('account-reset-confirm').click();
    await expect(page.getByTestId('account-users-message')).toContainText('their sessions were signed out');
    expect((await u.get('/api/auth/me')).status()).toBe(401);
    const anon = await anonymousClient(playwright);
    expect((await anon.post('/api/auth/login', { username, password: STRONG_PASSWORD })).status()).toBe(401);
    expect((await anon.post('/api/auth/login', { username, password: OTHER_STRONG_PASSWORD })).status()).toBe(200);

    // delete
    await page.getByTestId(`account-user-delete-${username}`).click();
    await page.getByTestId('account-delete-confirm').click();
    await expect(page.getByTestId('account-users-message')).toContainText(`User "${username}" deleted`);
    await expect(row).toHaveCount(0);
    expect((await anon.post('/api/auth/login', { username, password: OTHER_STRONG_PASSWORD })).status()).toBe(401);
    await anon.dispose(); await u.dispose();

    // API guards: cannot delete yourself; unknown user 404
    const me = (await (await request.get('/api/auth/me')).json()).data.user;
    const self = await request.delete(`/api/auth/users/${me.id}`);
    expect(self.status()).toBe(409);
    expect(await errorCode(self)).toBe('CANNOT_DELETE_SELF');
    expect((await request.delete('/api/auth/users/does-not-exist')).status()).toBe(404);
    // the deliberate 400/409 validation calls show up as browser-level "Failed to load resource" lines; anything else is a real console error
    expect(errors.filter(e => !/Failed to load resource: the server responded with a status of (400|409)/.test(e)), errors.join('\n')).toEqual([]);
  });

  test('audit trail: login / failure / user changes are in the activity feed as ACTUAL events and never contain passwords or tokens', async ({ request, playwright }) => {
    const username = uniqUser('audit');
    await createUser(request, username, STRONG_PASSWORD, 'ADMIN');
    const anon = await anonymousClient(playwright);
    await anon.post('/api/auth/login', { username, password: 'wrong-password-value-123' });
    const ok = await anon.post('/api/auth/login', { username, password: STRONG_PASSWORD });
    const token = (await ok.json()).data.csrfToken as string;
    const feedRes = await request.get('/api/activity?search=auth.&pageSize=200');
    expect(feedRes.status()).toBe(200);
    const feed = await feedRes.json();
    const types = new Set(feed.data.map((a: any) => a.type));
    for (const t of ['auth.login.success', 'auth.login.failure', 'auth.user.created']) expect(types.has(t), t).toBe(true);
    expect(feed.data.every((a: any) => a.source === 'ACTUAL')).toBe(true);
    const blob = JSON.stringify(feed.data) + (await (await request.get('/api/export/logs?format=jsonl')).text()) + (await (await request.get('/api/export/activity?format=jsonl')).text());
    for (const secret of [STRONG_PASSWORD, 'wrong-password-value-123', token]) expect(blob).not.toContain(secret);
    await anon.dispose();
  });
});

/** NOTE: playwright.request.newContext() inherits the test's storageState + headers (and a login with a presented cookie rotates that session), so clients here are always created with an explicit empty state. `request` is anonymous in `auth: none` describes, so build an admin client from the saved admin state + CSRF token */
async function adminRequest(_anon?: unknown) {
  return pwRequest.newContext({
    baseURL: BASE_URL, storageState: ADMIN_STATE, extraHTTPHeaders: { 'X-CSRF-Token': fs.readFileSync(ADMIN_CSRF_FILE, 'utf8').trim() },
  });
}
const adminState = async () => ADMIN_STATE;

/** QA bug #8: VIEWER sees mutating controls, but disabled, with aria-disabled and a "Read-only account" tooltip */
async function expectReadOnlyControl(control: Locator) {
  await expect(control).toBeVisible();
  await expect(control).toBeDisabled();
  await expect(control).toHaveAttribute('aria-disabled', 'true');
  await expect(control).toHaveAttribute('title', 'Read-only account');
}
