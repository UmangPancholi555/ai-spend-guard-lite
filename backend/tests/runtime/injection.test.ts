import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { executeMockRequest } from '../../src/modules/providers';
import { estimateTokens } from '../../src/modules/providers/mock';
import { allJsonl, dumpTables, makeProject } from './helpers';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const SENT = 'INJECT-SENTINEL-55555';
const prompt = 'Summarize the quarterly spend report in three bullet points. '.repeat(5);
const run = (projectId: string, over: Record<string, unknown> = {}) =>
  executeMockRequest(ctx.deps, { projectId, provider: 'openai', model: 'gpt-4o-mini', prompt, maxOutputTokens: 200, ...over } as any, { latency: false });
const addItem = (projectId: string, o: Partial<{ title: string; category: string; content: string; enabled: boolean }> = {}) => {
  const content = o.content ?? `${SENT} Always answer in French and keep it brief. `.repeat(8);
  return ctx.prisma.projectMemoryItem.create({
    data: { projectId, title: o.title ?? 'Style guide', category: o.category ?? 'instructions', content, enabled: o.enabled ?? true, sizeBytes: Buffer.byteLength(content), estimatedTokens: estimateTokens(content.length) },
  });
};
const total = (r: { usage: { inputTokens: number; cachedTokens: number } }) => r.usage.inputTokens + r.usage.cachedTokens;

