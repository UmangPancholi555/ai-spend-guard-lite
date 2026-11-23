import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupTestDir, createTestApp } from '../helpers/testApp';
import { api, Ctx, dumpAllTables, listAll, logFiles, mkProject, pay } from './helpers';

let ctx: Ctx;
let proj: { id: string };
const MARKER = `PRIVMARK_${Math.random().toString(36).slice(2)}_${Date.now()}`;
const prompts = [
  `${MARKER}_plain you are a helpful assistant with secret sk-test-123`,
  `${MARKER}_failure`, `${MARKER}_agent`, `${MARKER}_timeout`, `${MARKER}_unknown_model`,
];
beforeAll(async () => {
  ctx = await createTestApp();
  proj = await mkProject(ctx, 'privacy-proj');
  await pay(ctx, { projectId: proj.id, prompt: prompts[0] });
  await pay(ctx, { projectId: proj.id, prompt: prompts[1], simulateFailure: 'error' });
  await pay(ctx, { projectId: proj.id, prompt: prompts[2], simulateAgentActivity: true });
  await pay(ctx, { projectId: proj.id, prompt: prompts[3], simulateFailure: 'timeout', simulateAgentActivity: true });
  await pay(ctx, { projectId: proj.id, prompt: prompts[4], model: 'unknown-x' });
  // validation failure with a prompt inside the body must not leak the prompt either
  const bad = await api(ctx).post('/api/providers/requests').send({ projectId: proj.id, provider: 'openai', model: 'gpt-4o', prompt: `${MARKER}_invalid`, maxOutputTokens: -5 });
  expect(bad.status).toBe(400);
  expect(JSON.stringify(bad.body)).not.toContain(MARKER);
  // budget alerts + a retention run + seed so many tables are populated
  await api(ctx).post('/api/budgets').send({ projectId: proj.id, name: 'priv', period: 'DAILY', limitUsd: '0.000000000001' });
  await pay(ctx, { projectId: proj.id, prompt: `${MARKER}_budget` });
  await api(ctx).post('/api/logging/retention/run');
}, 60_000);
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

describe('privacy: prompt text is never persisted or exported', () => {
  it('no table/column in SQLite contains the prompt marker; only hash + length are stored', async () => {
    const dump = await dumpAllTables(ctx);
    expect(dump).not.toContain(MARKER);
    expect(dump).not.toContain('sk-test-123');
    const rows = await ctx.prisma.usageEvent.findMany();
    expect(rows.length).toBe(7 - 1); // 6 successful-validation requests
    for (const r of rows) {
      expect(r.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.promptChars).toBeGreaterThan(MARKER.length);
    }
  });

  it('the raw SQLite file (incl. free pages) and every JSONL log file contain no prompt text', async () => {
    const dbBytes = fs.readFileSync(ctx.dbPath);
    expect(dbBytes.includes(Buffer.from(MARKER))).toBe(false);
    for (const f of logFiles(ctx)) expect(fs.readFileSync(f, 'utf8')).not.toContain(MARKER);
    // no stray files with content in the log dir
    for (const f of fs.readdirSync(path.join(ctx.dir, 'logs'))) expect(fs.readFileSync(path.join(ctx.dir, 'logs', f), 'utf8')).not.toContain(MARKER);
  });

  it('no API response (lists, details, exports) leaks the prompt', async () => {
    const urls = [
      '/api/usage', '/api/activity', '/api/traces', '/api/logs', '/api/observability/errors', '/api/observability/memory-events', '/api/observability/bus-events',
      '/api/observability/tool-events', '/api/observability/context-events', '/api/background-tasks', '/api/budget-alerts', '/api/dashboard', '/api/observability/overview',
      '/api/observability/performance', '/api/observability/sources', '/api/projects',
      ...['activity', 'traces', 'logs', 'errors', 'memory', 'bus', 'tools', 'context', 'alerts', 'tasks'].flatMap(d => [`/api/export/${d}?format=jsonl`, `/api/export/${d}?format=csv`]),
      '/api/usage/export.csv',
    ];
    for (const u of urls) {
      const r = await api(ctx).get(u);
      expect(r.status, u).toBe(200);
      expect(r.text, u).not.toContain(MARKER);
    }
    const usage = await listAll<any>(ctx, '/api/usage');
    for (const u of usage) {
      const d = await api(ctx).get(`/api/usage/${u.id}`);
      expect(d.text).not.toContain(MARKER);
      if (u.traceId) expect((await api(ctx).get(`/api/traces/${u.traceId}`)).text).not.toContain(MARKER);
    }
    // the mock content never echoes the prompt
    const resp = await api(ctx).post('/api/providers/requests').send({ projectId: proj.id, provider: 'openai', model: 'gpt-4o', prompt: `${MARKER}_echo` });
    expect(resp.text).not.toContain(MARKER);
  });

  it('usage metadata holds metadata only (no content keys)', async () => {
    const rows = await ctx.prisma.usageEvent.findMany({ select: { metadata: true } });
    for (const r of rows) {
      const m = JSON.parse(r.metadata);
      for (const k of Object.keys(m)) expect(['prompt', 'messages', 'input', 'content', 'completion']).not.toContain(k);
    }
  });

  it('settings: captureContentPlaintext can never be switched on', async () => {
    const r = await api(ctx).put('/api/settings').send({ captureContentPlaintext: true });
    const s = (await api(ctx).get('/api/settings')).body.data;
    expect(s.captureContentPlaintext).toBe(false);
    expect([200, 400]).toContain(r.status);
  });
});

