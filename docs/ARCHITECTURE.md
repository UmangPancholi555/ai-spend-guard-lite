# Architecture

AI Spend Guard Lite is a **modular monolith**: one Node.js process (Express) with feature modules that talk to each
other through a small set of interfaces, one SQLite database (via Prisma), and a React single-page UI that is served
either by Vite (development) or by the same Express process (production-style run).

> Everything about "AI providers" is a local, deterministic simulation. See [SECURITY.md](SECURITY.md) for how
> outbound AI calls are prevented.

## 1. System overview

```
                    Browser (React SPA)                          curl / scripts
                           |                                           |
      dev: Vite :5173 -----+---- proxy /api ---->                      |
      prod: static files served by Express                             |
                           v                                           v
 +-----------------------------------------------------------------------------------+
 |  Express app  (backend/src/app.ts)                       http://localhost:4000    |
 |   cors (localhost/127.0.0.1 origins) -> express.json(1mb) -> request-lifecycle    |
 |   middleware (logs mutations + 4xx/5xx) -> /api routers -> notFound -> errorHandler|
 |                                                                                   |
 |  +-----------+ +-----------+ +-----------+ +---------+ +-----------+ +-----------+|
 |  | dashboard | | projects  | | usage     | | cost    | | budgets   | | providers ||
 |  | (read)    | | CRUD      | | list/CSV  | | pricing | | periods + | | mock APIs ||
 |  |           | |           | |           | | engine  | | alerts    | | pipeline  ||
 |  +-----------+ +-----------+ +-----------+ +---------+ +-----------+ | simulators||
 |  +-----------+ +-----------+ +---------------+  +-----------------+   +-----------+|
 |  | activity  | | traces    | | observability |  | logging         |                |
 |  | (read)    | | (read)    | | (read)        |  | logs/export/    |                |
 |  +-----------+ +-----------+ +---------------+  | settings/retent.|                |
 |                                                  +-----------------+                |
 |  +--------------------------------------------------------------------------------+|
 |  | instrumentation  SDK (traces, spans, typed events, activity, errors, tasks)   ||
 |  |   sanitizer (privacy) -> SQLite rows  +  JSONL files                            ||
 |  +--------------------------------------------------------------------------------+|
 +-----------------------------------+-----------------------------+-----------------+
                                     |                             |
                       Prisma Client (parameterized SQL)    data/logs/execution-YYYY-MM-DD.jsonl
                                     v
                         SQLite file prisma/spendguard.db
```

### Dependency injection

`createDeps(prisma, config)` in `backend/src/app.ts` builds the shared `AppDeps` object, defined in
`backend/src/contracts/services.ts`:

```
AppDeps = { prisma, instr: Instrumentation, cost: CostService, budgets: BudgetService, config: AppConfig }
```

`createXRouter(deps)` factories (one per module) receive it and declare their **full sub-paths** under `/api`.
The same factory functions are used by `server.ts` and by the test harness, so tests exercise the real wiring.
`backend/src/contracts/noop.ts` provides a no-op `Instrumentation` for isolated unit tests.

## 2. Module responsibilities

| Module (`backend/src/modules/...`) | Responsibility |
|---|---|
| `projects` | Project CRUD, archive / unarchive, delete (test projects only), per-project usage summaries (computed from persisted usage events), per-project activity. Emits `project.*` activity (source `ACTUAL`). |
| `providers` | Mock OpenAI / Anthropic providers, the **mock request pipeline** (the only place that creates `UsageEvent` rows), demo seeding (`/simulations/seed`) and simulated agent runs (`/simulations/agent-run`). |
| `cost` | Exact cost calculation and versioned pricing (`/cost/calculate`, `/cost/pricing`). |
| `budgets` | Budget CRUD, period math (`periods.ts`), utilization, alert evaluation with duplicate prevention, `/budgets/evaluate`, `/budget-alerts`. |
| `usage` | Usage list / filters / detail / CSV export. Wildcard-safe search. |
| `dashboard` | One aggregate endpoint (`GET /dashboard`) built from persisted data only. |
| `activity` | Read API for the persistent `ActivityEvent` feed. |
| `traces` | Trace list, trace detail with spans and a merged **execution timeline** (`timeline.ts`, a pure function), background-task list. |
| `observability` | Read-side analytics: overview, performance, instrumentation sources, errors / error groups, memory / bus / tool / context event lists. Never writes. |
| `instrumentation` | The SDK (`sdk.ts`), the privacy sanitizer (`sanitize.ts`), JSONL writer (`jsonl.ts`) and the request-lifecycle middleware. The only writer of trace / span / event / log rows. |
| `logging` | `/logs`, `/export/:dataset`, `/settings`, retention sweep. |

