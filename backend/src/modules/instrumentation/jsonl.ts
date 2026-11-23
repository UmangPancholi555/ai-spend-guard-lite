import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionLogDto } from '../../../../shared/types';
import { safeStringify } from '../../utils/serialize';

/** `execution-YYYY-MM-DD.jsonl`, or `execution-YYYY-MM-DD.N.jsonl` for size-rollover files (N >= 1). Group 1 = date. */
export const JSONL_FILE_RE = /^execution-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

export function jsonlFileName(ts: Date, index = 0): string {
  const day = ts.toISOString().slice(0, 10);
  return index > 0 ? `execution-${day}.${index}.jsonl` : `execution-${day}.jsonl`;
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

export interface JsonlWriter { append(dto: ExecutionLogDto): void }

/**
 * Synchronous JSONL appender with a per-file size cap. When the current day file would exceed `maxFileBytes` the writer rolls over to
 * `execution-<day>.1.jsonl`, `.2.jsonl`, ... (a single oversized line still goes into a fresh file). The current rollover index per day
 * is remembered in memory and re-discovered by stat after a restart. Throws on I/O failure (callers wrap).
 */
export function createJsonlWriter(logDir: string, maxFileBytes = DEFAULT_MAX_FILE_BYTES): JsonlWriter {
  const index = new Map<string, number>(); // day -> current rollover index
  const sizeOf = (file: string) => { try { return fs.statSync(file).size; } catch { return 0; } };
  const write = (file: string, line: string) => {
    try {
      fs.appendFileSync(file, line, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(file, line, 'utf8');
    }
  };
  return {
    append(dto) {
      const ts = new Date(dto.ts);
      const day = ts.toISOString().slice(0, 10);
      const line = toJsonlLine(dto);
      const bytes = Buffer.byteLength(line, 'utf8');
      let i = index.get(day) ?? 0;
      for (;;) {
        const file = path.join(logDir, jsonlFileName(ts, i));
        const size = sizeOf(file);
        if (size > 0 && size + bytes > maxFileBytes) { i++; continue; }
        index.set(day, i);
        write(file, line);
        return;
      }
    },
  };
}

/** Convenience one-shot append (no remembered state; stats from index 0 each time). */
export function appendJsonl(logDir: string, dto: ExecutionLogDto, maxFileBytes = DEFAULT_MAX_FILE_BYTES): void {
  createJsonlWriter(logDir, maxFileBytes).append(dto);
}
