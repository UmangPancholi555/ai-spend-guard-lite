import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createLoggingRouter } from '../../src/modules/logging';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';

let ctx: TestCtx;
const D = (s: string) => new Date(s);
const trace = 'b'.repeat(32);

/** minimal RFC4180 parser for assertions */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  return rows;
}

beforeAll(async () => {
  ctx = await createTestApp();
  const i = ctx.deps.instr;
  const at = (s: string) => ({ at: D(s) } as object);
  await i.recordMemory({ source: 'SIMULATED', phase: 'COMPLETED', memorySource: 'mem1', category: 'c', itemCount: 2, estimatedTokens: 10, payloadBytes: 40, traceId: trace, ...at('2026-03-01T10:00:00Z') });
  await i.recordMemory({ source: 'ACTUAL', phase: 'FAILED', memorySource: 'mem2', category: 'c', itemCount: 0, estimatedTokens: 0, payloadBytes: 0, errorMessage: '=HYPERLINK("http://evil","x")', ...at('2026-03-02T10:00:00Z') });
  await i.recordBus({ source: 'ACTUAL', operationName: 'bus.a', operationType: 'PUBLISH', eventName: 'e', success: true, inputMeta: { keys: ['a', 'b'] }, ...at('2026-03-01T11:00:00Z') });
  await i.recordBus({ source: 'SIMULATED', operationName: 'bus.b', operationType: 'DISPATCH', eventName: 'e', success: false, errorMessage: 'x', traceId: trace, ...at('2026-03-02T11:00:00Z') });
  await i.recordTool({ source: 'SIMULATED', toolName: 'tool, with "quotes"', toolCallId: 'c1', startedAt: D('2026-03-01T11:59:00Z'), endedAt: D('2026-03-01T12:00:00Z'), success: true, traceId: trace });
  await i.recordContext({ source: 'SIMULATED', contextId: 'ctx1', operation: 'CREATED', contextSource: 's', sizeBytes: 10, estimatedTokens: 3, version: 1, traceId: trace, ...at('2026-03-01T13:00:00Z') });
  await i.recordActivity({ type: 'project.created', message: '@cmd|evil', source: 'ACTUAL', ...at('2026-03-01T14:00:00Z') });
  await i.recordActivity({ type: 'request.failed', level: 'ERROR', message: 'line1\nline2', source: 'SIMULATED', traceId: trace, ...at('2026-03-02T14:00:00Z') });
  await i.recordError({ source: 'ACTUAL', category: 'PROVIDER', operation: 'p.err', error: new Error('provider down'), ...at('2026-03-03T10:00:00Z') });
  const t = await i.startTrace({ name: 'export.trace', source: 'SIMULATED', ...({ at: D('2026-03-01T15:00:00Z') } as object) });
  await t.end();
  const failing = await i.startTrace({ name: 'export.failing', source: 'ACTUAL', ...({ at: D('2026-03-04T15:00:00Z') } as object) });
  await failing.end(new Error('x'));
  const tk = await i.startTask({ name: 'export.task', kind: 'OTHER', source: 'ACTUAL' }); await tk.succeed({ n: 1 });
  const b = await ctx.prisma.budget.create({ data: { name: 'Global', period: 'DAILY', limitPico: 1_000_000_000_000n } });
  await ctx.prisma.budgetAlert.create({ data: { budgetId: b.id, threshold: 80, periodStart: D('2026-03-01'), periodEnd: D('2026-03-02'), spendPico: 800_000_000_000n, limitPico: 1_000_000_000_000n, percent: 80, createdAt: D('2026-03-01T16:00:00Z') } });
});
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const exp = (ds: string, q = '') => request(ctx.app).get(`/api/export/${ds}${q}`).buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', c => (d += c)); res.on('end', () => cb(null, d)); });
const jsonl = (text: string) => text.split('\n').filter(Boolean).map(l => JSON.parse(l));

