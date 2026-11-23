import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonlWriter, flushLogs, maxDirBytesFromEnv, createInstrumentation, DEFAULT_MAX_DIR_BYTES, JSONL_FILE_RE } from '../../src/modules/instrumentation';
import type { ExecutionLogDto } from '../../../shared/types';
import { createTestApp, cleanupTestDir } from '../helpers/testApp';
import { readJsonl, sleep } from './util';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-t-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const today = () => new Date().toISOString();
const dto = (id: string, over: Partial<ExecutionLogDto> = {}): ExecutionLogDto => ({
  id, ts: today(), level: 'INFO', eventType: 'e', category: 'SYSTEM', operation: 'o', status: 'INFO', source: 'ACTUAL', traceId: null, spanId: null,
  requestId: null, projectId: null, durationMs: null, message: 'm', attributes: {}, errorCategory: null, errorMessage: null, stack: null, ...over,
});
const lineBytes = (d: ExecutionLogDto) => Buffer.byteLength(JSON.stringify(d)) + 1;
const files = (dir: string) => fs.readdirSync(dir).filter(f => JSONL_FILE_RE.test(f)).sort();

describe('buffered async appends + flushLogs()', () => {
  it('buffers lines (not on disk immediately), batches them in order, and flushLogs() forces them out', async () => {
    const dir = tmp();
    const w = createJsonlWriter(dir, { flushIntervalMs: 10_000 });
    for (let i = 0; i < 25; i++) await w.append(dto(`b${i}`));
    expect(files(dir)).toHaveLength(0); // still buffered
    await flushLogs();
    const ids = readJsonl(dir).map(l => l.id);
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => `b${i}`));
    await flushLogs(); // idempotent, nothing pending
    expect(readJsonl(dir)).toHaveLength(25);
  });

  it('flushes by itself within the flush interval', async () => {
    const dir = tmp();
    const w = createJsonlWriter(dir, { flushIntervalMs: 40 });
    await w.append(dto('t1')); await w.append(dto('t2'));
    expect(files(dir)).toHaveLength(0);
    await sleep(250);
    expect(readJsonl(dir).map(l => l.id)).toEqual(['t1', 't2']);
  });

  it('flushLogs() covers every live writer; flush() resolves after in-flight writes', async () => {
    const [a, b] = [tmp(), tmp()];
    const wa = createJsonlWriter(a, { flushIntervalMs: 10_000 });
    const wb = createJsonlWriter(b, { flushIntervalMs: 10_000 });
    await wa.append(dto('a1')); await wb.append(dto('b1'));
    await Promise.all([flushLogs(), flushLogs()]);
    expect(readJsonl(a)).toHaveLength(1);
    expect(readJsonl(b)).toHaveLength(1);
  });

  it('flushSync() (process-exit path) writes whatever is buffered', async () => {
    const dir = tmp();
    const w = createJsonlWriter(dir, { flushIntervalMs: 10_000 });
    await w.append(dto('s1'));
    w.flushSync();
    expect(readJsonl(dir).map(l => l.id)).toEqual(['s1']);
    await flushLogs();
    expect(readJsonl(dir)).toHaveLength(1); // not duplicated
  });

  it('instrumentation in buffered mode: DB rows are immediate, JSONL is complete after flushLogs()', async () => {
    const ctx = await createTestApp();
    try {
      const logDir = path.join(ctx.dir, 'buffered-logs');
      const instr = createInstrumentation(ctx.prisma, { logDir, jsonlFlushMs: 10_000 });
      for (let i = 0; i < 20; i++) await instr.log({ level: 'INFO', eventType: 'buf', category: 'SYSTEM', operation: `buf.${i}`, status: 'INFO', source: 'ACTUAL', message: 'm' });
      expect(await ctx.prisma.executionLog.count({ where: { eventType: 'buf' } })).toBe(20);
      expect(readJsonl(logDir)).toHaveLength(0);
      await flushLogs();
      expect(readJsonl(logDir).map(l => l.operation)).toEqual(Array.from({ length: 20 }, (_, i) => `buf.${i}`));
    } finally { await ctx.close(); cleanupTestDir(ctx.dir); }
  });

  it('write failures in buffered mode are reported via onError and never reject', async () => {
    const dir = tmp();
    const blocker = path.join(dir, 'file'); fs.writeFileSync(blocker, 'x');
    const errs: string[] = [];
    const w = createJsonlWriter(path.join(blocker, 'logs'), { flushIntervalMs: 10_000, onError: (_e, c) => errs.push(c) });
    await w.append(dto('f1'));
    await expect(flushLogs()).resolves.toBeUndefined();
    expect(errs).toContain('jsonl.append');
  });
});

