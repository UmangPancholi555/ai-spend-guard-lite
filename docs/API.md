# REST API

Base URL: `http://localhost:4000/api` (also `http://localhost:5173/api` through the Vite dev proxy). The server binds to `127.0.0.1` by default (`HOST`).
**Every endpoint except `GET /health`, `GET /auth/status`, `POST /auth/setup` and `POST /auth/login` needs a logged-in session** (cookie `sg_session`);
state-changing calls also need the `X-CSRF-Token` header (section 1, "Authentication"). The one exception is `AUTH_ENABLED=false`, which turns all of this off (see [SECURITY.md](SECURITY.md)).
All provider traffic is a local simulation; responses and records carry `simulated: true` / `label: "DEMO / SIMULATED"` where the DTO says so.
Response types are defined in `shared/types.ts`; this document lists endpoints, parameters, status codes and examples.

Examples assume (log in once, then use `c` for every authenticated call; it sends the cookie jar and the CSRF header):

```bash
API=http://localhost:4000/api
# helper used below to pull one field out of a JSON response without extra tools
jid() { node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).data.'"${1:-id}"; }

# first run only, on an empty database (or use ADMIN_USERNAME / ADMIN_PASSWORD, or `npm run user:create`):
#   curl -s -X POST $API/auth/setup -H 'content-type: application/json' -d '{"username":"alice","password":"a-long-unique-passphrase"}'
JAR=$(mktemp)
CSRF=$(curl -s -c $JAR -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"username":"alice","password":"a-long-unique-passphrase"}' | jid csrfToken)
c() { curl -s -b $JAR -H "X-CSRF-Token: $CSRF" "$@"; }   # GETs ignore the header; POST/PATCH/PUT/DELETE need it
```

The `content-type: application/json` header is added explicitly in the examples that send a body. (Against a server started with `AUTH_ENABLED=false`, plain `curl -s` works.)

## 1. Conventions

### Envelopes

| Case | Shape |
|---|---|
| Single object / array | `{ "data": ... }` |
| Paged list | `{ "data": [...], "pagination": { "page": 1, "pageSize": 25, "total": 120, "totalPages": 5 } }` |
| No content | HTTP `204`, empty body (`DELETE` endpoints) |
| Error | `{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed", "details": ... } }` |
| File download | raw body with `Content-Disposition: attachment` (CSV / JSONL) |

Every `/api` response carries an `x-request-id` header. A client-supplied `x-request-id` matching `[A-Za-z0-9._-]{8,64}` is echoed back; anything else is replaced by a generated id. Request logging is flood-protected: `401`, `429` and unmatched-route `404` responses are never logged individually; they are counted in memory and flushed as at most one `request.rejected.summary` log per minute (counts by status only). Detailed request rows are capped at 1200/min (excess counted in the summary). JSONL files (`LOG_DIR`) are written in async batches (<=250ms), rolled over at 50MB per day file, and the whole directory is capped at `LOG_DIR_MAX_MB` (default 500): oldest day files are deleted first, then JSONL appends are suspended with one warning (DB rows are unaffected). Call `flushLogs()` on shutdown.

### Error codes

| HTTP | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Zod validation failed (`details` is a list of `{path, message}`), invalid JSON body (`"Invalid JSON body"`), `from` after `to`, bad price / amount, no updatable fields |
| 401 | `UNAUTHENTICATED` | No / expired / idle session cookie on a protected route (also for unknown `/api/*` paths) |
| 401 | `INVALID_CREDENTIALS` | Wrong username or password at `POST /auth/login` (identical for unknown users) |
| 403 | `CSRF_INVALID` | Missing or wrong `X-CSRF-Token` on a state-changing request |
| 403 | `FORBIDDEN` | `VIEWER` account on a write route, or a non-admin on `/auth/users*` |
| 403 | `FORBIDDEN_ORIGIN` | State-changing request whose `Origin` header is not localhost / 127.0.0.1 / `[::1]` |
| 403 | `INVALID_CURRENT_PASSWORD` | Wrong `currentPassword` at `POST /auth/password` (counts toward lockout) |
| 400 | `USE_PASSWORD_ENDPOINT` | An admin tries to set **their own** password through `PATCH /auth/users/:id` (use `POST /auth/password`) |
| 421 | `MISDIRECTED_REQUEST` | `Host` header is not localhost / 127.0.0.1 / `[::1]` or listed in `ALLOWED_HOSTS` |
| 404 | `AUTH_DISABLED` | Any `/auth/*` route except `/auth/status` when `AUTH_ENABLED=false` |
| 404 | `NOT_FOUND` | Unknown resource id, unknown export dataset, unknown `/api/*` route (`"Route not found"`) |
| 409 | `CONFLICT` | Duplicate project name, duplicate budget (project + period), archived project used for a request / seed, deleting a non-test project, duplicate username, 200 memory items per project reached |
| 409 | `SETUP_COMPLETE` | `POST /auth/setup` after a user already exists |
| 409 | `LAST_ADMIN` | Demoting or deleting the last `ADMIN` |
| 409 | `CANNOT_DELETE_SELF` | Deleting your own account |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body larger than 1 MB |
| 429 | `ACCOUNT_LOCKED` | 5 consecutive failed logins from one address for one username (15-minute lock for that username + address pair), or the progressive per-username lock after 10 failures from any address (`Retry-After`) |
| 429 | `RATE_LIMITED` | General API limit (default 600 requests / minute / IP) or the per-IP login limit (`Retry-After`) |
| 500 | `INTERNAL_ERROR` | Unexpected error (the stack is never returned; it is recorded as an ACTUAL error event) |
| 502 | `TOOL_FAILED` | A local tool failed after its retries (`POST /tools/:name/invoke`); the message is generic (`details: {toolCallId, attempts}`), the cause is in the ACTUAL tool / error events |
| 500 | `PRICING_UNAVAILABLE` | No pricing row for the model *and* the `*/*` fallback row is missing |

