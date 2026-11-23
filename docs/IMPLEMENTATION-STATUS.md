# Implementation status

Status legend: **Complete** = implemented and exercised by automated tests or verified by reading / running the code;
**Partial** = implemented with a stated gap; **Pending** = not implemented / not delivered yet; **Unverified** = code exists but this document's author could not confirm runtime behaviour.

How this was produced: derived from the repository source (`backend/src`, `frontend/src`, `prisma`, `shared`), the test suites, and a local run of the API with curl against a temporary database. The original specification text is not in the repository; rows follow the requirement areas named in the documentation briefing, in that order, and the lettering of the observability sub-items (A-J) is **inferred** (see section 2). The coordinator should reconcile row names / numbers with the spec.
File paths are given as evidence; line numbers and test counts are deliberately omitted because other agents are still changing code and tests.

## 1. Requirement areas

| # | Requirement area | Status | Evidence |
|---|---|---|---|
| 1 | **Dashboard**: totals, tokens, success rate, daily spend, provider / model breakdown, budget utilization, recent activity / errors / alerts, empty state, demo-data button | Complete | `backend/src/modules/dashboard/index.ts`, `dashboard/budgetUtil.ts`, `frontend/src/pages/DashboardPage.tsx`, `components/dashboard/*`; `backend/tests/dashboard/dashboard.test.ts`, `integration/totals-exports.test.ts` |
| 2 | **Projects**: CRUD, archive / unarchive, delete test projects only, usage summary, activity history, unique names | Complete | `modules/projects/*`, `pages/ProjectsPage.tsx`, `pages/ProjectDetailPage.tsx`; `tests/projects/projects.test.ts`. Gap: list search matches the name only (UI placeholder says "name or description") |
| 3 | **Providers** (mock OpenAI / Anthropic, models, request API, failure modes, deterministic output) | Complete (mock only) | `modules/providers/index.ts`, `mock/*`, `pipeline.ts`; `tests/providers/*`. No real provider integration exists or is intended |
| 4 | **Cost engine**: exact BigInt math, input / output / cached, versioned pricing, fallback pricing, cost classes | Complete | `utils/money.ts`, `modules/cost/*`, `database/catalog.ts`; `tests/cost/cost.test.ts`, `integration/pipeline.test.ts` |
| 4b | Pricing management / cost calculator **UI** | Pending | No page or component calls `/cost/pricing` or `/cost/calculate`; the cost breakdown is shown only inside the usage drawer (`components/usage/CostBreakdownView.tsx`). Available via REST only |
| 5 | **Usage management**: list, filters, search, sort, pagination, detail, CSV export | Complete | `modules/usage/*`, `pages/UsagePage.tsx`, `components/usage/*`; `tests/usage/usage.test.ts` |
| 6 | **Budgets and alerts**: global / project budgets, daily / weekly / monthly UTC periods, 50 / 80 / 100 % alerts, duplicate prevention, utilization + history, manual evaluate | Complete | `modules/budgets/*`, `pages/BudgetsPage.tsx`, `components/budgets/*`; `tests/budgets/*`, `integration/budgets.test.ts` (including concurrent evaluations) |
| 7 | **Activity feed and tracing**: persistent activity, traces, spans, execution timeline, background tasks | Complete | `modules/activity`, `modules/traces/*` (`timeline.ts`), `pages/{Activity,Traces,TraceDetail}Page.tsx`; `tests/activity/*`, `tests/traces/*` |
| 8 | **Observability** (see section 2 for sub-items) | Partial | `modules/observability/*`, `modules/instrumentation/*`, `pages/ObservabilityPage.tsx`, `ErrorsPage.tsx`; memory / tool / context have only SIMULATED sources by design |
| 9 | **Persistent logging**: SQLite + JSONL files, exports (JSONL / CSV), retention, settings | Complete | `modules/logging/*`, `modules/instrumentation/jsonl.ts`, `pages/{Logs,Settings}Page.tsx`; `tests/logging/*`, `integration/totals-exports.test.ts`. Retention is manual (no scheduler) |
| 10 | **Privacy / redaction**: no prompt, context or memory content stored | Complete | `modules/instrumentation/sanitize.ts`; `tests/instrumentation/sanitize.test.ts`, `integration/privacy-security.test.ts`. Free-text messages are not redacted (documented in SECURITY.md) |
| 11 | **Architecture**: modular monolith, DI, shared contracts | Complete | `backend/src/app.ts`, `contracts/*`, `shared/types.ts`; [ARCHITECTURE.md](ARCHITECTURE.md) |
| 12 | **Database models** (Prisma / SQLite) | Complete | `prisma/schema.prisma` (17 models), `prisma/migrations/20261123103049_init`; [DATABASE.md](DATABASE.md) |
| 13 | **REST APIs** | Complete | All routes listed in [API.md](API.md); routers under `backend/src/modules/*`; responses spot-checked by curl against a live server |
| 14 | **UI**: pages, navigation, dark mode, responsive, DEMO / SIMULATED labelling | Complete (code) / Unverified (runtime in a browser by this author) | `frontend/src/App.tsx`, `components/Layout.tsx`, `pages/*`; browser behaviour is covered by e2e / QA (see below) |
| 15 | **Setup and scripts**: install, migrate, dev, build, start, reset, demo data | Complete | root `package.json` scripts, `.env.example`, [README.md](../README.md); `npm run dev` / `build` / `start` flows verified by reading config (`backend/src/config.ts`, `app.ts` static serving) and a manual server start |
| 16 | **Backend tests** (unit, API, integration) | Complete (counts TODO) | `backend/tests/**`; see section 3 |
| 17 | **End-to-end tests** (Playwright) | Complete (53 specs passed in one run; QA reports 3 further full runs all green; see QA-REPORT.md) | `playwright.config.ts`, `tests/e2e/support/*` (isolated build + temp DB + server on :4300), `tests/e2e/01-shell … 99-restart-persistence.spec.ts`; `npm run test:e2e` |
| 18 | **Documentation** | Complete | `README.md`, `docs/{ARCHITECTURE,DATABASE,API,TESTING,SECURITY,IMPLEMENTATION-STATUS}.md`; `docs/QA-REPORT.md` is written by the QA role (link only) |
| 19 | **Security posture** for a local app | Complete for scope; auth / TLS intentionally absent | [SECURITY.md](SECURITY.md) |