Cross-cutting code: `utils/money.ts` (BigInt money), `utils/http.ts` (Zod `parse`, pagination, CSV helpers),
`utils/errors.ts` (`AppError`), `middleware/errorHandler.ts`, `database/catalog.ts` (idempotent catalog seed).

The shared DTO types live in `shared/types.ts` and are imported by both backend and frontend (`@shared/types` alias in Vite).

## 3. HTTP layer

Order of middleware in `buildApp`:

1. `x-powered-by` disabled.
2. `cors` with an allow-list: `http://localhost:<any port>` and `http://127.0.0.1:<any port>` (regex).
3. `express.json({ limit: '1mb' })`.
4. `requestLifecycleMiddleware` on `/api` (details in section 6).
5. `GET /api/health` (inline).
6. Module routers on an `express.Router()` mounted at `/api`; then `notFoundHandler` for unknown `/api/*`.
7. If `frontend/dist` exists: `express.static` plus an SPA fallback for every non-`/api` GET.
8. `errorHandler`.

Envelopes: `{ data }`, `{ data, pagination }`, `{ error: { code, message, details? } }`. Validation is done with Zod
(`parse()` in `utils/http.ts`) which throws `AppError(400, 'VALIDATION_ERROR')`. Route handlers are wrapped with `ah()` so
async rejections reach the error handler. Full catalogue: [API.md](API.md).

## 4. The mock request pipeline

`POST /api/providers/requests` -> `executeMockRequest()` in `modules/providers/pipeline.ts`.

```
client
  | POST /api/providers/requests {projectId, provider, model, prompt, ...}
  v
 1. Zod validate                       -> 400 VALIDATION_ERROR
 2. load project                       -> 404 NOT_FOUND / 409 CONFLICT (archived)
 3. requestId = req_<uuid>; promptHash = sha256(prompt); promptChars = length   (prompt text is then dropped)
 4. trace = instr.startTrace('provider.request', source ACTUAL)           root span kind REQUEST
 5.   span provider.mock  (PROVIDER)   deterministic mock completion; failure modes error|timeout|rate_limit
        - on failure: instr.recordError(category PROVIDER|TIMEOUT)
 6.   span cost.calculate (COST)       CostService.calculate(tokens, pricing version effective at event time)
 7.   span usage.persist  (INTERNAL)   INSERT UsageEvent (BigInt pico columns, metadata JSON, createdAt = event time)
 8.   activity usage.recorded (INFO) | request.failed (ERROR)             source ACTUAL
 9.   span budget.evaluate (BUDGET)    BudgetService.evaluateAfterUsage -> newly created alerts
10.   if simulateAgentActivity: SIMULATED context/memory/bus/tool spans + events on the same trace
11.   trace.end(error?)                trace status OK | ERROR
  v
 201 { data: MockProviderResponse }    includes cost breakdown, budgetAlerts, traceId, usageEventId
```

Key properties:

- **Failures still record usage.** A simulated failure yields a `FAILURE` usage event with the input tokens consumed,
  `outputTokens = 0`, and cost for those input tokens. The HTTP response is still `201` with `status: "FAILURE"` and an `error` object.
- **Determinism.** `mock/engine.ts` derives a seed from `sha256(provider|model|prompt|maxOutputTokens|temperature)` and uses a
  `mulberry32` PRNG (no `Math.random`). Same input -> same tokens, cached tokens, text and simulated duration.
  Simulated duration is 20..900 ms and is *reported*, not slept: the pipeline sleeps at most 25 ms to feel like a request.
