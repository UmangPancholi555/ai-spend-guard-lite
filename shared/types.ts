/**
 * Shared API contract types (used by backend and frontend).
 * RULES
 *  - All timestamps are ISO-8601 strings in JSON.
 *  - All money is a decimal STRING in USD with exactly 12 fraction digits (pico-USD precision), e.g. "0.000123450000".
 *    Never use JS numbers for money. Internally money is BigInt pico-USD (1 USD = 1_000_000_000_000 pico).
 *  - Success envelope:  { data: T }   List envelope: { data: T[], pagination: Pagination }
 *  - Error envelope:    { error: { code, message, details? } }
 */

export type Source = 'ACTUAL' | 'SIMULATED';
export const SOURCES: Source[] = ['ACTUAL', 'SIMULATED'];

export type ProviderKey = 'openai' | 'anthropic';
export type UsageStatus = 'SUCCESS' | 'FAILURE';
export type CostClass = 'SIMULATED' | 'ESTIMATED';
export type BudgetPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type AlertThreshold = 50 | 80 | 100;
export type ProjectStatus = 'ACTIVE' | 'ARCHIVED';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type SpanStatus = 'RUNNING' | 'OK' | 'ERROR';
export type SpanKind =
  | 'REQUEST' | 'CONTEXT' | 'MEMORY' | 'BUS' | 'TOOL' | 'PROVIDER' | 'COST' | 'BUDGET' | 'INTERNAL';
export type ErrorCategory =
  | 'VALIDATION' | 'PROVIDER' | 'TIMEOUT' | 'TOOL' | 'BUS' | 'MEMORY' | 'CONTEXT' | 'DATABASE' | 'INTERNAL' | 'UNKNOWN';
export type LogCategory =
  | 'REQUEST' | 'MEMORY' | 'BUS' | 'TOOL' | 'CONTEXT' | 'ERROR' | 'SYSTEM' | 'BUDGET' | 'PROVIDER';
export type TaskStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type TaskKind = 'RETENTION_SWEEP' | 'DEMO_SEED' | 'BUDGET_EVALUATION' | 'EXPORT' | 'OTHER';
export type ContextOperation = 'CREATED' | 'UPDATED' | 'ADDED' | 'MODIFIED';
export type BusOperationType = 'PUBLISH' | 'SUBSCRIBE' | 'REQUEST' | 'DISPATCH';
export type SimulatedFailure = 'none' | 'error' | 'timeout' | 'rate_limit';

export interface Pagination { page: number; pageSize: number; total: number; totalPages: number }
export interface ApiList<T> { data: T[]; pagination: Pagination }
export interface ApiOne<T> { data: T }
export interface ApiError { error: { code: string; message: string; details?: unknown } }

/** Error codes: VALIDATION_ERROR(400) NOT_FOUND(404) CONFLICT(409) INTERNAL_ERROR(500) */

// ---------- Projects ----------
export interface ProjectDto {
  id: string; name: string; description: string | null;
  status: ProjectStatus; isTest: boolean;
  createdAt: string; updatedAt: string; archivedAt: string | null;
}
export interface ProjectUsageSummary {
  requests: number; successes: number; failures: number;
  inputTokens: number; outputTokens: number; cachedTokens: number;
  costUsd: string; lastActivityAt: string | null;
}
export interface ProjectWithUsage extends ProjectDto { usage: ProjectUsageSummary }
export interface ProjectCreateInput { name: string; description?: string; isTest?: boolean }
export interface ProjectUpdateInput { name?: string; description?: string | null; isTest?: boolean }

