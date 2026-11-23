import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { requestLifecycleMiddleware } from '../../src/modules/instrumentation';
import { readJsonl } from './util';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const reqLogs = () => ctx.prisma.executionLog.findMany({ where: { category: 'REQUEST', eventType: { startsWith: 'request.' }, traceId: null }, orderBy: { ts: 'asc' } });

describe('requestLifecycleMiddleware', () => {
  it('sets x-request-id header and does not log successful GET or /api/health', async () => {
    const h = await request(ctx.app).get('/api/health');
    expect(h.headers['x-request-id']).toMatch(/^req_[0-9a-f]{32}$/);
    const g = await request(ctx.app).get('/api/settings');
    expect(g.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(await reqLogs()).toHaveLength(0);
  });

  it('honours a well-formed incoming x-request-id and ignores a malformed one', async () => {
    const a = await request(ctx.app).get('/api/health').set('x-request-id', 'client-123');
    expect(a.headers['x-request-id']).toBe('client-123');
    const b = await request(ctx.app).get('/api/health').set('x-request-id', 'bad id with spaces\t');
    expect(b.headers['x-request-id']).toMatch(/^req_/);
    // length bounds: 8..64 chars only
    expect((await request(ctx.app).get('/api/health').set('x-request-id', 'abcdefg')).headers['x-request-id']).toMatch(/^req_/);
    expect((await request(ctx.app).get('/api/health').set('x-request-id', 'abcdefgh')).headers['x-request-id']).toBe('abcdefgh');
    expect((await request(ctx.app).get('/api/health').set('x-request-id', 'a'.repeat(64))).headers['x-request-id']).toBe('a'.repeat(64));
    expect((await request(ctx.app).get('/api/health').set('x-request-id', 'a'.repeat(65))).headers['x-request-id']).toMatch(/^req_/);
  });

  it('logs ACTUAL REQUEST events for non-GET requests using the route pattern', async () => {
    const res = await request(ctx.app).put('/api/settings').send({ slowOperationMs: 700 });
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 100));
    const log = (await reqLogs()).find(l => l.operation === 'PUT /api/settings')!;
    expect(log).toBeTruthy();
    expect(log).toMatchObject({ eventType: 'request.completed', category: 'REQUEST', status: 'SUCCESS', level: 'INFO', source: 'ACTUAL', requestId: res.headers['x-request-id'] });
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(log.attributes)).toMatchObject({ method: 'PUT', route: '/api/settings', statusCode: 200 });
    expect(readJsonl(ctx.deps.config.logDir).some(l => l.id === log.id)).toBe(true);
  });

  it('logs failing GET (4xx => INFO status, WARN level) and uses route patterns not concrete ids', async () => {
    const res = await request(ctx.app).get('/api/logs/does-not-exist');
    expect(res.status).toBe(404);
    await new Promise(r => setTimeout(r, 100));
    const log = (await reqLogs()).find(l => l.operation === 'GET /api/logs/:id')!;
    expect(log).toMatchObject({ status: 'INFO', level: 'WARN', eventType: 'request.completed' });
    expect(JSON.parse(log.attributes).statusCode).toBe(404);
  });

  it('logs 400s from validation on matched routes', async () => {
    const bad = await request(ctx.app).put('/api/settings').send({ retentionDays: -5 });
    expect(bad.status).toBe(400);
    await new Promise(r => setTimeout(r, 100));
    const logs = await reqLogs();
    expect(logs.some(l => l.operation === 'PUT /api/settings' && JSON.parse(l.attributes).statusCode === 400)).toBe(true);
  });

  it('logs 5xx as FAILURE / ERROR / request.failed with errorCategory INTERNAL', async () => {
    const app = express();
    app.use('/api', requestLifecycleMiddleware(ctx.deps.instr));
    const router = express.Router();
    router.get('/boom/:id', (_req, res) => { res.status(503).json({ error: 'x' }); });
    router.post('/ok', (_req, res) => { res.status(201).json({}); });
    app.use('/api', router);
    await request(app).get('/api/boom/7');
    await request(app).post('/api/ok');
    await new Promise(r => setTimeout(r, 100));
    const logs = await reqLogs();
    expect(logs.find(l => l.operation === 'GET /api/boom/:id')).toMatchObject({ status: 'FAILURE', level: 'ERROR', eventType: 'request.failed', errorCategory: 'INTERNAL' });
    expect(logs.find(l => l.operation === 'POST /api/ok')).toMatchObject({ status: 'SUCCESS', level: 'INFO' });
  });

  it('does not create traces', async () => {
    const before = await ctx.prisma.trace.count();
    await request(ctx.app).put('/api/settings').send({});
    await new Promise(r => setTimeout(r, 50));
    expect(await ctx.prisma.trace.count()).toBe(before);
  });
});

