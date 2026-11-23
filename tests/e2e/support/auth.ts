import type { APIRequestContext, APIResponse, Page, PlaywrightWorkerArgs } from '@playwright/test';

type Playwright = PlaywrightWorkerArgs['playwright'];
import { expect } from '@playwright/test';
import { BASE_URL } from './env';

/** Strong password that satisfies the policy (>=12 chars, not common, never contains a generated username). */
export const STRONG_PASSWORD = 'Pelican-Ridge-Orbit-Mango-52';
export const OTHER_STRONG_PASSWORD = 'Saffron-Tundra-Kettle-Drift-77';

let n = 0;
/** valid unique username: 3-32 chars, lowercase letters / digits / dot / underscore / hyphen */
export function uniqUser(prefix = 'u'): string {
  n += 1;
  return `${prefix}-${Date.now().toString(36)}${n}`.slice(0, 32);
}

/** A logged-in (or anonymous) API client with its own cookie jar. `csrf` is added automatically to unsafe methods. */
export interface Client {
  ctx: APIRequestContext;
  csrf?: string;
  get(path: string, headers?: Record<string, string>): Promise<APIResponse>;
  post(path: string, data?: unknown, headers?: Record<string, string>): Promise<APIResponse>;
  patch(path: string, data?: unknown): Promise<APIResponse>;
  put(path: string, data?: unknown): Promise<APIResponse>;
  del(path: string): Promise<APIResponse>;
  dispose(): Promise<void>;
}

function wrap(ctx: APIRequestContext, csrf?: string): Client {
  const h = (extra?: Record<string, string>) => ({ ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(extra ?? {}) });
  const c: Client = {
    ctx, csrf,
    get: (p, headers) => ctx.get(p, { headers }),
    post: (p, data, headers) => ctx.post(p, { data: data ?? {}, headers: h(headers) }),
    patch: (p, data) => ctx.patch(p, { data, headers: h() }),
    put: (p, data) => ctx.put(p, { data, headers: h() }),
    del: p => ctx.delete(p, { headers: h() }),
    dispose: () => ctx.dispose(),
  };
  return c;
}

export async function anonymousClient(playwright: Playwright, baseURL = BASE_URL): Promise<Client> {
  return wrap(await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} }));
}

/** Logs in through the real API with a fresh cookie jar. */
export async function loginClient(playwright: Playwright, username: string, password: string, baseURL = BASE_URL): Promise<Client> {
  const ctx = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} });
  const res = await ctx.post('/api/auth/login', { data: { username, password } });
  if (res.status() !== 200) throw new Error(`login ${username} failed: ${res.status()} ${await res.text()}`);
  return wrap(ctx, (await res.json()).data.csrfToken);
}

/** Admin (the default `request` fixture, already authenticated + CSRF header) creates a user. */
export async function createUser(admin: APIRequestContext, username: string, password: string, role: 'ADMIN' | 'VIEWER'): Promise<{ id: string; username: string; role: string }> {
  const res = await admin.post('/api/auth/users', { data: { username, password, role } });
  if (res.status() !== 201) throw new Error(`create user ${username} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).data;
}

export async function errorCode(res: APIResponse): Promise<string | undefined> {
  try { return (await res.json()).error?.code; } catch { return undefined; }
}

/** Fill the login form and submit (does not wait for the result). */
export async function submitLogin(page: Page, username: string, password: string) {
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
}

/** Full UI login; resolves when the app shell (user menu) is visible. */
export async function uiLogin(page: Page, username: string, password: string, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await submitLogin(page, username, password);
  await expect(page.getByTestId('user-menu')).toBeVisible();
}

export const sessionCookieOf = async (page: Page) => (await page.context().cookies()).find(c => c.name === 'sg_session');