## 2. Observability sub-items (letters inferred)

| Item | Capability | Status | Evidence / note |
|---|---|---|---|
| A | Request lifecycle logging (every mutation and error, request id, duration) | Complete | `instrumentation/middleware.ts`. Successful GET requests are intentionally not logged |
| B | Memory injection events (started / completed / failed, item count, tokens, bytes) | Partial: SIMULATED only | `recordMemory` in `instrumentation/sdk.ts`; emitted only by `providers/simulator/agentActivity.ts`. No real memory runtime |
| C | Event / message bus operations | Partial | In-app budget-alert publishes are ACTUAL (`budgets/service.ts`); all other bus events are SIMULATED |
| D | Tool-call tracking (name, input / output metadata, retries, duration, status) | Partial: SIMULATED only | `recordTool`; only the simulator emits tool calls |
| E | Context lifecycle (created / updated / added / modified, size, version) | Partial: SIMULATED only | `recordContext`; simulator only |
| F | Error log and grouping by category, stack traces | Complete | `observability/errors.ts`, `ErrorsPage.tsx`, error handler (`middleware/errorHandler.ts`) |
| G | Performance (avg / p95 latency, slow operations, series) | Complete | `observability/performance.ts`, `PerformancePanel.tsx` |
| H | Traces, spans, merged execution timeline, correlated events | Complete | `traces/*`, `TraceDetailPage.tsx`, `components/traces/*` |
| I | Persistent structured logs (SQLite + JSONL), exports, retention | Complete | `logging/*`, `instrumentation/jsonl.ts` |
| J | Honest instrumentation source registry (ACTUAL / SIMULATED / UNAVAILABLE) | Complete | `observability/sources.ts`, `SourcesPanel.tsx`; `tests/observability/sources.test.ts`, `integration/observability.test.ts` |

## 3. Test results

