# Implementation status

Status legend: **Complete** = implemented and exercised by automated tests or verified by reading / running the code;
**Partial** = implemented with a stated gap; **Pending** = not implemented / not delivered yet; **Unverified** = code exists but this document's author could not confirm runtime behaviour.

How this was produced: derived from the repository source (`backend/src`, `frontend/src`, `prisma`, `shared`) and the test suites on branch `fix/spec-gaps` (after the G1-G6 spec-gap work, section 6). Rows follow the requirement areas of the project specification (`CreateProjectOne.md`, which is **not** stored in this repository): the observability sub-items A-J in section 2 use the specification's section 12 lettering. A row is **Complete** only when nothing the specification asks for is knowingly missing; otherwise it is **Partial** and the gap is stated in the row.
File paths are given as evidence; line numbers are deliberately omitted because they drift. Test counts are in section 3 (from the final verification run of this branch).

## 0. What is real and what is simulated

This is the precise boundary; the rest of the document refers back to it.

**Real (executed by this application, recorded as `source: ACTUAL`):**

- **Accounts and sessions**: login, roles, CSRF, lockout, audit events (`modules/auth`).
- **Project memory store**: user-entered memory items in SQLite (`ProjectMemoryItem`), CRUD API and UI, **injected into every mock provider request** of that project (enabled items, oldest first, prepended to the prompt the mock receives). Truncation to the model's context window is real (whole items are dropped).
- **Request context manager**: one real context object per request (prompt + memory + response sizes / token estimates) with versioned `CREATED` / `ADDED` / `MODIFIED` / `UPDATED` events.
- **Three local tools**: `pricing.lookup`, `budget.status`, `usage.summary` (real queries on the local database) with validation, bounded retries and instrumentation. The pipeline calls the first two on every request; all three can be invoked through the API.
- **In-process event bus**: the pipeline publishes `usage.recorded` / `request.failed` (a real subscriber writes the activity event) and requests `budget.evaluate` from the real budget engine; budget alerts publish `budget.threshold.crossed`.
- **Request lifecycle logging, error recording, budgets, cost engine, pricing versions, retention (scheduled and manual), JSONL logging.**

**Still simulated (labelled `SIMULATED` / `DEMO`):**

- **The mock providers themselves**: deterministic fake completions, token counts, cached tokens, latencies and failures. No real AI vendor is ever called. Since G1 this is also what the trace data says: the `provider.mock` span, its `Response generated (provider.mock)` timeline entry and the provider-failure error record are **always `SIMULATED`** (shown as DEMO / SIMULATED, counted as simulated), even for a live request; the real lifecycle around it (root trace, context, memory, tools, cost, persistence, budgets, bus) stays `ACTUAL`.
- **The agent-run demo generator** (`POST /simulations/agent-run`, `simulateAgentActivity`, seeded "agent activity" traces): scripted memory / bus / tool / context events, including a scripted failing-then-retried `web_search` tool and a `read_file` tool that do not exist as real tools.
- **Seeded demo data** (`POST /simulations/seed`): backdated requests created through the normal pipeline in `silent` runtime mode (no runtime events or tool calls are written for them).

**Not present:** there is **no external agent, LLM client or tool server** attached to this app, so there is nothing external to instrument. "Real" above means "real code paths of this app's own mock pipeline and REST API", not "wrapping a production agent runtime".

## 1. Requirement areas

