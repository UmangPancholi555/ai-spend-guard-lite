import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';

let counter = 0;
/** unique, URL-safe, human-readable name (specs share one DB, so every entity gets its own name) */
export function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter}`;
}
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Collects console errors / page errors / failed API responses so a spec can assert "no console errors". */
export function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

async function ok<T>(res: APIResponse, what: string, status = [200, 201]): Promise<T> {
  if (!status.includes(res.status())) throw new Error(`${what} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).data as T;
}

export interface Project { id: string; name: string; status: string; isTest: boolean }
export async function apiCreateProject(request: APIRequestContext, name = uniq('e2e-proj'), isTest = true): Promise<Project> {
  return ok(await request.post('/api/projects', { data: { name, isTest } }), 'create project');
}

export interface MockResponse {
  requestId: string; traceId: string; status: 'SUCCESS' | 'FAILURE'; usageEventId: string; projectId: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  cost: { totalCostUsd: string; inputCostUsd: string; outputCostUsd: string; cachedCostUsd: string; costClass: string }; budgetAlerts: { threshold: number; budgetId: string }[];
  /** wave 2 real runtime summaries (ACTUAL, metadata only) */
  memory: { injected: boolean; items: number; estimatedTokens: number; truncated: boolean; droppedItems: number };
  context: { contextId: string; version: number; sizeBytes: number; estimatedTokens: number; windowTokens: number; truncated: boolean };
  tools?: { name: string; toolCallId: string; status: string; attempts: number; durationMs: number }[];
}
export async function apiRequest(request: APIRequestContext, projectId: string, extra: Record<string, unknown> = {}): Promise<MockResponse> {
  return ok(await request.post('/api/providers/requests', {
    data: { projectId, provider: 'openai', model: 'gpt-4o', prompt: 'e2e prompt', maxOutputTokens: 200, ...extra },
  }), 'provider request');
}
export async function apiBudget(request: APIRequestContext, projectId: string | null, limitUsd: string, period = 'MONTHLY', name = uniq('e2e-budget')) {
  return ok<{ id: string; name: string }>(await request.post('/api/budgets', { data: { projectId, name, period, limitUsd } }), 'create budget');
}
export async function apiGet<T = any>(request: APIRequestContext, path: string): Promise<T> {
  return ok<T>(await request.get(path), `GET ${path}`, [200]);
}

/** USD string with 12 fraction digits from pico-USD (BigInt) */
export function picoToUsd(p: bigint): string {
  return `${p / 1_000_000_000_000n}.${(p % 1_000_000_000_000n).toString().padStart(12, '0')}`;
}
export function usdToPico(usd: string): bigint {
  const [w, f = ''] = usd.split('.');
  return BigInt(w) * 1_000_000_000_000n + BigInt(f.padEnd(12, '0'));
}

/** Minimal RFC-4180 parser for downloaded CSV files */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

/** Click an anchor-like export control and return the downloaded file's text + metadata. */
export async function downloadText(page: Page, trigger: () => Promise<void>): Promise<{ text: string; filename: string }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const stream = await dl.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return { text: Buffer.concat(chunks).toString('utf8'), filename: dl.suggestedFilename() };
}

export const NAV: { label: string; path: string; heading: RegExp }[] = [
  { label: 'Dashboard', path: '/', heading: /^Dashboard$/ },
  { label: 'Projects', path: '/projects', heading: /^Projects$/ },
  { label: 'Usage', path: '/usage', heading: /^Usage$/ },
  { label: 'Request Simulator', path: '/simulator', heading: /^Request Simulator$/ },
  { label: 'Pricing & Calculator', path: '/pricing', heading: /^Pricing & Cost Calculator$/ },
  { label: 'Budgets & Alerts', path: '/budgets', heading: /^Budgets & Alerts$/ },
  { label: 'Activity', path: '/activity', heading: /^Activity$/ },
  { label: 'Traces', path: '/traces', heading: /^Traces$/ },
  { label: 'Observability', path: '/observability', heading: /^Observability$/ },
  { label: 'Error Log', path: '/errors', heading: /^Error Log$/ },
  { label: 'Execution Logs', path: '/logs', heading: /^Execution Logs$/ },
  { label: 'Settings', path: '/settings', heading: /^Settings$/ },
];

export async function expectNoHorizontalOverflow(page: Page) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  expect(o.sw, `documentElement.scrollWidth ${o.sw} > clientWidth ${o.cw}`).toBeLessThanOrEqual(o.cw);
  expect(o.bw).toBeLessThanOrEqual(o.cw);
}

/** href of the <a> wrapping an export test-id span, fetched with the page's request context (so downloads can be validated as text). */
export async function fetchExport(page: Page, testId: string): Promise<{ href: string; status: number; contentType: string; disposition: string; text: string }> {
  const href = await page.getByTestId(testId).locator('xpath=ancestor-or-self::a').getAttribute('href');
  expect(href, `${testId} has an href`).toBeTruthy();
  const res = await page.request.get(href!);
  return { href: href!, status: res.status(), contentType: res.headers()['content-type'] ?? '', disposition: res.headers()['content-disposition'] ?? '', text: await res.text() };
}
export const jsonlLines = (text: string) => text.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Record<string, any>);
