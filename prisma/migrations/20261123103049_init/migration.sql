-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isSimulated" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Model" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contextWindow" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Model_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PricingConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerKey" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "inputPerMTok" TEXT NOT NULL,
    "outputPerMTok" TEXT NOT NULL,
    "cachedPerMTok" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "effectiveFrom" DATETIME NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cachedTokens" INTEGER NOT NULL,
    "costPico" BIGINT NOT NULL,
    "inputCostPico" BIGINT NOT NULL,
    "outputCostPico" BIGINT NOT NULL,
    "cachedCostPico" BIGINT NOT NULL,
    "costClass" TEXT NOT NULL,
    "pricingConfigId" TEXT,
    "pricingVersion" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "traceId" TEXT,
    "promptHash" TEXT NOT NULL,
    "promptChars" INTEGER NOT NULL,
    "responseText" TEXT,
    "metadata" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UsageEvent_pricingConfigId_fkey" FOREIGN KEY ("pricingConfigId") REFERENCES "PricingConfig" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "limitPico" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Budget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BudgetAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "budgetId" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "spendPico" BIGINT NOT NULL,
    "limitPico" BIGINT NOT NULL,
    "percent" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BudgetAlert_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "projectId" TEXT,
    "traceId" TEXT,
    "requestId" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActivityEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Trace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "projectId" TEXT,
    "requestId" TEXT,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "stack" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Trace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Span" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "spanId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "parentSpanId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "stack" TEXT,
    "attributes" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "Span_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "Trace" ("traceId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExecutionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "traceId" TEXT,
    "spanId" TEXT,
    "requestId" TEXT,
    "projectId" TEXT,
    "durationMs" INTEGER,
    "message" TEXT NOT NULL,
    "attributes" TEXT NOT NULL DEFAULT '{}',
    "errorCategory" TEXT,
    "errorMessage" TEXT,
    "stack" TEXT
);

-- CreateTable
CREATE TABLE "MemoryEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operationId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "memorySource" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "estimatedTokens" INTEGER NOT NULL,
    "payloadBytes" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "traceId" TEXT,
    "spanId" TEXT,
    "projectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BusEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operationId" TEXT NOT NULL,
    "operationName" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "inputMeta" TEXT NOT NULL DEFAULT '{}',
    "outputStatus" TEXT,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "stack" TEXT,
    "traceId" TEXT,
    "spanId" TEXT,
    "projectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ToolCallEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "toolName" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "requestId" TEXT,
    "inputMeta" TEXT NOT NULL DEFAULT '{}',
    "outputMeta" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 0,
    "traceId" TEXT,
    "spanId" TEXT,
    "projectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ContextEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contextId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "contextSource" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "estimatedTokens" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "traceId" TEXT,
    "spanId" TEXT,
    "projectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BackgroundTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "traceId" TEXT,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "durationMs" INTEGER,
    "result" TEXT NOT NULL DEFAULT '{}',
    "errorMessage" TEXT,
    "stack" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE INDEX "Project_createdAt_idx" ON "Project"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Provider_key_key" ON "Provider"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Model_providerId_name_key" ON "Model"("providerId", "name");