// ---------- Providers / pricing ----------
export interface ModelDto { name: string; displayName: string; contextWindow: number; active: boolean }
export interface ProviderDto { key: ProviderKey; displayName: string; isSimulated: true; label: 'DEMO / SIMULATED'; models: ModelDto[] }
export interface MockProviderRequest {
  projectId: string;
  provider: ProviderKey;
  model: string;             // unknown model names are allowed -> cost class ESTIMATED
  prompt: string;            // never stored; only sha256 + length
  maxOutputTokens?: number;  // default 256
  temperature?: number;
  simulateFailure?: SimulatedFailure; // default 'none'
  simulateAgentActivity?: boolean;    // default false: also emit SIMULATED memory/bus/tool/context events
}
export interface MockProviderResponse {
  requestId: string; traceId: string;
  simulated: true; label: 'DEMO / SIMULATED';
  provider: ProviderKey; model: string; projectId: string;
  status: UsageStatus;
  content: string | null;    // deterministic mock text (null on failure)
  finishReason: 'stop' | 'length' | 'error';
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  cost: CostBreakdown;
  durationMs: number;
  error?: { code: string; message: string };
  budgetAlerts: BudgetAlertDto[]; // alerts newly raised by this request
  usageEventId: string;
}

// ---------- Cost ----------
export interface CostBreakdown {
  currency: 'USD';
  inputCostUsd: string; outputCostUsd: string; cachedCostUsd: string; totalCostUsd: string;
  costClass: CostClass;            // SIMULATED = priced from a known model; ESTIMATED = unknown model, fallback pricing
  unknownModel: boolean;
  pricingConfigId: string | null; pricingVersion: number | null;
  pricing: { inputPerMTok: string; outputPerMTok: string; cachedPerMTok: string };
}
export interface CostCalculateInput {
  provider: string; model: string;
  inputTokens: number; outputTokens: number; cachedTokens?: number;
  at?: string; // ISO; selects pricing version effective at that time (reproducibility)
}
export interface PricingDto {
  id: string; providerKey: string; modelName: string; version: number;
  inputPerMTok: string; outputPerMTok: string; cachedPerMTok: string;
  currency: 'USD'; effectiveFrom: string; note: string | null; createdAt: string; isCurrent: boolean;
}
export interface PricingCreateInput {
  provider: string; model: string;
  inputPerMTok: string; outputPerMTok: string; cachedPerMTok: string;
  effectiveFrom?: string; note?: string;
}

// ---------- Usage ----------
export interface UsageEventDto {
  id: string; requestId: string; projectId: string; projectName?: string;
  provider: string; model: string; status: UsageStatus;
  errorCode: string | null; errorMessage: string | null;
  inputTokens: number; outputTokens: number; cachedTokens: number;
  costUsd: string; costClass: CostClass; pricingVersion: number | null;
  durationMs: number; simulated: true; label: 'DEMO / SIMULATED';
  traceId: string | null; createdAt: string;
}
export interface UsageEventDetail extends UsageEventDto {
  inputCostUsd: string; outputCostUsd: string; cachedCostUsd: string;
  pricingConfigId: string | null;
  promptHash: string; promptChars: number;
  responseText: string | null;
  metadata: Record<string, unknown>;
}
export interface UsageFilterOptions { providers: string[]; models: { provider: string; model: string }[]; }

// ---------- Budgets ----------
export interface BudgetDto {
  id: string; projectId: string | null; projectName: string | null;
  name: string; period: BudgetPeriod; limitUsd: string; active: boolean;
  createdAt: string; updatedAt: string;
}
export interface BudgetCreateInput { projectId?: string | null; name: string; period: BudgetPeriod; limitUsd: string; active?: boolean }
export interface BudgetUpdateInput { name?: string; limitUsd?: string; active?: boolean }
export interface BudgetUtilization {
  budget: BudgetDto;
  periodStart: string; periodEnd: string;
  spendUsd: string; limitUsd: string; percent: number; // percent 0..n (can exceed 100), 2 decimals
  highestThresholdReached: AlertThreshold | null;
}
export interface BudgetUtilizationHistoryPoint { periodStart: string; periodEnd: string; spendUsd: string; percent: number }
export interface BudgetUtilizationDetail extends BudgetUtilization { history: BudgetUtilizationHistoryPoint[] }
export interface BudgetAlertDto {
  id: string; budgetId: string; budgetName: string; projectId: string | null; projectName: string | null;
  period: BudgetPeriod; threshold: AlertThreshold; periodStart: string; periodEnd: string;
  spendUsd: string; limitUsd: string; percent: number; createdAt: string;
}