describe('GET /export/:dataset', () => {
  it('sets attachment headers and content types', async () => {
    const j = await exp('logs');
    expect(j.status).toBe(200);
    expect(j.headers['content-type']).toMatch(/^application\/x-ndjson/);
    expect(j.headers['content-disposition']).toMatch(/^attachment; filename="spendguard-logs-\d{8}-\d{6}Z\.jsonl"$/);
    const c = await exp('logs', '?format=csv');
    expect(c.headers['content-type']).toMatch(/^text\/csv/);
    expect(c.headers['content-disposition']).toMatch(/filename="spendguard-logs-.*\.csv"/);
  });

  it('exports every dataset in JSONL and CSV, parseable, row counts agree', async () => {
    const expected: Record<string, number> = { activity: 2, traces: 2, logs: 0, errors: 0, memory: 2, bus: 2, tools: 1, context: 1, alerts: 1, tasks: 1 };
    for (const ds of Object.keys(expected)) {
      const j = await exp(ds);
      expect(j.status, ds).toBe(200);
      const objs = jsonl(j.text ?? j.body);
      const c = await exp(ds, '?format=csv');
      const rows = parseCsv(c.body);
      expect(rows.length - 1, `${ds} csv vs jsonl`).toBe(objs.length);
      expect(new Set(rows.map(r => r.length)).size, `${ds} uniform columns`).toBe(1);
      if (expected[ds]) expect(objs.length, ds).toBe(expected[ds]);
      else expect(objs.length, ds).toBeGreaterThan(0);
    }
  });

  it('logs export honors eventType, date range, status, traceId and operation search', async () => {
    expect(jsonl((await exp('logs', '?eventType=bus.operation')).body)).toHaveLength(2);
    expect(jsonl((await exp('logs', '?eventType=memory.injection.*&status=FAILURE')).body).map(l => l.operation)).toEqual(['mem2']);
    expect(jsonl((await exp('logs', `?traceId=${trace}`)).body).length).toBeGreaterThanOrEqual(5);
    expect(jsonl((await exp('logs', '?search=bus.b')).body)).toHaveLength(1);
    const range = jsonl((await exp('logs', '?eventType=bus.operation&from=2026-03-02&to=2026-03-02')).body);
    expect(range.map(l => l.operation)).toEqual(['bus.b']);
  });

  it('errors export = level ERROR or status FAILURE only, honoring category filter', async () => {
    const all = jsonl((await exp('errors')).body);
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.every((l: any) => l.level === 'ERROR' || l.status === 'FAILURE')).toBe(true);
    const p = jsonl((await exp('errors', '?category=PROVIDER')).body);
    expect(p.every((l: any) => l.errorCategory === 'PROVIDER')).toBe(true);
    expect(p.some((l: any) => l.operation === 'p.err')).toBe(true);
  });

  it('applies dataset-specific filters (memory/bus/tools/context/activity/traces/alerts/tasks)', async () => {
    expect(jsonl((await exp('memory', '?status=FAILURE')).body)).toHaveLength(1);
    expect(jsonl((await exp('memory', '?source=SIMULATED')).body).map(m => m.memorySource)).toEqual(['mem1']);
    expect(jsonl((await exp('bus', `?traceId=${trace}`)).body).map(m => m.operationName)).toEqual(['bus.b']);
    expect(jsonl((await exp('bus', '?search=bus.a')).body)).toHaveLength(1);
    expect(jsonl((await exp('tools', '?search=quotes')).body)).toHaveLength(1);
    expect(jsonl((await exp('context', '?from=2026-03-02')).body)).toHaveLength(0);
    expect(jsonl((await exp('activity', '?level=ERROR')).body).map(a => a.type)).toEqual(['request.failed']);
    expect(jsonl((await exp('activity', '?type=project.created')).body)).toHaveLength(1);
    expect(jsonl((await exp('traces', '?status=ERROR')).body).map(t => t.name)).toEqual(['export.failing']);
    expect(jsonl((await exp('traces', '?source=SIMULATED&search=export.trace')).body)).toHaveLength(1);
    expect(jsonl((await exp('tasks', '?kind=OTHER&status=SUCCEEDED')).body)).toHaveLength(1);
    expect(jsonl((await exp('tasks', '?status=FAILED')).body)).toHaveLength(0);
    const a = jsonl((await exp('alerts', '?threshold=80')).body);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ budgetName: 'Global', spendUsd: '0.800000000000', limitUsd: '1.000000000000', threshold: 80 });
    expect(jsonl((await exp('alerts', '?threshold=50')).body)).toHaveLength(0);
  });

  it('CSV escapes quotes/commas/newlines and guards against formula injection', async () => {
    const act = parseCsv((await exp('activity', '?format=csv')).body);
    const header = act[0];
    const msgIdx = header.indexOf('message');
    const messages = act.slice(1).map(r => r[msgIdx]);
    expect(messages).toContain("'@cmd|evil"); // guarded
    expect(messages).toContain('line1\nline2'); // newline survives quoting
    const mem = parseCsv((await exp('memory', '?format=csv')).body);
    const em = mem[0].indexOf('errorMessage');
    expect(mem.slice(1).map(r => r[em])).toContain(`'=HYPERLINK("http://evil","x")`);
    for (const row of [...act.slice(1), ...mem.slice(1)]) for (const cell of row) expect(cell).not.toMatch(/^[=+@]/);
    const tools = parseCsv((await exp('tools', '?format=csv')).body);
    expect(tools[1][tools[0].indexOf('toolName')]).toBe('tool, with "quotes"');
  });

  it('exported JSONL contains no raw content (only redacted markers)', async () => {
    await ctx.deps.instr.log({ level: 'INFO', eventType: 'x', category: 'SYSTEM', operation: 'priv', status: 'INFO', source: 'ACTUAL', message: 'm', attributes: { prompt: 'RAW-PROMPT-VALUE' } });
    const out = (await exp('logs', '?search=priv')).body as string;
    expect(out).not.toContain('RAW-PROMPT-VALUE');
    expect(out).toContain('sha256_8');
  });

  it('streams large exports in batches (> 500 rows, ordered newest first, no duplicates)', async () => {
    const rows = Array.from({ length: 1300 }, (_, k) => ({
      level: 'INFO', eventType: 'bulk.event', category: 'SYSTEM', operation: `bulk.${k}`, status: 'INFO', source: 'SIMULATED', message: `bulk ${k}`,
      ts: new Date(Date.UTC(2025, 0, 1) + k * 1000), attributes: '{}',
    }));
    await ctx.prisma.executionLog.createMany({ data: rows });
    const jl = jsonl((await exp('logs', '?eventType=bulk.event')).body);
    expect(jl).toHaveLength(1300);
    expect(new Set(jl.map(l => l.id)).size).toBe(1300);
    expect(jl[0].operation).toBe('bulk.1299');
    expect(jl[1299].operation).toBe('bulk.0');
    const csv = parseCsv((await exp('logs', '?eventType=bulk.event&format=csv')).body);
    expect(csv.length).toBe(1301);
  });

  it('returns 404 for unknown datasets, 400 for bad format or filters (before any download headers)', async () => {
    const nf = await request(ctx.app).get('/api/export/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
    expect((await request(ctx.app).get('/api/export/constructor')).status).toBe(404);
    const bf = await request(ctx.app).get('/api/export/logs?format=xml');
    expect(bf.status).toBe(400);
    expect(bf.headers['content-disposition']).toBeUndefined();
    expect((await request(ctx.app).get('/api/export/alerts?threshold=7')).status).toBe(400);
  });

  it('empty result still yields a valid file (CSV header only / empty JSONL)', async () => {
    const c = await exp('logs', '?format=csv&search=zzzz-none');
    expect(parseCsv(c.body)).toHaveLength(1);
    expect((await exp('logs', '?search=zzzz-none')).body).toBe('');
  });
});

