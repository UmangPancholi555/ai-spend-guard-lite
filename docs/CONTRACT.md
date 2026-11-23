# Build Contract (coordinator-owned, source of truth for parallel agents)

Types: `shared/types.ts` (DTOs) · `backend/src/contracts/*.ts` (service + instrumentation interfaces) · schema: `prisma/schema.prisma`.
Do NOT edit those files, `backend/src/app.ts`, `backend/src/utils/*`, `backend/src/database/*`, `backend/src/config.ts`,
`frontend/src/components/{Layout.tsx,ui/*}`, `frontend/src/lib/*`, `frontend/src/App.tsx`, root configs.
If you need a change there, say so in your final report (coordinator applies it). You may ADD new files in your own area.

## Conventions
- Base path `/api`. Each module's `createXRouter(deps)` is mounted at `/api` and declares FULL sub-paths below.
- Envelopes: `{data}`, `{data, pagination}`, `{error:{code,message,details?}}`. Validate with Zod via `parse()` from `utils/http.ts`; wrap handlers with `ah()`.
- Money: BigInt pico-USD internally, 12-dp decimal strings in JSON (`utils/money.ts`). Never floats.
- Dates: ISO strings. Query dates `from`/`to` are ISO; `to` inclusive.
- Pagination query: `page` (1), `pageSize` (25, max 200). Lists sorted newest first unless stated.
- Every simulated record/response carries `simulated: true` + `label: 'DEMO / SIMULATED'` where the DTO says so.
- `source`: `ACTUAL` = emitted by a real instrumented component of this app; `SIMULATED` = DEMO generator. Never label simulated data ACTUAL.
- Privacy: never store prompt/context/memory CONTENT. Only hashes, sizes, counts, key names. JSON metadata columns hold metadata only.
- Tests: Vitest, `backend/tests/<module>/*.test.ts`, use `createTestApp()` from `backend/tests/helpers/testApp.ts` (isolated temp SQLite + migrations + seeded catalog).
- No network access to AI vendors, ever.

## Endpoints (all under /api)
### Dashboard (module dashboard)
- `GET /dashboard?days=30&projectId=` -> `DashboardStats` (zero-filled dailySpend, from persisted data only; archived projects included)
### Projects (module projects)
- `GET /projects?status=ACTIVE|ARCHIVED&includeTest=true&search=&page&pageSize` -> list of `ProjectWithUsage`
- `POST /projects` `ProjectCreateInput` -> 201 `ProjectWithUsage`; name 1..80 chars, unique among all projects (case-insens) else 409
- `GET /projects/:id` -> `ProjectWithUsage`
- `PATCH /projects/:id` `ProjectUpdateInput` -> `ProjectWithUsage` (409 if archived? no: allowed)
- `POST /projects/:id/archive` | `POST /projects/:id/unarchive` -> `ProjectWithUsage` (archived projects reject new provider requests with 409)
- `DELETE /projects/:id` -> 204; only `isTest=true` projects, else 409 CONFLICT; cascades usage/budgets/alerts
- `GET /projects/:id/activity?page&pageSize` -> list `ActivityEventDto`
- Activity events emitted via `deps.instr.recordActivity` (`project.created|updated|archived|unarchived|deleted`, source ACTUAL)
### Providers / mock requests (module providers)
- `GET /providers` -> `ProviderDto[]` (list in `{data}`)
- `POST /providers/requests` `MockProviderRequest` -> 201 `MockProviderResponse` (see pipeline below)
- `POST /simulations/seed` `SimulationSeedRequest` -> `{ taskId, created, projectId }`; generates N backdated simulated requests across `spreadDays` (deterministic PRNG), tracked as a BackgroundTask (kind DEMO_SEED, source SIMULATED) — runs inline and returns when complete
- `POST /simulations/agent-run` `{ projectId, simulateFailure? }` -> `{ traceId }` emits a full SIMULATED agent execution (context init, memory injection, bus op, tool call(s) incl. one retry, response, completion) without a usage event
### Usage (module usage)
- `GET /usage?search&provider&model&projectId&status=SUCCESS|FAILURE&from&to&page&pageSize&sort=createdAt|costUsd|durationMs&order=asc|desc` -> list `UsageEventDto` (search matches requestId, model, provider, projectName, errorMessage, traceId)
- `GET /usage/filters` -> `UsageFilterOptions`
- `GET /usage/export.csv?<same filters>` -> text/csv attachment (all matching rows, not paginated)
- `GET /usage/:id` (id OR requestId) -> `UsageEventDetail`
### Cost (module cost)
- `POST /cost/calculate` `CostCalculateInput` -> `CostBreakdown`
- `GET /cost/pricing?provider&model&history=true` -> `PricingDto[]` (history=false => only current version per model)
- `POST /cost/pricing` `PricingCreateInput` -> 201 `PricingDto` (new version = max+1; prices validated decimal <=6dp; effectiveFrom default now; existing rows are immutable)
### Budgets (module budgets)
- `GET /budgets?projectId=` -> `BudgetDto[]`;  `POST /budgets` `BudgetCreateInput` -> 201; `PATCH /budgets/:id`; `DELETE /budgets/:id` 204
  - unique per (projectId|global, period) -> 409; limit > 0