// ---------- Activity / traces ----------
export interface ActivityEventDto {
  id: string; type: string; level: 'INFO' | 'WARN' | 'ERROR'; message: string; source: Source;
  projectId: string | null; projectName?: string | null; traceId: string | null; requestId: string | null;
  metadata: Record<string, unknown>; createdAt: string;
}
export interface TraceDto {
  traceId: string; name: string; projectId: string | null; requestId: string | null;
  status: SpanStatus; source: Source; startedAt: string; endedAt: string | null; durationMs: number | null;
  errorMessage: string | null; stack: string | null; spanCount: number;
}
export interface SpanDto {
  spanId: string; traceId: string; parentSpanId: string | null; name: string; kind: SpanKind;
  status: SpanStatus; source: Source; startedAt: string; endedAt: string | null; durationMs: number | null;
  errorMessage: string | null; stack: string | null; attributes: Record<string, unknown>;
}
/** One row in the execution timeline (merged from spans + memory/bus/tool/context events + logs). */
export interface TimelineEntry {
  ts: string;
  step:
    | 'execution.started' | 'context.initialized' | 'memory.injection.started' | 'memory.injection.completed'
    | 'memory.injection.failed' | 'bus.operation' | 'tool.call.initiated' | 'tool.call.completed' | 'tool.call.failed'
    | 'context.event' | 'response.generated' | 'execution.completed' | 'execution.failed' | 'span' | 'other';
  label: string; status: 'SUCCESS' | 'FAILURE' | 'STARTED' | 'INFO';
  source: Source; durationMs: number | null; spanId: string | null;
  refKind: 'span' | 'memory' | 'bus' | 'tool' | 'context' | 'log';
  refId: string | null; errorMessage: string | null; details: Record<string, unknown>;
}
export interface TraceDetail { trace: TraceDto; spans: SpanDto[]; timeline: TimelineEntry[]; }
export interface BackgroundTaskDto {
  id: string; name: string; kind: TaskKind; status: TaskStatus; source: Source; traceId: string | null;
  startedAt: string | null; endedAt: string | null; durationMs: number | null;
  result: Record<string, unknown>; errorMessage: string | null; stack: string | null; createdAt: string;
}

// ---------- Observability events ----------
export interface ExecutionLogDto {
  id: string; ts: string; level: LogLevel; eventType: string; category: LogCategory; operation: string;
  status: 'STARTED' | 'SUCCESS' | 'FAILURE' | 'INFO'; source: Source;
  traceId: string | null; spanId: string | null; requestId: string | null; projectId: string | null;
  durationMs: number | null; message: string; attributes: Record<string, unknown>;
  errorCategory: ErrorCategory | null; errorMessage: string | null; stack: string | null;
}
export interface MemoryEventDto {
  id: string; operationId: string; phase: 'STARTED' | 'COMPLETED' | 'FAILED'; status: 'STARTED' | 'SUCCESS' | 'FAILURE';
  source: Source; memorySource: string; category: string; itemCount: number; estimatedTokens: number;
  payloadBytes: number; durationMs: number | null; errorMessage: string | null;
  traceId: string | null; spanId: string | null; projectId: string | null; createdAt: string;
}
export interface BusEventDto {
  id: string; operationId: string; operationName: string; operationType: BusOperationType; eventName: string;
  inputMeta: Record<string, unknown>; outputStatus: string | null; status: 'SUCCESS' | 'FAILURE'; source: Source;
  durationMs: number | null; errorMessage: string | null; stack: string | null;
  traceId: string | null; spanId: string | null; projectId: string | null; createdAt: string;
}
export interface ToolCallEventDto {
  id: string; toolName: string; toolCallId: string; requestId: string | null;
  inputMeta: Record<string, unknown>; outputMeta: Record<string, unknown>;
  status: 'SUCCESS' | 'FAILURE'; source: Source; startedAt: string; endedAt: string | null; durationMs: number | null;
  errorMessage: string | null; retryCount: number; maxRetries: number;
  traceId: string | null; spanId: string | null; projectId: string | null; createdAt: string;
}
export interface ContextEventDto {
  id: string; contextId: string; operation: ContextOperation; contextSource: string; sizeBytes: number;
  estimatedTokens: number; version: number; status: 'SUCCESS' | 'FAILURE'; source: Source;
  errorMessage: string | null; durationMs: number | null;
  traceId: string | null; spanId: string | null; projectId: string | null; createdAt: string;
}