describe('flood protection (unauthenticated noise is aggregated, not logged per request)', () => {
  const rows = (op: string) => ctx.prisma.executionLog.findMany({ where: { operation: op } });
  const mk = (opts = {}) => {
    const mw = requestLifecycleMiddleware(ctx.deps.instr, { summaryIntervalMs: 60_000, ...opts });
    const app = express();
    app.use('/api', mw);
    const router = express.Router();
    router.get('/secure', (_q, r) => { r.status(401).json({ error: { code: 'UNAUTHENTICATED' } }); });
    router.get('/limited', (_q, r) => { r.status(429).json({}); });
    router.get('/forbidden', (_q, r) => { r.status(403).json({}); });
    router.get('/missing/:id', (_q, r) => { r.status(404).json({}); }); // matched route + 404 (resource not found)
    router.post('/things/:id', (_q, r) => { r.status(201).json({}); });
    app.use('/api', router); // anything else is an unmatched route -> express default 404
    return { app, mw };
  };

  it('401 / 429 / unmatched-404 write NO per-request rows or JSONL lines; one summary with counts and no attacker strings', async () => {
    const { app, mw } = mk();
    const before = readJsonl(ctx.deps.config.logDir).length;
    const evil = '/api/<script>alert(1)</script>' + 'x'.repeat(300);
    for (let i = 0; i < 30; i++) await request(app).get('/api/secure').set('x-request-id', `evil-${i}-${'z'.repeat(40)}`);
    for (let i = 0; i < 12; i++) await request(app).get(evil + i);
    for (let i = 0; i < 3; i++) await request(app).get('/api/limited');
    await request(app).get('/api/health'); // never counted
    await new Promise(r => setTimeout(r, 50));
    expect(readJsonl(ctx.deps.config.logDir).length).toBe(before); // nothing written yet: only counted in memory
    expect(await ctx.prisma.executionLog.count({ where: { operation: { in: ['GET /api/secure', 'GET /api/limited', 'GET (unmatched)'] } } })).toBe(0);
    await mw.flushSummary();
    const sums = await rows('request.rejected.summary');
    expect(sums).toHaveLength(1);
    expect(sums[0]).toMatchObject({ eventType: 'request.rejected.summary', category: 'REQUEST', level: 'WARN', status: 'INFO', source: 'ACTUAL' });
    expect(JSON.parse(sums[0].attributes)).toMatchObject({ total: 45, byStatus: { '401': 30, '404': 12, '429': 3 }, suppressedDetailed: 0 });
    expect(JSON.stringify(sums[0])).not.toMatch(/script|evil|zzzz/);
    expect(readJsonl(ctx.deps.config.logDir).length).toBe(before + 1);
    await mw.flushSummary(); // nothing pending -> no second row
    expect(await rows('request.rejected.summary')).toHaveLength(1);
    mw.stop();
  });

  it('the summary is emitted by the timer (not per request); counts are conserved across windows', async () => {
    const { app, mw } = mk({ summaryIntervalMs: 300 });
    await ctx.prisma.executionLog.deleteMany({ where: { operation: 'request.rejected.summary' } });
    await Promise.all(Array.from({ length: 10 }, () => request(app).get('/api/secure')));
    await new Promise(r => setTimeout(r, 1200));
    const sums = await ctx.prisma.executionLog.findMany({ where: { operation: 'request.rejected.summary' } });
    expect(sums.length).toBeGreaterThanOrEqual(1);
    expect(sums.length).toBeLessThanOrEqual(3); // one per window, never one per request
    expect(sums.reduce((n, r) => n + (JSON.parse(r.attributes).byStatus['401'] ?? 0), 0)).toBe(10);
    mw.stop();
  });

  it('403, matched-route 404 and non-GET requests are still logged individually', async () => {
    const { app, mw } = mk();
    await request(app).get('/api/forbidden');
    await request(app).get('/api/missing/42');
    await request(app).post('/api/things/42');
    await new Promise(r => setTimeout(r, 100));
    expect((await rows('GET /api/forbidden'))[0]).toMatchObject({ status: 'INFO', level: 'WARN' });
    expect(JSON.parse((await rows('GET /api/missing/:id'))[0].attributes).statusCode).toBe(404);
    expect((await rows('POST /api/things/:id')).length).toBeGreaterThanOrEqual(1);
    mw.stop();
  });

  it('truncates the logged path attribute to 120 chars', async () => {
    const { app, mw } = mk();
    await request(app).post('/api/things/' + 'p'.repeat(400));
    await new Promise(r => setTimeout(r, 100));
    const logs = await rows('POST /api/things/:id');
    const longest = Math.max(...logs.map(l => JSON.parse(l.attributes).path.length));
    expect(longest).toBe(120);
    mw.stop();
  });

  it('caps detailed rows per minute; the excess is only counted in the summary', async () => {
    const { app, mw } = mk({ maxDetailedPerMinute: 5 });
    await ctx.prisma.executionLog.deleteMany({ where: { operation: 'POST /api/things/:id' } });
    for (let i = 0; i < 12; i++) await request(app).post(`/api/things/${i}`);
    await new Promise(r => setTimeout(r, 150));
    expect(await ctx.prisma.executionLog.count({ where: { operation: 'POST /api/things/:id' } })).toBe(5);
    await ctx.prisma.executionLog.deleteMany({ where: { operation: 'request.rejected.summary' } });
    await mw.flushSummary();
    const sum = await rows('request.rejected.summary');
    expect(sum).toHaveLength(1);
    expect(JSON.parse(sum[0].attributes)).toMatchObject({ total: 0, suppressedDetailed: 7 });
    mw.stop();
  });
});