### Authentication

- Cookie `sg_session` (`__Host-sg_session` when `COOKIE_SECURE=true`; HttpOnly, `SameSite=Strict`, `Secure` when `COOKIE_SECURE=true`) is set by `POST /auth/login` and `POST /auth/setup` and cleared by `POST /auth/logout`. Sessions last `SESSION_TTL_HOURS` (default 12) and expire after 30 minutes without a request.
- `X-CSRF-Token: <data.csrfToken>` is required on every `POST` / `PUT` / `PATCH` / `DELETE` after login (not on login / setup themselves). Missing or wrong: `403 CSRF_INVALID`. The token is returned by login, setup and `GET /auth/me` and stays valid for that session.
- Roles: `ADMIN` may do everything; `VIEWER` may only read (plus `POST /auth/logout`, `POST /auth/password`, `POST /cost/calculate`, `DELETE /auth/sessions/:id`). Other writes: `403 FORBIDDEN`.
- Browsers: a cross-site `Origin` on a write is refused with `403 FORBIDDEN_ORIGIN` before anything else runs.
- Rate limit headers on every `/api` response: `RateLimit-Limit`, `RateLimit-Remaining`; `Retry-After` on `429`.
- Authenticated responses are `Cache-Control: no-store`.

### Pagination, sorting, dates