export interface ObservabilityOverview {
  range: { from: string; to: string };
  totals: {
    operations: number; successful: number; failed: number;
    memoryInjections: number; busOperations: number; toolCalls: number; contextUpdates: number;
    averageDurationMs: number; failureRate: number; // 0..1
  };
  bySource: { actual: number; simulated: number };
  recentErrors: ExecutionLogDto[];
  recentTraces: TraceDto[];
}
export interface OperationStat { operation: string; category: LogCategory; count: number; failures: number; avgMs: number; p95Ms: number; maxMs: number }
export interface PerformanceStats {
  range: { from: string; to: string };
  slowThresholdMs: number;
  averageExecutionMs: number;
  requestLatency: { avgMs: number; p95Ms: number; count: number };
  toolLatency: { avgMs: number; p95Ms: number; count: number };
  memoryInjectionLatency: { avgMs: number; p95Ms: number; count: number };
  failureRate: number;
  operationCounts: { category: LogCategory; count: number; failures: number }[];
  operations: OperationStat[];
  slowOperations: ExecutionLogDto[];
  durationSeries: { bucket: string; avgMs: number; count: number }[]; // bucket = ISO hour or day
}
export interface InstrumentationSourceDto {
  id: string; kind: 'request' | 'memory' | 'bus' | 'tool' | 'context' | 'error';
  name: string;
  /** CONNECTED = real instrumented component in this app emitting ACTUAL events;
   *  SIMULATED_ONLY = only DEMO/SIMULATED generators exist;
   *  UNAVAILABLE = no instrumentation source exists, nothing is shown as actual. */
  status: 'CONNECTED' | 'SIMULATED_ONLY' | 'UNAVAILABLE';
  actualEvents: number; simulatedEvents: number; lastEventAt: string | null; notes: string;
}
export interface ErrorGroup { category: ErrorCategory; count: number; lastSeen: string }
export interface AppSettings {
  retentionDays: number;        // default 30; 0 = keep forever
  slowOperationMs: number;      // default 500
  captureContentPlaintext: false; // fixed false: sensitive content is never logged in plaintext
}

// ---------- Dashboard ----------
export interface DashboardStats {
  range: { from: string; to: string; days: number };
  simulated: true; label: 'DEMO / SIMULATED';
  totals: {
    spendUsd: string; requests: number; successes: number; failures: number; successRate: number; // 0..1
    inputTokens: number; outputTokens: number; cachedTokens: number;
  };
  providerBreakdown: { provider: string; requests: number; costUsd: string; inputTokens: number; outputTokens: number; cachedTokens: number }[];
  modelBreakdown: { provider: string; model: string; requests: number; costUsd: string; inputTokens: number; outputTokens: number; cachedTokens: number }[];
  dailySpend: { date: string; costUsd: string; requests: number; failures: number }[]; // one point per day in range (zero-filled), date = YYYY-MM-DD UTC
  budgetUtilization: BudgetUtilization[];
  recentActivity: ActivityEventDto[];
  recentErrors: UsageEventDto[];
  recentAlerts: BudgetAlertDto[];
}

export interface SimulationSeedRequest { projectId?: string; requests: number; spreadDays: number; includeFailures?: boolean; includeAgentActivity?: boolean }