describe('export row guard', () => {
  const smallApp = (maxExportRows: number) => {
    const app = express();
    app.use('/api', createLoggingRouter(ctx.deps, { maxExportRows }));
    app.use(errorHandler(ctx.deps.instr));
    return app;
  };
  const text = (app: express.Express, url: string) => request(app).get(url).buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', c => (d += c)); res.on('end', () => cb(null, d)); });

  it('rejects (400, no download headers) when the filter matches more rows than the cap', async () => {
    const total = await ctx.prisma.executionLog.count();
    expect(total).toBeGreaterThan(5);
    const res = await request(smallApp(5)).get('/api/export/logs');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toMatchObject({ maxRows: 5 });
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('limit=n exports the newest n rows (jsonl and csv) and sets X-Total-Rows; limit above the cap is rejected', async () => {
    const app = smallApp(5);
    const all = jsonl((await exp('logs')).body);
    const res = await text(app, '/api/export/logs?limit=3');
    expect(res.status).toBe(200);
    expect(res.headers['x-total-rows']).toBe('3');
    const rows = jsonl(res.body);
    expect(rows.map(r => r.id)).toEqual(all.slice(0, 3).map(r => r.id));
    const csv = parseCsv((await text(app, '/api/export/logs?limit=2&format=csv')).body);
    expect(csv).toHaveLength(3);
    expect((await request(app).get('/api/export/logs?limit=6')).status).toBe(400);
    expect((await request(app).get('/api/export/logs?limit=0')).status).toBe(400);
  });

  it('filters that stay under the cap export normally; limit larger than the match count is fine', async () => {
    const app = smallApp(5);
    const res = await text(app, '/api/export/tasks');
    expect(res.status).toBe(200);
    expect(jsonl(res.body)).toHaveLength(1);
    expect(jsonl((await text(app, '/api/export/tasks?limit=5')).body)).toHaveLength(1);
  });

  it('eventType filter list is capped at 20 values', async () => {
    const many = Array.from({ length: 21 }, (_, k) => `e${k}`).join(',');
    expect((await request(ctx.app).get(`/api/logs?eventType=${many}`)).status).toBe(400);
    expect((await request(ctx.app).get('/api/export/logs?eventType=' + many)).status).toBe(400);
  });
});