| # | Requirement area | Status | Evidence |
|---|---|---|---|
| 1 | **Dashboard**: totals, tokens, success rate, daily spend, provider / model breakdown, budget utilization, recent activity / errors / alerts (with alert level), empty state, demo-data button | Complete | `backend/src/modules/dashboard/index.ts`, `dashboard/budgetUtil.ts` (reuses the budgets module's period math, so it matches `/budgets/utilization`; daily series is one grouped SQL query), `frontend/src/pages/DashboardPage.tsx`, `components/dashboard/*`; `backend/tests/dashboard/dashboard.test.ts`, `integration/totals-exports.test.ts` |
| 2 | **Projects**: CRUD, archive / unarchive, delete test projects only, usage summary, activity history, unique names | Complete | `modules/projects/*`, `pages/ProjectsPage.tsx`, `pages/ProjectDetailPage.tsx`; `tests/projects/projects.test.ts`. List search now matches name **or** description; names / descriptions reject control characters |
| 3 | **Providers** (mock OpenAI / Anthropic, models, request API, failure modes, deterministic output) | Complete (mock only) | `modules/providers/index.ts`, `mock/*`, `pipeline.ts`; `tests/providers/*`. No real provider integration exists or is intended (section 0) |
| 4 | **Cost engine**: exact BigInt math, input / output / cached, versioned pricing, fallback pricing, cost classes | Complete | `utils/money.ts`, `modules/cost/*`, `database/catalog.ts`; `tests/cost/cost.test.ts`, `integration/pipeline.test.ts` |
| 4b | Pricing management / cost calculator **UI** | Complete | `pages/PricingPage.tsx` (Calculator, Compare models, Catalog with version history, New version), `components/pricing/*` (exact BigInt math in `math.ts`); uses `/cost/calculate`, `/cost/pricing`, `/providers`; `tests/e2e/12-pricing.spec.ts`. Creating a price version needs an `ADMIN`; the calculator works for `VIEWER` |
| 5 | **Usage management**: list, filters, search, sort, pagination, detail, CSV export | Complete | `modules/usage/*` (shared SQL fragment in `query.ts`; CSV streamed in keyset batches of 500 with the TAB / CR formula guard), `pages/UsagePage.tsx`, `components/usage/*`; `tests/usage/usage.test.ts`, `usage.large.test.ts` |
| 6 | **Budgets and alerts**: global / project budgets, daily / weekly / monthly UTC periods, 50 / 80 / 100 % alerts with an escalating level (50 % INFO, 80 % WARN, 100 % CRITICAL; G4), duplicate prevention, utilization + history, manual evaluate | Complete | `modules/budgets/*`, `pages/BudgetsPage.tsx`, `components/budgets/*`; `tests/budgets/*`, `integration/budgets.test.ts` (including concurrent evaluations and one test per level). The level is derived from the threshold (not stored) and is an alert severity, never an error / failure |
| 7 | **Activity feed and tracing**: persistent activity, traces, spans, execution timeline, background tasks | Complete | `modules/activity`, `modules/traces/*` (`timeline.ts`), `pages/{Activity,Traces,TraceDetail}Page.tsx`; `tests/activity/*`, `tests/traces/*`; HTTP log line <-> trace <-> usage event join: `tests/runtime/join.test.ts` |
| 8 | **Observability** (see section 2 for sub-items) | **Partial**: complete for the app's own components; there is no external agent / tool / bus runtime to instrument | `modules/observability/*`, `modules/instrumentation/*`, `modules/runtime/*`, `pages/ObservabilityPage.tsx`, `ErrorsPage.tsx`. Memory, bus, tool and context sources are `CONNECTED` because real in-app components are registered (section 0); the demo generator is a separate `SIMULATED_ONLY` entry. Nothing external is observed, and the "actual" side is only this app's own pipeline |
| 9 | **Persistent logging**: SQLite + JSONL files, exports (JSONL / CSV), retention, settings | Complete | `modules/logging/*` (incl. `scheduler.ts`: automatic retention sweep 60 s after start and every 6 h, never overlapping), `modules/instrumentation/jsonl.ts` (50 MB file rollover, 500 MB directory cap, batched writes, log-injection safe lines), `pages/{Logs,Settings}Page.tsx`; `tests/logging/*` (incl. `scheduler.test.ts`), `tests/instrumentation/{hardening,jsonl}.test.ts`, `integration/totals-exports.test.ts` |
| 10 | **Privacy / redaction**: no prompt or context content in logs; no memory content outside its own table | **Partial**: logs / events are metadata-only, but memory content is plain text at rest | `modules/instrumentation/sanitize.ts` (now also credential / session / hash keys and values); `tests/instrumentation/sanitize.test.ts`, `integration/privacy-security.test.ts`, `auth/audit-privacy.test.ts`, `runtime/memory.test.ts`. By design project memory **content is stored in plain text** in `ProjectMemoryItem` and returned by the memory API; free-text messages are only pattern-redacted (see SECURITY.md) |
| 11 | **Architecture**: modular monolith, DI, shared contracts | Complete | `backend/src/app.ts`, `contracts/*`, `shared/{types,auth,runtime}.ts`; [ARCHITECTURE.md](ARCHITECTURE.md) |
| 12 | **Database models** (Prisma / SQLite): models, indexes, relationships | **Partial**: relations exist where they do not change behaviour; the log / event tables deliberately have none | `prisma/schema.prisma` (20 models), 4 migrations: `20261123103049_init`, `20261123122336_auth_and_memory`, `20261123125616_memory_cascade`, `20261124104502_relations_and_indexes` (G3: `Span` self relation, `BackgroundTask -> Trace`, lookup indexes). Not foreign keys, on purpose: `ExecutionLog` / `MemoryEvent` / `BusEvent` / `ToolCallEvent` / `ContextEvent` `traceId` / `projectId`, `UsageEvent` / `ActivityEvent.traceId`, `PricingConfig -> Provider/Model` (reasons in [DATABASE.md](DATABASE.md) "Relations that are intentionally not foreign keys"); `backend/tests/core/migrations.test.ts` |
| 13 | **REST APIs** | Complete | All routes listed in [API.md](API.md) (including `/auth/*`, `/projects/:id/memory*`, `/tools*`); routers under `backend/src/modules/*` |
| 14 | **UI**: pages, navigation, dark mode, responsive (390 px), DEMO / SIMULATED labelling | Complete (Chromium only) | `frontend/src/App.tsx`, `components/Layout.tsx`, `pages/*` (incl. Login, Setup, Account, Pricing), `components/{auth,memory,pricing,traces}/*`; `tests/e2e/90-mobile.spec.ts` (no horizontal overflow on every page at 390 px). Only Chromium is exercised |
| 15 | **Setup and scripts**: install, migrate, dev, build, start, reset, demo data, first admin | Complete | root `package.json` scripts (incl. `reset` (G6: `backend/src/scripts/reset.ts`, refuses without `--yes`), `test:coverage`, `user:create`, `user:unlock`, `user:reset-password`), `.env.example`, [README.md](../README.md); first-run `/setup`, `ADMIN_USERNAME` / `ADMIN_PASSWORD` bootstrap and the CLI: `tests/auth/bootstrap.test.ts`, `tests/e2e/11-auth-setup.spec.ts`; `backend/tests/core/reset.test.ts` (temp DB / LOG_DIR only). Before G6 the row claimed "reset" while only manual `rm` commands existed |
| 16 | **Backend tests** (unit, API, integration) | Complete (60 files / 753 tests passing; coverage 96.5 % lines) | `backend/tests/**`; see section 3 |
| 17 | **End-to-end tests** (Playwright) | Complete (90 specs passing; Chromium only) | `playwright.config.ts`, `tests/e2e/support/*` (isolated build + temp DB + auth-ON server on `E2E_PORT` (default :4300), second no-user server on `E2E_SETUP_PORT` (default :4301) for first-run setup), `tests/e2e/01-shell ... 99-restart-persistence.spec.ts`; `npm run test:e2e` |
| 18 | **Documentation** | Complete | `README.md`, `docs/{ARCHITECTURE,DATABASE,API,TESTING,SECURITY,IMPLEMENTATION-STATUS,QA-REPORT}.md`; `docs/CONTRACT.md` is the original contract and keeps its "wave 2 addendum" as planned ownership, not final behaviour |
| 19 | **Security posture** | **Partial**: sound for a local app; residual risks documented | [SECURITY.md](SECURITY.md): login required by default, HttpOnly SameSite=Strict sessions, CSRF token, origin and Host guards, roles, lockout and throttles, scrypt, CSP and security headers, rate limiting. Not provided: TLS termination, MFA / SSO, multi-tenancy, encryption at rest; throttles are in memory and per process |
| 20 | **Authentication and authorization**: login, first-run setup, sessions, CSRF, `ADMIN` / `VIEWER`, user management, lockout, audit | Complete | `modules/auth/*`, `middleware/security.ts`, `utils/password.ts`, `shared/auth.ts`, `pages/{Login,Setup,Account}Page.tsx`, `components/auth/*`; `tests/auth/*`, `tests/core/{hostguard,clientkey}.test.ts`, `tests/e2e/10-auth.spec.ts`, `11-auth-setup.spec.ts`. `AUTH_ENABLED=false` removes all of it (explicit opt-out with a startup warning). For `VIEWER` the UI disables (but still shows) every mutating control with `aria-disabled` and a "Read-only account" tooltip, and blocks their submit paths (`components/auth/readOnly.ts`, QA bug #8); the server keeps enforcing the role. Tests: `frontend/src/components/auth/readOnly.test.tsx` |
| 21 | **Runtime: project memory, context manager, local tools, event bus** | **Partial**: complete as in-app components; not an external agent runtime (section 0) | `modules/runtime/*`, `modules/providers/pipeline.ts`, `shared/runtime.ts`, `components/memory/*`; `tests/runtime/*` |

## 2. Observability sub-items (specification section 12, A-J)

The lettering follows the specification's section 12 (`CreateProjectOne.md`). "Actual" means executed by this app's own code; there is no external agent runtime (section 0).

| Item | Specification topic | Status | Evidence / note |
|---|---|---|---|
| A | Memory injection tracking (started / completed / failed, timestamp, source / category, item count, token estimate, payload size) | Complete: **ACTUAL** for the real project memory store; SIMULATED for the demo generator | `runtime/{memory,injection}.ts` (`recordMemory`, never content), `providers/simulator/agentActivity.ts` for the demo events. Memory is only injected when the project has enabled items; nothing is emitted otherwise |
| B | Bus calling logs | Complete: **ACTUAL** (pipeline bus, budget alert publishes); SIMULATED for demo events | `runtime/bus.ts`, `providers/pipeline.ts`, `budgets/service.ts` |
| C | Tool calling logs (name, input / output metadata, retries, duration, status) | Complete: **ACTUAL** for the 3 local tools; SIMULATED for the demo `web_search` / `read_file` | `runtime/tools.ts`, `POST /tools/:name/invoke`, pipeline preflight calls |
| D | Context tracking (created / updated / added / modified, size, version) | Complete: **ACTUAL** per request; SIMULATED for the demo generator | `runtime/context.ts`, `runtime/injection.ts` (MODIFIED only on a real window truncation) |
| E | Execution timeline (the nine named steps, failed operations highlighted) | Complete. The mock provider step ("Response generated") is **SIMULATED** since G1 | `traces/timeline.ts`, `TraceDetailPage.tsx`, `components/traces/*`; `tests/traces/timeline.test.ts`, `tests/e2e/06-traces.spec.ts` |
| F | Performance monitoring (durations, average, slow operations, latency, failure rate, counts) | Complete | `observability/performance.ts`, `PerformancePanel.tsx` |
| G | Error monitoring (centralized log, categories, messages, stack traces, trace IDs, timestamps, filter / search) | Complete. A mock-provider failure is recorded as a **SIMULATED** error since G1; HTTP / validation / internal errors stay ACTUAL | `observability/errors.ts`, `ErrorsPage.tsx`, `middleware/errorHandler.ts`, `providers/pipeline.ts` (`recordError`) |
| H | Observability dashboard (totals, success / failure, per-kind counts, average time, recent errors, **execution timeline, trace explorer**) | Complete. The trace explorer with an inline execution timeline was the missing piece (G2) | `pages/ObservabilityPage.tsx`, `components/traces/TraceExplorer.tsx` (filters, trace list, selected timeline, link to the full trace), `components/observability/*`; `tests/e2e/07-observability.spec.ts` (explorer) and `90-mobile.spec.ts` (no overflow at 390 px) |
| I | Persistent logging (SQLite, JSONL / CSV export, restart-safe, filters by type / date / status / trace id, search by operation, retention) | Complete | `logging/*`, `instrumentation/jsonl.ts`, retention scheduler; request lifecycle logging (every mutation and error, request id, duration) lives in `instrumentation/middleware.ts` (successful GETs are intentionally not logged; unauthenticated 401 / 429 / unmatched 404 are aggregated into one summary per minute; HTTP log rows join to traces and usage events through `httpRequestId`) |
| J | Instrumentation architecture (reusable interfaces / middleware; ACTUAL vs SIMULATED vs UNAVAILABLE; no fabricated observations; no sensitive content in logs) | Complete for this app's own components | `observability/sources.ts`, `runtime/registry.ts`, `SourcesPanel.tsx`, `instrumentation/*`; `tests/observability/sources.test.ts`, `integration/observability.test.ts`. A kind is `CONNECTED` only when a real component registered itself; `demo-simulator` is its own `SIMULATED_ONLY` entry. Nothing external is instrumented because nothing external exists |

## 3. Test results

Final verification run of branch `fix/spec-gaps` (2026-11-24), with every DB / log directory in a temp location:

| Item | Result |
|---|---|
| Backend tests (Vitest) | 60 files / 753 tests passed, 0 failed, 0 skipped |
| Frontend unit tests (Vitest + jsdom, part of `npm test`) | 2 files / 35 tests passed |
| Typecheck (`npm run typecheck`, `tsc -p tests/e2e/tsconfig.json --noEmit`) | clean |
| Build (`npm run build`) | succeeds |
| E2E (Playwright, `npm run test:e2e`, Chromium only) | 90 passed / 0 failed (3.7 min) |
| Coverage (`npm run test:coverage`, v8) | backend 96.45 % statements / 91.22 % branches / 96.16 % functions / 96.45 % lines; frontend 26.18 % / 56.06 % / 26.44 % / 26.18 % (only 2 component test files, so low by design; the UI is exercised by the e2e suite, which is not instrumented) |

## 4. Known limitations

**Scope / honesty**
- **Mock providers only.** There is no integration with real AI vendors; prices are illustrative demo numbers. All usage is `simulated: true`.
- **No external agent runtime.** Memory, context, tool and bus events are real for this app's own pipeline and REST API, but no external agent framework is wired in; the agent-run / seeded agent-activity generator is scripted demo data and stays `SIMULATED`. Bulk demo seeding writes no runtime events at all.
- The memory "injection" changes what the **mock** receives (and therefore token counts and cost); it does not influence any real model.
- A usage event's `durationMs` is the **simulated** latency (20-900 ms); trace and span durations are real elapsed time. The two are intentionally different.
- Token counts and memory sizes are estimates (`ceil(chars / 4)`), not tokenizer output.

**Security / deployment** (details in [SECURITY.md](SECURITY.md))
- Login is on by default; `AUTH_ENABLED=false` disables all access control.
- No TLS termination (use a TLS proxy and `COOKIE_SECURE=true` beyond loopback), no MFA / SSO / email password reset (recovery is the CLI), no multi-tenancy: every authenticated user sees all projects; `VIEWER` is read-only.
- The per-IP rate limiter, login limiter and (username, IP) locks are in memory and per process; behind a reverse proxy set `TRUST_PROXY` and `ALLOWED_HOSTS` correctly.
- Until the first admin exists, anyone who can reach the port can claim it via `/setup`.
- Project memory content is stored unencrypted in the SQLite file.

**Product**
- Retention runs automatically (every 6 h, first run 60 s after start) and on demand; it never deletes usage events, activity events, budget alerts, users, sessions or memory items. The scheduler is in-process: it does not run while the server is stopped.
- Successful `GET` requests are not logged (only mutations and 4xx / 5xx; unauthenticated rejections are aggregated).
- No UI to edit `Provider` / `Model` catalog rows (no API either; edit via seed code). Price versions can be added through the Pricing page.
- Budgets cannot change period or project after creation (delete and recreate); budgets of archived projects are dormant.
- "One budget per scope + period" is enforced in application code with an in-process lock, so it is not safe with several server processes (alert de-duplication is enforced by the database and is safe). The same holds for the "last admin" rule.
- `POST /simulations/seed` runs inline (up to 2,000 requests per call).
- SQLite single-writer: heavy concurrent writes may retry; alert insertion retries on busy errors.

## 5. Inconsistencies observed between code, contract and UI

These are documentation findings, not necessarily bugs. Items fixed since the first documentation pass are listed at the end.

1. `POST /simulations/seed` returns an extra field `failures` and accepts an optional `seed`; [CONTRACT.md](CONTRACT.md) lists only `{taskId, created, projectId}`.
2. The pipeline's `UsageEvent.requestId` (`req_<uuid>`) is still a different id from the HTTP request-log `requestId` (`x-request-id`); they are now joined through `httpRequestId` (trace attributes, usage metadata, request-log `traceId`), not by identity.
3. Cached-token convention: tokens are modelled as `inputTokens` (non-cached) + `cachedTokens` (separate, cached rate), *not* as cached being a subset of input. If the specification defines cached tokens as a subset of input tokens, behaviour differs. Documented in code (`cost/service.ts`) and in `usage.metadata.tokenConvention`.
4. Contract says the observability default window is "last 24h... use last 7 days": implemented as 7 days.
5. `UsageEvent.metadata` includes a hash-derived mock response id and seed (not content, but derived from the prompt hash); see [SECURITY.md](SECURITY.md).
6. `prisma/schema.prisma` documents `ProjectMemoryItem.category` as "instructions | preferences | facts", while the API and `shared/runtime.ts` also accept `other`.
7. The CORS allow-list is `http://` only, while the origin guard accepts `http(s)://` localhost origins; harmless (an `https://localhost` page would simply not be granted CORS reads).
8. The CLI reads `USERNAME` from the environment, a variable Windows sets to the OS account name; use `--username` there.

**Fixed since the first documentation pass** (previously listed here): project search now matches descriptions; the dashboard and `/budgets/utilization` now share one implementation (same numbers, global budgets included for a project filter); period math is no longer duplicated; the usage CSV is streamed and has the TAB / CR guard; the source registry no longer special-cases `event-bus` (every real component is `CONNECTED` once registered); the server binds to `127.0.0.1` by default and cross-origin simple requests are blocked by the origin guard, CSRF token and `SameSite=Strict`; HTTP log rows can be joined to traces and usage events.

Also fixed on `fix/spec-gaps` (G4, documentation pass): the budget alert `level` is no longer always `WARN` (old item 6), and the stale notes about `CONTRACT.md` / `QA-REPORT.md` and uncommitted code (old items 10 and 11) were removed; `QA-REPORT.md` now records the final run.

## 6. Spec-gap work on `fix/spec-gaps` (G1-G6)

| Gap | Change | Where |
|---|---|---|
| G1 | The `provider.mock` span, its timeline entry and its error records are `SIMULATED` (`PROVIDER_SOURCE` in the pipeline); real lifecycle spans stay `ACTUAL` | `providers/pipeline.ts`; tests in `providers/`, `integration/`, `traces/`; e2e `06-traces`, `08-errors-logs`, `13-runtime` |
| G2 | Trace explorer + execution timeline on the Observability page; no horizontal scroll at 390 px | `components/traces/TraceExplorer.tsx`, `ObservabilityPage.tsx`; e2e `07-observability` |
| G3 | Relations `Span.parentSpanId -> Span` and `BackgroundTask.traceId -> Trace`, lookup indexes; migration `20261124104502_relations_and_indexes` (valid rows kept, orphans handled explicitly in the migration comment). Other candidates skipped because they would break retention or seeding (documented) | `prisma/`, [DATABASE.md](DATABASE.md); `tests/core/migrations.test.ts`, `tests/logging/retention.test.ts` |
| G4 | Alert level by threshold: 50 % `INFO`, 80 % `WARN`, 100 % `CRITICAL` (derived, unique de-dupe unchanged); shown in the UI, exports and activity / log level filters | `shared/types.ts`, `budgets/service.ts`, `components/budgets/AlertHistory.tsx`; tests per threshold, e2e `05-budgets` |
| G5 | `test:coverage` scripts (root, backend, frontend; v8; text + html in git-ignored `coverage/`); numbers in section 3 and [TESTING.md](TESTING.md) | `vitest.config.ts` (both workspaces), `package.json` files |
| G6 | `npm run reset`: dry run without `--yes`, only the configured SQLite file and `LOG_DIR` contents, refuses outside-repo paths without `--force`, re-runs migrations; README no longer lists manual `rm` commands | `backend/src/scripts/reset.ts`; `tests/core/reset.test.ts` |
