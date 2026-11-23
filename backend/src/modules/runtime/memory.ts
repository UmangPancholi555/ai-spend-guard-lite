/**
 * Real project MemoryStore (SQLite via Prisma) + injection builder.
 * Memory CONTENT lives in ProjectMemoryItem.content (user data). It is never passed to instrumentation: only counts, sizes,
 * token estimates, categories and a short hash prefix.
 */
import type { PrismaClient, ProjectMemoryItem } from '@prisma/client';
import { z } from 'zod';
import { MEMORY_CATEGORIES, MEMORY_LIMITS, type MemoryItemDto } from '../../../../shared/runtime';
import { AppError, conflict, notFound } from '../../utils/errors';
import { sha256 } from '../../utils/ids';
import { estimateTokens } from '../providers/mock/engine';

export const memoryCreateSchema = z.object({
  title: z.string().trim().min(1).max(MEMORY_LIMITS.maxTitleChars),
  category: z.enum(MEMORY_CATEGORIES),
  content: z.string().min(1).max(MEMORY_LIMITS.maxContentChars),
  enabled: z.boolean().default(true),
});
export const memoryUpdateSchema = z.object({
  title: z.string().trim().min(1).max(MEMORY_LIMITS.maxTitleChars).optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  content: z.string().min(1).max(MEMORY_LIMITS.maxContentChars).optional(),
  enabled: z.boolean().optional(),
}).refine(v => Object.keys(v).length > 0, 'at least one field is required');

export const toMemoryDto = (r: ProjectMemoryItem): MemoryItemDto => ({
  id: r.id, projectId: r.projectId, title: r.title, category: r.category as MemoryItemDto['category'], content: r.content,
  enabled: r.enabled, sizeBytes: r.sizeBytes, estimatedTokens: r.estimatedTokens,
  createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

/** privacy-safe metadata about an item (no title, no content) */
export const memoryItemMeta = (r: { id: string; category: string; sizeBytes: number; estimatedTokens: number; enabled: boolean; content: string }) => ({
  itemId: r.id, category: r.category, sizeBytes: r.sizeBytes, estimatedTokens: r.estimatedTokens, enabled: r.enabled,
  contentHash: sha256(r.content).slice(0, 8),
});

const sizeFields = (content: string) => ({ sizeBytes: Buffer.byteLength(content, 'utf8'), estimatedTokens: estimateTokens(content.length) });

export class MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  private async requireProject(projectId: string) {
    const p = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!p) throw notFound('Project');
  }

  async list(projectId: string): Promise<MemoryItemDto[]> {
    await this.requireProject(projectId);
    const rows = await this.prisma.projectMemoryItem.findMany({ where: { projectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toMemoryDto);
  }

  async create(projectId: string, input: z.infer<typeof memoryCreateSchema>): Promise<ProjectMemoryItem> {
    await this.requireProject(projectId);
    const count = await this.prisma.projectMemoryItem.count({ where: { projectId } });
    if (count >= MEMORY_LIMITS.maxItemsPerProject) {
      throw conflict(`A project can hold at most ${MEMORY_LIMITS.maxItemsPerProject} memory items`, { limit: MEMORY_LIMITS.maxItemsPerProject });
    }
    return this.prisma.projectMemoryItem.create({
      data: { projectId, title: input.title, category: input.category, content: input.content, enabled: input.enabled, ...sizeFields(input.content) },
    });
  }

  async update(projectId: string, itemId: string, input: z.infer<typeof memoryUpdateSchema>): Promise<ProjectMemoryItem> {
    await this.requireProject(projectId);
    const existing = await this.prisma.projectMemoryItem.findFirst({ where: { id: itemId, projectId } });
    if (!existing) throw notFound('Memory item');
    return this.prisma.projectMemoryItem.update({
      where: { id: itemId },
      data: { ...input, ...(input.content !== undefined ? sizeFields(input.content) : {}) },
    });
  }

  async remove(projectId: string, itemId: string): Promise<ProjectMemoryItem> {
    await this.requireProject(projectId);
    const existing = await this.prisma.projectMemoryItem.findFirst({ where: { id: itemId, projectId } });
    if (!existing) throw notFound('Memory item');
    await this.prisma.projectMemoryItem.delete({ where: { id: itemId } });
    return existing;
  }

  /** enabled items in stable injection order (oldest first) */
  async enabledItems(projectId: string): Promise<ProjectMemoryItem[]> {
    return this.prisma.projectMemoryItem.findMany({ where: { projectId, enabled: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }
}

// ---------------------------------------------------------------- injection

export interface InjectionItem { id: string; category: string; sizeBytes: number; estimatedTokens: number; text: string; chars: number }
export interface InjectionPlan {
  items: InjectionItem[]; chars: number; bytes: number; tokens: number; categories: string[];
}

/** formatted block for one item (title + content): the text that is really prepended to the provider prompt */
export function formatMemoryItem(r: { title: string; category: string; content: string }): string {
  return `[${r.category}] ${r.title}\n${r.content}\n\n`;
}

export function planInjection(rows: ProjectMemoryItem[]): InjectionPlan {
  const items: InjectionItem[] = rows.map(r => {
    const text = formatMemoryItem(r);
    return { id: r.id, category: r.category, sizeBytes: Buffer.byteLength(text, 'utf8'), estimatedTokens: estimateTokens(text.length), text, chars: text.length };
  });
  return summarize(items);
}

export function summarize(items: InjectionItem[]): InjectionPlan {
  const chars = items.reduce((s, i) => s + i.chars, 0);
  return {
    items, chars, bytes: items.reduce((s, i) => s + i.sizeBytes, 0),
    tokens: items.length ? estimateTokens(chars) : 0,
    categories: [...new Set(items.map(i => i.category))].sort(),
  };
}

/**
 * REAL truncation: keep the longest prefix of items (oldest first) whose tokens fit `budgetTokens`; drop the rest whole.
 * Never edits the user's prompt and never cuts an item in the middle.
 */
export function fitToBudget(plan: InjectionPlan, budgetTokens: number): { plan: InjectionPlan; dropped: number } {
  if (plan.tokens <= budgetTokens) return { plan, dropped: 0 };
  const kept: InjectionItem[] = [];
  let chars = 0;
  for (const it of plan.items) {
    if (estimateTokens(chars + it.chars) > budgetTokens) break;
    kept.push(it); chars += it.chars;
  }
  return { plan: summarize(kept), dropped: plan.items.length - kept.length };
}

export { AppError };
