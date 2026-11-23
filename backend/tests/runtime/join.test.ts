import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { makeProject, until } from './helpers';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

describe('HTTP request log <-> trace <-> usage event join', () => {
  it('POST /providers/requests: the request log row carries the traceId; trace attributes and usage metadata carry httpRequestId', async () => {
    const p = await makeProject(ctx.prisma);
    const res = await request(ctx.app).post('/api/providers/requests').set('x-request-id', 'http-join-0001')
      .send({ projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'join me' });
    expect(res.status).toBe(201);
    expect(res.headers['x-request-id']).toBe('http-join-0001');
    const d = res.body.data;
    expect(d.httpRequestId).toBe('http-join-0001');
    expect(d.requestId).not.toBe('http-join-0001'); // the mock provider request id is a different id

    const http = await until(() => ctx.prisma.executionLog.findFirst({ where: { requestId: 'http-join-0001', operation: { startsWith: 'POST ' } } }));
    expect(http).toMatchObject({ category: 'REQUEST', source: 'ACTUAL', traceId: d.traceId, projectId: p.id, status: 'SUCCESS' });
    expect(http.operation).toMatch(/providers\/requests/);

    const root = await ctx.prisma.span.findFirstOrThrow({ where: { traceId: d.traceId, parentSpanId: null } });
    expect(JSON.parse(root.attributes).httpRequestId).toBe('http-join-0001');
    const usage = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { id: d.usageEventId } });
    expect(JSON.parse(usage.metadata).httpRequestId).toBe('http-join-0001');
    expect(usage.traceId).toBe(d.traceId);
    // follow the join: log line -> trace -> usage event
    const viaTrace = await ctx.prisma.usageEvent.findFirstOrThrow({ where: { traceId: http.traceId! } });
    expect(viaTrace.requestId).toBe(d.requestId);
  });

  it('without a client x-request-id the generated one is joined the same way', async () => {
    const p = await makeProject(ctx.prisma);
    const res = await request(ctx.app).post('/api/providers/requests').send({ projectId: p.id, provider: 'anthropic', model: 'claude-haiku', prompt: 'auto id' });
    const id = res.headers['x-request-id'] as string;
    expect(id).toMatch(/^req_/);
    expect(res.body.data.httpRequestId).toBe(id);
    const http = await until(() => ctx.prisma.executionLog.findFirst({ where: { requestId: id, operation: { startsWith: 'POST ' } } }));
    expect(http.traceId).toBe(res.body.data.traceId);
  });

  it('failed provider requests (simulated failure, 201) and tool invocations join as well; agent-run too', async () => {
    const p = await makeProject(ctx.prisma);
    const f = await request(ctx.app).post('/api/providers/requests').set('x-request-id', 'http-join-fail')
      .send({ projectId: p.id, provider: 'openai', model: 'gpt-4o', prompt: 'fail', simulateFailure: 'timeout' });
    expect(f.body.data.status).toBe('FAILURE');
    expect((await until(() => ctx.prisma.executionLog.findFirst({ where: { requestId: 'http-join-fail', operation: { startsWith: 'POST ' } } }))).traceId).toBe(f.body.data.traceId);

    const t = await request(ctx.app).post('/api/tools/pricing.lookup/invoke').set('x-request-id', 'http-join-tool').send({ input: { provider: 'openai', model: 'gpt-4o' } });
    expect((await until(() => ctx.prisma.executionLog.findFirst({ where: { requestId: 'http-join-tool', operation: { startsWith: 'POST ' } } }))).traceId).toBe(t.body.data.traceId);
    const toolRoot = await ctx.prisma.span.findFirstOrThrow({ where: { traceId: t.body.data.traceId, parentSpanId: null } });
    expect(JSON.parse(toolRoot.attributes).httpRequestId).toBe('http-join-tool');

    const a = await request(ctx.app).post('/api/simulations/agent-run').set('x-request-id', 'http-join-agent').send({ projectId: p.id });
    expect((await until(() => ctx.prisma.executionLog.findFirst({ where: { requestId: 'http-join-agent', operation: { startsWith: 'POST ' } } }))).traceId).toBe(a.body.data.traceId);
  });

  it('a request rejected before a trace exists (404/409/400) has no traceId on its log row', async () => {
    const res = await request(ctx.app).post('/api/providers/requests').set('x-request-id', 'http-join-404')
      .send({ projectId: 'missing', provider: 'openai', model: 'gpt-4o', prompt: 'x' });
    expect(res.status).toBe(404);
    const http = await until(() => ctx.prisma.executionLog.findFirst({ where: { requestId: 'http-join-404' } }));
    expect(http.traceId).toBeNull();
  });
});
