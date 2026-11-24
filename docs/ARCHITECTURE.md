# Architecture

AI Spend Guard Lite is a **modular monolith**: one Node.js process (Express) with feature modules that talk to each
other through a small set of interfaces, one SQLite database (via Prisma), and a React single-page UI that is served
either by Vite (development) or by the same Express process (production-style run).

> The AI **providers** are local, deterministic simulations. The app around them is real: login and sessions, a project
> memory store, a request context manager, local tools and an in-process event bus are real components that run on every
> mock request (section 4a). See [SECURITY.md](SECURITY.md) for the auth model and for how outbound AI calls are prevented.

## 1. System overview

```
                    Browser (React SPA)                          curl / scripts
                           |                                           |
      dev: Vite :5173 -----+---- proxy /api ---->                      |
      prod: static files served by Express                             |
                           v                                           v
 +-----------------------------------------------------------------------------------+
 |  Express app  (backend/src/app.ts)                    http://127.0.0.1:4000 (HOST) |
 |   host guard -> security headers -> cors -> origin guard -> rate limit ->          |
 |   express.json(1mb) -> request-lifecycle log -> /api/health -> auth router ->      |
 |   requireAuth (session,                                                           |
 |   CSRF, roles) -> module routers -> notFound -> errorHandler                       |
 |                                                                                   |
 |  +-----------+ +-----------+ +-----------+ +---------+ +-----------+ +-----------+|
 |  | auth      | | projects  | | usage     | | cost    | | budgets   | | providers ||
 |  | sessions  | | CRUD      | | list/CSV  | | pricing | | periods + | | pipeline  ||
 |  | users     | |           | | (streamed)| | engine  | | alerts    | | simulators||
 |  +-----------+ +-----------+ +-----------+ +---------+ +-----------+ +-----+-----+|
 |  +-----------+ +-----------+ +---------------+  +-----------------+         |     |
 |  | dashboard | | activity  | | observability |  | logging         |   +-----v-----+|
 |  | (read)    | | traces    | | (read)        |  | logs/export/    |   | runtime   ||
 |  +-----------+ | (read)    | +---------------+  | settings/retent.|   | memory    ||
 |                +-----------+                    | + scheduler     |   | context   ||
 |                                                 +-----------------+   | tools bus ||
 |  +--------------------------------------------------------------------------------+|
 |  | instrumentation  SDK (traces, spans, typed events, activity, errors, tasks)   ||
 |  |   sanitizer (privacy) -> SQLite rows  +  JSONL files (50 MB rollover)           ||
 |  +--------------------------------------------------------------------------------+|
 +-----------------------------------+-----------------------------+-----------------+
                                     |                             |
                       Prisma Client (parameterized SQL)    data/logs/execution-YYYY-MM-DD[.N].jsonl
                                     v
                         SQLite file prisma/spendguard.db
```

### Dependency injection

`createDeps(prisma, config)` in `backend/src/app.ts` builds the shared `AppDeps` object, defined in
`backend/src/contracts/services.ts`:

```
AppDeps = { prisma, instr: Instrumentation, cost: CostService, budgets: BudgetService, config: AppConfig }

AppConfig = { port, databaseUrl, logDir, frontendDist, auth: { enabled, sessionTtlHours, cookieSecure }, security: { rateLimitPerMinute } }
```

`createXRouter(deps)` factories (one per module) receive it and declare their **full sub-paths** under `/api`.
The same factory functions are used by `server.ts` and by the test harness, so tests exercise the real wiring.
`backend/src/contracts/noop.ts` provides a no-op `Instrumentation` for isolated unit tests.

## 2. Module responsibilities

