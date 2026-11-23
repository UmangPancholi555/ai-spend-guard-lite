# Database

AI Spend Guard Lite uses **SQLite** through **Prisma 6** (`prisma/schema.prisma`). The single migration set lives in `prisma/migrations/`.

## 1. Conventions

- **Money** is stored as `BigInt` **pico-USD** (1 USD = 10^12 pico) in `*Pico` columns. Prices (`PricingConfig`) are decimal **strings** (USD per 1M tokens, max 6 decimals). See [ARCHITECTURE.md](ARCHITECTURE.md#7-money-model).
- **Enum-like columns are plain `String`s** (SQLite has no enums); allowed values are validated by Zod at the API boundary and typed in `shared/types.ts`. They are listed in the column notes below.
- **JSON columns** (`metadata`, `attributes`, `inputMeta`, `outputMeta`, `result`, `AppSetting.value`) are `String`s holding JSON. They hold **metadata only**, after passing through the sanitizer.
- **IDs** are `cuid()` strings. `Trace.traceId` (32 hex) and `Span.spanId` (16 hex) are separate unique ids used for correlation; `UsageEvent.requestId` is `req_<uuid>`.
- **Timestamps** are `DateTime` (stored by SQLite as epoch milliseconds / ISO via Prisma); the API serialises them as ISO-8601 strings (UTC).
- Several event tables carry `traceId` / `spanId` / `projectId` as **plain strings without foreign keys**, so retention sweeps and project deletes never fail on them (see section 4).

## 2. Entity overview

```
Provider 1---* Model

PricingConfig 1---* UsageEvent *---1 Project 1---* Budget 1---* BudgetAlert
                                      |  1
                                      |  *
                          ActivityEvent (SetNull)     Trace (SetNull) 1---* Span (Cascade)

Standalone (no FKs): ExecutionLog, MemoryEvent, BusEvent, ToolCallEvent, ContextEvent, BackgroundTask, AppSetting
```

| Relation | On delete |
|---|---|
| `Model.providerId -> Provider` | CASCADE |
| `UsageEvent.projectId -> Project` | CASCADE |
| `UsageEvent.pricingConfigId -> PricingConfig` | SET NULL |
| `Budget.projectId -> Project` (nullable: null = global budget) | CASCADE |
| `BudgetAlert.budgetId -> Budget` | CASCADE |
| `ActivityEvent.projectId -> Project` (nullable) | SET NULL |
| `Trace.projectId -> Project` (nullable) | SET NULL |
| `Span.traceId -> Trace.traceId` | CASCADE |

Deleting a (test) project therefore removes its usage events, budgets and their alerts; its activity events and traces survive with `projectId = NULL`.

## 3. Models

Generated from `prisma/schema.prisma` (column notes are the schema's own comments).

### Project

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `name` | String | required |  |
| `description` | String | nullable |  |
| `status` | String | required, default "ACTIVE" | ACTIVE / ARCHIVED |
| `isTest` | Boolean | required, default false |  |
| `createdAt` | DateTime | required, default now() |  |
| `updatedAt` | DateTime | required, auto-updated |  |
| `archivedAt` | DateTime | nullable |  |

Indexes / uniques:

- `index(status)`
- `index(createdAt)`

Relations:

- `usageEvents` -> `UsageEvent[]` 
- `budgets` -> `Budget[]` 
- `activityEvents` -> `ActivityEvent[]` 
- `traces` -> `Trace[]` 

### Provider

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `key` | String | required, unique | "openai" / "anthropic" |
| `displayName` | String | required |  |
| `isSimulated` | Boolean | required, default true |  |
| `createdAt` | DateTime | required, default now() |  |

Relations:

- `models` -> `Model[]` 

### Model

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `providerId` | String | required |  |
| `name` | String | required | e.g. "gpt-4o-mini" |
| `displayName` | String | required |  |
| `contextWindow` | Int | required |  |
| `active` | Boolean | required, default true |  |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `unique(providerId, name)`

Relations:

- `provider` -> `Provider` `@relation(fields: [providerId], references: [id], onDelete: Cascade)`

### PricingConfig

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `providerKey` | String | required |  |
| `modelName` | String | required |  |
| `version` | Int | required |  |
| `inputPerMTok` | String | required |  |
| `outputPerMTok` | String | required |  |
| `cachedPerMTok` | String | required |  |
| `currency` | String | required, default "USD" |  |
| `effectiveFrom` | DateTime | required |  |
| `note` | String | nullable |  |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `unique(providerKey, modelName, version)`
- `index(providerKey, modelName, effectiveFrom)`

Relations:

- `usageEvents` -> `UsageEvent[]` 

### UsageEvent

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `requestId` | String | required, unique |  |
| `projectId` | String | required |  |
| `providerKey` | String | required |  |
| `modelName` | String | required |  |
| `status` | String | required | SUCCESS / FAILURE |
| `errorCode` | String | nullable |  |
| `errorMessage` | String | nullable |  |
| `inputTokens` | Int | required |  |
| `outputTokens` | Int | required |  |
| `cachedTokens` | Int | required |  |
| `costPico` | BigInt | required | total cost in pico-USD |
| `inputCostPico` | BigInt | required |  |
| `outputCostPico` | BigInt | required |  |
| `cachedCostPico` | BigInt | required |  |
| `costClass` | String | required | SIMULATED / ESTIMATED |
| `pricingConfigId` | String | nullable |  |
| `pricingVersion` | Int | nullable |  |
| `durationMs` | Int | required |  |
| `simulated` | Boolean | required, default true |  |
| `traceId` | String | nullable |  |
| `promptHash` | String | required | sha256 hex of prompt (prompt text is never stored) |
| `promptChars` | Int | required |  |
| `responseText` | String | nullable | deterministic MOCK response text (not real model output) |
| `metadata` | String | required | JSON string: full request metadata |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `index(projectId, createdAt)`
- `index(providerKey, modelName)`
- `index(createdAt)`
- `index(status)`
- `index(traceId)`

Relations:

- `project` -> `Project` `@relation(fields: [projectId], references: [id], onDelete: Cascade)`
- `pricingConfig` -> `PricingConfig?` `@relation(fields: [pricingConfigId], references: [id], onDelete: SetNull)`

### Budget

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `projectId` | String | nullable | null => global budget |
| `name` | String | required |  |
| `period` | String | required | DAILY / WEEKLY / MONTHLY |
| `limitPico` | BigInt | required |  |
| `active` | Boolean | required, default true |  |
| `createdAt` | DateTime | required, default now() |  |
| `updatedAt` | DateTime | required, auto-updated |  |

Indexes / uniques:

- `index(projectId)`
- `index(period)`

Relations:

- `project` -> `Project?` `@relation(fields: [projectId], references: [id], onDelete: Cascade)`
- `alerts` -> `BudgetAlert[]` 

### BudgetAlert

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `budgetId` | String | required |  |
| `threshold` | Int | required | 50 / 80 / 100 |
| `periodStart` | DateTime | required |  |
| `periodEnd` | DateTime | required |  |
| `spendPico` | BigInt | required |  |
| `limitPico` | BigInt | required |  |
| `percent` | Float | required |  |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `unique(budgetId, periodStart, threshold)`
- `index(createdAt)`

Relations:

- `budget` -> `Budget` `@relation(fields: [budgetId], references: [id], onDelete: Cascade)`

### ActivityEvent

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `type` | String | required | e.g. project.created, usage.recorded, budget.alert, request.failed |
| `level` | String | required | INFO / WARN / ERROR |
| `message` | String | required |  |
| `source` | String | required | ACTUAL / SIMULATED |
| `projectId` | String | nullable |  |
| `traceId` | String | nullable |  |
| `requestId` | String | nullable |  |
| `metadata` | String | required, default "{}" | JSON |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `index(createdAt)`
- `index(type)`
- `index(projectId, createdAt)`
- `index(traceId)`

Relations:

- `project` -> `Project?` `@relation(fields: [projectId], references: [id], onDelete: SetNull)`

### Trace

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `traceId` | String | required, unique | 32 hex |
| `name` | String | required |  |
| `projectId` | String | nullable |  |
| `requestId` | String | nullable |  |
| `status` | String | required | RUNNING / OK / ERROR |
| `source` | String | required | ACTUAL / SIMULATED |
| `startedAt` | DateTime | required |  |
| `endedAt` | DateTime | nullable |  |
| `durationMs` | Int | nullable |  |
| `errorMessage` | String | nullable |  |
| `stack` | String | nullable |  |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `index(startedAt)`
- `index(status)`
- `index(projectId)`
- `index(requestId)`

Relations:

- `project` -> `Project?` `@relation(fields: [projectId], references: [id], onDelete: SetNull)`
- `spans` -> `Span[]` 

### Span

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `spanId` | String | required, unique | 16 hex |
| `traceId` | String | required |  |
| `parentSpanId` | String | nullable |  |
| `name` | String | required |  |
| `kind` | String | required | REQUEST / CONTEXT / MEMORY / BUS / TOOL / PROVIDER / COST / BUDGET / INTERNAL |
| `status` | String | required | RUNNING / OK / ERROR |
| `source` | String | required | ACTUAL / SIMULATED |
| `startedAt` | DateTime | required |  |
| `endedAt` | DateTime | nullable |  |
| `durationMs` | Int | nullable |  |
| `errorMessage` | String | nullable |  |
| `stack` | String | nullable |  |
| `attributes` | String | required, default "{}" | JSON (metadata only, never sensitive content) |

Indexes / uniques:

- `index(traceId)`
- `index(parentSpanId)`
- `index(startedAt)`

Relations:

- `trace` -> `Trace` `@relation(fields: [traceId], references: [traceId], onDelete: Cascade)`

### ExecutionLog

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `ts` | DateTime | required, default now() |  |
| `level` | String | required | DEBUG / INFO / WARN / ERROR |
| `eventType` | String | required | e.g. memory.injection.completed, bus.operation, tool.call.completed, context.updated, request.started, error |
| `category` | String | required | REQUEST / MEMORY / BUS / TOOL / CONTEXT / ERROR / SYSTEM / BUDGET / PROVIDER |
| `operation` | String | required | operation name (searchable) |
| `status` | String | required | STARTED / SUCCESS / FAILURE / INFO |
| `source` | String | required | ACTUAL / SIMULATED |
| `traceId` | String | nullable |  |
| `spanId` | String | nullable |  |
| `requestId` | String | nullable |  |
| `projectId` | String | nullable |  |
| `durationMs` | Int | nullable |  |
| `message` | String | required |  |
| `attributes` | String | required, default "{}" | JSON metadata only |
| `errorCategory` | String | nullable | VALIDATION / PROVIDER / TIMEOUT / TOOL / BUS / MEMORY / CONTEXT / DATABASE / INTERNAL / UNKNOWN |
| `errorMessage` | String | nullable |  |
| `stack` | String | nullable |  |

Indexes / uniques:

- `index(ts)`
- `index(eventType)`
- `index(status)`
- `index(traceId)`
- `index(operation)`
- `index(category, ts)`
- `index(errorCategory)`

### MemoryEvent

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `operationId` | String | required | groups started/completed/failed of one injection |
| `phase` | String | required | STARTED / COMPLETED / FAILED |
| `status` | String | required | STARTED / SUCCESS / FAILURE |
| `source` | String | required | ACTUAL / SIMULATED |
| `memorySource` | String | required | e.g. "session-memory" (label only) |
| `category` | String | required | e.g. "user-preferences" |
| `itemCount` | Int | required |  |
| `estimatedTokens` | Int | required |  |
| `payloadBytes` | Int | required |  |
| `durationMs` | Int | nullable |  |
| `errorMessage` | String | nullable |  |
| `traceId` | String | nullable |  |
| `spanId` | String | nullable |  |
| `projectId` | String | nullable |  |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `index(traceId)`
- `index(createdAt)`
- `index(operationId)`
- `index(status)`

### BusEvent

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `operationId` | String | required |  |
| `operationName` | String | required |  |
| `operationType` | String | required | PUBLISH / SUBSCRIBE / REQUEST / DISPATCH |
| `eventName` | String | required |  |
| `inputMeta` | String | required, default "{}" | JSON metadata only |
| `outputStatus` | String | nullable | e.g. "delivered", "no-subscribers", "error" |
| `status` | String | required | SUCCESS / FAILURE |
| `source` | String | required | ACTUAL / SIMULATED |
| `durationMs` | Int | nullable |  |
| `errorMessage` | String | nullable |  |
| `stack` | String | nullable |  |
| `traceId` | String | nullable |  |
| `spanId` | String | nullable |  |
| `projectId` | String | nullable |  |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `index(traceId)`
- `index(createdAt)`
- `index(operationName)`
- `index(status)`

### ToolCallEvent

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `toolName` | String | required |  |
| `toolCallId` | String | required |  |
| `requestId` | String | nullable |  |
| `inputMeta` | String | required, default "{}" | JSON: parameter names/types/sizes/hash - never values |
| `outputMeta` | String | required, default "{}" |  |
| `status` | String | required | SUCCESS / FAILURE |
| `source` | String | required | ACTUAL / SIMULATED |
| `startedAt` | DateTime | required |  |
| `endedAt` | DateTime | nullable |  |
| `durationMs` | Int | nullable |  |
| `errorMessage` | String | nullable |  |
| `retryCount` | Int | required, default 0 |  |
| `maxRetries` | Int | required, default 0 |  |
| `traceId` | String | nullable |  |
| `spanId` | String | nullable |  |
| `projectId` | String | nullable |  |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `index(traceId)`
- `index(toolName)`
- `index(createdAt)`
- `index(status)`
- `index(toolCallId)`

### ContextEvent

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `contextId` | String | required |  |
| `operation` | String | required | CREATED / UPDATED / ADDED / MODIFIED |
| `contextSource` | String | required |  |
| `sizeBytes` | Int | required |  |
| `estimatedTokens` | Int | required |  |
| `version` | Int | required |  |
| `status` | String | required | SUCCESS / FAILURE |
| `source` | String | required | ACTUAL / SIMULATED |
| `errorMessage` | String | nullable |  |
| `durationMs` | Int | nullable |  |
| `traceId` | String | nullable |  |
| `spanId` | String | nullable |  |
| `projectId` | String | nullable |  |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `index(traceId)`
- `index(contextId)`
- `index(createdAt)`

### BackgroundTask

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `id` | String | required, PK, default cuid() |  |
| `name` | String | required |  |
| `kind` | String | required | RETENTION_SWEEP / DEMO_SEED / BUDGET_EVALUATION / EXPORT / OTHER |
| `status` | String | required | QUEUED / RUNNING / SUCCEEDED / FAILED |
| `source` | String | required | ACTUAL / SIMULATED |
| `traceId` | String | nullable |  |
| `startedAt` | DateTime | nullable |  |
| `endedAt` | DateTime | nullable |  |
| `durationMs` | Int | nullable |  |
| `result` | String | required, default "{}" | JSON |
| `errorMessage` | String | nullable |  |
| `stack` | String | nullable |  |
| `createdAt` | DateTime | required, default now() |  |

Indexes / uniques:

- `index(status)`
- `index(createdAt)`
- `index(kind)`

### AppSetting

| Column | Type | Constraints / default | Notes |
|---|---|---|---|
| `key` | String | required, PK |  |
| `value` | String | required | JSON-encoded |
| `updatedAt` | DateTime | required, auto-updated |  |


## 4. Notes on integrity

- **No FK** on `ExecutionLog`, `MemoryEvent`, `BusEvent`, `ToolCallEvent`, `ContextEvent` (`traceId`, `spanId`, `projectId`): these are append-only logs correlated by id, and the retention sweep deletes them (and traces) independently.
- **Budget uniqueness** per `(projectId or global, period)` is enforced in application code, not by a DB constraint (nullable `projectId` in a SQLite unique index would allow duplicates for global budgets).
- **Alert uniqueness** is enforced by the DB: `BudgetAlert unique(budgetId, periodStart, threshold)`.
- **Pricing uniqueness**: `PricingConfig unique(providerKey, modelName, version)`. The fallback row is `providerKey = "*"`, `modelName = "*"`.
- **Request id uniqueness**: `UsageEvent.requestId` is unique.

## 5. Seeded catalog

`seedCatalog()` (`backend/src/database/catalog.ts`) runs on every server start and in every test database; it uses `upsert` with empty `update`, so it only inserts what is missing.

- Providers: `openai` ("Mock OpenAI"), `anthropic` ("Mock Anthropic"), `isSimulated = true`.
- Models: `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `o3-mini`, `claude-opus`, `claude-sonnet`, `claude-haiku`.
- Pricing (illustrative demo numbers, USD per 1M tokens): one version per model, a second version for `gpt-4o-mini` (effective 2025-01-01), and the fallback `*/*` row (input 5, output 15, cached 2.5).

## 6. Migrations workflow

| Task | Command |
|---|---|
| Apply existing migrations (also creates the DB file if missing) | `npm run db:migrate` (= `prisma migrate deploy --schema prisma/schema.prisma`) |
| Create a new migration after editing `schema.prisma` (development) | `npm run db:migrate:dev -- --name <what_changed>` (= `prisma migrate dev`), then commit the new folder in `prisma/migrations/` |
| Regenerate the Prisma client | `npm run db:generate` |

The migration history currently has one migration, `20261123103049_init`. `prisma/migrations/migration_lock.toml` pins the provider to `sqlite`.
Tests create a fresh temporary database per test app and apply the same migrations with `prisma migrate deploy` (see [TESTING.md](TESTING.md)).

## 7. File locations

| What | Default location | Controlled by |
|---|---|---|
| SQLite database | `prisma/spendguard.db` (the `file:./spendguard.db` URL is relative to `prisma/schema.prisma`); SQLite may also create `spendguard.db-journal` next to it while writing | `DATABASE_URL` in `.env` |
| JSONL execution logs | `data/logs/execution-YYYY-MM-DD.jsonl` (repo root) | `LOG_DIR` |
| Test databases | `<os tmpdir>/spendguard-test-*/test.db` and `.../logs/` | `createTestApp()` |

`*.db`, `*.db-journal`, `data/` (except `.gitkeep`) are git-ignored.

## 8. Backup and reset

- **Backup** (stop the server first so no write is in flight): `cp prisma/spendguard.db prisma/spendguard.backup.db` and, if you want the logs, `cp -R data/logs data/logs.backup`.
- **Restore**: stop the server, copy the backup over `prisma/spendguard.db`, start the server.
- **Reset to an empty database**:
  ```bash
  rm -f prisma/spendguard.db prisma/spendguard.db-journal
  rm -rf data/logs            # optional: also drop JSONL logs
  npm run db:migrate
  ```
  The catalog is re-seeded at the next server start. Then optionally regenerate demo data (`POST /api/simulations/seed` or the Dashboard button).
- To change `DATABASE_URL`, edit `.env`; remember relative SQLite paths resolve against the `prisma/` directory.

## 9. Retention

Retention is **manual** (no scheduler): `POST /api/logging/retention/run` or Settings -> "Run retention sweep now", using the `retentionDays` setting (default 30, `0` = keep forever).

| Table | Swept? | Cut-off column |
|---|---|---|
| `ExecutionLog` | yes | `ts` |
| `MemoryEvent`, `BusEvent`, `ToolCallEvent`, `ContextEvent` | yes | `createdAt` |
| `Trace` (+ `Span` via cascade) | yes, only finished traces (`status` OK or ERROR) | `startedAt` |
| JSONL files | yes, files whose whole UTC day is before the cut-off | filename date |
| `UsageEvent`, `ActivityEvent`, `BudgetAlert`, `BackgroundTask`, `Project`, `Budget`, `PricingConfig`, `AppSetting` | **no** (spend history is never deleted by retention) | - |

The sweep itself is recorded as a `RETENTION_SWEEP` row in `BackgroundTask` with per-table delete counts in `result`.