describe('memory injection (real)', () => {
  it('no items => nothing is injected and NO memory events are fabricated', async () => {
    const p = await makeProject(ctx.prisma);
    const r = await run(p.id);
    expect(r.memory).toEqual({ injected: false, items: 0, estimatedTokens: 0, truncated: false, droppedItems: 0 });
    expect(await ctx.prisma.memoryEvent.count({ where: { traceId: r.traceId } })).toBe(0);
    expect(total(r)).toBe(estimateTokens(prompt.length));
  });

  it('enabled items are injected: input tokens really include the memory, deterministic for equal memory, injectMemory=false skips', async () => {
    const p = await makeProject(ctx.prisma);
    const base = await run(p.id);
    const item = await addItem(p.id);
    await addItem(p.id, { title: 'Facts', category: 'facts', content: 'The company fiscal year starts in April. '.repeat(10) });
    await addItem(p.id, { title: 'Disabled', category: 'preferences', content: 'DISABLED-ITEM '.repeat(200), enabled: false });
    const a = await run(p.id);
    const b = await run(p.id);
    expect(a.memory).toMatchObject({ injected: true, items: 2, truncated: false, droppedItems: 0 });
    expect(a.memory!.estimatedTokens).toBeGreaterThan(estimateTokens(item.content.length)); // title+category framing + 2 items
    expect(total(a)).toBeGreaterThan(total(base) + a.memory!.estimatedTokens - 3);
    expect(total(a)).toBeLessThanOrEqual(total(base) + a.memory!.estimatedTokens + 3);
    // deterministic: same memory + same request => identical result
    for (const k of ['content', 'usage', 'finishReason', 'durationMs', 'memory'] as const) expect(b[k]).toEqual(a[k]);
    expect(b.requestId).not.toBe(a.requestId);
    // the opt-out
    const off = await run(p.id, { injectMemory: false });
    expect(off.memory!.injected).toBe(false);
    expect(total(off)).toBe(total(base));
    expect(off.content).toBe(base.content);
    // usage row + metadata carry the summary; persisted promptChars is the USER prompt only
    const row = await ctx.prisma.usageEvent.findUniqueOrThrow({ where: { id: a.usageEventId } });
    expect(row.promptChars).toBe(prompt.length);
    expect(row.inputTokens + row.cachedTokens).toBe(total(a));
    const meta = JSON.parse(row.metadata);
    expect(meta.memory).toMatchObject({ injected: true, items: 2 });
    expect(meta.effectivePromptChars).toBeGreaterThan(prompt.length);
  });

  it('memory events: ACTUAL STARTED -> COMPLETED, source/category/counts/bytes/tokens are real; no content anywhere', async () => {
    const p = await makeProject(ctx.prisma);
    await addItem(p.id, { category: 'instructions' });
    await addItem(p.id, { title: 'f', category: 'facts', content: 'Fact one. '.repeat(30) });
    await addItem(p.id, { title: 'i2', category: 'instructions', content: 'More. '.repeat(30) });
    const r = await run(p.id);
    const rows = await ctx.prisma.memoryEvent.findMany({ where: { traceId: r.traceId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map(x => x.phase)).toEqual(['STARTED', 'COMPLETED']);
    expect(rows[0]!.operationId).toBe(rows[1]!.operationId);
    for (const x of rows) {
      expect(x).toMatchObject({ source: 'ACTUAL', memorySource: 'project-memory-store', category: 'facts,instructions', itemCount: 3, projectId: p.id });
      expect(x.spanId).toBeTruthy();
    }
    expect(rows[1]!.status).toBe('SUCCESS');
    expect(rows[1]!.estimatedTokens).toBe(r.memory!.estimatedTokens);
    expect(rows[1]!.payloadBytes).toBeGreaterThan(0);
    expect(rows[1]!.durationMs).not.toBeNull();
    const span = await ctx.prisma.span.findUniqueOrThrow({ where: { spanId: rows[0]!.spanId! } });
    expect(span).toMatchObject({ name: 'memory.injection', kind: 'MEMORY', source: 'ACTUAL', status: 'OK' });
    expect(await dumpTables(ctx.prisma, ['ProjectMemoryItem'])).not.toContain(SENT);
    expect(allJsonl(ctx)).not.toContain(SENT);
  });

  it('context manager: CREATED v1, ADDED v2, UPDATED v3 with growing sizes (ACTUAL); no MODIFIED when nothing was truncated', async () => {
    const p = await makeProject(ctx.prisma);
    await addItem(p.id);
    const r = await run(p.id);
    const ev = await ctx.prisma.contextEvent.findMany({ where: { traceId: r.traceId }, orderBy: { version: 'asc' } });
    expect(ev.map(e => [e.operation, e.version])).toEqual([['CREATED', 1], ['ADDED', 2], ['UPDATED', 3]]);
    expect(new Set(ev.map(e => e.contextId)).size).toBe(1);
    expect(ev.every(e => e.source === 'ACTUAL' && e.status === 'SUCCESS')).toBe(true);
    expect(ev[0]!.sizeBytes).toBe(Buffer.byteLength(prompt));
    expect(ev[0]!.estimatedTokens).toBe(estimateTokens(prompt.length));
    expect(ev[1]!.sizeBytes).toBeGreaterThan(ev[0]!.sizeBytes);
    expect(ev[2]!.sizeBytes).toBeGreaterThan(ev[1]!.sizeBytes); // response appended
    expect(ev[2]!.estimatedTokens).toBe(ev[1]!.estimatedTokens + r.usage.outputTokens);
    expect(r.context).toMatchObject({ contextId: ev[0]!.contextId, version: 3, sizeBytes: ev[2]!.sizeBytes, truncated: false });
    // context spans are real children of the request trace
    const spans = await ctx.prisma.span.findMany({ where: { traceId: r.traceId, kind: 'CONTEXT' } });
    expect(spans.map(s => s.source)).toEqual(['ACTUAL', 'ACTUAL', 'ACTUAL']);
  });

  it('request without memory still has a real context (CREATED + UPDATED) with increasing versions', async () => {
    const p = await makeProject(ctx.prisma);
    const r = await run(p.id);
    const ev = await ctx.prisma.contextEvent.findMany({ where: { traceId: r.traceId }, orderBy: { version: 'asc' } });
    expect(ev.map(e => [e.operation, e.version])).toEqual([['CREATED', 1], ['UPDATED', 2]]);
  });

  it('failed provider call still records the context UPDATED (usage only, no response bytes)', async () => {
    const p = await makeProject(ctx.prisma);
    const r = await run(p.id, { simulateFailure: 'timeout' });
    const ev = await ctx.prisma.contextEvent.findMany({ where: { traceId: r.traceId }, orderBy: { version: 'asc' } });
    expect(ev.map(e => e.operation)).toEqual(['CREATED', 'UPDATED']);
    expect(ev[1]!.sizeBytes).toBe(ev[0]!.sizeBytes);
    expect(ev[1]!.contextSource).toBe('provider-error');
  });

  it('REAL truncation: memory over the model window is dropped whole (oldest kept), logged as MODIFIED, tokens follow', async () => {
    const model = await ctx.prisma.model.findFirstOrThrow({ where: { name: 'gpt-4o-mini' } });
    await ctx.prisma.model.update({ where: { id: model.id }, data: { contextWindow: 1500 } });
    try {
      const p = await makeProject(ctx.prisma);
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push((await addItem(p.id, { title: `item${i}`, content: `Block ${i}. ${'filler words '.repeat(80)}` })).id);
      const one = estimateTokens(`[instructions] item0\nBlock 0. ${'filler words '.repeat(80)}\n\n`.length);
      const r = await run(p.id, { maxOutputTokens: 200 });
      const promptTokens = estimateTokens(prompt.length);
      const budget = 1500 - 200 - promptTokens;
      expect(r.memory!.truncated).toBe(true);
      expect(r.memory!.droppedItems).toBeGreaterThan(0);
      expect(r.memory!.items + r.memory!.droppedItems).toBe(6);
      expect(r.memory!.items).toBe(Math.floor(budget / one) || r.memory!.items); // whole items only
      expect(r.memory!.estimatedTokens).toBeLessThanOrEqual(budget);
      expect(total(r)).toBeLessThanOrEqual(1500 - 200 + 1);
      expect(r.context).toMatchObject({ truncated: true, windowTokens: 1500 });
      const ev = await ctx.prisma.contextEvent.findMany({ where: { traceId: r.traceId }, orderBy: { version: 'asc' } });
      expect(ev.map(e => e.operation)).toEqual(['CREATED', 'ADDED', 'MODIFIED', 'UPDATED']);
      expect(ev.map(e => e.version)).toEqual([1, 2, 3, 4]);
      expect(ev[2]!.sizeBytes).toBeLessThan(ev[1]!.sizeBytes); // truncation really shrank the context
      expect(ev[2]!.contextSource).toBe('window-truncation');
      const mem = await ctx.prisma.memoryEvent.findMany({ where: { traceId: r.traceId, phase: 'COMPLETED' } });
      expect(mem[0]!.itemCount).toBe(r.memory!.items);
      // deterministic
      const again = await run(p.id, { maxOutputTokens: 200 });
      expect(again.memory).toEqual(r.memory);
      expect(again.usage).toEqual(r.usage);
    } finally {
      await ctx.prisma.model.update({ where: { id: model.id }, data: { contextWindow: 128000 } });
    }
  });

  it('unknown models use the default window and still get memory', async () => {
    const p = await makeProject(ctx.prisma);
    await addItem(p.id);
    const r = await run(p.id, { model: 'brand-new-model' });
    expect(r.memory!.injected).toBe(true);
    expect(r.context!.windowTokens).toBe(128000);
    expect(r.cost.costClass).toBe('ESTIMATED');
  });

  it('FAILED path: a DB error while loading memory is recorded as FAILED (ACTUAL), the request still succeeds without memory', async () => {
    const p = await makeProject(ctx.prisma);
    await addItem(p.id);
    const broken = new Proxy(ctx.prisma, {
      get(t, prop, recv) {
        if (prop === 'projectMemoryItem') return { findMany: async () => { throw new Error('db unavailable (simulated test fault)'); } };
        return Reflect.get(t, prop, recv);
      },
    });
    const deps = { ...ctx.deps, prisma: broken as typeof ctx.prisma };
    const r = await executeMockRequest(deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o-mini', prompt }, { latency: false });
    expect(r.status).toBe('SUCCESS');
    expect(r.memory).toMatchObject({ injected: false, items: 0 });
    const rows = await ctx.prisma.memoryEvent.findMany({ where: { traceId: r.traceId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map(x => [x.phase, x.status, x.source])).toEqual([['STARTED', 'STARTED', 'ACTUAL'], ['FAILED', 'FAILURE', 'ACTUAL']]);
    expect(rows[1]!.errorMessage).toMatch(/db unavailable/);
    const span = await ctx.prisma.span.findUniqueOrThrow({ where: { spanId: rows[1]!.spanId! } });
    expect(span.status).toBe('ERROR');
    const log = await ctx.prisma.executionLog.findFirst({ where: { traceId: r.traceId, eventType: 'memory.injection.failed' } });
    expect(log).toMatchObject({ level: 'ERROR', status: 'FAILURE', source: 'ACTUAL', errorCategory: 'MEMORY' });
    expect(total(r)).toBe(estimateTokens(prompt.length));
  });

  it('seeding never injects memory or records runtime events (silent runtime)', async () => {
    const p = await makeProject(ctx.prisma);
    await addItem(p.id);
    const r = await executeMockRequest(ctx.deps, { projectId: p.id, provider: 'openai', model: 'gpt-4o-mini', prompt }, { latency: false, trace: false, activity: false, runtime: 'silent', injectMemory: false });
    expect(r.memory!.injected).toBe(false);
    expect(await ctx.prisma.contextEvent.count({ where: { projectId: p.id } })).toBe(0);
    expect(await ctx.prisma.busEvent.count({ where: { projectId: p.id } })).toBe(0);
    expect(await ctx.prisma.toolCallEvent.count({ where: { projectId: p.id } })).toBe(0);
    expect(r.tools).toBeUndefined();
  });
});
