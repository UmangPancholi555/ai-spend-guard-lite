import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionLogDto } from '../../../../shared/types';
import { safeStringify } from '../../utils/serialize';

/** `execution-YYYY-MM-DD.jsonl`, or `execution-YYYY-MM-DD.N.jsonl` for size-rollover files (N >= 1). Group 1 = date, group 2 = index. */
export const JSONL_FILE_RE = /^execution-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_DIR_BYTES = 500 * 1024 * 1024;
export const DEFAULT_FLUSH_MS = 250;
const MAX_BATCH_BYTES = 1024 * 1024; // flush immediately once this much is buffered
const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // hard bound: beyond this new lines are dropped (and reported once) instead of growing memory
const RESCAN_MIN_MS = 5000;

export function jsonlFileName(ts: Date, index = 0): string {
  const day = ts.toISOString().slice(0, 10);
  return index > 0 ? `execution-${day}.${index}.jsonl` : `execution-${day}.jsonl`;
}
const fileName = (day: string, index: number) => (index > 0 ? `execution-${day}.${index}.jsonl` : `execution-${day}.jsonl`);

/** Total JSONL directory cap from env LOG_DIR_MAX_MB (default 500MB). */
export function maxDirBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.LOG_DIR_MAX_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : DEFAULT_MAX_DIR_BYTES;
}

/**
 * Serialize one ExecutionLogDto as exactly ONE physical line: JSON.stringify escapes CR/LF/ANSI ESC and every other C0 control char
 * (\u000a, \u001b ...); we additionally escape U+2028/U+2029/U+0085, which are legal inside JSON strings but treated as line breaks
 * by some JS/log tooling. A log message can therefore never inject a forged JSONL line.
 */
export function toJsonlLine(dto: ExecutionLogDto): string {
  const json = (safeStringify(dto) ?? '{}')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029').replace(/\u0085/g, '\\u0085');
  return `${json}\n`;
}

export interface JsonlWriterOptions {
  maxFileBytes?: number;
  /** Cap on the TOTAL size of all execution-*.jsonl files in the directory (default 500MB). */
  maxDirBytes?: number;
  /**
   * Buffered mode: lines are queued and written asynchronously in batches at most this many ms later (default 250).
   * 0 = unbuffered: append() resolves only after the line is on disk (default under tests so read-after-write holds).
   */
  flushIntervalMs?: number;
  /** Min ms between full directory rescans while enforcing the directory cap (default 5000; tests lower it). */
  rescanMinMs?: number;
  /** Called for I/O failures and cap events (context: 'jsonl.append' | 'jsonl.dirCap' | 'jsonl.overflow'). Never throws into the writer. */
  onError?: (error: unknown, context: string) => void;
}
export interface JsonlWriter {
  /** Queue (buffered) or write (unbuffered) one line. Never rejects. In unbuffered mode resolves after the write. */
  append(dto: ExecutionLogDto): Promise<void>;
  /** Write everything buffered so far; resolves when on disk. Never rejects. */
  flush(): Promise<void>;
  /** Synchronous best-effort flush (used on process exit). */
  flushSync(): void;
}

interface Item { day: string; line: string; bytes: number }

// ---- process-wide registry so server shutdown can flush every live writer
const live = new Set<JsonlWriter>();
let exitHooked = false;
/** Flush every JSONL writer that has buffered or in-flight lines. Call on graceful shutdown (server.ts). Never rejects. */
export async function flushLogs(): Promise<void> {
  await Promise.all([...live].map(w => w.flush()));
}
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => { for (const w of live) { try { w.flushSync(); } catch { /* ignore */ } } });
}

/**
 * JSONL appender with
 *  - per-file size cap: rolls over to `execution-<day>.<n>.jsonl` (one oversized line still goes to a fresh file),
 *  - total directory cap: when over `maxDirBytes` the OLDEST day files are deleted first (never today's / files being written);
 *    if still over, appending is suspended with ONE warning (resumes automatically once space is available again),
 *  - buffered async batching (flush <= flushIntervalMs, order preserved) or unbuffered mode for tests.
 * DB rows remain the source of truth, so dropped/suspended JSONL lines never lose data.
 */