| Module (`backend/src/modules/...`) | Responsibility |
|---|---|
| `auth` | Login, logout, first-run setup, sessions (cookie + CSRF), password change, user management (ADMIN), account lockout and login throttling, audit activity, `bootstrapAdmin` and the `user:create` CLI. Exports `createAuthRouter` and `requireAuth`. Details in section 3a and [SECURITY.md](SECURITY.md). |
| `projects` | Project CRUD, archive / unarchive, delete (test projects only), per-project usage summaries (computed from persisted usage events), per-project activity. Emits `project.*` activity (source `ACTUAL`). |
| `providers` | Mock OpenAI / Anthropic providers, the **mock request pipeline** (the only place that creates `UsageEvent` rows), demo seeding (`/simulations/seed`) and the SIMULATED agent-run generator (`/simulations/agent-run`). Mounts the runtime router. |
| `runtime` | The **real in-app runtime**: `MemoryStore` (project memory in SQLite), `ContextManager` (per-request context), `ToolExecutor` (3 local tools), `EventBus` (in-process pub/sub), the runtime component registry that backs `/observability/sources`, and the routes `/projects/:id/memory*`, `/tools`, `/tools/:name/invoke`. Details in section 4a. |
| `cost` | Exact cost calculation and versioned pricing (`/cost/calculate`, `/cost/pricing`). |
| `budgets` | Budget CRUD, period math (`periods.ts`), utilization, alert evaluation with duplicate prevention, `/budgets/evaluate`, `/budget-alerts`. |
| `usage` | Usage list / filters / detail / **streamed** CSV export (keyset batches of 500). One parameterised SQL fragment (`query.ts`) is shared by count, page and export; wildcard-safe search. |
| `dashboard` | One aggregate endpoint (`GET /dashboard`) built from persisted data only. Budget utilization reuses the budgets module's period math (same numbers as `/budgets/utilization`); the daily series is one grouped SQL query. |
| `activity` | Read API for the persistent `ActivityEvent` feed. |
| `traces` | Trace list, trace detail with spans and a merged **execution timeline** (`timeline.ts`, a pure function), background-task list. |
| `observability` | Read-side analytics: overview, performance, instrumentation sources, errors / error groups, memory / bus / tool / context event lists. Never writes. |
| `instrumentation` | The SDK (`sdk.ts`), the privacy sanitizer (`sanitize.ts`), JSONL writer (`jsonl.ts`) and the request-lifecycle middleware. The only writer of trace / span / event / log rows. |
| `logging` | `/logs`, `/export/:dataset`, `/settings`, retention sweep and the **retention scheduler** (`scheduler.ts`). |

Cross-cutting code: `utils/money.ts` (BigInt money), `utils/http.ts` (Zod `parse`, pagination, CSV helpers),
`utils/errors.ts` (`AppError`), `utils/password.ts` (scrypt hashing + password policy), `middleware/security.ts` (headers, rate limiter),
`middleware/errorHandler.ts`, `database/catalog.ts` (idempotent catalog seed).

The shared DTO types live in `shared/types.ts`, `shared/auth.ts` and `shared/runtime.ts` and are imported by both backend and frontend (`@shared/types` alias in Vite).

## 3. HTTP layer

Order of middleware in `buildApp`:

1. `x-powered-by` disabled; `trust proxy` only when `TRUST_PROXY` is set (opt-in).
1b. `hostGuard(ALLOWED_HOSTS)`: `Host` must be localhost / 127.0.0.1 / `[::1]` or an allowed name, else `421 MISDIRECTED_REQUEST` (DNS-rebinding defence).
2. `securityHeaders()`: CSP, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP / CORP `same-origin`, `Permissions-Policy` (every response, including the static UI).
3. `cors` with an allow-list: `http://localhost:<any port>` and `http://127.0.0.1:<any port>` (regex).
4. **Origin guard** on `/api`: a non-GET/HEAD/OPTIONS request whose `Origin` is not localhost / 127.0.0.1 / `[::1]` gets `403 FORBIDDEN_ORIGIN`.
5. `rateLimiter(RATE_LIMIT_PER_MINUTE)` on `/api` (fixed window per client IP, IPv6 by /64, default 600/min, in memory, `429 RATE_LIMITED`).
6. `express.json({ limit: '1mb' })` (`413 PAYLOAD_TOO_LARGE` above that).
7. `requestLifecycleMiddleware` on `/api` (details in section 6).
8. `GET /api/health` (inline, public).
9. One `express.Router()` mounted at `/api`: `createAuthRouter` (public auth routes and the authenticated `/auth/*` routes), then `requireAuth` (session cookie, CSRF, VIEWER rule; no-op when `AUTH_ENABLED=false`), then the module routers (dashboard, projects, providers (+ runtime), usage, cost, budgets, activity, traces, observability, logging); then `notFoundHandler` for unknown `/api/*` (an unauthenticated caller gets `401` for unknown paths before reaching it).
10. If `frontend/dist` exists: `express.static` plus an SPA fallback for every non-`/api` GET.
11. `errorHandler` (maps `AppError`, Zod errors, `entity.too.large` -> 413; records an ACTUAL error event; never returns stacks).