| Item | Result | Verified |
|---|---|---|
| Backend test files / tests (Vitest) | 35 files / 439 tests | verified by coordinator: yes (ran 2026-11-23) |
| Backend pass / fail / skipped | 439 / 0 / 0 | verified by coordinator: yes |
| Typecheck (`npm run typecheck`) | clean | verified by coordinator: yes |
| Build (`npm run build`) | succeeds | verified by coordinator: yes |
| E2E (Playwright) | 53 passed / 0 failed (coordinator single run; QA reports 3 more green runs) | verified by coordinator: yes |

The documentation author did not run the full test suite (other agents were modifying tests concurrently); no pass / fail claim is made here.

## 4. Known limitations

**Scope / honesty**
- **Mock providers only.** There is no integration with real AI vendors; prices are illustrative demo numbers. All usage is `simulated: true`.
- **Memory, tool and context have no real instrumentation source.** Only SIMULATED events exist for them (generated by `/simulations/agent-run`, seeding with agent activity, or `simulateAgentActivity`). The sources panel reports `SIMULATED_ONLY` (or `UNAVAILABLE` when none exist), never `CONNECTED`.
- The event bus is ACTUAL only for the budget-alert publish operation.
- A usage event's `durationMs` is the **simulated** latency (20-900 ms); trace and span durations are real elapsed time. The two are intentionally different.

**Product**
- Single user; **no authentication, authorisation, multi-tenancy or TLS**; the server binds to all interfaces (see [SECURITY.md](SECURITY.md)).
- Retention is manual (button / API); there is no scheduler. Retention never deletes usage events or budget alerts.
- Successful `GET` requests are not logged (only mutations and 4xx / 5xx).
- No pricing / calculator UI (REST only); no UI to edit `Provider` / `Model` catalog rows (no API either; edit via seed code).
- Budgets cannot change period or project after creation (delete and recreate); budgets of archived projects are dormant.
- "One budget per scope + period" is enforced in application code with an in-process lock, so it is not safe with several server processes (alert de-duplication is enforced by the database and is safe).
- `GET /usage/export.csv` reads all matching rows into memory (other exports stream in batches).
- `POST /simulations/seed` runs inline (up to 2,000 requests per call).
- SQLite single-writer: heavy concurrent writes may retry; alert insertion retries on busy errors.

## 5. Inconsistencies observed between code, contract and UI

These are documentation findings, not necessarily bugs:

1. `POST /simulations/seed` returns an extra field `failures` and accepts an optional `seed`; [CONTRACT.md](CONTRACT.md) lists only `{taskId, created, projectId}`.
2. The HTTP request-log `requestId` (assigned by the middleware, echoed in `x-request-id`) is a different id from the pipeline's `UsageEvent.requestId`, and request-log rows never carry a `traceId` (`res.locals.traceId` is not set). An HTTP log line cannot be joined to its usage event or trace by id.
3. Project search: the UI placeholder says "Project name or description", but `GET /projects?search=` matches the **name** only.
4. Budget utilization differs by endpoint: the dashboard lists **active** budgets only (and with `projectId` omits global budgets); `GET /budgets/utilization` includes inactive budgets. Period math is implemented twice (`budgets/periods.ts`, `dashboard/budgetUtil.ts`).
5. Source registry semantics: `request-lifecycle` and `error-handler` are `CONNECTED` even with zero events, while `event-bus` is `UNAVAILABLE` on a fresh database (it becomes `CONNECTED` only after the first ACTUAL bus event, i.e. the first budget alert).
6. Cached-token convention: tokens are modelled as `inputTokens` (non-cached) + `cachedTokens` (separate, cached rate), *not* as cached being a subset of input. If the specification defines cached tokens as a subset of input tokens, behaviour differs. Documented in code (`cost/service.ts`) and in `usage.metadata.tokenConvention`.
7. CSV guards differ: dataset exports also neutralise a leading TAB / CR; `/usage/export.csv` does not.
8. Contract says the observability default window is "last 24h... use last 7 days": implemented as 7 days.
9. `UsageEvent.metadata` includes a hash-derived mock response id and seed (not content, but derived from the prompt hash); see the privacy limits in [SECURITY.md](SECURITY.md).