describe('total JSONL directory cap', () => {
  const seedOld = (dir: string, days: string[], bytes = 800) => {
    for (const d of days) fs.writeFileSync(path.join(dir, `execution-${d}.jsonl`), JSON.stringify({ id: `old-${d}`, pad: 'x'.repeat(bytes - 30) }).padEnd(bytes - 1, ' ') + '\n');
  };

  it('maxDirBytesFromEnv reads LOG_DIR_MAX_MB, default 500MB', () => {
    expect(DEFAULT_MAX_DIR_BYTES).toBe(500 * 1024 * 1024);
    expect(maxDirBytesFromEnv({})).toBe(500 * 1024 * 1024);
    expect(maxDirBytesFromEnv({ LOG_DIR_MAX_MB: '2' } as NodeJS.ProcessEnv)).toBe(2 * 1024 * 1024);
    expect(maxDirBytesFromEnv({ LOG_DIR_MAX_MB: '0' } as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_DIR_BYTES);
    expect(maxDirBytesFromEnv({ LOG_DIR_MAX_MB: 'abc' } as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_DIR_BYTES);
  });

  it('drops the OLDEST day files first to make room, keeps newer files and today', async () => {
    const dir = tmp();
    seedOld(dir, ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']); // 4000 bytes
    const errs: string[] = [];
    const w = createJsonlWriter(dir, { maxDirBytes: 3000, flushIntervalMs: 0, rescanMinMs: 0, onError: (_e, c) => errs.push(c) });
    const d = dto('new');
    await w.append(d);
    const f = files(dir);
    expect(f).not.toContain('execution-2026-01-01.jsonl');
    expect(f).not.toContain('execution-2026-01-02.jsonl');
    expect(f).toContain('execution-2026-01-05.jsonl'); // newest old file survives
    expect(f).toContain(`execution-${today().slice(0, 10)}.jsonl`);
    const total = f.reduce((n, x) => n + fs.statSync(path.join(dir, x)).size, 0);
    expect(total).toBeLessThanOrEqual(3000);
    expect(readJsonl(dir).some(l => l.id === 'new')).toBe(true);
    expect(errs).toEqual(['jsonl.dirCap']); // a single report for the drop
  });

  it('when only protected files remain, appends are suspended with ONE warning (not per event), then resume when space frees', async () => {
    const dir = tmp();
    const errs: string[] = [];
    const sample = dto('x0');
    const per = lineBytes(sample);
    const w = createJsonlWriter(dir, { maxDirBytes: per * 5 + 10, flushIntervalMs: 0, rescanMinMs: 0, onError: (_e, c) => errs.push(c) });
    for (let i = 0; i < 40; i++) await w.append(dto(`x${i}`)); // same size lines
    expect(readJsonl(dir).length).toBe(5); // first 5 kept, rest dropped
    expect(readJsonl(dir).map(l => l.id)).toEqual(['x0', 'x1', 'x2', 'x3', 'x4']);
    expect(errs.filter(e => e === 'jsonl.dirCap')).toHaveLength(1); // single warning for 35 suppressed events
    // free the space (retention / operator) -> appends resume
    for (const f of files(dir)) fs.unlinkSync(path.join(dir, f));
    await w.append(dto('after-free'));
    expect(readJsonl(dir).map(l => l.id)).toEqual(['after-free']);
    expect(errs.filter(e => e === 'jsonl.dirCap')).toHaveLength(1); // no new warning on resume
    // a NEW capped episode warns again
    for (let i = 0; i < 10; i++) await w.append(dto(`y${i}`));
    expect(errs.filter(e => e === 'jsonl.dirCap')).toHaveLength(2);
  });

  it('instrumentation keeps writing DB rows while the JSONL cap suspends file appends', async () => {
    const ctx = await createTestApp();
    try {
      const logDir = path.join(ctx.dir, 'cap-logs');
      const errs: string[] = [];
      const instr = createInstrumentation(ctx.prisma, { logDir, maxLogDirBytes: 1500, onError: (_e, c) => errs.push(c) });
      for (let i = 0; i < 30; i++) await instr.log({ level: 'INFO', eventType: 'cap', category: 'SYSTEM', operation: `cap.${i}`, status: 'INFO', source: 'ACTUAL', message: 'm' });
      expect(await ctx.prisma.executionLog.count({ where: { eventType: 'cap' } })).toBe(30);
      const size = files(logDir).reduce((n, f) => n + fs.statSync(path.join(logDir, f)).size, 0);
      expect(size).toBeLessThanOrEqual(1500);
      expect(errs.filter(e => e === 'jsonl.dirCap')).toHaveLength(1);
    } finally { await ctx.close(); cleanupTestDir(ctx.dir); }
  });
});