- **Token convention.** `inputTokens` = non-cached prompt tokens (input rate), `cachedTokens` = cached prompt tokens
  (cached rate), total prompt tokens = `inputTokens + cachedTokens`. Cached tokens are 0..60 % of the prompt, only for prompts longer than 200 chars.
- **Unknown model names are accepted** and priced with the fallback row, giving `costClass: ESTIMATED`.
- **Backdating.** The same function is reused by the seeder with an explicit `createdAt`; budgets are evaluated "as of" that instant.

Seeding (`/simulations/seed`, `simulator/seed.ts`): validates, resolves or creates the test project
`Demo Project (simulated)`, starts a `BackgroundTask` (`DEMO_SEED`, source `SIMULATED`), plans N requests from a seeded PRNG
(provider / model mix with ~3 % `experimental-preview-x` unknown model, business-hours weighting, ~6 % failures when enabled), and
executes them through the pipeline in chronological order with `trace: false` and `activity: false` for speed. With
`includeAgentActivity`, the most recent 25 requests get a `SIMULATED` trace with agent activity. It runs inline and returns when finished.

Simulated agent runs (`/simulations/agent-run`) produce a trace named `agent.run` (source `SIMULATED`) with context lifecycle
(CREATED, UPDATED, ADDED, MODIFIED), memory injection, two bus operations, a `web_search` tool call that fails once and is retried, and a `read_file` tool call,
and no usage event. `simulateFailure` forces one step to fail (`error` -> memory, `rate_limit` -> bus, `timeout` -> tool).

Event timestamps of simulated activity come from a trace-anchored clock so they always fall inside the trace window. The *simulated*
latency numbers are exposed as `simulatedDurationMs` / `simulatedLatencyMs` attributes, while `durationMs` on those events is the real elapsed time.

## 5. Instrumentation architecture

### 5.1 The SDK

`modules/instrumentation/sdk.ts` implements the `Instrumentation` interface from `contracts/instrumentation.ts`:

| Method | Writes |
|---|---|
| `startTrace` / `TraceHandle.startSpan` / `SpanHandle.end` | `Trace`, `Span` rows (+ `request.started` / `request.completed|failed` log lines) |
| `recordMemory` | `MemoryEvent` (+ `memory.injection.started|completed|failed` log) |
| `recordBus` | `BusEvent` (+ `bus.operation` log) |
| `recordTool` | `ToolCallEvent` for completed calls (+ `tool.call.initiated|completed|failed` log); `INITIATED` writes only a log line |
| `recordContext` | `ContextEvent` (+ `context.<op>` log) |
| `recordActivity` | `ActivityEvent` (+ `activity.<type>` log) |
| `recordError` | `ExecutionLog` row with `eventType: "error"` |
| `log` | `ExecutionLog` row |
| `startTask` | `BackgroundTask` lifecycle (QUEUED -> RUNNING -> SUCCEEDED / FAILED) + log lines |
| `withSpan` | convenience wrapper around `startSpan` / `end` |

Every call (1) inserts into its typed table, (2) mirrors an `ExecutionLog` row, and (3) appends the same
`ExecutionLogDto` as one JSON line to a JSONL file. **Instrumentation never crashes the host**: every write is wrapped,
failures go to `console.error` plus an optional `onError` hook, and DB and file writes are independent (a DB failure still
produces the JSONL line and vice versa). Handles keep working even if their rows could not be written because IDs are generated client-side.

Span ids are 16 hex chars, trace ids 32 hex chars. Span timestamps use a monotonic clock anchored at the trace start, so backdated traces have consistent spans.

### 5.2 `source` semantics: ACTUAL vs SIMULATED vs UNAVAILABLE

Every event, span, trace, activity entry and task carries `source`:

