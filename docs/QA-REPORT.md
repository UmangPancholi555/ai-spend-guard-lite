# QA Report - AI Spend Guard Lite

Scope: cross-module integration tests (Vitest + supertest) and browser E2E (Playwright, Chromium). Local app only. No external network or AI calls.

## Results (real runs, wave 3 = auth + real runtime + pricing page)

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | backend and frontend clean (also in the 2026-11-24 final verification) |
| E2E typecheck | `npx tsc -p tests/e2e/tsconfig.json --noEmit` | clean (not part of `npm run typecheck`) |
| Backend unit + integration | `npm test` | 57 files, 727 tests passed (wave 3). Final verification 2026-11-24 on `fix/fmtusd-rounding` (merged as e158f0e, PR #2): `npm run test -w backend` 58 files, 733 tests passed |
| Frontend Vitest | `npm run test -w frontend` | Final verification 2026-11-24: 2 files, 35 tests passed (`format.test.ts` 11, `readOnly.test.tsx` 24) |
| Integration folder alone | `cd backend && npx vitest run tests/integration` | 8 files, 75 tests passed (incl. the new `auth-runtime.test.ts`, 12 tests) |
| Playwright E2E | `npm run test:e2e` | 89 tests. First full run after wave 3 work: 88 passed, 1 failed (99-restart lockout assertion, a wrong test assumption, see Observations). After fixing the spec: 89 passed (1.6m). Final run on the stable tree (after fe-b and the backend agents finished, fresh `frontend/dist` build): `npm test` 727 passed, then E2E 89 passed (2.0m) on private ports (`E2E_PORT=4310 E2E_SETUP_PORT=4311 E2E_DIR=/tmp/spendguard-e2e-qa`). Final verification 2026-11-24 on `fix/fmtusd-rounding` (PR #2, e158f0e), private ports `E2E_PORT=4447 E2E_SETUP_PORT=4448`: 89 passed (5.8m), including `01-shell` 7/7 after the PR #1 fix |

Per-spec counts: 01 shell 7, 02 dashboard 4, 03 projects 6, 04 simulator-usage 7, 05 budgets 6, 06 traces 5, 07 observability 4, 08 errors-logs 6, 09 settings 4, 10 auth 15, 11 auth-setup 4, 12 pricing 7, 13 runtime 9, 90 mobile 3, 99 restart 2.

An earlier final attempt on the default ports showed 9 failures (ECONNREFUSED, missing CSRF file): another agent ran `playwright test` at the same time against the same port and temp dir, and its global teardown deleted the shared dir. Not a product or test bug; use private ports when several agents run E2E.

Repeat-run stability was only measured in wave 1 (3 x 53 passed). Wave 3 has one clean full run plus the per-spec runs made while fixing; it has NOT been repeated.

## Files

Integration (`backend/tests/integration/`): `helpers.ts`, `pipeline.test.ts`, `budgets.test.ts`, `totals-exports.test.ts`, `observability.test.ts`, `privacy-security.test.ts`, `persistence.test.ts`, `edge-cases.test.ts`.

Wave 3 added `auth-runtime.test.ts` (auth ON through the real wired app with a cookie jar: full flow login -> project -> request -> dashboard -> usage CSV -> traces JSONL; every API route 401 without session; CSRF and foreign Origin; VIEWER read-only and role change effective on the next request; lockout per (user, address) and the global per-user ceiling; password change revokes other sessions; secrets (passwords, session token, CSRF token) in no table, JSONL or export; memory marker only in `ProjectMemoryItem`, never in other tables, logs, exports, traces; injection raises billed input tokens with a BigInt oracle; tool invoke gives an ACTUAL trace; sources CONNECTED and simulator SIMULATED_ONLY; sessions, CSRF and failure counters survive `ctx.restart()`).

E2E: `playwright.config.ts` (root), `tests/e2e/tsconfig.json`, `tests/e2e/support/{env,server,global-setup,global-teardown,helpers,auth,test}.ts`, and the specs `01-shell`, `02-dashboard`, `03-projects`, `04-simulator-usage`, `05-budgets`, `06-traces`, `07-observability`, `08-errors-logs`, `09-settings`, `10-auth`, `11-auth-setup`, `12-pricing`, `13-runtime`, `90-mobile`, `99-restart-persistence` (all `*.spec.ts`).

## How to run

```
npm run typecheck
npm test                          # backend unit + integration, then frontend unit (Vitest + jsdom)
npx playwright install chromium   # one-time; global setup also installs it if missing
npm run test:e2e                  # builds frontend, starts isolated backend on :4300
```

E2E isolation: a temp SQLite DB and LOG_DIR under `os.tmpdir()/spendguard-e2e`, `prisma migrate deploy`, `npx tsx backend/src/server.ts`. A pid file lets specs stop and restart the backend (the restart spec). Env knobs: `E2E_PORT` (default 4300), `E2E_SETUP_PORT` (default 4301, the second server of `11-auth-setup`), `E2E_SKIP_BUILD=1` (reuse `frontend/dist`), `E2E_KEEP=1` (keep the temp dir). The ports must be free, otherwise global setup aborts.

Auth in E2E (wave 3): the main server runs with auth ON, `ADMIN_USERNAME`/`ADMIN_PASSWORD` bootstrap, `RATE_LIMIT_PER_MINUTE=0`, `AUTH_LOGIN_IP_LIMIT_PER_MINUTE=1000`. Global setup logs in as the admin through the API, creates a VIEWER, and saves Playwright `storageState` plus the CSRF token for both. `tests/e2e/support/test.ts` exports a `test` with an `auth: 'admin' | 'viewer' | 'none'` option (default admin) that sets the storage state and an `X-CSRF-Token` header for both `page` and `request`, so seeding helpers need no changes. Use `test.use({ auth: 'none' })` for anonymous specs. `11-auth-setup` starts a second backend on :4301 with an empty DB and no ADMIN env to exercise first-run `/setup`. Pitfall found: `playwright.request.newContext()` inherits the test's storage state and headers, and a login that presents a session cookie rotates (deletes) that session, so helper clients are always created with an explicit empty state.

Order dependence: specs run serially on one shared DB, alphabetically. `01-shell` (empty states) and `02-dashboard` (empty dashboard) need a fresh DB, so do not reorder them or run them against a used DB. Every other spec creates uniquely named data.

## Coverage

Integration: exact BigInt cost for 6 models against an independent oracle, pricing version change, unknown model gives ESTIMATED, ACTUAL trace and spans, ExecutionLog and JSONL, alerts at 50/80/100 exactly once (including 12 concurrent requests), dashboard totals equal usage rows equal CSV, all 10 export datasets (JSONL and CSV), CSV formula injection, retention sweep, SIMULATED labelling and sources statuses, failure modes, no prompt text in any table, raw DB bytes, JSONL or API response, SQL-ish search strings, 1MB body limit, invalid JSON gives 400, restart persistence (also twice), delete cascade, UTC budget periods with backdated usage, uniqueness races.

E2E: all items in the brief (shell, theme, projects CRUD, simulator and usage drawer and CSV, ESTIMATED, budgets and alerts, dashboard and seed, trace timeline badges and `timeline-entry-failed`, observability and sources, error log, logs and exports, settings persistence, restart persistence, 390px mobile).

Wave 3 coverage. E2E: first-run setup (separate fresh server, validation, closes for good, survives restart), login/logout, generic wrong-password error, `?next=` redirect and open-redirect guard, invalid and revoked sessions, lockout (per user+address, unlock), unauthenticated API 401 incl. unknown paths, CSRF 403, foreign Origin 403, security headers and a CSP-clean SPA render, VIEWER UI (badge, banner, server-refused writes) and API 403s, password change kills other sessions, session revoke, user management (create, role, reset, delete, self-delete 409), audit trail without secrets, pricing calculator against the BigInt oracle (exact strings), ESTIMATED for unknown models, "price as of" versions, compare tab, catalog history, new version with impact preview, pricing validation, project memory panel CRUD, injection raising input tokens, ACTUAL context/memory/tool events on the trace, simulator runtime summary with ACTUAL badges, truncation (whole items dropped), privacy of memory content and prompts in every export and endpoint, tools API and traces, sources registry counters, session and failure counter surviving a restart.

## Bugs found

| # | Sev | Area | Repro | Owner | Fixed? |
|---|---|---|---|---|---|
| 1 | Medium | Settings / observability | `PUT /api/settings {slowOperationMs: 1234}` then `GET /api/observability/performance`: `slowThresholdMs` stays 500. Logging stores key `slowOperationMs`; observability read a different key (`settings` JSON blob), so the UI setting never took effect. | observability / logging | Yes, by QA: `backend/src/modules/observability/common.ts` `loadSlowThresholdMs` reads `slowOperationMs` first and falls back to the legacy `settings` blob. Observability tests (28) pass; integration test added. |
| 2 | Medium | Projects | 8 concurrent `POST /api/projects` with the same name (any case) all return 201. The case-insensitive check is check-then-write with no lock or unique index. | projects | Yes, by QA: `backend/src/modules/projects/service.ts` serializes create and rename through an in-process promise lock. Projects tests (32) and `edge-cases` pass. Limitation: protects a single process only; a DB-level unique index on a lowercased name would be the durable fix. |
| 3 | Medium | Frontend layout | At 390px, Dashboard and Observability pages scroll horizontally (documentElement.scrollWidth 560 to 709 vs 390). Recharts and long error rows stretch the grid because the Card has no `min-w-0`. | frontend | Yes, by QA: `frontend/src/components/ui/Card.tsx` adds `min-w-0`. Mobile spec passes on every page, including with seeded data. |
| 4 | Low | Middleware | A body over 1MB returned 500 INTERNAL_ERROR and was recorded as an internal error. | core | Yes, by QA: `backend/src/middleware/errorHandler.ts` returns 413 `PAYLOAD_TOO_LARGE` for `entity.too.large`. |
| 5 | Low | Activity | Search placeholder says "message, type, request id" but searching by request id returned nothing. | activity / logging | Yes, by QA: `backend/src/modules/activity/index.ts` and `backend/src/modules/logging/datasets.ts` now also search `requestId`. 39 unit tests pass; integration test added. |
| 7 | Medium | Frontend auth UI | Setup, user-create and password-change forms showed only "Request validation failed" for a 400 (e.g. password containing the username), because they used `err.message` and dropped the Zod `details`. Repro: `/setup`, username `founder`, password `my-founder-password-1`. | frontend (auth) | Yes, by QA: `SetupPage.tsx`, `components/auth/UsersCard.tsx`, `components/auth/ChangePasswordCard.tsx` now use `errMessage()` from `components/projects/util.ts` (same helper the other forms use). E2E `10-auth` and `11-auth-setup` assert the specific message. |
| 8 | Low | Frontend (VIEWER) | A VIEWER sees the read-only badge and banner, but every mutating control (create project, budgets, settings, simulator, memory) stays enabled; the click fails only after the server answers 403 with "read-only". No data is at risk (server enforces). | frontend / UX | Yes: `frontend/src/components/auth/readOnly.ts` (`useReadOnly()` from the auth context's `canWrite`) disables every mutating control for VIEWER while keeping it visible, with `aria-disabled="true"` and `title="Read-only account"`: project create / rename / archive / delete (list and detail), budget create / evaluate / activate / edit / delete, settings save and inputs, retention run, simulator send / seed / agent run / quick project, dashboard seed, memory add / toggle / edit / delete, new pricing version, user management. Submit handlers and action handlers also return early for VIEWER, so Enter / form submit sends nothing. Unchanged for VIEWER: cost calculator, compare, pricing impact preview (all `/cost/calculate`), own password change, own session sign-out. ADMIN unchanged; server-side authorization unchanged. Tests: `frontend/src/components/auth/readOnly.test.tsx` (24 Vitest + Testing Library tests, VIEWER vs ADMIN; `npm test` now runs them) and the VIEWER UI test in `tests/e2e/10-auth.spec.ts` (asserts the disabled state on every page and that no write request and no 403 is sent; only `POST /api/cost/calculate`). |
| 9 | Low | SPA fallback | While `frontend/dist` is being rebuilt, any SPA route returns `{"error":{"code":"INTERNAL_ERROR"}}` (500, `sendFile` ENOENT) instead of a clear 503 or a retry. Seen three times in E2E when another agent rebuilt dist during a run. Not a product bug in steady state. | core (`backend/src/app.ts` fallback) | Yes (2026-11-24; the Retry-After and `/assets` parts shipped in PR #2, merged as e158f0e): the fallback's `sendFile` error callback (bf08160) answers 503 `FRONTEND_UNAVAILABLE` instead of 500 when `index.html` is missing, now with `Retry-After: 5` (7a007e8). Re-tested: deleted `index.html`, deleted or emptied `dist`, and nested client routes all give 503; the pre-bf08160 handler reproduces the 500 `INTERNAL_ERROR` (ENOENT). Related: a missing file under `/assets/` now returns 404 JSON `NOT_FOUND` instead of `index.html` with 200 (1a991f5). Tests: `backend/tests/core/spaFallback.test.ts` (4). |
| 6 | Info | providers / budgets | No bugs found in `backend/src/modules/{providers,budgets}`. Not edited. | - | n/a |

Edits outside QA-owned paths in wave 3: `frontend/src/pages/SetupPage.tsx`, `frontend/src/components/auth/UsersCard.tsx`, `frontend/src/components/auth/ChangePasswordCard.tsx` (bug 7, import and use `errMessage`). No other app files were edited in wave 3.

Note on 1, 2, 3: those three edits are uncommitted working-tree changes in files outside QA ownership. All edits made outside QA-owned paths: `observability/common.ts`, `projects/service.ts`, `frontend/src/components/ui/Card.tsx`, `middleware/errorHandler.ts`, `activity/index.ts`, `logging/datasets.ts`. (git status at the time of this report shows only the first three as modified; the other three may already have been committed or reverted by another agent, so check `git diff` and git log before relying on that list.)

## Observations (not blocking)

- Bug #8 fix run (2026-11-24, private ports `E2E_PORT=4347 E2E_SETUP_PORT=4348`, private `E2E_DIR`): full E2E 88 passed, 1 failed (9.3 min). The failure is `01-shell` "unknown client route renders a not-found message": `getByText('Page not found')` hits a strict-mode violation because the sr-only `route-announcer` in `components/Layout.tsx` (added in bf08160) repeats the page heading. Not caused by the bug #8 change (neither file touched); fix is to target the heading (`getByRole('heading', { name: 'Page not found' })`). The updated VIEWER spec in `10-auth` passed. Fixed in PR #1 (branch `fix/e2e-shell-not-found`, 4a8dd1b), merged on GitHub: `tests/e2e/01-shell.spec.ts` asserts the level-1 heading and checks the announcer text separately.

- Fixed (2026-11-24, PR #2, merged as e158f0e): `fmtUsd` (`frontend/src/lib/format.ts`) used to truncate at 6 dp, so a cost below $0.000001 rendered as `$0.00`. It now rounds half-up on the decimal string (no float maths), carrying into the integer part (b23459c); covered by `frontend/src/lib/format.test.ts`. Costs below $0.0000005 still render as `$0.00` by design.
- Fixed (2026-11-24, PR #2, merged as e158f0e): flaky DB-vs-JSONL comparison in `backend/tests/integration/persistence.test.ts` (saw 41 DB rows vs 40 JSONL lines under full-suite load). The request-lifecycle middleware logs from `res` `finish` without awaiting, so the test could count the DB row before its JSONL line was appended. `Instrumentation.flush()` now waits for every log entry started so far to reach the DB and disk; the test calls it before comparing (46aec24), and the other two persistence comparisons do the same (1ce7113). No sleeps. The race was in the test's timing; request handling is unchanged (only the new `flush()` was added to the instrumentation SDK).
- Wave 3 semantics now tested as designed: CONNECTED means a real component is registered (ACTUAL and SIMULATED counts are split); `simulator` is SIMULATED_ONLY with 0 actual.
- Login lockout design: 5 failures lock the (username, IP) pair in memory only, so a backend restart clears pair locks; the persisted per-user counter (`failedAttempts`, global progressive delay from 10 failures) survives restarts. My first tests assumed a 15 minute per-user lock that survives restarts; the tests were corrected, not the app. An attacker who can restart the process could reset pair locks, which is out of scope for a local single-user tool.
- `costClass` for known models is `SIMULATED` (not a separate CATALOG class); unknown models are `ESTIMATED`.
- Total request cost with memory injection is not always higher than without it (the mock's output tokens vary), so tests compare input tokens and input cost.
- Observability `tool` actual counter is one event per tool call, not initiated plus completed.
- Budget tests that depend on the current UTC day or month could flake at a boundary (a run crossing midnight UTC or a month change).
- The in-process name lock (bug 2) does not cover multiple server processes.

## Known gaps

- E2E runs Chromium only, serial, one worker, with no retries. Firefox and WebKit are not covered.
- `tests/e2e` is type-checked by `npx tsc -p tests/e2e/tsconfig.json --noEmit` (committed config, clean) but this is not wired into the root `npm run typecheck` (root package.json is outside QA ownership).
- No visual regression tests. Chart rendering is checked by SVG presence, not content.
- Real provider calls are out of scope by design. Everything is DEMO/SIMULATED.
- The restart spec stops and starts the backend process, but not a hard crash (SIGKILL mid-write).
- E2E repeat-run stability: 3 x 53 in wave 1; wave 3 (89 tests) has one clean full run only, not repeated.
- Auth gaps: no test for the 12h absolute or 30 min idle session expiry in a browser (covered by backend unit tests only), no `COOKIE_SECURE=true` / `__Host-` cookie run, no multi-IP lockout in E2E (all requests come from 127.0.0.1; integration tests use X-Forwarded-For), CLI commands `user:create` / `user:unlock` / `user:reset-password` not exercised end to end.
- Other agents rebuilt `frontend/dist` and edited `frontend/src` while I was running E2E; the final full run was made after `frontend/src` had been quiet for more than 5 minutes (last change 18:50, run 18:57). Changes made after that are not covered.