- Paged endpoints accept `page` (>= 1, default 1) and `pageSize` (1..200, default 25). On `/projects`, `/projects/:id/activity` and `/usage`, `page` is capped at 10000 (400 above that); repeated or array query parameters (`?status=a&status=b`, `?search[x]=1`) are a 400. Lists are newest first unless a `sort` parameter says otherwise.
- Dates (`from`, `to`) are ISO-8601. `to` is **inclusive**; a date-only value (`2026-11-23`) means the whole UTC day (`from` -> 00:00:00.000Z, `to` -> 23:59:59.999Z). `from` after `to` -> 400.
- Observability / activity / traces / logs / export / budget endpoints treat empty query values (`?status=`) as "not provided". `/usage` and `/projects` validate them (an empty `provider=` is a 400), so omit unused parameters there.
- Text `search` is a case-insensitive (ASCII) substring match. On `/usage` and `/projects`, `%`, `_` and `\` typed by the user are matched literally.
- Unknown query parameters are ignored.

### Money

All money in JSON is a **decimal string with 12 fraction digits** (e.g. `"0.000064480000"`). Prices are strings with 6 fraction digits (USD per 1M tokens). Never parse them as floats for accounting.

---

## 2. Health

### `GET /health`
Public (no session). `200` `{ "data": { "status": "ok", "version": "0.1.0", "simulated": true, "label": "DEMO / SIMULATED", "time": "<ISO>" } }`. Not written to the execution log.

```bash
curl -s $API/health
```

## 2a. Authentication and users

Source: `backend/src/modules/auth/router.ts`, DTOs in `shared/auth.ts`. Rules (lockout, hashing, sessions) are in [SECURITY.md](SECURITY.md).
When the server runs with `AUTH_ENABLED=false`, only `GET /auth/status` exists (`{ authEnabled: false, setupRequired: false, authenticated: false }`); every other `/auth/*` route answers `404 AUTH_DISABLED`.

| Method & path | Access | Body / notes | Success | Errors |
|---|---|---|---|---|
| `GET /auth/status` | public | `AuthStatusDto`: `authEnabled, setupRequired (true while no user exists), authenticated, user?` | 200 | |
| `POST /auth/setup` | public, only while zero users exist | `{ username, password }` -> creates the first `ADMIN`, logs in, sets the cookie. `data: { user, csrfToken }` | 201 | 400 (username / password policy), 409 `SETUP_COMPLETE`, 429 |
| `POST /auth/login` | public | `{ username, password }`. Rotates the session (the presented cookie's session is deleted). `data: { user, csrfToken }`. Cookie name is `sg_session`, or `__Host-sg_session` when `COOKIE_SECURE=true` | 200 | 400, 401 `INVALID_CREDENTIALS`, 429 `ACCOUNT_LOCKED` / `RATE_LIMITED` |
| `GET /auth/me` | any role | `data: { user, csrfToken }` (use it to restore the CSRF token after a page reload) | 200 | 401 |
| `POST /auth/logout` | any role | deletes the session, clears the cookie. `data: { loggedOut: true }` | 200 | 401, 403 `CSRF_INVALID` |
| `POST /auth/password` | any role | `{ currentPassword, newPassword }`. Revokes all your **other** sessions. `data: { changed: true, otherSessionsRevoked }` | 200 | 400 (policy), 403 `INVALID_CURRENT_PASSWORD`, 429 `ACCOUNT_LOCKED` |
| `GET /auth/sessions` | any role | your own sessions: `UserSessionDto[]` (`id, createdAt, lastSeenAt, expiresAt, ip, userAgent, current`); never tokens | 200 | 401 |
| `DELETE /auth/sessions/:id` | any role | revoke one of your own sessions | 204 | 404 |
| `GET /auth/users` | ADMIN | `ManagedUserDto[]`: user + `failedAttempts, lockedUntil, locked, activeSessions` | 200 | 403 |
| `POST /auth/users` | ADMIN | `{ username, password, role: "ADMIN" \| "VIEWER" }` | 201 | 400, 403, 409 `CONFLICT` |
| `PATCH /auth/users/:id` | ADMIN | at least one of `{ role?, password?, unlock? }` (a password reset revokes that user's sessions and clears their lockouts; `unlock: true` clears the lockout; an admin cannot set their **own** password here: `400 USE_PASSWORD_ENDPOINT`) | 200 | 400, 403, 404, 409 `LAST_ADMIN` |
| `DELETE /auth/users/:id` | ADMIN | sessions cascade | 204 | 403, 404, 409 `CANNOT_DELETE_SELF` / `LAST_ADMIN` |

Username: 3-32 characters of `a-z 0-9 . _ -` (stored lower-case). Password: 12-128 characters, must not contain the username, must not be a common / repeated / sequential password.
Auth events are recorded as activity events `auth.setup`, `auth.login.success|failure|locked`, `auth.logout`, `auth.password.changed`, `auth.user.created|updated|deleted`.

```bash
curl -s $API/auth/status                          # {"data":{"authEnabled":true,"setupRequired":false,"authenticated":false}}
c $API/auth/me
c -X POST $API/auth/users -H 'content-type: application/json' \
  -d '{"username":"reader","password":"another-long-passphrase","role":"VIEWER"}'
c -X PATCH $API/auth/users/<userId> -H 'content-type: application/json' -d '{"unlock":true}'
c $API/auth/sessions
c -X POST $API/auth/logout
curl -s -X POST $API/projects -H 'content-type: application/json' -d '{"name":"x"}'
# {"error":{"code":"UNAUTHENTICATED","message":"Authentication required"}}
```

## 3. Dashboard

### `GET /dashboard`
Aggregates persisted data only (archived projects included). Returns `DashboardStats`.

| Query | Type | Default | Notes |
|---|---|---|---|
| `days` | int 1..365 | 30 | window = today (UTC) and the previous `days - 1` days |
| `projectId` | string | - | restrict to one project; `404` if it does not exist |

Response fields: `range`, `simulated`, `label`, `totals` (`spendUsd, requests, successes, failures, successRate (0..1), inputTokens, outputTokens, cachedTokens`),
`providerBreakdown[]`, `modelBreakdown[]` (sorted by cost desc), `dailySpend[]` (one entry per UTC day, zero-filled), `budgetUtilization[]` (**active** budgets only, current period, same period math and numbers as `/budgets/utilization`; with `projectId` that project's budgets **and** the global budgets),
`recentActivity[]` (10), `recentErrors[]` (10 failed usage events), `recentAlerts[]` (10; with `projectId`: alerts of that project's budgets and of global budgets). `dailySpend` is a single grouped SQL query (exact int64 sums).

```bash
c "$API/dashboard?days=7"
```

## 4. Projects

`ProjectWithUsage` = project fields (`id, name, description, status ACTIVE|ARCHIVED, isTest, createdAt, updatedAt, archivedAt`) + `usage` (`requests, successes, failures, inputTokens, outputTokens, cachedTokens, costUsd, lastActivityAt`).

| Method & path | Description | Success | Errors |
|---|---|---|---|
| `GET /projects` | List. Query: `status` (`ACTIVE`/`ARCHIVED`), `includeTest` (`true`/`false`, default `true`), `search` (substring of **name or description**, max 200), `page`, `pageSize`. Newest first. | 200 paged | 400 |
| `POST /projects` | Body `{ name (1..80, trimmed, no control characters), description? (<= 1000, no control characters except tab/newline), isTest? (bool) }`. Names are unique case-insensitively across **all** projects, archived included. | 201 | 400, 409 |
| `GET /projects/:id` | One project with usage. | 200 | 404 |
| `PATCH /projects/:id` | Body `{ name?, description? (string or null), isTest? }`. No-op if nothing changed. | 200 | 400, 404, 409 |
| `POST /projects/:id/archive` | Idempotent. Archived projects reject new provider requests (409). | 200 | 404 |
| `POST /projects/:id/unarchive` | Idempotent. | 200 | 404 |
| `DELETE /projects/:id` | Only `isTest = true` projects; cascades usage events, budgets and alerts. | 204 | 404, 409 |
| `GET /projects/:id/activity` | Paged `ActivityEventDto` for that project. Query `page`, `pageSize`. | 200 paged | 404 |

Create / update / archive / unarchive / delete emit activity events `project.created|updated|archived|unarchived|deleted` (source `ACTUAL`).

```bash
# create a test project and keep its id
PID=$(c -X POST $API/projects -H 'content-type: application/json' \
  -d '{"name":"Docs Demo","description":"curl example","isTest":true}' | jid id)
echo $PID

# duplicate name -> 409
c -X POST $API/projects -H 'content-type: application/json' -d '{"name":"docs demo"}'
# {"error":{"code":"CONFLICT","message":"A project named \"Docs Demo\" already exists","details":{"field":"name"}}}

c "$API/projects?status=ACTIVE&includeTest=true&search=demo"
c -X PATCH  $API/projects/$PID -H 'content-type: application/json' -d '{"description":null}'
c -X POST   $API/projects/$PID/archive
c -X DELETE $API/projects/$PID -i        # 204 for a test project
```

## 5. Providers and request simulation

### `GET /providers`
`200` `{ data: ProviderDto[] }`: `key` (`openai`/`anthropic`), `displayName`, `isSimulated: true`, `label`, `models[]` (`name, displayName, contextWindow, active`).

### `POST /providers/requests`
Runs the [mock pipeline](ARCHITECTURE.md#4-the-mock-request-pipeline). Returns **201** even when the *simulated* provider failed (`status: "FAILURE"` plus an `error` object); usage is recorded either way.

| Body field | Type | Notes |
|---|---|---|
| `projectId` | string (required) | `404` if missing, `409` if archived |
| `provider` | `openai` \| `anthropic` (required) | |
| `model` | string 1..100 (required) | unknown names allowed, priced with the fallback (`costClass: ESTIMATED`) |
| `prompt` | string 1..20000 (required) | **never stored**; only sha256 + length |
| `maxOutputTokens` | int 1..8192 | engine default 256 |
| `temperature` | number 0..2 | |
| `simulateFailure` | `none` \| `error` \| `timeout` \| `rate_limit` | default `none` |
| `simulateAgentActivity` | boolean | default `false`; also emits SIMULATED context / memory / bus / tool events on the same trace (demo generator; the real runtime events below are emitted regardless) |
| `injectMemory` | boolean | default `true`: prepend the project's enabled memory items (real `MemoryStore`) to the provider prompt; `false` skips injection |

Response `MockProviderResponse`: `requestId, traceId, simulated, label, provider, model, projectId, status, content (null on failure), finishReason (stop|length|error), usage {inputTokens, outputTokens, cachedTokens}, cost (CostBreakdown), durationMs (simulated), error?, budgetAlerts[], usageEventId`, plus the real-runtime summaries (metadata only, no content):
`memory { injected, items, estimatedTokens, truncated, droppedItems }`, `context { contextId, version, sizeBytes, estimatedTokens, windowTokens, truncated }`, `tools[]` (`name, toolCallId, status SUCCESS|FAILURE, attempts, durationMs` for the `pricing.lookup` and `budget.status` preflight calls), `budgetPreflight { status OK|UNAVAILABLE, budgets, highestPercent, overLimit }`, `httpRequestId`.
The same `memory` / `context` / `tools` / `budgetPreflight` objects are stored in `UsageEvent.metadata`. With memory items present, token counts reflect prompt **plus** injected memory.
Simulated error codes: `PROVIDER_ERROR` (HTTP 500-style), `PROVIDER_TIMEOUT`, `RATE_LIMITED`.

```bash
c -X POST $API/providers/requests -H 'content-type: application/json' -d "{
  \"projectId\":\"$PID\",\"provider\":\"openai\",\"model\":\"gpt-4o-mini\",
  \"prompt\":\"Summarise this\",\"maxOutputTokens\":128}"
# {"data":{"requestId":"req_...","traceId":"...","simulated":true,"label":"DEMO / SIMULATED",
#  "memory":{"injected":false,"items":0,...},"context":{"version":2,...},"tools":[{"name":"pricing.lookup",...},{"name":"budget.status",...}],
#  "status":"SUCCESS","finishReason":"length","usage":{"inputTokens":4,"outputTokens":128,"cachedTokens":0},
#  "cost":{"totalCostUsd":"0.000064480000","costClass":"SIMULATED","pricingVersion":2,...},"budgetAlerts":[],...}}

# simulated failure, with agent activity on the trace
c -X POST $API/providers/requests -H 'content-type: application/json' -d "{
  \"projectId\":\"$PID\",\"provider\":\"anthropic\",\"model\":\"claude-haiku\",
  \"prompt\":\"hello\",\"simulateFailure\":\"timeout\",\"simulateAgentActivity\":true}"
```

### `POST /simulations/seed`
Generates deterministic, **backdated** simulated requests through the same pipeline (in `silent` runtime mode with memory injection off: no runtime events and no tool calls are written for the bulk requests); runs inline and returns when finished; tracked as a `DEMO_SEED` background task (source `SIMULATED`).

| Body field | Type | Default |
|---|---|---|
| `projectId` | string | omitted: uses / creates the test project **"Demo Project (simulated)"** (`409` if that project is archived) |
| `requests` | int 1..2000 | required |
| `spreadDays` | int 1..365 | required |
| `includeFailures` | boolean | `true` (~6 % of requests fail) |
| `includeAgentActivity` | boolean | `false` (the newest <= 25 requests get a SIMULATED trace with agent activity) |
| `seed` | string \| int | optional PRNG seed to vary the batch; same parameters give the same batch |

`201` `{ data: { taskId, created, projectId, failures } }`. Errors: 400, 404 (unknown `projectId`), 409 (archived project).

```bash
c -X POST $API/simulations/seed -H 'content-type: application/json' \
  -d '{"requests":60,"spreadDays":7,"includeFailures":true,"includeAgentActivity":true}'
# {"data":{"taskId":"...","created":60,"projectId":"...","failures":2}}
```

### `POST /simulations/agent-run`
Body `{ projectId (required), simulateFailure? ('none'|'error'|'timeout'|'rate_limit', default 'none') }`. Emits one **SIMULATED demo** agent execution (`agent.run` trace; scripted events, not produced by the real runtime) with context, memory, bus and tool events (including one tool retry) and **no usage event**. A non-`none` failure mode deterministically fails one step (`error` -> memory, `rate_limit` -> bus, `timeout` -> tool).
`201` `{ data: { traceId, requestId, status: "SUCCESS"|"FAILURE", simulated, label, error?: {message} } }`. Errors: 400, 404, 409.

```bash
c -X POST $API/simulations/agent-run -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PID\",\"simulateFailure\":\"timeout\"}"
```

## 5a. Project memory and local tools (real runtime)

Implemented by `backend/src/modules/runtime/*`; DTOs in `shared/runtime.ts`. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md#4a-the-real-runtime-modulesruntime).

### Project memory
`MemoryItemDto`: `id, projectId, title, category (instructions|preferences|facts|other), content, enabled, sizeBytes, estimatedTokens (ceil(chars/4), min 1), createdAt, updatedAt`.
Limits: title 1..120 chars, content 1..8000 chars, 200 items per project. Enabled items are injected into provider requests of that project, oldest first.
**Content is user data**: it is returned here and nowhere else (logs, events and exports only carry ids, sizes, token estimates and a hash prefix).

| Method & path | Description | Success | Errors |
|---|---|---|---|
| `GET /projects/:id/memory` | All items of the project (oldest first, not paged). | 200 | 404 |
| `POST /projects/:id/memory` | Body `{ title, category, content, enabled? (default true) }`. | 201 | 400, 404, 409 (limit) |
| `PATCH /projects/:id/memory/:itemId` | Body with at least one of `title, category, content, enabled`. | 200 | 400, 404 |
| `DELETE /projects/:id/memory/:itemId` | | 204 | 404 |

Writes record `project.memory.created|updated|deleted` activity (ACTUAL, metadata only). Archived projects can still be edited.

### Local tools
Real, read-only local tools executed by the `ToolExecutor` (Zod-validated input, up to 2 retries with 20 / 40 ms back-off for transient errors only, a TOOL span and tool events per call; `inputMeta` stores parameter names, types, sizes and a hash, never values).

| Tool | Params | Output |
|---|---|---|
| `pricing.lookup` | `provider` (string), `model` (string) | `inputPerMTok, outputPerMTok, cachedPerMTok, pricingVersion, costClass, unknownModel` |
| `budget.status` | `projectId` | `count, highestPercent, overLimit, budgets[]` (project and global budgets, current period) |
| `usage.summary` | `projectId`, `days` (1..365, default 7) | `requests, failures, inputTokens, outputTokens, cachedTokens, costUsd` |

| Method & path | Description | Success | Errors |
|---|---|---|---|
| `GET /tools` | `ToolDescriptorDto[]`: `name, description, params[], maxRetries, source: "ACTUAL"`. | 200 | |
| `POST /tools/:name/invoke` | Body `{ input: { ... } }`. Starts a `tool.invoke` trace (ACTUAL). `200` `{ data: { output, traceId, toolCallId, attempts, durationMs } }`. ADMIN only (VIEWER gets 403). | 200 | 400 (invalid input), 404 (unknown tool), 502 `TOOL_FAILED` |

```bash
c $API/projects/$PID/memory
c -X POST $API/projects/$PID/memory -H 'content-type: application/json' \
  -d '{"title":"Tone","category":"instructions","content":"Answer in one short paragraph."}'
c $API/tools
c -X POST $API/tools/pricing.lookup/invoke -H 'content-type: application/json' \
  -d '{"input":{"provider":"openai","model":"gpt-4o-mini"}}'
c -X POST $API/tools/budget.status/invoke -H 'content-type: application/json' -d "{\"input\":{\"projectId\":\"$PID\"}}"
```

## 6. Usage

`UsageEventDto`: `id, requestId, projectId, projectName?, provider, model, status, errorCode, errorMessage, inputTokens, outputTokens, cachedTokens, costUsd, costClass, pricingVersion, durationMs, simulated: true, label, traceId, createdAt`.
`UsageEventDetail` adds `inputCostUsd, outputCostUsd, cachedCostUsd, pricingConfigId, promptHash, promptChars, responseText (deterministic mock text), metadata`.

### `GET /usage`
| Query | Notes |
|---|---|
| `search` | substring of request id, model, provider, error message, trace id or project name |
| `provider`, `model`, `projectId` | exact match |
| `status` | `SUCCESS` \| `FAILURE` |
| `from`, `to` | on `createdAt`; date-only `to` covers the whole day |
| `sort` | `createdAt` (default) \| `costUsd` \| `durationMs` |
| `order` | `desc` (default) \| `asc` |
| `page`, `pageSize` | |

### `GET /usage/filters`
`{ data: { providers: string[], models: {provider, model}[] } }`: union of active catalog models and models seen in usage (includes unknown models that have been used).

### `GET /usage/export.csv`
Same filters as `GET /usage` (no paging or sorting, newest first, **all** matching rows). The body is streamed in keyset batches of 500 rows (constant memory); filter errors are returned as a normal JSON 400 before streaming starts. `Content-Type: text/csv; charset=utf-8`,
`Content-Disposition: attachment; filename="usage-export-YYYY-MM-DD.csv"`. Columns: `request_id, created_at, project_id, project_name, provider, model, status, error_code, input_tokens, output_tokens, cached_tokens, cost_usd, cost_class, pricing_version, duration_ms, trace_id, simulated`. Cells starting with `= + - @` (non-numeric), TAB or CR are prefixed with `'` to defuse spreadsheet formulas.

### `GET /usage/:id`
`:id` is the usage event id **or** its `requestId`. `404` if neither matches.

```bash
c "$API/usage?status=FAILURE&sort=costUsd&order=desc&pageSize=5"
c "$API/usage?search=gpt-4o&from=2026-11-01&to=2026-11-30"
c -OJ "$API/usage/export.csv?status=FAILURE&from=2026-11-01"
c $API/usage/req_0123456789abcdef   # by requestId
```

## 7. Cost and pricing

### `POST /cost/calculate`
Body `{ provider, model, inputTokens, outputTokens, cachedTokens?, at? }` (token counts: non-negative safe integers; `at`: ISO date selecting the pricing version effective then, default now). `provider` is lower-cased. Returns `CostBreakdown`:
`currency, inputCostUsd, outputCostUsd, cachedCostUsd, totalCostUsd, costClass (SIMULATED|ESTIMATED), unknownModel, pricingConfigId, pricingVersion, pricing {inputPerMTok, outputPerMTok, cachedPerMTok}`.
`inputTokens` are the **non-cached** input tokens; cached tokens are billed separately at the cached rate.

```bash
c -X POST $API/cost/calculate -H 'content-type: application/json' \
  -d '{"provider":"openai","model":"gpt-4o-mini","inputTokens":1000,"outputTokens":500,"cachedTokens":200,"at":"2024-06-01T00:00:00Z"}'
# totalCostUsd "0.000465000000", pricingVersion 1 (v1 was effective on 2024-06-01)

c -X POST $API/cost/calculate -H 'content-type: application/json' \
  -d '{"provider":"openai","model":"made-up","inputTokens":10,"outputTokens":10}'
# costClass "ESTIMATED", unknownModel true, fallback prices 5.000000 / 15.000000
```

### `GET /cost/pricing`
| Query | Notes |
|---|---|
| `provider`, `model` | filters (provider lower-cased) |
| `history` | `false` -> only the currently effective version per model; default `true` (all versions) |

Returns `PricingDto[]`: `id, providerKey, modelName, version, inputPerMTok, outputPerMTok, cachedPerMTok, currency, effectiveFrom, note, createdAt, isCurrent`. The fallback row is `providerKey "*"`, `modelName "*"`.

### `POST /cost/pricing`
Creates a **new version** (`max + 1`); existing versions are immutable.

| Body field | Rule |
|---|---|
| `provider` | lowercase slug (`^[a-z0-9][a-z0-9._-]*$`) or `*` |
| `model` | `[A-Za-z0-9][A-Za-z0-9._:/@+-]*` or `*` (`*` is valid only for both provider and model) |
| `inputPerMTok`, `outputPerMTok`, `cachedPerMTok` | non-negative decimal strings, <= 6 fraction digits |
| `effectiveFrom` | ISO, default now; must not be earlier than the latest existing version's `effectiveFrom` (400) |
| `note` | <= 500 chars |

`201` `PricingDto`.

```bash
c -X POST $API/cost/pricing -H 'content-type: application/json' \
  -d '{"provider":"openai","model":"gpt-4o-mini","inputPerMTok":"0.100000","outputPerMTok":"0.400000","cachedPerMTok":"0.050000","note":"docs example"}'
```

## 8. Budgets and alerts

`BudgetDto`: `id, projectId (null = global), projectName, name, period (DAILY|WEEKLY|MONTHLY), limitUsd, active, createdAt, updatedAt`.
Periods are UTC: DAILY = UTC day, WEEKLY = ISO week from Monday 00:00 UTC, MONTHLY = UTC calendar month. Spend = sum of usage cost in the period (global budget: all projects).

| Method & path | Description | Success | Errors |
|---|---|---|---|
| `GET /budgets` | Query `projectId?`. Returns `BudgetDto[]` (not paged). | 200 | |
| `POST /budgets` | Body `{ projectId? (string or null), name (1..80), period, limitUsd (positive decimal string, <= 12 dp), active? }`. One budget per (project or global, period). | 201 | 400, 404 (project), 409 |
| `PATCH /budgets/:id` | Body with at least one of `name`, `limitUsd`, `active`. Period and project cannot be changed. | 200 | 400, 404 |
| `DELETE /budgets/:id` | Cascades its alerts. | 204 | 404 |
| `GET /budgets/utilization` | Query `projectId?`. `BudgetUtilization[]` for the **current period** of every budget (inactive ones included): `budget, periodStart, periodEnd, spendUsd, limitUsd, percent (can exceed 100), highestThresholdReached (50|80|100|null)`. | 200 | |
| `GET /budgets/:id/utilization` | Query `periods` (0..60, default 6). Current utilization + `history[]` of previous periods (oldest first). | 200 | 400, 404 |
| `POST /budgets/evaluate` | Re-evaluates every active budget now, records a `BUDGET_EVALUATION` task, returns only **newly created** `BudgetAlertDto[]`. | 200 | |
| `GET /budget-alerts` | Query `budgetId`, `projectId`, `threshold` (50\|80\|100), `from`, `to`, `page`, `pageSize` (on alert `createdAt`). | 200 paged | 400 |

Alerts are created automatically after each provider request (included in `budgetAlerts` of the response) at **50 %, 80 % and 100 %** of the limit, at most once per budget + period + threshold. Budgets of archived projects are not evaluated.
`BudgetAlertDto`: `id, budgetId, budgetName, projectId, projectName, period, threshold, periodStart, periodEnd, spendUsd, limitUsd, percent, createdAt`.

```bash
c -X POST $API/budgets -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PID\",\"name\":\"Daily cap\",\"period\":\"DAILY\",\"limitUsd\":\"0.000100\"}"
# second DAILY budget for the same project -> 409 CONFLICT {"details":{"existingBudgetId":"..."}}

c "$API/budgets/utilization?projectId=$PID"
c "$API/budgets/<budgetId>/utilization?periods=3"
c -X POST $API/budgets/evaluate
c "$API/budget-alerts?threshold=100&from=2026-11-01"
c -X PATCH $API/budgets/<budgetId> -H 'content-type: application/json' -d '{"limitUsd":"5.00","active":true}'
```

## 9. Activity, traces, background tasks

### `GET /activity`
Paged `ActivityEventDto` (`id, type, level INFO|WARN|ERROR, message, source, projectId, projectName, traceId, requestId, metadata, createdAt`).

| Query | Notes |
|---|---|
| `type` | exact; comma-separated list allowed (`usage.recorded,request.failed`) |
| `level` | `INFO` \| `WARN` \| `ERROR` |
| `source` | `ACTUAL` \| `SIMULATED` |
| `projectId`, `traceId` | exact |
| `search` | substring of message or type |
| `from`, `to`, `page`, `pageSize` | on `createdAt` |

Event types emitted by the app include `project.created|updated|archived|unarchived|deleted`, `usage.recorded`, `request.failed`, `budget.alert`, `settings.updated`, `simulation.seeded`, `agent.run.completed`, `agent.run.failed`.

### `GET /traces`
Paged `TraceDto` (`traceId, name, projectId, requestId, status RUNNING|OK|ERROR, source, startedAt, endedAt, durationMs, errorMessage, stack, spanCount`).
Query: `status`, `source`, `projectId`, `search` (name, trace id or request id), `from`, `to` (on `startedAt`), `page`, `pageSize`.

### `GET /traces/:traceId`
`TraceDetail`: `trace`, `spans[]` (flat, with `parentSpanId`, `kind` REQUEST|CONTEXT|MEMORY|BUS|TOOL|PROVIDER|COST|BUDGET|INTERNAL, `status`, `source`, `attributes`), and `timeline[]` (spans, typed events and logs merged and de-duplicated, sorted by time; failed entries have `status: "FAILURE"`). `404` if unknown (for example swept by retention).

### `GET /background-tasks`
Paged `BackgroundTaskDto` (`id, name, kind RETENTION_SWEEP|DEMO_SEED|BUDGET_EVALUATION|EXPORT|OTHER, status QUEUED|RUNNING|SUCCEEDED|FAILED, source, traceId, startedAt, endedAt, durationMs, result, errorMessage, stack, createdAt`).
Query: `status`, `kind`, `source`, `from`, `to` (on `createdAt`), `page`, `pageSize`.

```bash
c "$API/activity?type=usage.recorded,request.failed&level=ERROR&pageSize=5"
c "$API/traces?status=ERROR&source=SIMULATED"
c $API/traces/<traceId>
c "$API/background-tasks?kind=DEMO_SEED"
```

## 10. Observability

Defaults: `from`/`to` default to the **last 7 days** ending now. All endpoints are read-only.

| Endpoint | Query | Returns |
|---|---|---|
| `GET /observability/overview` | `from`, `to` | `ObservabilityOverview`: `range`, `totals` {`operations, successful, failed, memoryInjections, busOperations, toolCalls, contextUpdates, averageDurationMs, failureRate (0..1)`}, `bySource {actual, simulated}`, `recentErrors[]` (10), `recentTraces[]` (10). An *operation* = execution-log row with status SUCCESS or FAILURE. |
| `GET /observability/performance` | `from`, `to`, `bucket` (`hour`\|`day`; default hour when range <= 48 h) | `PerformanceStats`: avg / p95 (nearest-rank) for request, tool and memory-injection latency, `operationCounts`, per-`operations` stats, `slowOperations[]` (duration strictly above the `slowOperationMs` setting, max 20), `durationSeries[]` |
| `GET /observability/sources` | - | `InstrumentationSourceDto[]` (`id, kind (request, memory, bus, tool, context, error, simulator), name, status CONNECTED\|SIMULATED_ONLY\|UNAVAILABLE, actualEvents, simulatedEvents, lastEventAt, notes`): `CONNECTED` = a real in-app component is registered (project memory store, request context manager, local tool executor, in-process bus, request middleware, error recording); the separate `demo-simulator` entry is always `SIMULATED_ONLY`. See [honesty rules](ARCHITECTURE.md#52-source-semantics-actual-vs-simulated-vs-unavailable) |
| `GET /observability/errors` | `category` (VALIDATION, PROVIDER, TIMEOUT, TOOL, BUS, MEMORY, CONTEXT, DATABASE, INTERNAL, UNKNOWN), `search` (message, error message, operation, event type), `traceId`, `source`, `from`, `to`, `page`, `pageSize` | paged `ExecutionLogDto` where level = ERROR or status = FAILURE |
| `GET /observability/errors/groups` | same filters, no paging | `ErrorGroup[]` `{category, count, lastSeen}`, most frequent first |
| `GET /observability/memory-events` | `traceId`, `projectId`, `source`, `status` (STARTED\|SUCCESS\|FAILURE), `search`, `from`, `to`, `page`, `pageSize` | paged `MemoryEventDto` |
| `GET /observability/bus-events` | same, `status` SUCCESS\|FAILURE | paged `BusEventDto` |
| `GET /observability/tool-events` | same, `status` SUCCESS\|FAILURE | paged `ToolCallEventDto` |
| `GET /observability/context-events` | same, `status` SUCCESS\|FAILURE | paged `ContextEventDto` |

```bash
c "$API/observability/overview?from=2026-11-16&to=2026-11-23"
c "$API/observability/performance?bucket=day"
c $API/observability/sources
# memory / bus / tool / context are CONNECTED (real in-app components, even with 0 events); demo-simulator is SIMULATED_ONLY
c "$API/observability/errors/groups?source=SIMULATED"
c "$API/observability/tool-events?status=FAILURE&traceId=<traceId>"
```

## 11. Logs, exports, settings, retention

### `GET /logs` and `GET /logs/:id`
Paged `ExecutionLogDto` (`id, ts, level DEBUG|INFO|WARN|ERROR, eventType, category, operation, status STARTED|SUCCESS|FAILURE|INFO, source, traceId, spanId, requestId, projectId, durationMs, message, attributes, errorCategory, errorMessage, stack`).

| Query | Notes |
|---|---|
| `eventType` | exact, comma-separated list, or trailing-`*` prefix (`memory.injection.*`) |
| `category` | REQUEST, MEMORY, BUS, TOOL, CONTEXT, ERROR, SYSTEM, BUDGET, PROVIDER |
| `status`, `level`, `source`, `traceId`, `requestId`, `projectId` | exact |
| `search` | substring of the **operation** name |
| `from`, `to`, `page`, `pageSize` | on `ts` |

`GET /logs/:id` -> `404` if unknown.

### `GET /export/:dataset`
Streams all matching rows (newest first, no paging). `format=jsonl` (default, `application/x-ndjson`) or `format=csv` (`text/csv`; header row always written; objects serialised as JSON text; formula-injection guard also covers leading TAB / CR). Filename `spendguard-<dataset>-<UTC stamp>.<ext>`. Unknown dataset -> 404; bad filter or format -> 400. Rows are read in batches of 500 (bounded memory). **Row guard:** if the filter matches more than 250,000 rows (env `EXPORT_MAX_ROWS`) the request is rejected with `400 VALIDATION_ERROR` (`details: {total, maxRows}`) before any download header is sent; pass `limit=<n>` (1..cap) to export only the newest `n` rows. Response header `X-Total-Rows` = number of rows that will be streamed. `eventType` accepts at most 20 comma-separated values.

| Dataset | Filters (mirror the list endpoints, with the differences noted below) |
|---|---|
| `logs` | `eventType, category, status, level, source, traceId, requestId, projectId, search, from, to` |
| `errors` | `category, search, traceId, source, projectId, from, to` (level ERROR or status FAILURE) |
| `activity` | `type, level, source, projectId, traceId, search, from, to` |
| `traces` | `status, source, projectId, search, from, to` |
| `memory`, `bus`, `tools`, `context` | `traceId, status, source, projectId, search, from, to` |
| `alerts` | `budgetId, projectId, threshold, from, to` |
| `tasks` | `status, kind, source, from, to` |

Differences from the list endpoints: in `activity` exports `type` is an exact match (no comma list); in `errors` exports `search` covers operation, message and error message (not event type); `memory` / `bus` / `tools` / `context` exports accept `status=STARTED|SUCCESS|FAILURE` for every dataset, and `search` covers the same text columns as the corresponding `/observability/*-events` endpoint (without `errorMessage`).

The usage CSV is separate: `GET /usage/export.csv`.

```bash
c -OJ "$API/export/logs?format=jsonl&category=REQUEST&from=2026-11-23"
c -OJ "$API/export/errors?format=csv"
c "$API/export/nope"            # 404 NOT_FOUND
```

### `GET /settings`, `PUT /settings`
`AppSettings`: `{ retentionDays, slowOperationMs, captureContentPlaintext: false }`. Defaults: `30`, `500`, `false`.
`PUT` body (all optional, **unknown keys are rejected**): `retentionDays` int 0..3650 (`0` = keep forever), `slowOperationMs` int 1..600000, `captureContentPlaintext` may only be `false` (anything else -> 400). A real change records a `settings.updated` activity event.

```bash
c -X PUT $API/settings -H 'content-type: application/json' -d '{"retentionDays":14}'
# {"data":{"retentionDays":14,"slowOperationMs":500,"captureContentPlaintext":false}}
c -X PUT $API/settings -H 'content-type: application/json' -d '{"captureContentPlaintext":true}'   # 400
```

### `POST /logging/retention/run`
No body. Runs the retention sweep now, `200` `{ data: BackgroundTaskDto }` (`kind: RETENTION_SWEEP`, `result` = `{ trigger: "manual", retentionDays, skipped, cutoff, deleted {...per table, logFiles}, totalDeleted }`; the in-process scheduler (`startRetentionScheduler`: first run 60s after start, then every 6h, never overlapping, skipped when `retentionDays = 0`) creates the same task with `trigger: "scheduled"`). With `retentionDays = 0` it is a no-op with `skipped: true`.

```bash
c -X POST $API/logging/retention/run
```

---

## 12. Quick end-to-end walkthrough

```bash
API=http://localhost:4000/api
jid() { node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).data.'"${1:-id}"; }
JAR=$(mktemp)
CSRF=$(curl -s -c $JAR -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"username":"alice","password":"a-long-unique-passphrase"}' | jid csrfToken)   # your own account
c() { curl -s -b $JAR -H "X-CSRF-Token: $CSRF" "$@"; }

PID=$(c -X POST $API/projects -H 'content-type: application/json' -d '{"name":"Walkthrough","isTest":true}' | jid id)
c -X POST $API/budgets -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PID\",\"name\":\"Tiny\",\"period\":\"DAILY\",\"limitUsd\":\"0.0001\"}" > /dev/null
c -X POST $API/providers/requests -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PID\",\"provider\":\"anthropic\",\"model\":\"claude-sonnet\",\"prompt\":\"hi\",\"simulateAgentActivity\":true}" \
  | tee /tmp/resp.json | node -pe 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).data; `${d.status} ${d.cost.totalCostUsd} alerts=${d.budgetAlerts.length} trace=${d.traceId}`'
TRACE=$(node -pe 'JSON.parse(require("fs").readFileSync("/tmp/resp.json","utf8")).data.traceId')
c $API/traces/$TRACE            # spans + merged timeline
c "$API/budgets/utilization?projectId=$PID"
c -X DELETE $API/projects/$PID  # cleans up the test project (204)
```