- `GET /budgets/utilization?projectId=` -> `BudgetUtilization[]` (current period)
- `GET /budgets/:id/utilization?periods=6` -> `BudgetUtilizationDetail` (history of previous periods)
- `POST /budgets/evaluate` -> `BudgetAlertDto[]` newly created (also creates BackgroundTask BUDGET_EVALUATION, ACTUAL)
- `GET /budget-alerts?budgetId&projectId&threshold&from&to&page&pageSize` -> list `BudgetAlertDto`
- Periods are UTC: DAILY = UTC day, WEEKLY = ISO week Monday 00:00 UTC, MONTHLY = UTC calendar month. Spend = SUM(costPico) of usage events in period (global budget: all projects; project budget: that project).
### Activity (module activity)
- `GET /activity?type&level&source&projectId&traceId&search&from&to&page&pageSize` -> list `ActivityEventDto`
### Traces (module traces)
- `GET /traces?status&source&projectId&search(name|traceId|requestId)&from&to&page&pageSize` -> list `TraceDto`
- `GET /traces/:traceId` -> `TraceDetail` (spans flat with parentSpanId; `timeline` merged+sorted by ts from spans/memory/bus/tool/context/logs; failed entries `status:'FAILURE'`)
- `GET /background-tasks?status&kind&page&pageSize` -> list `BackgroundTaskDto`
### Observability (module observability)
- `GET /observability/overview?from&to` (default last 24h... use last 7 days) -> `ObservabilityOverview`
- `GET /observability/performance?from&to&bucket=hour|day` -> `PerformanceStats`
- `GET /observability/sources` -> `InstrumentationSourceDto[]` (honest registry; see "Instrumentation honesty")
- `GET /observability/errors?category&search&traceId&source&from&to&page&pageSize` -> list `ExecutionLogDto` (level ERROR / status FAILURE) ; `GET /observability/errors/groups` -> `ErrorGroup[]`
- `GET /observability/memory-events|bus-events|tool-events|context-events?traceId&status&source&search&from&to&page&pageSize` -> lists of `MemoryEventDto|BusEventDto|ToolCallEventDto|ContextEventDto`
### Logging (module logging)
- `GET /logs?eventType&category&status&level&source&traceId&search(operation name)&from&to&page&pageSize` -> list `ExecutionLogDto`
- `GET /logs/:id` -> `ExecutionLogDto`
- `GET /export/:dataset?format=jsonl|csv&<filters of that dataset>` datasets: `activity|traces|logs|errors|memory|bus|tools|context|alerts|tasks` -> attachment download (usage CSV lives at `/usage/export.csv`)
- `GET /settings` / `PUT /settings` `Partial<AppSettings>` -> `AppSettings` (persisted in AppSetting; retentionDays 0..3650, slowOperationMs 1..600000; `captureContentPlaintext` is always false)
- `POST /logging/retention/run` -> `BackgroundTaskDto` (deletes ExecutionLog/Memory/Bus/Tool/Context events + finished traces older than retentionDays; tracked as BackgroundTask RETENTION_SWEEP, ACTUAL)

