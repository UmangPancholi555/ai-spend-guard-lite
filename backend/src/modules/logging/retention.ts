import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { BackgroundTaskDto } from '../../../../shared/types';
import type { Instrumentation } from '../../contracts/instrumentation';
import { JSONL_FILE_RE } from '../instrumentation/jsonl';
import { toTaskDto } from './mappers';
import { getSettings } from './settings';

const DAY_MS = 86_400_000;

/** Delete JSONL files whose whole UTC day is older than `cutoff`. Returns number of deleted files. */
export function pruneJsonlFiles(logDir: string, cutoff: Date): number {
  let deleted = 0;
  let names: string[];
  try { names = fs.readdirSync(logDir); } catch { return 0; }
  for (const name of names) {
    const m = JSONL_FILE_RE.exec(name);
    if (!m) continue;
    const dayEnd = Date.parse(`${m[1]}T00:00:00.000Z`) + DAY_MS; // exclusive end of that file's day
    if (!Number.isNaN(dayEnd) && dayEnd <= cutoff.getTime()) {
      try { fs.unlinkSync(path.join(logDir, name)); deleted++; } catch { /* ignore */ }
    }
  }
  return deleted;
}

export async function runRetentionSweep(
  prisma: PrismaClient, instr: Instrumentation, logDir: string, now = new Date(),
): Promise<BackgroundTaskDto> {
  const task = await instr.startTask({ name: 'retention.sweep', kind: 'RETENTION_SWEEP', source: 'ACTUAL' });
  try {
    const { retentionDays } = await getSettings(prisma);
    const deleted = {
      executionLogs: 0, memoryEvents: 0, busEvents: 0, toolCallEvents: 0, contextEvents: 0, traces: 0, spans: 0, logFiles: 0,
    };
    let cutoff: Date | null = null;
    if (retentionDays > 0) {
      cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
      const old = { lt: cutoff };
      deleted.executionLogs = (await prisma.executionLog.deleteMany({ where: { ts: old } })).count;
      deleted.memoryEvents = (await prisma.memoryEvent.deleteMany({ where: { createdAt: old } })).count;
      deleted.busEvents = (await prisma.busEvent.deleteMany({ where: { createdAt: old } })).count;
      deleted.toolCallEvents = (await prisma.toolCallEvent.deleteMany({ where: { createdAt: old } })).count;
      deleted.contextEvents = (await prisma.contextEvent.deleteMany({ where: { createdAt: old } })).count;
      const traceWhere = { status: { in: ['OK', 'ERROR'] }, startedAt: old };
      deleted.spans = await prisma.span.count({ where: { trace: traceWhere } });
      deleted.traces = (await prisma.trace.deleteMany({ where: traceWhere })).count; // spans cascade
      deleted.logFiles = pruneJsonlFiles(logDir, cutoff);
    }
    await task.succeed({
      retentionDays, skipped: retentionDays === 0, cutoff: cutoff ? cutoff.toISOString() : null, deleted,
      totalDeleted: Object.values(deleted).reduce((a, b) => a + b, 0),
    });
  } catch (e) {
    await task.fail(e);
    throw e;
  }
  const row = await prisma.backgroundTask.findUnique({ where: { id: task.id } });
  if (!row) throw new Error('retention task row missing');
  return toTaskDto(row);
}