| Value | Meaning | Examples in this app |
|---|---|---|
| `ACTUAL` | Emitted by a real, instrumented component of *this* application | HTTP request middleware, provider-request pipeline spans (cost, persist, budget), budget engine alerts and bus publishes, error handler, project CRUD activity, retention sweep and budget-evaluation tasks |
| `SIMULATED` | Emitted by the DEMO generators | Seeded traces, simulated agent runs, every memory / tool / context event, simulated bus operations, the `Demo Project` creation activity, `DEMO_SEED` tasks |

`UNAVAILABLE` is not a stored value. It is a *status* of an instrumentation source in the registry (`GET /api/observability/sources`).

How sources are determined (`modules/observability/sources.ts`): counts per `source` are read from the database each time; nothing is hard-coded.

| Registry entry | Status rule |
|---|---|
| `request-lifecycle` (request) | always `CONNECTED`: the middleware and provider pipeline really emit ACTUAL events (note says "No events recorded yet." when empty) |
| `error-handler` (error) | always `CONNECTED` (error middleware and pipeline failures are recorded as ACTUAL). Provider failures from the mock are tagged with the trace's source, so they count as SIMULATED when seeded |
| `event-bus` (bus) | `CONNECTED` if at least one ACTUAL bus event exists (the in-app budget-alert publishes); `SIMULATED_ONLY` if only simulated bus events exist; else `UNAVAILABLE` |
| `memory-injection`, `tool-calls`, `context-lifecycle` | **never** `CONNECTED`. This app has no real memory / tool / context runtime. Rows exist -> `SIMULATED_ONLY`; none -> `UNAVAILABLE`. If rows labelled ACTUAL somehow exist they are reported in `actualEvents` and the note flags them as unverified |

### 5.3 Honesty rules

1. Simulated data is never labelled `ACTUAL`. Demo generators pass `source: 'SIMULATED'` explicitly.
2. A live provider request is a real execution of this app's pipeline, so its trace / spans are `ACTUAL`, but the provider span carries
   `simulated: true` and all usage events and API responses carry `simulated: true` and `label: "DEMO / SIMULATED"`.
3. The overview splits operation counts into `bySource.actual` and `bySource.simulated`; the UI shows both and a SourceBadge on each event.
4. Memory / tool / context events are shown in the UI under a "simulated" label; the sources panel states the absence of a real source.
5. Nothing synthesises counts: every number is derived from persisted rows.

## 6. Logging architecture

```
 instrumented code
      |  record*/log()                                       (sanitizeAttributes on every metadata object)
      v
 +------------+     +--------------------+     +-------------------------------------+
 | typed row  | --> | ExecutionLog row   | --> | data/logs/execution-YYYY-MM-DD.jsonl |
 | (Memory/   |     | (central log,      |     | one ExecutionLogDto per line,        |
 | Bus/Tool/  |     |  SQLite)           |     | UTC day of event ts, sync append     |
 | Context/   |     +--------------------+     +-------------------------------------+
 | Activity/..|              |
 +------------+              v
                  GET /logs, /observability/*, /export/:dataset   (all read from SQLite)
```

- **SQLite is the source of truth.** JSONL files are an append-only on-disk mirror of `ExecutionLog` (one JSON object per
  line, CR/LF stripped). Exports are generated from SQLite, not from the files.
- **Request lifecycle middleware** (`middleware.ts`, mounted on `/api`): assigns `x-request-id` (an incoming well-formed
  header `[A-Za-z0-9._-]{1,64}` is honoured), measures duration, and on `finish` writes an `ExecutionLog` row (category `REQUEST`,
  operation `METHOD /route-pattern`). Status/level: `<400` SUCCESS/INFO, `4xx` INFO status with WARN level, `>=500` FAILURE/ERROR.
  **Successful GET/HEAD/OPTIONS are not logged**, and `/api/health` never is. It does not create traces.
- **Exports** (`GET /export/:dataset?format=jsonl|csv`): datasets `activity, traces, logs, errors, memory, bus, tools, context, alerts, tasks`.
  Rows are streamed from SQLite in cursor-paged batches of 500 (no full in-memory load), with `Content-Disposition: attachment`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. CSV cells are RFC 4180 escaped with a formula-injection guard. Usage CSV is at `/usage/export.csv`.