## Mock request pipeline (module providers; the ONLY place that creates UsageEvents)
`POST /providers/requests`:
1. Zod-validate; project must exist (404) and be ACTIVE (409).
2. `trace = instr.startTrace({name:'provider.request', projectId, requestId, source:'ACTUAL'})` — the request lifecycle is real app execution -> ACTUAL spans: `provider.mock` (PROVIDER; the mock call itself is simulated, put `simulated:true` in span attributes), `cost.calculate` (COST), `usage.persist` (INTERNAL), `budget.evaluate` (BUDGET).
3. Mock provider (`modules/providers/mock/*`): deterministic from sha256(provider|model|prompt|maxOutputTokens): token counts, cached tokens (portion of input, deterministic), content, duration (deterministic 20–900ms *simulated*; do not actually sleep more than ~25ms), finishReason. Failure modes: `error` (500-ish provider error), `timeout`, `rate_limit` -> status FAILURE, usage still recorded (input tokens consumed, output 0). Models per provider from DB; unknown model names are accepted (cost ESTIMATED).
4. `cost.calculate(...)`; persist `UsageEvent` (requestId unique `req_<uuid>`, promptHash, promptChars, metadata JSON incl. provider, model, temperature, maxOutputTokens, simulatedFailure, mockSeed, apiVersion label, `simulated:true`, deterministic response id), emit activity `usage.recorded` (or `request.failed`, level ERROR) with source ACTUAL.
5. `budgets.evaluateAfterUsage({projectId, at, traceId, spanId})` -> returned alerts included in response.
6. If `simulateAgentActivity` -> emit SIMULATED context/memory/bus/tool events correlated to the same trace id (spans with source SIMULATED).
7. End trace (ERROR if FAILURE with error message+stack where available). Response `MockProviderResponse`.
Backdated seeding (`/simulations/seed`) reuses the same code path with an explicit `createdAt`.

## Instrumentation honesty (module observability `/observability/sources`)
Registry entries (derived from DB counts, never hard-coded numbers):
- `request` lifecycle: CONNECTED (ACTUAL) — middleware + provider pipeline.
- `bus`: CONNECTED only for the in-app budget/alert event bus operations the app really emits (ACTUAL); simulated bus ops are SIMULATED.
- `memory`, `tool`, `context`: SIMULATED_ONLY — this app has no real memory/tool/context runtime; only the simulator emits them. If no events exist at all -> UNAVAILABLE.
- `error`: CONNECTED (error handler + pipeline).
The UI shows a SourceBadge on every event; counts in the overview split actual vs simulated. Never fabricate ACTUAL memory/tool/context events.

## Persistent logging (module logging + instrumentation)
Instrumentation writes SQLite rows AND appends JSONL lines to `${LOG_DIR}/execution-YYYY-MM-DD.jsonl` (sync append, one JSON object per line, no content values). Exports are generated from SQLite (source of truth).
JSONL line shape = `ExecutionLogDto`.

## File ownership
| Agent | Owns |
|---|---|
| obs-core | `backend/src/modules/{instrumentation,logging}/**`, `backend/tests/{instrumentation,logging}/**` |
| obs-events | `backend/src/modules/{observability,traces,activity}/**`, `backend/tests/{observability,traces,activity}/**` |
| cost-budget | `backend/src/modules/{cost,budgets}/**`, `backend/tests/{cost,budgets}/**` |
| providers | `backend/src/modules/providers/**`, `backend/tests/providers/**` |
| core-api | `backend/src/modules/{projects,usage,dashboard}/**`, `backend/tests/{core,projects,usage,dashboard}/**` |
| fe-a | `frontend/src/pages/{Dashboard,Projects,ProjectDetail,Usage,Simulator}Page.tsx`, `frontend/src/components/{dashboard,projects,usage,simulator}/**` |
| fe-b | `frontend/src/pages/{Budgets,Activity,Traces,TraceDetail,Observability,Errors,Logs,Settings}Page.tsx`, `frontend/src/components/{budgets,activity,traces,observability}/**` |
| qa (later) | `tests/e2e/**`, `playwright.config.ts`, cross-module `backend/tests/integration/**` |
| docs (later) | `docs/*.md` (except CONTRACT.md), `README.md` |
Only commit nothing: the coordinator commits. Do not run `git` commands that change state.
Frontend agents: backend modules are being written concurrently; code against this contract and `shared/types.ts`. To test against a live API, run the real backend once endpoints exist (`npm run dev -w backend`), and skip gracefully if an endpoint still 404s.
