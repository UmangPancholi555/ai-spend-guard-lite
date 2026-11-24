-- Relations + indexes (spec 438 "indexes, relationships").
--
-- 1. Span.parentSpanId  -> Span.spanId   (self relation "SpanTree", ON DELETE SET NULL)
-- 2. BackgroundTask.traceId -> Trace.traceId (ON DELETE SET NULL; tasks are kept forever, finished traces are swept by retention)
-- 3. New indexes: BackgroundTask(traceId), Trace(projectId, startedAt), projectId on ExecutionLog / MemoryEvent / BusEvent /
--    ToolCallEvent / ContextEvent, requestId on ExecutionLog / ToolCallEvent.
--
-- NOT added on purpose (see docs/DATABASE.md "Relations that are intentionally not foreign keys"): traceId / projectId on the
-- ExecutionLog / MemoryEvent / BusEvent / ToolCallEvent / ContextEvent tables, UsageEvent/ActivityEvent.traceId and
-- PricingConfig -> Provider/Model.
--
-- DATA SAFETY: no row is deleted by this migration. SQLite cannot add a foreign key in place, so the two tables are rebuilt
-- (CREATE new_* / INSERT ... SELECT / DROP / RENAME); every column of every row is copied unchanged, except for ORPHANS:
--   * BackgroundTask rows whose traceId points at a Trace that no longer exists (swept by retention) keep the row and get
--     traceId = NULL (the same result ON DELETE SET NULL would have produced at sweep time).
--   * Span rows whose parentSpanId points at a Span that does not exist (only possible if the parent's insert failed) keep
--     the row and get parentSpanId = NULL, i.e. they become tree roots.
-- Both UPDATEs run first, against the old tables, so the copied data satisfies the new constraints. They are no-ops on a database
-- without orphans (the normal case).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
UPDATE "BackgroundTask" SET "traceId" = NULL WHERE "traceId" IS NOT NULL AND "traceId" NOT IN (SELECT "traceId" FROM "Trace");
UPDATE "Span" SET "parentSpanId" = NULL WHERE "parentSpanId" IS NOT NULL AND "parentSpanId" NOT IN (SELECT "spanId" FROM "Span");

-- RedefineTables
CREATE TABLE "new_BackgroundTask" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BackgroundTask_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "Trace" ("traceId") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BackgroundTask" ("createdAt", "durationMs", "endedAt", "errorMessage", "id", "kind", "name", "result", "source", "stack", "startedAt", "status", "traceId") SELECT "createdAt", "durationMs", "endedAt", "errorMessage", "id", "kind", "name", "result", "source", "stack", "startedAt", "status", "traceId" FROM "BackgroundTask";
DROP TABLE "BackgroundTask";
ALTER TABLE "new_BackgroundTask" RENAME TO "BackgroundTask";
CREATE INDEX "BackgroundTask_status_idx" ON "BackgroundTask"("status");
CREATE INDEX "BackgroundTask_createdAt_idx" ON "BackgroundTask"("createdAt");
CREATE INDEX "BackgroundTask_kind_idx" ON "BackgroundTask"("kind");
CREATE INDEX "BackgroundTask_traceId_idx" ON "BackgroundTask"("traceId");
CREATE TABLE "new_Span" (
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
    CONSTRAINT "Span_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "Trace" ("traceId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Span_parentSpanId_fkey" FOREIGN KEY ("parentSpanId") REFERENCES "Span" ("spanId") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Span" ("attributes", "durationMs", "endedAt", "errorMessage", "id", "kind", "name", "parentSpanId", "source", "spanId", "stack", "startedAt", "status", "traceId") SELECT "attributes", "durationMs", "endedAt", "errorMessage", "id", "kind", "name", "parentSpanId", "source", "spanId", "stack", "startedAt", "status", "traceId" FROM "Span";
DROP TABLE "Span";
ALTER TABLE "new_Span" RENAME TO "Span";
CREATE UNIQUE INDEX "Span_spanId_key" ON "Span"("spanId");
CREATE INDEX "Span_traceId_idx" ON "Span"("traceId");
CREATE INDEX "Span_parentSpanId_idx" ON "Span"("parentSpanId");
CREATE INDEX "Span_startedAt_idx" ON "Span"("startedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "BusEvent_projectId_idx" ON "BusEvent"("projectId");

-- CreateIndex
CREATE INDEX "ContextEvent_projectId_idx" ON "ContextEvent"("projectId");

-- CreateIndex
CREATE INDEX "ExecutionLog_projectId_idx" ON "ExecutionLog"("projectId");

-- CreateIndex
CREATE INDEX "ExecutionLog_requestId_idx" ON "ExecutionLog"("requestId");

-- CreateIndex
CREATE INDEX "MemoryEvent_projectId_idx" ON "MemoryEvent"("projectId");

-- CreateIndex
CREATE INDEX "ToolCallEvent_projectId_idx" ON "ToolCallEvent"("projectId");

-- CreateIndex
CREATE INDEX "ToolCallEvent_requestId_idx" ON "ToolCallEvent"("requestId");

-- CreateIndex
CREATE INDEX "Trace_projectId_startedAt_idx" ON "Trace"("projectId", "startedAt");
