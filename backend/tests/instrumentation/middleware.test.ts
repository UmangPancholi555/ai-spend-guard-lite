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

  it('logs unmatched routes without exploding cardinality and 400s from validation', async () => {
    await request(ctx.app).get('/api/definitely/not/here');
    const bad = await request(ctx.app).put('/api/settings').send({ retentionDays: -5 });
    expect(bad.status).toBe(400);
    await new Promise(r => setTimeout(r, 100));
    const logs = await reqLogs();
    expect(logs.some(l => l.operation === 'GET (unmatched)')).toBe(true);
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
