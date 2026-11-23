import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionLogDto } from '../../../shared/types';

export function readJsonl(logDir: string): ExecutionLogDto[] {
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir).filter(f => /^execution-.*\.jsonl$/.test(f)).sort()
    .flatMap(f => fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ExecutionLogDto));
}
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