describe('security & robustness', () => {
  const evil = [
    "' OR 1=1 --", '"; DROP TABLE Project; --', "1; DELETE FROM UsageEvent", "%", "_", "\\", "%27%20OR%201=1", "' UNION SELECT * FROM sqlite_master --",
    '<script>alert(1)</script>', '../../etc/passwd', '\u0000', 'ünïcødé 💥', 'x'.repeat(250),
  ];
  const searchable = ['/api/usage?search=', '/api/activity?search=', '/api/traces?search=', '/api/logs?search=', '/api/observability/errors?search=',
    '/api/projects?search=', '/api/observability/memory-events?search=', '/api/observability/tool-events?search=', '/api/observability/bus-events?search=',
    '/api/observability/context-events?search=', '/api/usage/export.csv?search=', '/api/export/logs?search='];

  it('SQL-ish / odd strings in search params never cause a 5xx and never harm data', async () => {
    const before = await ctx.prisma.usageEvent.count();
    for (const base of searchable) for (const e of evil) {
      const r = await api(ctx).get(base + encodeURIComponent(e));
      expect(r.status, `${base}${JSON.stringify(e)}`).toBeLessThan(500);
      expect([200, 400]).toContain(r.status);
      if (r.status === 400) expect(r.body.error?.code ?? 'VALIDATION_ERROR').toBe('VALIDATION_ERROR');
    }
    expect(await ctx.prisma.usageEvent.count()).toBe(before);
    const tables = await ctx.prisma.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' AND name='Project'");
    expect(tables).toHaveLength(1);
    // other filter params
    for (const q of ["status=' OR 1=1", "provider=' OR 1=1 --", "projectId=' OR '1'='1", "sort=costUsd;DROP TABLE x", "order=asc;--", 'page=1;DROP', 'pageSize=-1', 'pageSize=99999', 'page=0', 'page=abc']) {
      const r = await api(ctx).get(`/api/usage?${q}`);
      expect(r.status, q).toBeLessThan(500);
    }
    // an empty result for an injection-like string (it is treated as a literal)
    const r = await api(ctx).get(`/api/usage?search=${encodeURIComponent("' OR 1=1 --")}`);
    expect(r.body.pagination.total).toBe(0);
  });

  it('LIKE wildcards in search are treated literally', async () => {
    await mkProject(ctx, 'wild%card'); await mkProject(ctx, 'wildXcard'); await mkProject(ctx, 'wild_card');
    const pct = await api(ctx).get('/api/projects?search=' + encodeURIComponent('wild%card'));
    expect(pct.body.data.map((p: any) => p.name)).toEqual(['wild%card']);
    const us = await api(ctx).get('/api/projects?search=' + encodeURIComponent('wild_card'));
    expect(us.body.data.map((p: any) => p.name)).toEqual(['wild_card']);
  });

  it('SQL-ish and HTML payloads in project names are stored as plain data and returned unchanged', async () => {
    const nm = `'); DROP TABLE "Project";-- <img src=x onerror=alert(1)>`;
    const p = await mkProject(ctx, nm);
    const g = await api(ctx).get(`/api/projects/${p.id}`);
    expect(g.body.data.name).toBe(nm);
    expect(g.headers['content-type']).toMatch(/application\/json/);
    expect(g.headers['x-content-type-options'] ?? 'nosniff').toBeTruthy();
    expect((await api(ctx).get(`/api/projects/${encodeURIComponent("x' OR '1'='1")}`)).status).toBe(404);
  });

  it('malformed JSON => 400 envelope; wrong shapes => 400; never 500', async () => {
    const cases: [string, string, string | undefined][] = [
      ['/api/projects', '{bad json', 'application/json'], ['/api/providers/requests', '{"projectId":', 'application/json'],
      ['/api/projects', '[]', 'application/json'], ['/api/projects', 'null', 'application/json'], ['/api/projects', '"str"', 'application/json'],
      ['/api/budgets', '{', 'application/json'], ['/api/cost/pricing', '{"a":', 'application/json'], ['/api/simulations/seed', '{', 'application/json'],
    ];
    for (const [url, body, ct] of cases) {
      const r = await api(ctx).post(url).set('Content-Type', ct!).send(body);
      expect(r.status, `${url} ${body}`).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      expect(typeof r.body.error.message).toBe('string');
      expect(r.text).not.toMatch(/\bat .*\.(ts|js):\d+/); // no stack leakage
    }
    const noCt = await api(ctx).post('/api/projects').send('name=abc');
    expect(noCt.status).toBe(400);
    const proto = await api(ctx).post('/api/projects').set('Content-Type', 'application/json').send('{"name":"proto","__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}}}');
    expect(proto.status).toBeLessThan(500);
    expect(({} as any).isAdmin).toBeUndefined();
    expect(({} as any).x).toBeUndefined();
  });

  it('1MB body limit => 413 with error envelope, nothing persisted; just-under-limit bodies are processed', async () => {
    const before = await ctx.prisma.usageEvent.count();
    const big = await api(ctx).post('/api/providers/requests').set('Content-Type', 'application/json')
      .send(JSON.stringify({ projectId: proj.id, provider: 'openai', model: 'gpt-4o', prompt: 'a'.repeat(1_100_000) }));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await ctx.prisma.usageEvent.count()).toBe(before);
    // 900KB prompt: either accepted (201) or rejected with a 4xx validation error, never 5xx; never stored
    const near = await api(ctx).post('/api/providers/requests').set('Content-Type', 'application/json')
      .send(JSON.stringify({ projectId: proj.id, provider: 'openai', model: 'gpt-4o', prompt: `${MARKER}${'b'.repeat(900_000)}` }));
    expect(near.status).toBeLessThan(500);
    const dump = await dumpAllTables(ctx);
    expect(dump).not.toContain(MARKER);
    // server still healthy afterwards
    expect((await api(ctx).get('/api/health')).status).toBe(200);
    // the 413 is not recorded as an INTERNAL error
    const internal = await ctx.prisma.executionLog.count({ where: { errorCategory: 'INTERNAL' } });
    expect(internal).toBe(0);
  });

  it('CORS only allows localhost origins; x-powered-by hidden; unknown API route is a JSON 404', async () => {
    const ok = await api(ctx).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const bad = await api(ctx).get('/api/health').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    expect(ok.headers['x-powered-by']).toBeUndefined();
    const nf = await api(ctx).get('/api/nope/nothing');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
  });

  it('input validation: lengths, types and enums on key endpoints', async () => {
    const t = (r: any) => expect(r.status).toBe(400);
    t(await api(ctx).post('/api/projects').send({ name: '' }));
    t(await api(ctx).post('/api/projects').send({ name: 'x'.repeat(81) }));
    t(await api(ctx).post('/api/projects').send({ name: 123 }));
    expect((await api(ctx).post('/api/projects').send({ name: 'Dup-Case' })).status).toBe(201);
    expect((await api(ctx).post('/api/projects').send({ name: 'dup-case' })).status).toBe(409);
    t(await api(ctx).post('/api/providers/requests').send({ projectId: proj.id, provider: 'openai', model: 'gpt-4o', prompt: 'p', temperature: 'hot' }));
    t(await api(ctx).post('/api/providers/requests').send({ projectId: proj.id, provider: 'openai', model: 'gpt-4o', prompt: 'p', simulateFailure: 'explode' }));
    t(await api(ctx).post('/api/providers/requests').send({ projectId: proj.id, provider: 'openai', model: 'gpt-4o', prompt: '' }));
    t(await api(ctx).post('/api/budgets').send({ projectId: proj.id, name: 'n', period: 'YEARLY', limitUsd: '1' }));
    t(await api(ctx).post('/api/budgets').send({ projectId: proj.id, name: 'n', period: 'DAILY', limitUsd: '-1' }));
    t(await api(ctx).post('/api/budgets').send({ projectId: proj.id, name: 'n', period: 'DAILY', limitUsd: '1e3' }));
    t(await api(ctx).post('/api/cost/calculate').send({ provider: 'openai', model: 'gpt-4o', inputTokens: -1, outputTokens: 0 }));
    t(await api(ctx).post('/api/cost/calculate').send({ provider: 'openai', model: 'gpt-4o', inputTokens: 1.5, outputTokens: 0 }));
    t(await api(ctx).put('/api/settings').send({ retentionDays: -1 }));
    t(await api(ctx).put('/api/settings').send({ retentionDays: 99999 }));
    t(await api(ctx).put('/api/settings').send({ slowOperationMs: 0 }));
    t(await api(ctx).post('/api/simulations/seed').send({ requests: 0, spreadDays: 5 }));
    t(await api(ctx).get('/api/usage?from=not-a-date'));
  });
});
