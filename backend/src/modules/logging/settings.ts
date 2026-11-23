import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { AppSettings } from '../../../../shared/types';

export const DEFAULT_SETTINGS: AppSettings = { retentionDays: 30, slowOperationMs: 500, captureContentPlaintext: false };

export const settingsUpdateSchema = z.object({
  retentionDays: z.number().int().min(0).max(3650).optional(),
  slowOperationMs: z.number().int().min(1).max(600000).optional(),
  // plaintext content capture is permanently disabled: only `false` is accepted
  captureContentPlaintext: z.literal(false).optional(),
}).strict();

const stored = {
  retentionDays: z.number().int().min(0).max(3650),
  slowOperationMs: z.number().int().min(1).max(600000),
};

/** Read persisted settings (AppSetting rows, JSON-encoded values), falling back to defaults for missing/invalid values. */
export async function getSettings(prisma: Pick<PrismaClient, 'appSetting'>): Promise<AppSettings> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.keys(stored) } } });
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    const key = r.key as keyof typeof stored;
    try {
      const parsed = stored[key].safeParse(JSON.parse(r.value));
      if (parsed.success) out[key] = parsed.data;
    } catch { /* ignore corrupt value -> default */ }
  }
  out.captureContentPlaintext = false;
  return out;
}

export async function updateSettings(prisma: PrismaClient, patch: z.infer<typeof settingsUpdateSchema>): Promise<AppSettings> {
  const writes = (Object.keys(stored) as (keyof typeof stored)[])
    .filter(k => patch[k] !== undefined)
    .map(k => prisma.appSetting.upsert({
      where: { key: k }, create: { key: k, value: JSON.stringify(patch[k]) }, update: { value: JSON.stringify(patch[k]) },
    }));
  if (writes.length) await prisma.$transaction(writes);
  return getSettings(prisma);
}