`server.ts` additionally: binds to `HOST` (default `127.0.0.1`), seeds the catalog, runs `bootstrapAdmin` (creates the first admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD` when no user exists), prints a setup hint when no users exist, warns when `HOST` is non-loopback with `COOKIE_SECURE=false`, prints a loud banner when `AUTH_ENABLED=false`, starts the retention scheduler and stops it on shutdown.

Envelopes: `{ data }`, `{ data, pagination }`, `{ error: { code, message, details? } }`. Validation is done with Zod
(`parse()` in `utils/http.ts`) which throws `AppError(400, 'VALIDATION_ERROR')`. Route handlers are wrapped with `ah()` so
async rejections reach the error handler. Full catalogue: [API.md](API.md).

### 3a. Authentication architecture

```
 browser --POST /api/auth/login {username,password}--> auth router
      |                 verify scrypt (constant time, dummy verify for unknown users) + lockout + per-IP limiter
      |   <-- Set-Cookie sg_session=<43-char token> (HttpOnly, SameSite=Strict, Secure?)   +  { user, csrfToken }
      |
      +-- every later request: Cookie -> sha256 -> Session row -> (idle / absolute expiry) -> req.user
                         unsafe methods: X-CSRF-Token must equal HMAC(sessionToken, "spendguard:csrf:v1") (checked against Session.csrfHash)
                         VIEWER: only logout / password / cost calculate / own-session revoke may be non-GET
```

Code map (`backend/src/modules/auth/`): `core.ts` (cookie, token hashing, CSRF derivation, session create / resolve / prune, lockout counters, audit helper, per-process locks), `middleware.ts` (`requireAuth`, `sessionGate`, public-route list), `router.ts` (all `/auth/*` endpoints), `users.ts` (`createUser`, `createFirstAdmin`), `bootstrap.ts`, `cli.ts`, `types.ts`; `utils/password.ts` (scrypt, policy). The frontend side is `components/auth/*` + `lib/api.ts` (CSRF header, 401 handling). All rules (lifetimes, limits, cookie flags) are in [SECURITY.md](SECURITY.md).

## 4. The mock request pipeline

`POST /api/providers/requests` -> `executeMockRequest()` in `modules/providers/pipeline.ts`.

```
client
  | POST /api/providers/requests {projectId, provider, model, prompt, injectMemory?, ...}
  v
 1. Zod validate                       -> 400 VALIDATION_ERROR
 2. load project                       -> 404 NOT_FOUND / 409 CONFLICT (archived)
 3. requestId = req_<uuid>; promptHash = sha256(prompt); promptChars = length   (prompt text is then dropped)
 4. trace = instr.startTrace('provider.request', source ACTUAL)           root span kind REQUEST (carries httpRequestId)
 5. REAL context: ContextManager.create  -> context event CREATED v1 (prompt size / tokens)
 6. REAL memory injection (unless injectMemory=false): MemoryStore.enabledItems(project)
        -> memory events STARTED -> COMPLETED|FAILED + MEMORY span + context event ADDED v2
        -> if prompt + memory + max output would exceed the model's context window: drop whole items (newest first)
           and emit context event MODIFIED v3 (truncation). No enabled items: nothing is emitted.
 7. REAL tool calls (preflight, never blocking): pricing.lookup, budget.status  -> tool events + TOOL spans
 8.   span provider.mock  (PROVIDER)   deterministic mock completion over (injected memory + prompt); failure modes error|timeout|rate_limit
        - ALWAYS source SIMULATED (a simulation, whatever the request source); every other lifecycle span stays ACTUAL
        - on failure: instr.recordError(category PROVIDER|TIMEOUT, source SIMULATED)
      context event UPDATED (response / usage appended)
 9.   span cost.calculate (COST)       CostService.calculate(tokens, pricing version effective at event time)
10.   span usage.persist  (INTERNAL)   INSERT UsageEvent (BigInt pico columns, metadata JSON incl. memory / context / tools summaries)
11. REAL bus: publish usage.recorded | request.failed -> subscriber "activity-recorder" writes the ActivityEvent
12.   span budget.evaluate (BUDGET)    bus.request('budget.evaluate') -> responder "budget-engine" -> BudgetService.evaluateAfterUsage -> new alerts
13.   if simulateAgentActivity: SIMULATED context/memory/bus/tool spans + events on the same trace (demo generator)
14.   trace.end(error?)                trace status OK | ERROR
  v
 201 { data: MockProviderResponse }    cost breakdown, budgetAlerts, traceId, usageEventId, memory / context / tools / budgetPreflight summaries
```

Key properties:

- **Failures still record usage.** A simulated failure yields a `FAILURE` usage event with the input tokens consumed,
  `outputTokens = 0`, and cost for those input tokens. The HTTP response is still `201` with `status: "FAILURE"` and an `error` object.
- **Determinism.** `mock/engine.ts` derives a seed from `sha256(provider|model|prompt|maxOutputTokens|temperature)` and uses a
  `mulberry32` PRNG (no `Math.random`). Same input -> same tokens, cached tokens, text and simulated duration. Because the
  provider receives the memory text prepended to the prompt, the same prompt gives different token counts once memory items change (and identical ones when they do not).
  Simulated duration is 20..900 ms and is *reported*, not slept: the pipeline sleeps at most 25 ms to feel like a request.
- **Token convention.** `inputTokens` = non-cached prompt tokens (input rate), `cachedTokens` = cached prompt tokens
  (cached rate), total prompt tokens = `inputTokens + cachedTokens`. Cached tokens are 0..60 % of the prompt, only for prompts longer than 200 chars.
- **Unknown model names are accepted** and priced with the fallback row, giving `costClass: ESTIMATED`.
- **Backdating.** The same function is reused by the seeder with an explicit `createdAt`; budgets are evaluated "as of" that instant. Events use a trace-anchored clock (`runtime/clock.ts`) so they always fall inside the trace window, also for backdated traces.
- **Seeding is silent.** The seeder runs the pipeline with `runtime: 'silent'` and `injectMemory: false`: same behaviour, but no context / memory / tool / bus events are written and no tool calls are made (bulk demo data must not fabricate runtime events).

Seeding (`/simulations/seed`, `simulator/seed.ts`): validates, resolves or creates the test project
`Demo Project (simulated)`, starts a `BackgroundTask` (`DEMO_SEED`, source `SIMULATED`), plans N requests from a seeded PRNG
(provider / model mix with ~3 % `experimental-preview-x` unknown model, business-hours weighting, ~6 % failures when enabled), and
executes them through the pipeline in chronological order with `trace: false` and `activity: false` for speed. With
`includeAgentActivity`, the most recent 25 requests get a `SIMULATED` trace with agent activity. It runs inline and returns when finished.

Simulated agent runs (`/simulations/agent-run`, `simulator/agentRun.ts`, `agentActivity.ts`) are a **demo generator**: a trace named `agent.run` (source `SIMULATED`) with context lifecycle
(CREATED, UPDATED, ADDED, MODIFIED), memory injection, two bus operations, a `web_search` tool call that fails once and is retried, and a `read_file` tool call,
and no usage event. `simulateFailure` forces one step to fail (`error` -> memory, `rate_limit` -> bus, `timeout` -> tool). These are scripted events: no real memory, tool or bus is exercised, and they stay labelled `SIMULATED` everywhere.
The *simulated* latency numbers are exposed as `simulatedDurationMs` / `simulatedLatencyMs` attributes, while `durationMs` on those events is the real elapsed time.

## 4a. The real runtime (`modules/runtime`)

Four real, in-process components, created once per `AppDeps` by `getRuntime(deps)` (cached in a `WeakMap`; `getRuntime(deps, {silent: true})` returns the same wiring with a no-op instrumentation). Everything they emit is `source: ACTUAL`.

| Component | What it really is | What it records |
|---|---|---|
| `MemoryStore` (`memory.ts`) | CRUD over the `ProjectMemoryItem` table (max 200 items per project; title <= 120, content <= 8000 chars; categories `instructions`, `preferences`, `facts`, `other`). Injection builds the text `[category] title\ncontent\n\n` per enabled item, oldest first, and prepends it to the provider prompt. | memory events (`STARTED` -> `COMPLETED` / `FAILED`, item count, estimated tokens, bytes, categories), `project.memory.*` activity. **Never the content or title** (only ids, sizes, a content-hash prefix). |
| `ContextManager` (`context.ts`) | One `RequestContext` per provider request holding sizes and token estimates of prompt + memory + response, with strictly increasing versions. Truncation is real: whole memory items are dropped when prompt + memory + max output tokens exceed the model's `contextWindow` (default 128000 when the model is unknown). | context events `CREATED` v1, `ADDED` v2 (memory), `MODIFIED` (only when truncated), `UPDATED` (response), each with a CONTEXT span. Content is never persisted. |
| `ToolExecutor` (`tools.ts`) | Registry of local tools with Zod-validated input, bounded retries on transient errors (max 2 retries, 20 / 40 ms back-off) and a TOOL span. Built-ins: **`pricing.lookup`** (price + version for a provider / model via the cost service), **`budget.status`** (current-period utilization of the project's and global budgets), **`usage.summary`** (requests, failures, tokens and cost over the last N days). The pipeline calls the first two on every request; all three are callable through `POST /api/tools/:name/invoke`. | tool events (`INITIATED` log line, `COMPLETED`, retries, duration); `inputMeta` = parameter names / types / sizes / hash only. |
| `EventBus` (`bus.ts`) | Real in-process pub/sub with `publish` (synchronous fan-out, isolated subscriber failures), `dispatch` (async fan-out) and `request` (one responder). The pipeline publishes `usage.recorded` / `request.failed` (subscriber `activity-recorder` writes the activity event) and requests `budget.evaluate` (responder `budget-engine`). | bus events (`PUBLISH`, `SUBSCRIBE`, `REQUEST`, `DISPATCH`, with key names, byte size and subscriber counts; never payload values). |

`registerRuntimeComponents()` registers these (plus the request-lifecycle middleware and error recording) in the **runtime registry** (`registry.ts`); the sources endpoint reports a kind `CONNECTED` only when a component is registered for it (section 5.2).

What is real and what is not: memory, context, tools and the bus are real code paths executed by this app's own request pipeline and REST API. They do not wrap an external agent runtime: **there is no external agent, LLM or tool server to instrument**. The mock providers, their token counts and latencies, and the `agent-run` / seeded agent-activity generator remain simulated and labelled as such.

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
failures go to a rate-limited `console.error` (one line per failure context per 30 s with a suppressed-repeat count; silent under `NODE_ENV=test` / Vitest) plus an `onError` hook that is called on every failure, and DB and file writes are independent (a DB failure still
produces the JSONL line and vice versa). Handles keep working even if their rows could not be written because IDs are generated client-side.

Span ids are 16 hex chars, trace ids 32 hex chars. Span timestamps use a monotonic clock anchored at the trace start, so backdated traces have consistent spans.

### 5.2 `source` semantics: ACTUAL vs SIMULATED vs UNAVAILABLE

Every event, span, trace, activity entry and task carries `source`:

| Value | Meaning | Examples in this app |
|---|---|---|
| `ACTUAL` | Emitted by a real, instrumented component of *this* application | HTTP request middleware, provider-request pipeline spans (context, memory injection, tools, cost, persist, budget), the real memory / context / tool / bus components, budget engine alerts and bus publishes, error handler, project CRUD and memory activity, auth audit events, retention sweep (manual and scheduled) and budget-evaluation tasks |
| `SIMULATED` | Emitted by the DEMO generators | Seeded traces, simulated agent runs and `simulateAgentActivity` (their memory / tool / context / bus events), the `Demo Project` creation activity, `DEMO_SEED` tasks |

`UNAVAILABLE` is not a stored value. It is a *status* of an instrumentation source in the registry (`GET /api/observability/sources`).

How sources are determined (`modules/observability/sources.ts`): counts per `source` are read from the database each time; nothing is hard-coded.

| Registry entry | Status rule |
|---|---|
| `request-lifecycle` (request) | `CONNECTED`: the request-lifecycle middleware registers itself in the runtime registry and the pipeline emits ACTUAL events (note says "No events recorded yet." when empty) |
| `memory-injection` (memory), `event-bus` (bus), `tool-calls` (tool), `context-lifecycle` (context) | `CONNECTED` when `getRuntime(deps)` has registered the real `MemoryStore` / `EventBus` / `ToolExecutor` / `ContextManager` (every normal server and test app does, at router construction), **even with zero events**. Counts split ACTUAL vs SIMULATED from the database; simulated rows are mentioned in the note as counted separately. If a kind were not registered it would be `SIMULATED_ONLY` (only simulated rows) or `UNAVAILABLE`, and ACTUAL rows without a registered component are flagged as unverified |
| `error-handler` (error) | `CONNECTED` (HTTP error handler and pipeline failures are recorded as ACTUAL). Provider failures from the mock are tagged with the trace's source, so they count as SIMULATED when seeded |
| `demo-simulator` (kind `simulator`) | always `SIMULATED_ONLY`; counts = every SIMULATED memory + bus + tool + context row. This entry makes it explicit that the demo generator exists and is separate from the real components |

### 5.3 Honesty rules

1. Simulated data is never labelled `ACTUAL`. Demo generators pass `source: 'SIMULATED'` explicitly.
2. A live provider request is a real execution of this app's pipeline (context, memory, tools, bus, cost, persistence, budgets), so its trace / spans are `ACTUAL`, but the provider span carries
   `simulated: true` and all usage events and API responses carry `simulated: true` and `label: "DEMO / SIMULATED"`.
3. The overview splits operation counts into `bySource.actual` and `bySource.simulated`; the UI shows both and a SourceBadge on each event.
4. Memory / tool / context / bus events carry their own `source` badge. Real ones (project memory injection, local tool calls, request context, bus operations of the pipeline) are `ACTUAL`; agent-run / seeded demo events are `SIMULATED`; the sources panel lists the demo generator as its own entry. `CONNECTED` means "a real in-app component is wired", not "an external agent is attached".
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

- **SQLite is the source of truth.** JSONL files are an append-only on-disk mirror of `ExecutionLog` (exactly one JSON object per
  physical line: CR/LF/ESC/control characters and U+2028 / U+2029 / U+0085 are escaped, so a message cannot forge a line). A day file rolls over to `execution-YYYY-MM-DD.N.jsonl` at 50 MB; the whole directory is capped at 500 MB (`LOG_DIR_MAX_MB`; oldest day files are deleted first, then appends are suspended with one warning while DB logging continues); lines are written in async batches (about every 250 ms; write-through under tests) and flushed on exit. Exports are generated from SQLite, not from the files.
- **Request lifecycle middleware** (`middleware.ts`, mounted on `/api`): assigns `x-request-id` (an incoming
  header matching `[A-Za-z0-9._-]{8,64}` is honoured, anything else is replaced), measures duration, and on `finish` writes an `ExecutionLog` row (category `REQUEST`,
  operation `METHOD /route-pattern`). Status/level: `<400` SUCCESS/INFO, `4xx` INFO status with WARN level, `>=500` FAILURE/ERROR.
  **Successful GET/HEAD/OPTIONS are not logged**, and `/api/health` never is. Because it runs before authentication, `401`, `429` and unmatched-route `404` responses are only counted and flushed as one aggregated `request.rejected.summary` log per minute, and detailed rows are capped at 1,200 per minute (flood protection). It does not create traces itself, but handlers that start one (provider requests, agent runs, tool invocations) set `res.locals.traceId` / `projectId`: the request log row then carries the `traceId`, and the trace attributes and `UsageEvent.metadata` carry `httpRequestId` (= the `x-request-id`), so an HTTP log line, its trace and its usage event can be joined. (The pipeline's own `UsageEvent.requestId` is still a different id, `req_<uuid>`.)
- **Exports** (`GET /export/:dataset?format=jsonl|csv`): datasets `activity, traces, logs, errors, memory, bus, tools, context, alerts, tasks`.
  Rows are streamed from SQLite in cursor-paged batches of 500 (no full in-memory load); a filter matching more than 250,000 rows (`EXPORT_MAX_ROWS`) is refused with 400 unless `limit=<n>` is given, with `Content-Disposition: attachment`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. CSV cells are RFC 4180 escaped with a formula-injection guard. Usage CSV is at `/usage/export.csv` and is streamed in keyset batches of 500 with the same formula guard (including TAB / CR).
- **Retention** (`logging/retention.ts`): setting `retentionDays` (default 30; `0` = keep forever). `POST /api/logging/retention/run`
  (the Settings page button) records a `RETENTION_SWEEP` background task and deletes `ExecutionLog`, `MemoryEvent`, `BusEvent`, `ToolCallEvent`,
  `ContextEvent` rows older than the cutoff, finished traces (`OK`/`ERROR`, spans cascade) older than the cutoff, and JSONL files whose whole UTC day is
  older than the cutoff. It does **not** delete usage events, activity events, budget alerts, background tasks, projects, budgets, users, sessions or memory items.
- **Retention scheduler** (`logging/scheduler.ts`, started by `server.ts`): the same sweep runs automatically 60 s after start and then every 6 h (the next run is armed only after the previous one finished, so runs never overlap; the timer is `unref`'d). `retentionDays = 0` skips the run (no task row). Each run is an ACTUAL `RETENTION_SWEEP` task with `result.trigger = "scheduled"` (manual runs: `"manual"`); failures are recorded as FAILED tasks and scheduling continues.
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
The dashboard (`dashboard/budgetUtil.ts`) no longer has its own period math: it calls the budgets module's `periods.ts` and `utilizationFor`, so `GET /dashboard` and `GET /budgets/utilization` agree (the dashboard lists active budgets only; with a `projectId` it shows that project's budgets and the global ones).

**Evaluation** (`budgets/service.ts`): after each usage event `evaluateAfterUsage({projectId, at})` loads active budgets that are global or belong to the project and, for each, computes spend in the period containing `at`. `evaluateAll()` (via `POST /budgets/evaluate`, tracked as `BUDGET_EVALUATION` task) does the same for every active budget. Budgets of archived projects are dormant (not evaluated).

**Duplicate prevention** has three layers:

1. an application pre-check: existing alerts for `(budgetId, periodStart, threshold in crossed)` are skipped;
2. a DB unique index `BudgetAlert(budgetId, periodStart, threshold)`, the real backstop;
3. race handling when inserting: a unique violation (`P2002`), a missing budget (`P2003` / `P2025`, deleted meanwhile) resolve to "someone else already did it" and the insert returns `null`; SQLite contention (`P1008` / `P2034`) is retried up to 5 times with a short back-off.

A jump from 10 % to 120 % creates the 50, 80 and 100 alerts at once. Each new alert emits an activity event `budget.alert` (level `WARN`, source `ACTUAL`) and a bus `PUBLISH` operation `budget.alert.publish` (event `budget.threshold.crossed`, source `ACTUAL`) (an ACTUAL bus event, recorded next to the pipeline's own `usage.recorded` / `budget.evaluate` bus traffic). A real failure to insert is recorded as a `DATABASE` error.
The "one budget per (project or global, period)" rule is enforced in application code under an in-process mutex (a DB unique index cannot cover the nullable `projectId`), so it is not safe across multiple server processes.

## 10. Privacy model and sanitizer

The app must never put raw prompt / context / memory / secret content into logs, traces, events or exports.

- The prompt is hashed (`promptHash = sha256`) and measured (`promptChars`); the text is never persisted or logged.
- `UsageEvent.responseText` holds the **deterministic mock text**, not model output and not derived from the prompt.
- **Project memory content is user data and is stored on purpose** in `ProjectMemoryItem.content` (it must be, to be injected). It is returned only by `/projects/:id/memory`; the injection step, the memory routes, context events and tool calls record only counts, sizes, token estimates, categories and a short hash prefix. The text prepended to the prompt exists only in process memory during the request.
- Every metadata object passed to the SDK goes through `sanitizeAttributes` (`instrumentation/sanitize.ts`):
  keys matching `/(content|prompt|text|body|message|memory|secret|password|passwd|authorization|api[-_]?key|token$|cookie|session|csrf|credential|private)/i` are replaced by
  `{ redacted: true, type, length, sha256_8 }`, except numeric / boolean counters (not under credential keys) and keys with count-like suffixes
  (`...Hash, ...Chars, ...Count, ...Bytes, ...Tokens`); label-like suffixes (`...Id, ...Name, ...Type`) are kept only under non-credential keys (`sessionId` is redacted);
  credential-looking values (`Bearer`, `Basic`, `sk-`, JWT, GitHub / AWS / Slack tokens, scrypt / bcrypt / argon2 hashes, PEM keys) are redacted regardless of key and also inside free text;
  other strings are truncated to 256 chars; depth, item counts and serialised size are capped. Sanitising is idempotent.
- Free-text error messages / stacks / operation names are kept (they describe failures) but stripped of ANSI sequences and control characters, scrubbed of credential-looking substrings and bounded (2,000 / 8,000 chars).

Details and limits: [SECURITY.md](SECURITY.md).

## 11. Frontend structure

```
frontend/src/
├── main.tsx, App.tsx          router: public /login and /setup; everything else under RequireAuth -> Layout
├── index.css                  Tailwind layers
├── components/
│   ├── Layout.tsx             sidebar nav (lib/nav.ts), DEMO / SIMULATED banner, user menu, read-only banner for VIEWER, dark-mode toggle
│   ├── auth/                  AuthProvider (status / me / login / logout, CSRF token), RequireAuth, AuthShell, ChangePasswordCard, SessionsCard, UsersCard
│   ├── ui/                    Badge, Button, Card, PageHeader, State (loading / error), Table, Toast
│   ├── pricing/               Calculator, Compare, Catalog, New-version tabs and helpers (exact decimal math in math.ts)
│   ├── memory/                MemoryPanel (project memory CRUD), RuntimeSummary (memory / context / tools of a request)
│   ├── dashboard/ projects/ usage/ simulator/ budgets/ activity/ traces/ observability/   page-specific components
├── lib/
│   ├── api.ts                 fetch wrapper: api.get / list / post / patch / put / del / url; ApiRequestError; CSRF header, one-shot CSRF refresh, 401 handler, timeout and GET retry
│   ├── errors.ts, nav.ts, useApi.ts (useAsync hook, ignores stale responses), format.ts (string-based money formatting, ints, percentages, durations)
└── pages/                     Login, Setup, Dashboard, Projects, ProjectDetail, Usage, Simulator, Pricing, Budgets, Activity,
                               Traces, TraceDetail, Observability, Errors, Logs, Settings, Account
```

- Plain `fetch` through `lib/api.ts`; all paths are relative (`/api/...`), which works with the Vite proxy in dev and same-origin in production. The session is an HttpOnly cookie the script cannot read; the CSRF token lives only in memory and is re-fetched from `/auth/me` after a reload.
- When the server runs with `AUTH_ENABLED=false`, `/auth/status` reports it and the UI skips login, hides the user menu and shows no accounts on the Account page.
- State is local React state plus `useAsync`; list filters on the Usage page live in the URL query string so views are linkable.
- Types come from `shared/*.ts`; money stays a string end to end (the pricing calculator also does exact string / BigInt math in the browser, not floats).
- Charts use Recharts; styling is Tailwind with `dark:` variants.
- Stable `data-testid` attributes are used by the Playwright tests.
