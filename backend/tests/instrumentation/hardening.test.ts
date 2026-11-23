import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { createInstrumentation, createJsonlWriter, toJsonlLine, JSONL_FILE_RE } from '../../src/modules/instrumentation';
import type { ExecutionLogDto } from '../../../shared/types';
import { readJsonl } from './util';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const dto = (over: Partial<ExecutionLogDto> = {}): ExecutionLogDto => ({
  id: 'x', ts: '2026-04-01T10:00:00.000Z', level: 'INFO', eventType: 'e', category: 'SYSTEM', operation: 'o', status: 'INFO', source: 'ACTUAL',
  traceId: null, spanId: null, requestId: null, projectId: null, durationMs: null, message: 'm', attributes: {}, errorCategory: null,
  errorMessage: null, stack: null, ...over,
});

describe('log injection hardening', () => {
  it('toJsonlLine is always exactly one physical line (CR/LF, ANSI, U+2028/2029/0085, NUL)', () => {
    const nasty = 'a\nb\r\nc\u001b[31mred\u001b[0m\u2028d\u2029e\u0085f\u0000g {"forged":true}\n';
    const line = toJsonlLine(dto({ message: nasty, attributes: { k: nasty }, stack: nasty }));
    expect(line.endsWith('\n')).toBe(true);
    const body = line.slice(0, -1);
    expect(body).not.toMatch(/[\n\r\u001b\u2028\u2029\u0085\u0000]/);
    expect(JSON.parse(body).message).toBe(nasty); // lossless once parsed
  });

  it('forged lines inside messages never become separate JSONL records; DB/JSONL text has no ANSI or control chars', async () => {
    const forged = 'ok\n{"id":"forged","eventType":"admin.login","level":"INFO"}\n';
    const ansi = '\u001b[31mALERT\u001b[0m\u001b]0;title\u0007 plain';
    const before = readJsonl(ctx.deps.config.logDir).length;
    await ctx.deps.instr.log({ level: 'INFO', eventType: 'inj.test', category: 'SYSTEM', operation: 'inj\nop', status: 'INFO', source: 'ACTUAL', message: forged, attributes: { note: ansi } });
    await ctx.deps.instr.recordError({ source: 'ACTUAL', category: 'INTERNAL', operation: 'inj.err', error: new Error(ansi + forged) });
    await ctx.deps.instr.recordActivity({ type: 'inj.act', message: ansi, source: 'ACTUAL', metadata: { x: forged } });
    const rawFiles = fs.readdirSync(ctx.deps.config.logDir).filter(f => f.endsWith('.jsonl'));
    const raw = rawFiles.map(f => fs.readFileSync(path.join(ctx.deps.config.logDir, f), 'utf8')).join('');
    expect(raw).not.toMatch(/[\u001b\u2028\u2029]/);
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(before + 3);
    const parsed = lines.map(l => JSON.parse(l) as ExecutionLogDto);
    expect(parsed.some(l => l.id === 'forged' || l.eventType === 'admin.login')).toBe(false);
    const rows = await ctx.prisma.executionLog.findMany({ where: { OR: [{ eventType: 'inj.test' }, { operation: 'inj.err' }, { operation: 'inj.act' }] } });
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/\\u001b|\u001b|\\u0007/);
    expect(rows.find(r => r.eventType === 'inj.test')!.operation).toBe('inj op'); // newlines collapsed in operation names (single-line field)
  });
});

describe('JSONL rotation / size cap', () => {
  it('rolls over to execution-<day>.<n>.jsonl, never exceeds the cap (except one oversized line), loses no lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-rot-'));
    try {
      const w = createJsonlWriter(dir, { maxFileBytes: 2000, flushIntervalMs: 0 });
      for (let i = 0; i < 40; i++) await w.append(dto({ id: `id${i}`, message: 'x'.repeat(100) }));
      await w.append(dto({ id: 'huge', message: 'y'.repeat(5000) })); // larger than the cap by itself
      await w.append(dto({ id: 'next-day', ts: '2026-04-02T00:00:01.000Z' }));
      const files = fs.readdirSync(dir).sort();
      expect(files.length).toBeGreaterThan(4);
      expect(files.every(f => JSONL_FILE_RE.test(f))).toBe(true);
      expect(files).toContain('execution-2026-04-01.jsonl');
      expect(files).toContain('execution-2026-04-01.1.jsonl');
      expect(files).toContain('execution-2026-04-02.jsonl');
      let total = 0;
      for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const lines = text.split('\n').filter(Boolean);
        total += lines.length;
        lines.forEach(l => JSON.parse(l));
        if (!lines.some(l => l.includes('"id":"huge"'))) expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2000);
      }
      expect(total).toBe(42);
      // a new writer (restart) continues without exceeding the cap or losing data
      await createJsonlWriter(dir, { maxFileBytes: 2000, flushIntervalMs: 0 }).append(dto({ id: 'after-restart' }));
      expect(fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('')).toContain('after-restart');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('instrumentation honours maxLogFileBytes', async () => {
    const dir = path.join(ctx.dir, 'rot-logs');
    const instr = createInstrumentation(ctx.prisma, { logDir: dir, maxLogFileBytes: 1500 });
    for (let i = 0; i < 15; i++) await instr.log({ level: 'INFO', eventType: 'rot', category: 'SYSTEM', operation: `rot.${i}`, status: 'INFO', source: 'ACTUAL', message: 'm'.repeat(200) });
    const files = fs.readdirSync(dir);
    expect(files.length).toBeGreaterThan(2);
    expect(readJsonl(dir)).toHaveLength(15);
  });
});

describe('console error surfacing is rate limited', () => {
  const brokenDb = () => new Proxy(ctx.prisma, {
    get(t, prop, r) {
      if (prop === 'executionLog') return { create: async () => { throw new Error('db down'); } };
      return Reflect.get(t, prop, r);
    },
  });
  const logOne = (instr: ReturnType<typeof createInstrumentation>) =>
    instr.log({ level: 'INFO', eventType: 'x', category: 'SYSTEM', operation: 'o', status: 'INFO', source: 'ACTUAL', message: 'm' });

  it('prints once per context per window with a suppressed count, while onError fires every time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const instr = createInstrumentation(brokenDb(), { logDir: path.join(ctx.dir, 'rl-logs'), consoleErrors: true, errorLogIntervalMs: 10_000, onError: (_e, c) => seen.push(c) });
    for (let i = 0; i < 5; i++) await logOne(instr);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/executionLog\.create failed: db down/);
    expect(seen).toHaveLength(5);
    vi.setSystemTime(new Date('2026-05-01T00:00:11Z'));
    await logOne(instr);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toMatch(/\+4 similar suppressed/);
    expect(seen).toHaveLength(6);
  });

  it('is silent by default under test (VITEST) but still calls onError', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const instr = createInstrumentation(brokenDb(), { logDir: path.join(ctx.dir, 'rl2-logs'), onError: (_e, c) => seen.push(c) });
    await logOne(instr);
    expect(spy).not.toHaveBeenCalled();
    expect(seen).toEqual(['executionLog.create']);
  });

  it('a throwing onError hook never breaks instrumentation', async () => {
    const instr = createInstrumentation(brokenDb(), { logDir: path.join(ctx.dir, 'rl3-logs'), onError: () => { throw new Error('hook bug'); } });
    await expect(logOne(instr)).resolves.toBeUndefined();
  });
});