- **Retention** (`logging/retention.ts`): setting `retentionDays` (default 30; `0` = keep forever). `POST /api/logging/retention/run`
  (the Settings page button) records a `RETENTION_SWEEP` background task and deletes `ExecutionLog`, `MemoryEvent`, `BusEvent`, `ToolCallEvent`,
  `ContextEvent` rows older than the cutoff, finished traces (`OK`/`ERROR`, spans cascade) older than the cutoff, and JSONL files whose whole UTC day is
  older than the cutoff. It does **not** delete usage events, activity events, budget alerts, background tasks, projects or budgets. There is no scheduler: the sweep runs only when invoked.
- **Settings** live in `AppSetting` rows (`retentionDays`, `slowOperationMs`; JSON-encoded values). `captureContentPlaintext` is fixed `false`.

## 7. Money model

- Money is a **`BigInt` count of pico-USD** (1 USD = 10^12 pico) in the database (`costPico`, `limitPico`, ...) and in all arithmetic. No floats.
- On the wire money is a **decimal string with exactly 12 fraction digits**, e.g. `"0.000064480000"` (`picoToUsd`). Inputs such as budget limits are decimal strings (`usdToPico`, up to 12 fraction digits).
- Prices are stored as decimal strings: **USD per 1,000,000 tokens, up to 6 fraction digits** (`"0.150000"`). Parsed into micro-USD per MTok (`price * 10^6`), then
  `costPico = tokens * priceMicroPerMTok`, which is *exact* because `tokens * price / 10^6 USD = tokens * priceMicro * 10^-12 USD`.
- Cost = input cost + output cost + cached cost (cached tokens are billed separately and are not a subset of `inputTokens`).
- Percentages use integer math: `percentOf = Number(spend * 10000n / limit) / 100` (2 decimals, truncated); threshold checks are exact: `spend * 100 >= limit * threshold`.
- `JSON.stringify` cannot serialise BigInt, so `safeStringify` converts BigInt to strings for JSON columns / JSONL.
- The frontend formats the strings textually (`fmtUsd`). Converting to `Number` happens only for chart rendering.

## 8. Pricing versioning

`PricingConfig` holds one row per `(providerKey, modelName, version)`; the fallback row is `("*", "*")`.

- **Selection:** the highest `version` whose `effectiveFrom <= at`. For requests, `at` is the *event time* (so seeded, backdated usage is priced with the price that was current then).
  The seeded catalog has `gpt-4o-mini` v1 (effective 2024-01-01) and v2 (2025-01-01) to demonstrate this.
- **Fallback:** if the pair is unknown (or `at` predates all its versions) the `*/*` row is used and `costClass = ESTIMATED`; otherwise `SIMULATED`. If the fallback row is missing the API returns `500 PRICING_UNAVAILABLE`.
- **Immutability:** `POST /cost/pricing` always creates `version = max + 1`; existing rows are never edited. `effectiveFrom` defaults to now and must not be earlier than the latest existing version's `effectiveFrom` (else 400). Writes are serialised in-process and retried on a unique-constraint race.
- Each `UsageEvent` stores `pricingConfigId` and `pricingVersion`, so historical cost is reproducible.
- The catalog (providers, models, pricing) is seeded by `seedCatalog()` on every server start with `upsert ... update: {}` (never overwrites edits).

## 9. Budget periods and alert de-duplication

**Periods** (`budgets/periods.ts`, UTC, half-open `[start, end)`):

| Period | Window |
|---|---|
| `DAILY` | the UTC day |
| `WEEKLY` | ISO week: Monday 00:00 UTC to next Monday 00:00 UTC |
| `MONTHLY` | UTC calendar month |

Spend = `SUM(UsageEvent.costPico)` with `createdAt` in the period; a global budget (`projectId = null`) sums all projects, a project budget only that project. Usage exactly at the boundary belongs to the new period.
Utilization history (`GET /budgets/:id/utilization?periods=N`) walks back N previous periods (oldest first).
(`dashboard/budgetUtil.ts` holds a second copy of the period math for the dashboard; both are covered by tests.)