export function createJsonlWriter(logDir: string, opts: JsonlWriterOptions = {}): JsonlWriter {
  const maxFile = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxDir = opts.maxDirBytes ?? DEFAULT_MAX_DIR_BYTES;
  const interval = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  const report = (e: unknown, ctx: string) => { try { opts.onError?.(e, ctx); } catch { /* ignore */ } };

  let buffer: Item[] = [];
  let bufferedBytes = 0;
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let inflight = 0;
  let overflowReported = false;
  // disk state
  const sizes = new Map<string, number>(); // file name -> bytes (known execution-*.jsonl files)
  let dirBytes = 0;
  let scanned = false;
  let lastScan = 0;
  const idx = new Map<string, number>(); // day -> current rollover index
  let capped = false;

  async function scan() {
    lastScan = Date.now();
    sizes.clear(); dirBytes = 0;
    let names: string[] = [];
    try { names = await fs.promises.readdir(logDir); } catch { names = []; }
    for (const n of names) {
      if (!JSONL_FILE_RE.test(n)) continue;
      try { const s = await fs.promises.stat(path.join(logDir, n)); sizes.set(n, s.size); dirBytes += s.size; } catch { /* vanished */ }
    }
    scanned = true;
  }
  const order = (n: string) => { const m = JSONL_FILE_RE.exec(n)!; return `${m[1]}.${String(Number(m[2] ?? 0)).padStart(8, '0')}`; };

  /** make room for `bytes` by deleting the oldest day files (never `protect`ed ones or files of today/future days). */
  async function makeRoom(bytes: number, protect: Set<string>) {
    if (Date.now() - lastScan >= (opts.rescanMinMs ?? RESCAN_MIN_MS)) await scan(); // files may have been pruned/removed externally
    if (dirBytes + bytes <= maxDir) return;
    const today = new Date().toISOString().slice(0, 10);
    let dropped = 0;
    for (const f of [...sizes.keys()].sort((a, b) => order(a).localeCompare(order(b)))) {
      if (dirBytes + bytes <= maxDir) break;
      if (protect.has(f) || JSONL_FILE_RE.exec(f)![1] >= today) continue;
      try { await fs.promises.unlink(path.join(logDir, f)); } catch { /* already gone */ }
      dirBytes -= sizes.get(f) ?? 0; sizes.delete(f); dropped++;
    }
    if (dropped > 0) report(new Error(`log directory cap ${maxDir} bytes exceeded: dropped ${dropped} oldest JSONL file(s)`), 'jsonl.dirCap');
  }

  /** choose the target file for an item (or null when suspended by the directory cap). */
  async function pick(it: Item, protect: Set<string>): Promise<string | null> {
    let i = idx.get(it.day) ?? 0;
    let file = fileName(it.day, i);
    while ((sizes.get(file) ?? 0) > 0 && (sizes.get(file) ?? 0) + it.bytes > maxFile) { i++; file = fileName(it.day, i); }
    idx.set(it.day, i);
    protect.add(file);
    if (dirBytes + it.bytes > maxDir) {
      await makeRoom(it.bytes, protect);
      if (dirBytes + it.bytes > maxDir) {
        if (!capped) { capped = true; report(new Error(`log directory cap ${maxDir} bytes reached: JSONL appends suspended (DB logging continues)`), 'jsonl.dirCap'); }
        return null;
      }
    }
    if (capped) { capped = false; }
    return file;
  }

  async function writeFile(file: string, text: string) {
    const full = path.join(logDir, file);
    try {
      await fs.promises.appendFile(full, text, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await fs.promises.mkdir(logDir, { recursive: true });
      await fs.promises.appendFile(full, text, 'utf8');
    }
  }

  async function doFlush() {
    const batch = buffer; buffer = []; bufferedBytes = 0;
    if (batch.length === 0) return;
    try {
      if (!scanned) await scan();
      const protect = new Set<string>();
      const out = new Map<string, string[]>();
      for (const it of batch) {
        const file = await pick(it, protect);
        if (!file) continue;
        (out.get(file) ?? out.set(file, []).get(file)!).push(it.line);
        sizes.set(file, (sizes.get(file) ?? 0) + it.bytes);
        dirBytes += it.bytes;
      }
      for (const [file, lines] of out) {
        try { await writeFile(file, lines.join('')); }
        catch (e) { report(e, 'jsonl.append'); scanned = false; } // resync sizes after a failed write
      }
    } catch (e) { report(e, 'jsonl.append'); scanned = false; }
  }

  function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = undefined; }
    inflight++;
    live.add(writer);
    chain = chain.then(doFlush).catch(() => {}).finally(() => { if (--inflight === 0 && buffer.length === 0) live.delete(writer); });
    return chain;
  }

  function flushSync() {
    const batch = buffer; buffer = []; bufferedBytes = 0;
    const byFile = new Map<string, string[]>();
    for (const it of batch) {
      const file = fileName(it.day, idx.get(it.day) ?? 0);
      (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(it.line);
    }
    for (const [file, lines] of byFile) {
      try { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, file), lines.join(''), 'utf8'); } catch { /* exiting */ }
    }
  }

  const writer: JsonlWriter = {
    append(dto) {
      const line = toJsonlLine(dto);
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bufferedBytes + bytes > MAX_BUFFER_BYTES) {
        if (!overflowReported) { overflowReported = true; report(new Error('JSONL buffer full: dropping lines until it drains (DB logging continues)'), 'jsonl.overflow'); }
        return Promise.resolve();
      }
      overflowReported = false;
      buffer.push({ day: new Date(dto.ts).toISOString().slice(0, 10), line, bytes });
      bufferedBytes += bytes;
      if (interval <= 0) return flush();
      live.add(writer);
      if (bufferedBytes >= MAX_BATCH_BYTES) { void flush(); }
      else if (!timer) { hookExit(); timer = setTimeout(() => { timer = undefined; void flush(); }, interval); timer.unref(); }
      return Promise.resolve();
    },
    flush,
    flushSync,
  };
  return writer;
}

/** Convenience one-shot append (unbuffered; resolves after the write). */
export async function appendJsonl(logDir: string, dto: ExecutionLogDto, maxFileBytes = DEFAULT_MAX_FILE_BYTES): Promise<void> {
  await createJsonlWriter(logDir, { maxFileBytes, flushIntervalMs: 0 }).append(dto);
}