-- CreateIndex
CREATE INDEX "PricingConfig_providerKey_modelName_effectiveFrom_idx" ON "PricingConfig"("providerKey", "modelName", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PricingConfig_providerKey_modelName_version_key" ON "PricingConfig"("providerKey", "modelName", "version");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_requestId_key" ON "UsageEvent"("requestId");

-- CreateIndex
CREATE INDEX "UsageEvent_projectId_createdAt_idx" ON "UsageEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_providerKey_modelName_idx" ON "UsageEvent"("providerKey", "modelName");

-- CreateIndex
CREATE INDEX "UsageEvent_createdAt_idx" ON "UsageEvent"("createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_status_idx" ON "UsageEvent"("status");

-- CreateIndex
CREATE INDEX "UsageEvent_traceId_idx" ON "UsageEvent"("traceId");

-- CreateIndex
CREATE INDEX "Budget_projectId_idx" ON "Budget"("projectId");

-- CreateIndex
CREATE INDEX "Budget_period_idx" ON "Budget"("period");

-- CreateIndex
CREATE INDEX "BudgetAlert_createdAt_idx" ON "BudgetAlert"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetAlert_budgetId_periodStart_threshold_key" ON "BudgetAlert"("budgetId", "periodStart", "threshold");

-- CreateIndex
CREATE INDEX "ActivityEvent_createdAt_idx" ON "ActivityEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_type_idx" ON "ActivityEvent"("type");

-- CreateIndex
CREATE INDEX "ActivityEvent_projectId_createdAt_idx" ON "ActivityEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_traceId_idx" ON "ActivityEvent"("traceId");

-- CreateIndex
CREATE UNIQUE INDEX "Trace_traceId_key" ON "Trace"("traceId");

-- CreateIndex
CREATE INDEX "Trace_startedAt_idx" ON "Trace"("startedAt");

-- CreateIndex
CREATE INDEX "Trace_status_idx" ON "Trace"("status");

-- CreateIndex
CREATE INDEX "Trace_projectId_idx" ON "Trace"("projectId");

-- CreateIndex
CREATE INDEX "Trace_requestId_idx" ON "Trace"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "Span_spanId_key" ON "Span"("spanId");

-- CreateIndex
CREATE INDEX "Span_traceId_idx" ON "Span"("traceId");

-- CreateIndex
CREATE INDEX "Span_parentSpanId_idx" ON "Span"("parentSpanId");

-- CreateIndex
CREATE INDEX "Span_startedAt_idx" ON "Span"("startedAt");

-- CreateIndex
CREATE INDEX "ExecutionLog_ts_idx" ON "ExecutionLog"("ts");

-- CreateIndex
CREATE INDEX "ExecutionLog_eventType_idx" ON "ExecutionLog"("eventType");

-- CreateIndex
CREATE INDEX "ExecutionLog_status_idx" ON "ExecutionLog"("status");

-- CreateIndex
CREATE INDEX "ExecutionLog_traceId_idx" ON "ExecutionLog"("traceId");

-- CreateIndex
CREATE INDEX "ExecutionLog_operation_idx" ON "ExecutionLog"("operation");

-- CreateIndex
CREATE INDEX "ExecutionLog_category_ts_idx" ON "ExecutionLog"("category", "ts");

-- CreateIndex
CREATE INDEX "ExecutionLog_errorCategory_idx" ON "ExecutionLog"("errorCategory");

-- CreateIndex
CREATE INDEX "MemoryEvent_traceId_idx" ON "MemoryEvent"("traceId");

-- CreateIndex
CREATE INDEX "MemoryEvent_createdAt_idx" ON "MemoryEvent"("createdAt");

-- CreateIndex
CREATE INDEX "MemoryEvent_operationId_idx" ON "MemoryEvent"("operationId");

-- CreateIndex
CREATE INDEX "MemoryEvent_status_idx" ON "MemoryEvent"("status");

-- CreateIndex
CREATE INDEX "BusEvent_traceId_idx" ON "BusEvent"("traceId");

-- CreateIndex
CREATE INDEX "BusEvent_createdAt_idx" ON "BusEvent"("createdAt");

-- CreateIndex
CREATE INDEX "BusEvent_operationName_idx" ON "BusEvent"("operationName");

-- CreateIndex
CREATE INDEX "BusEvent_status_idx" ON "BusEvent"("status");

-- CreateIndex
CREATE INDEX "ToolCallEvent_traceId_idx" ON "ToolCallEvent"("traceId");

-- CreateIndex
CREATE INDEX "ToolCallEvent_toolName_idx" ON "ToolCallEvent"("toolName");

-- CreateIndex
CREATE INDEX "ToolCallEvent_createdAt_idx" ON "ToolCallEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ToolCallEvent_status_idx" ON "ToolCallEvent"("status");

-- CreateIndex
CREATE INDEX "ToolCallEvent_toolCallId_idx" ON "ToolCallEvent"("toolCallId");

-- CreateIndex
CREATE INDEX "ContextEvent_traceId_idx" ON "ContextEvent"("traceId");

-- CreateIndex
CREATE INDEX "ContextEvent_contextId_idx" ON "ContextEvent"("contextId");

-- CreateIndex
CREATE INDEX "ContextEvent_createdAt_idx" ON "ContextEvent"("createdAt");

-- CreateIndex
CREATE INDEX "BackgroundTask_status_idx" ON "BackgroundTask"("status");

-- CreateIndex
CREATE INDEX "BackgroundTask_createdAt_idx" ON "BackgroundTask"("createdAt");

-- CreateIndex
CREATE INDEX "BackgroundTask_kind_idx" ON "BackgroundTask"("kind");
