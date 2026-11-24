# Implementation status

Status legend: **Complete** = implemented and exercised by automated tests or verified by reading / running the code;
**Partial** = implemented with a stated gap; **Pending** = not implemented / not delivered yet; **Unverified** = code exists but this document's author could not confirm runtime behaviour.

How this was produced: derived from the repository source (`backend/src`, `frontend/src`, `prisma`, `shared`) as it stood in the working tree when this was written (including uncommitted hardening work), the test suites, and earlier local runs of the API with curl. The original specification text is not in the repository; rows follow the requirement areas named in the documentation briefing, in that order, and the lettering of the observability sub-items (A-J) is **inferred** (see section 2). The coordinator should reconcile row names / numbers with the spec.
File paths are given as evidence; line numbers and test counts are deliberately omitted because other agents are still changing code and tests. The browser UI is still being polished: this document only claims page names and behaviour, not layouts.

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

- **The mock providers themselves**: deterministic fake completions, token counts, cached tokens, latencies and failures. No real AI vendor is ever called.
- **The agent-run demo generator** (`POST /simulations/agent-run`, `simulateAgentActivity`, seeded "agent activity" traces): scripted memory / bus / tool / context events, including a scripted failing-then-retried `web_search` tool and a `read_file` tool that do not exist as real tools.
- **Seeded demo data** (`POST /simulations/seed`): backdated requests created through the normal pipeline in `silent` runtime mode (no runtime events or tool calls are written for them).

**Not present:** there is **no external agent, LLM client or tool server** attached to this app, so there is nothing external to instrument. "Real" above means "real code paths of this app's own mock pipeline and REST API", not "wrapping a production agent runtime".

## 1. Requirement areas

