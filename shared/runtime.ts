/**
 * Runtime (wave 2) shared types: real in-app MemoryStore, ContextManager, ToolExecutor and EventBus.
 * Everything emitted by these components is source ACTUAL. Memory CONTENT is user data kept in the DB and returned by the
 * memory API only; it is never written to logs, spans, events or activity (only counts, sizes, token estimates, hash prefixes).
 */
export const MEMORY_CATEGORIES = ['instructions', 'preferences', 'facts', 'other'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export const MEMORY_LIMITS = { maxItemsPerProject: 200, maxTitleChars: 120, maxContentChars: 8000 } as const;

export interface MemoryItemDto {
  id: string; projectId: string;
  title: string; category: MemoryCategory; content: string; enabled: boolean;
  sizeBytes: number; estimatedTokens: number; // estimatedTokens = ceil(content chars / 4), min 1
  createdAt: string; updatedAt: string;
}
export interface MemoryItemCreateInput { title: string; category: MemoryCategory; content: string; enabled?: boolean }
export interface MemoryItemUpdateInput { title?: string; category?: MemoryCategory; content?: string; enabled?: boolean }

export interface ToolParamDto { name: string; type: 'string' | 'number' | 'boolean'; required: boolean; description: string }
export interface ToolDescriptorDto {
  name: string; description: string; params: ToolParamDto[]; maxRetries: number;
  source: 'ACTUAL'; // real local tools of this app
}
export interface ToolInvokeResult {
  output: Record<string, unknown>; traceId: string; toolCallId: string; attempts: number; durationMs: number;
}

export interface RuntimeMemorySummary {
  /** true when memory items were injected into this request's context */
  injected: boolean; items: number; estimatedTokens: number; truncated: boolean; droppedItems: number;
}
export interface RuntimeContextSummary {
  contextId: string; version: number; sizeBytes: number; estimatedTokens: number;
  windowTokens: number; truncated: boolean;
}
export interface RuntimeToolSummary {
  name: string; toolCallId: string; status: 'SUCCESS' | 'FAILURE'; attempts: number; durationMs: number;
}
export interface RuntimeBudgetPreflight {
  budgets: number; highestPercent: number; overLimit: boolean; status: 'OK' | 'UNAVAILABLE';
}