**Evaluation** (`budgets/service.ts`): after each usage event `evaluateAfterUsage({projectId, at})` loads active budgets that are global or belong to the project and, for each, computes spend in the period containing `at`. `evaluateAll()` (via `POST /budgets/evaluate`, tracked as `BUDGET_EVALUATION` task) does the same for every active budget. Budgets of archived projects are dormant (not evaluated).

**Duplicate prevention** has three layers:

1. an application pre-check: existing alerts for `(budgetId, periodStart, threshold in crossed)` are skipped;
2. a DB unique index `BudgetAlert(budgetId, periodStart, threshold)`, the real backstop;
3. race handling when inserting: a unique violation (`P2002`), a missing budget (`P2003` / `P2025`, deleted meanwhile) resolve to "someone else already did it" and the insert returns `null`; SQLite contention (`P1008` / `P2034`) is retried up to 5 times with a short back-off.

A jump from 10 % to 120 % creates the 50, 80 and 100 alerts at once. Each new alert emits an activity event `budget.alert` (level `WARN`, source `ACTUAL`) and a bus `PUBLISH` operation `budget.alert.publish` (event `budget.threshold.crossed`, source `ACTUAL`) - this is what makes the registry's `event-bus` source `CONNECTED`. A real failure to insert is recorded as a `DATABASE` error.
The "one budget per (project or global, period)" rule is enforced in application code under an in-process mutex (a DB unique index cannot cover the nullable `projectId`), so it is not safe across multiple server processes.

## 10. Privacy model and sanitizer

The app must never store raw prompt / context / memory / secret content.

- The prompt is hashed (`promptHash = sha256`) and measured (`promptChars`); the text is never persisted or logged.
- `UsageEvent.responseText` holds the **deterministic mock text**, not model output and not derived from the prompt.
- Every metadata object passed to the SDK goes through `sanitizeAttributes` (`instrumentation/sanitize.ts`):
  keys matching `/(content|prompt|text|body|message|memory|secret|password|authorization|api[-_]?key|token$)/i` are replaced by
  `{ redacted: true, type, length, sha256_8 }`, except numeric / boolean counters and keys with metadata suffixes
  (`...Hash, ...Chars, ...Count, ...Bytes, ...Tokens, ...Id, ...Name` etc.); secret-looking values (`Bearer ...`, `sk-...`, JWTs) are redacted regardless of key;
  other strings are truncated to 256 chars; depth, item counts and serialised size are capped. Sanitising is idempotent.
- Free-text error messages / stacks are kept (bounded to 2,000 / 8,000 chars) because they describe failures.

Details and limits: [SECURITY.md](SECURITY.md).

## 11. Frontend structure

```
frontend/src/
├── main.tsx, App.tsx          router: Layout + one route per page
├── index.css                  Tailwind layers
├── components/
│   ├── Layout.tsx             sidebar nav, DEMO / SIMULATED banner, dark-mode toggle (class-based, persisted in localStorage)
│   ├── ui/                    Badge, Button, Card, PageHeader, State (loading/error), Table
│   ├── dashboard/ projects/ usage/ simulator/      page-specific components
│   └── budgets/ activity/ traces/ observability/
├── lib/
│   ├── api.ts                 fetch wrapper: api.get / list / post / patch / put / del / url; ApiRequestError
│   ├── useApi.ts              useAsync(loader, deps) hook, ignores stale responses
│   └── format.ts              string-based money formatting, ints, percentages, durations
└── pages/                     Dashboard, Projects, ProjectDetail, Usage, Simulator, Budgets, Activity,
                               Traces, TraceDetail, Observability, Errors, Logs, Settings
```

- Plain `fetch` through `lib/api.ts`; all paths are relative (`/api/...`), which works with the Vite proxy in dev and same-origin in production.
- State is local React state plus `useAsync`; list filters on the Usage page live in the URL query string so views are linkable.
- Types come from `shared/types.ts`; money stays a string end to end.
- Charts use Recharts; styling is Tailwind with `dark:` variants.
- Stable `data-testid` attributes are used by the Playwright tests.