| # | Requirement area | Status | Evidence |
|---|---|---|---|
| 1 | **Dashboard**: totals, tokens, success rate, daily spend, provider / model breakdown, budget utilization, recent activity / errors / alerts, empty state, demo-data button | Complete | `backend/src/modules/dashboard/index.ts`, `dashboard/budgetUtil.ts` (now reuses the budgets module's period math, so it matches `/budgets/utilization`; daily series is one grouped SQL query), `frontend/src/pages/DashboardPage.tsx`, `components/dashboard/*`; `backend/tests/dashboard/dashboard.test.ts`, `integration/totals-exports.test.ts` |
| 2 | **Projects**: CRUD, archive / unarchive, delete test projects only, usage summary, activity history, unique names | Complete | `modules/projects/*`, `pages/ProjectsPage.tsx`, `pages/ProjectDetailPage.tsx`; `tests/projects/projects.test.ts`. List search now matches name **or** description; names / descriptions reject control characters |
| 3 | **Providers** (mock OpenAI / Anthropic, models, request API, failure modes, deterministic output) | Complete (mock only) | `modules/providers/index.ts`, `mock/*`, `pipeline.ts`; `tests/providers/*`. No real provider integration exists or is intended (section 0) |
| 4 | **Cost engine**: exact BigInt math, input / output / cached, versioned pricing, fallback pricing, cost classes | Complete | `utils/money.ts`, `modules/cost/*`, `database/catalog.ts`; `tests/cost/cost.test.ts`, `integration/pipeline.test.ts` |
| 4b | Pricing management / cost calculator **UI** | Complete | `pages/PricingPage.tsx` (Calculator, Compare models, Catalog with version history, New version), `components/pricing/*` (exact BigInt math in `math.ts`); uses `/cost/calculate`, `/cost/pricing`, `/providers`; `tests/e2e/12-pricing.spec.ts`. Creating a price version needs an `ADMIN`; the calculator works for `VIEWER` |
| 5 | **Usage management**: list, filters, search, sort, pagination, detail, CSV export | Complete | `modules/usage/*` (shared SQL fragment in `query.ts`; CSV streamed in keyset batches of 500 with the TAB / CR formula guard), `pages/UsagePage.tsx`, `components/usage/*`; `tests/usage/usage.test.ts`, `usage.large.test.ts` |
| 6 | **Budgets and alerts**: global / project budgets, daily / weekly / monthly UTC periods, 50 / 80 / 100 % alerts, duplicate prevention, utilization + history, manual evaluate | Complete | `modules/budgets/*`, `pages/BudgetsPage.tsx`, `components/budgets/*`; `tests/budgets/*`, `integration/budgets.test.ts` (including concurrent evaluations) |
| 7 | **Activity feed and tracing**: persistent activity, traces, spans, execution timeline, background tasks | Complete | `modules/activity`, `modules/traces/*` (`timeline.ts`), `pages/{Activity,Traces,TraceDetail}Page.tsx`; `tests/activity/*`, `tests/traces/*`; HTTP log line <-> trace <-> usage event join: `tests/runtime/join.test.ts` |
| 8 | **Observability** (see section 2 for sub-items) | Complete for the app's own components; no external runtime to instrument | `modules/observability/*`, `modules/instrumentation/*`, `modules/runtime/*`, `pages/ObservabilityPage.tsx`, `ErrorsPage.tsx`. Memory, bus, tool and context sources are `CONNECTED` because real in-app components are registered (section 0); the demo generator is a separate `SIMULATED_ONLY` entry |
| 9 | **Persistent logging**: SQLite + JSONL files, exports (JSONL / CSV), retention, settings | Complete | `modules/logging/*` (incl. `scheduler.ts`: automatic retention sweep 60 s after start and every 6 h, never overlapping), `modules/instrumentation/jsonl.ts` (50 MB file rollover, 500 MB directory cap, batched writes, log-injection safe lines), `pages/{Logs,Settings}Page.tsx`; `tests/logging/*` (incl. `scheduler.test.ts`), `tests/instrumentation/{hardening,jsonl}.test.ts`, `integration/totals-exports.test.ts` |
| 10 | **Privacy / redaction**: no prompt or context content in logs; no memory content outside its own table | Complete | `modules/instrumentation/sanitize.ts` (now also credential / session / hash keys and values); `tests/instrumentation/sanitize.test.ts`, `integration/privacy-security.test.ts`, `auth/audit-privacy.test.ts`, `runtime/memory.test.ts`. By design project memory **content is stored in plain text** in `ProjectMemoryItem` and returned by the memory API; free-text messages are only pattern-redacted (see SECURITY.md) |
| 11 | **Architecture**: modular monolith, DI, shared contracts | Complete | `backend/src/app.ts`, `contracts/*`, `shared/{types,auth,runtime}.ts`; [ARCHITECTURE.md](ARCHITECTURE.md) |
| 12 | **Database models** (Prisma / SQLite) | Complete | `prisma/schema.prisma` (20 models), migrations `20261123103049_init` and `20261123122336_auth_and_memory`; [DATABASE.md](DATABASE.md) |
| 13 | **REST APIs** | Complete | All routes listed in [API.md](API.md) (including `/auth/*`, `/projects/:id/memory*`, `/tools*`); routers under `backend/src/modules/*` |
| 14 | **UI**: pages, navigation, dark mode, responsive, DEMO / SIMULATED labelling | Complete (code); browser behaviour covered by e2e / QA | `frontend/src/App.tsx`, `components/Layout.tsx`, `pages/*` (incl. Login, Setup, Account, Pricing), `components/{auth,memory,pricing}/*`; layouts are still being polished by the frontend agent |
| 15 | **Setup and scripts**: install, migrate, dev, build, start, reset, demo data, first admin | Complete | root `package.json` scripts (incl. `user:create`, `user:unlock`, `user:reset-password`), `.env.example`, [README.md](../README.md); first-run `/setup`, `ADMIN_USERNAME` / `ADMIN_PASSWORD` bootstrap and the CLI: `tests/auth/bootstrap.test.ts`, `tests/e2e/11-auth-setup.spec.ts` |
| 16 | **Backend tests** (unit, API, integration) | Complete (57 files / 727 tests passing) | `backend/tests/**`; see section 3 |
| 17 | **End-to-end tests** (Playwright) | Complete (89 specs passing; chromium only) | `playwright.config.ts`, `tests/e2e/support/*` (isolated build + temp DB + auth-ON server on :4300, second no-user server on :4301 for first-run setup), `tests/e2e/01-shell ... 99-restart-persistence.spec.ts`; `npm run test:e2e` |
| 18 | **Documentation** | Complete | `README.md`, `docs/{ARCHITECTURE,DATABASE,API,TESTING,SECURITY,IMPLEMENTATION-STATUS}.md`; `docs/QA-REPORT.md` is written by the QA role (link only) |
| 19 | **Security posture** | Complete for scope; residual risks documented | [SECURITY.md](SECURITY.md): login required by default, HttpOnly SameSite=Strict sessions, CSRF token, origin and Host guards, roles, lockout and throttles, scrypt, CSP and security headers, rate limiting. Not provided: TLS termination, MFA / SSO, multi-tenancy, encryption at rest; throttles are in memory and per process |
| 20 | **Authentication and authorization**: login, first-run setup, sessions, CSRF, `ADMIN` / `VIEWER`, user management, lockout, audit | Complete | `modules/auth/*`, `middleware/security.ts`, `utils/password.ts`, `shared/auth.ts`, `pages/{Login,Setup,Account}Page.tsx`, `components/auth/*`; `tests/auth/*`, `tests/core/{hostguard,clientkey}.test.ts`, `tests/e2e/10-auth.spec.ts`, `11-auth-setup.spec.ts`. `AUTH_ENABLED=false` removes all of it (explicit opt-out with a startup warning). For `VIEWER` the UI disables (but still shows) every mutating control with `aria-disabled` and a "Read-only account" tooltip, and blocks their submit paths (`components/auth/readOnly.ts`, QA bug #8); the server keeps enforcing the role. Tests: `frontend/src/components/auth/readOnly.test.tsx` |
| 21 | **Runtime: project memory, context manager, local tools, event bus** | Complete as in-app components; not an external agent runtime (section 0) | `modules/runtime/*`, `modules/providers/pipeline.ts`, `shared/runtime.ts`, `components/memory/*`; `tests/runtime/*` |

## 2. Observability sub-items (letters inferred)

| Item | Capability | Status | Evidence / note |
|---|---|---|---|
| A | Request lifecycle logging (every mutation and error, request id, duration) | Complete | `instrumentation/middleware.ts`. Successful GET requests are intentionally not logged; unauthenticated 401 / 429 / unmatched 404 responses are aggregated into one summary log per minute (flood protection); HTTP log rows join to traces and usage events through `httpRequestId` |
| B | Memory injection events (started / completed / failed, item count, tokens, bytes) | Complete: **ACTUAL** for the real project memory store; SIMULATED for the demo generator | `runtime/{memory,injection}.ts` (`recordMemory`, never content), `providers/simulator/agentActivity.ts` for the demo events. Memory is only injected when the project has enabled items; nothing is emitted otherwise |
| C | Event / message bus operations | Complete: **ACTUAL** (pipeline bus, budget alert publishes); SIMULATED for demo events | `runtime/bus.ts`, `providers/pipeline.ts`, `budgets/service.ts` |
| D | Tool-call tracking (name, input / output metadata, retries, duration, status) | Complete: **ACTUAL** for the 3 local tools; SIMULATED for the demo `web_search` / `read_file` | `runtime/tools.ts`, `POST /tools/:name/invoke`, pipeline preflight calls |
| E | Context lifecycle (created / updated / added / modified, size, version) | Complete: **ACTUAL** per request; SIMULATED for the demo generator | `runtime/context.ts`, `runtime/injection.ts` (MODIFIED only on a real window truncation) |
| F | Error log and grouping by category, stack traces | Complete | `observability/errors.ts`, `ErrorsPage.tsx`, error handler (`middleware/errorHandler.ts`) |
| G | Performance (avg / p95 latency, slow operations, series) | Complete | `observability/performance.ts`, `PerformancePanel.tsx` |
| H | Traces, spans, merged execution timeline, correlated events | Complete | `traces/*`, `TraceDetailPage.tsx`, `components/traces/*` |
| I | Persistent structured logs (SQLite + JSONL), exports, retention | Complete | `logging/*`, `instrumentation/jsonl.ts`, retention scheduler |
| J | Honest instrumentation source registry (ACTUAL / SIMULATED / UNAVAILABLE) | Complete | `observability/sources.ts`, `runtime/registry.ts`, `SourcesPanel.tsx`; `tests/observability/sources.test.ts`, `integration/observability.test.ts`. A kind is `CONNECTED` only when a real component registered itself; `demo-simulator` is its own `SIMULATED_ONLY` entry |

## 3. Test results

| Item | Result | Verified |
|---|---|---|
| Backend test files / tests (Vitest) | 57 files / 727 tests | verified by coordinator: yes (2026-11-23) |
| Backend pass / fail / skipped | 727 / 0 / 0 | verified by coordinator: yes |
| Frontend unit tests (Vitest + jsdom, part of `npm test`) | 1 file / 24 tests passed (VIEWER read-only controls, QA bug #8) | verified: yes (2026-11-24) |
| Typecheck (`npm run typecheck`) | clean | verified by coordinator: yes |
| Build (`npm run build`) | succeeds, no bundle-size warning | verified by coordinator: yes |
| E2E (Playwright) | 89 passed / 0 failed (1.6 min, single run after one racy step was fixed) | verified by coordinator: yes |

The documentation author did not run the full test suite (other agents were modifying code and tests concurrently); no pass / fail claim is made here. Earlier numbers (439 backend tests, 53 E2E tests) predate the auth, runtime, pricing-UI and hardening work and are intentionally not repeated.

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
6. Budget alert `level` is always `WARN` regardless of the threshold (50 / 80 / 100 %).
7. `prisma/schema.prisma` documents `ProjectMemoryItem.category` as "instructions | preferences | facts", while the API and `shared/runtime.ts` also accept `other`.
8. The CORS allow-list is `http://` only, while the origin guard accepts `http(s)://` localhost origins; harmless (an `https://localhost` page would simply not be granted CORS reads).
9. The CLI reads `USERNAME` from the environment, a variable Windows sets to the OS account name; use `--username` there.
10. `docs/CONTRACT.md` and `docs/QA-REPORT.md` were not updated by this documentation pass (read-only for it): the QA report still describes 35 test files / 439 backend tests and 53 E2E tests and the pre-auth E2E setup, and the contract's "wave 2 addendum" lists the planned ownership, not the final behaviour.
11. The code is still moving: `middleware.ts` / `core.ts` (auth), `instrumentation/*`, `app.ts` and the e2e support files had uncommitted changes while this document was written (Host guard, `__Host-` cookie, progressive lockout, JSONL buffering, CLI `unlock` / `reset-password`, auth-event visibility). The docs describe the working tree at that time; re-check them against `git diff` before release.

**Fixed since the first documentation pass** (previously listed here): project search now matches descriptions; the dashboard and `/budgets/utilization` now share one implementation (same numbers, global budgets included for a project filter); period math is no longer duplicated; the usage CSV is streamed and has the TAB / CR guard; the source registry no longer special-cases `event-bus` (every real component is `CONNECTED` once registered); the server binds to `127.0.0.1` by default and cross-origin simple requests are blocked by the origin guard, CSRF token and `SameSite=Strict`; HTTP log rows can be joined to traces and usage events.
