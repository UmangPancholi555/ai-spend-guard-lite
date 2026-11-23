import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionLogDto } from '../../../../shared/types';
import { safeStringify } from '../../utils/serialize';

export const JSONL_FILE_RE = /^execution-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function jsonlFileName(ts: Date): string {
  return `execution-${ts.toISOString().slice(0, 10)}.jsonl`;
}

/** Synchronously append one JSON object (an ExecutionLogDto) as a single line. Throws on I/O failure (callers wrap). */
export function appendJsonl(logDir: string, dto: ExecutionLogDto): void {
  const file = path.join(logDir, jsonlFileName(new Date(dto.ts)));
  const line = `${safeStringify(dto).replace(/[\r\n]+/g, ' ')}\n`; // JSON.stringify already escapes newlines; belt and braces
  try {
    fs.appendFileSync(file, line, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(file, line, 'utf8');
  }
}
