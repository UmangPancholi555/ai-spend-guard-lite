# QA Report - AI Spend Guard Lite

Scope: cross-module integration tests (Vitest + supertest) and browser E2E (Playwright, Chromium). Local app only. No external network or AI calls.

## Results (real runs)

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | backend and frontend clean |
| Backend unit + integration | `npm test` | 35 files, 439 tests passed (27.9s) |
| Integration folder alone | `cd backend && npx vitest run tests/integration` | 6 files, 56 tests passed at that time; `edge-cases.test.ts` (7 tests, passing) was added afterwards and is included in the 439 |
| Playwright E2E | `npm run test:e2e` | 53 tests, 52 passed on the first full run. The one failure (restart spec, last assertion on JSONL file size) was a test bug and was fixed. The coordinator's own full run: 53 passed (2.2m) |
| E2E repeat runs | `E2E_SKIP_BUILD=1 npx playwright test` x3 (background loop) | 53 passed, 53 passed, 53 passed (2.3m / 1.4m / 1.8m). Caveat: the 05-budgets assertion tightening (see below) happened while this loop was running, so it was not necessarily covered by all three runs. Re-run `npx playwright test tests/e2e/05-budgets.spec.ts` once to confirm it. |

## Files

Integration (`backend/tests/integration/`): `helpers.ts`, `pipeline.test.ts`, `budgets.test.ts`, `totals-exports.test.ts`, `observability.test.ts`, `privacy-security.test.ts`, `persistence.test.ts`, `edge-cases.test.ts`.

E2E: `playwright.config.ts` (root), `tests/e2e/support/{env,server,global-setup,global-teardown,helpers}.ts`, and the specs `01-shell`, `02-dashboard`, `03-projects`, `04-simulator-usage`, `05-budgets`, `06-traces`, `07-observability`, `08-errors-logs`, `09-settings`, `90-mobile`, `99-restart-persistence` (all `*.spec.ts`).

## How to run

```
npm run typecheck
npm test                          # backend unit + integration
npx playwright install chromium   # one-time; global setup also installs it if missing
npm run test:e2e                  # builds frontend, starts isolated backend on :4300
```

E2E isolation: a temp SQLite DB and LOG_DIR under `os.tmpdir()/spendguard-e2e`, `prisma migrate deploy`, `npx tsx backend/src/server.ts`. A pid file lets specs stop and restart the backend (the restart spec). Env knobs: `E2E_PORT` (default 4300), `E2E_SKIP_BUILD=1` (reuse `frontend/dist`), `E2E_KEEP=1` (keep the temp dir). The port must be free, otherwise global setup aborts.

Order dependence: specs run serially on one shared DB, alphabetically. `01-shell` (empty states) and `02-dashboard` (empty dashboard) need a fresh DB, so do not reorder them or run them against a used DB. Every other spec creates uniquely named data.

## Coverage

Integration: exact BigInt cost for 6 models against an independent oracle, pricing version change, unknown model gives ESTIMATED, ACTUAL trace and spans, ExecutionLog and JSONL, alerts at 50/80/100 exactly once (including 12 concurrent requests), dashboard totals equal usage rows equal CSV, all 10 export datasets (JSONL and CSV), CSV formula injection, retention sweep, SIMULATED labelling and sources statuses, failure modes, no prompt text in any table, raw DB bytes, JSONL or API response, SQL-ish search strings, 1MB body limit, invalid JSON gives 400, restart persistence (also twice), delete cascade, UTC budget periods with backdated usage, uniqueness races.

E2E: all items in the brief (shell, theme, projects CRUD, simulator and usage drawer and CSV, ESTIMATED, budgets and alerts, dashboard and seed, trace timeline badges and `timeline-entry-failed`, observability and sources, error log, logs and exports, settings persistence, restart persistence, 390px mobile).

## Bugs found

| # | Sev | Area | Repro | Owner | Fixed? |
|---|---|---|---|---|---|
| 1 | Medium | Settings / observability | `PUT /api/settings {slowOperationMs: 1234}` then `GET /api/observability/performance`: `slowThresholdMs` stays 500. Logging stores key `slowOperationMs`; observability read a different key (`settings` JSON blob), so the UI setting never took effect. | observability / logging | Yes, by QA: `backend/src/modules/observability/common.ts` `loadSlowThresholdMs` reads `slowOperationMs` first and falls back to the legacy `settings` blob. Observability tests (28) pass; integration test added. |
| 2 | Medium | Projects | 8 concurrent `POST /api/projects` with the same name (any case) all return 201. The case-insensitive check is check-then-write with no lock or unique index. | projects | Yes, by QA: `backend/src/modules/projects/service.ts` serializes create and rename through an in-process promise lock. Projects tests (32) and `edge-cases` pass. Limitation: protects a single process only; a DB-level unique index on a lowercased name would be the durable fix. |
| 3 | Medium | Frontend layout | At 390px, Dashboard and Observability pages scroll horizontally (documentElement.scrollWidth 560 to 709 vs 390). Recharts and long error rows stretch the grid because the Card has no `min-w-0`. | frontend | Yes, by QA: `frontend/src/components/ui/Card.tsx` adds `min-w-0`. Mobile spec passes on every page, including with seeded data. |
| 4 | Low | Middleware | A body over 1MB returned 500 INTERNAL_ERROR and was recorded as an internal error. | core | Yes, by QA: `backend/src/middleware/errorHandler.ts` returns 413 `PAYLOAD_TOO_LARGE` for `entity.too.large`. |
| 5 | Low | Activity | Search placeholder says "message, type, request id" but searching by request id returned nothing. | activity / logging | Yes, by QA: `backend/src/modules/activity/index.ts` and `backend/src/modules/logging/datasets.ts` now also search `requestId`. 39 unit tests pass; integration test added. |
| 6 | Info | providers / budgets | No bugs found in `backend/src/modules/{providers,budgets}`. Not edited. | - | n/a |

Note on 1, 2, 3: those three edits are uncommitted working-tree changes in files outside QA ownership. All edits made outside QA-owned paths: `observability/common.ts`, `projects/service.ts`, `frontend/src/components/ui/Card.tsx`, `middleware/errorHandler.ts`, `activity/index.ts`, `logging/datasets.ts`. (git status at the time of this report shows only the first three as modified; the other three may already have been committed or reverted by another agent, so check `git diff` and git log before relying on that list.)

## Observations (not fixed, not blocking)

- `fmtUsd` (`frontend/src/lib/format.ts`) truncates at 6 dp instead of rounding. A cost below $0.000001 renders as `$0.00`.
- In one probe the `error-handler` source reported `actualEvents 0` / `simulatedEvents 1` yet showed CONNECTED. This was not investigated further.
- Budget tests that depend on the current UTC day or month could flake at a boundary (a run crossing midnight UTC or a month change).
- The in-process name lock (bug 2) does not cover multiple server processes.

## Known gaps

- E2E runs Chromium only, serial, one worker, with no retries. Firefox and WebKit are not covered.
- `tests/e2e` is not type-checked by `npm run typecheck`. A scratch tsconfig run printed no errors, but there is no committed config.
- No visual regression tests. Chart rendering is checked by SVG presence, not content.
- Real provider calls are out of scope by design. Everything is DEMO/SIMULATED.
- The restart spec stops and starts the backend process, but not a hard crash (SIGKILL mid-write).
- E2E repeat-run stability: 3 consecutive full runs passed (see above), but that is a small sample and the 05-budgets tweak was made during it.
