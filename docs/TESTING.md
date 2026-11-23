# Testing

## 1. Strategy

| Layer | Tooling | Where | What it proves |
|---|---|---|---|
| Unit | Vitest | `backend/tests/**` (pure functions) | money math, period math, PRNG / mock determinism, sanitizer, timeline builder, stats helpers |
| API / module | Vitest + Supertest against the **real Express app** and a **real temporary SQLite database** | `backend/tests/<module>/` | each router: validation, status codes, filters, pagination, persistence, instrumentation side effects |
| Integration (cross-module) | same | `backend/tests/integration/` | full pipeline end to end with an independent cost oracle, privacy (no prompt text anywhere on disk), security / robustness, totals agreement dashboard = usage = CSV, exports, retention |
| Auth / security | Vitest + Supertest with auth **on** | `backend/tests/auth/`, `core/hostguard`, `core/clientkey`, `integration/privacy-security` | login, sessions, CSRF, roles, lockout, password policy, bootstrap / CLI, audit privacy, Host / Origin guards, redaction |
| Runtime | Vitest + Supertest | `backend/tests/runtime/` | real memory store, context lifecycle, tool executor retries, event bus, pipeline integration |
| End-to-end (browser) | Playwright (Chromium) | `tests/e2e/` | the built UI driving the real backend with auth ON, as admin, viewer and anonymous (owned by the QA role) |
| Type checks | `tsc` | `npm run typecheck`, also part of `npm run build` | contract between backend, frontend and `shared/types.ts` |

Design rules used throughout:

- **No mocks of the database.** Every test app gets its own SQLite file with all migrations applied (`prisma migrate deploy`) and the catalog seeded, so SQL, constraints (for example the alert unique index) and BigInt handling are tested for real.
- **Auth is OFF by default in test apps.** The legacy suites call the API without a session; `createTestApp({ auth: true })` turns on real login, CSRF and roles for the auth-specific suites (and `AUTH_ENABLED=false` behaviour has its own test). The rate limiter is disabled in test apps (`rateLimitPerMinute: 0`).
- **No network.** Tests never contact an AI vendor (there is no code path that could; see [SECURITY.md](SECURITY.md)).
- **Independent oracles.** The integration suite hard-codes the catalog prices and recomputes `tokens x price` with BigInt instead of importing the engine, so a bug in the engine cannot hide itself.
- **Restart tests.** Persistence is verified by closing the Prisma client and building a *new* app on the same files (`ctx.restart()`).
- Suites are independent and run in parallel in separate processes (`pool: 'forks'`, `fileParallelism: true`).

## 2. Commands

```bash
npm test                      # = npm run test -w backend = vitest run (all backend suites)
npm run test:watch -w backend # vitest in watch mode
npm run test -w backend -- tests/budgets                           # one folder
npm run test -w backend -- tests/providers/pipeline.test.ts        # one file
npm run typecheck             # backend + frontend tsc --noEmit
npx playwright install chromium   # one-time browser download for e2e
npm run test:e2e              # = playwright test (see section 6)
```

Vitest configuration (`backend/vitest.config.ts`): includes `tests/**/*.test.ts`, test timeout 30 s, hook timeout 60 s, forks pool.
The backend workspace also has `@vitest/coverage-v8` installed, so coverage can be produced with `npm run test -w backend -- --coverage` (output goes to the git-ignored `coverage/`).

Requirements: Node >= 20, the Prisma client generated (`npm install` does it), and `npx prisma` available on the PATH of the test process (it is a root dev dependency). No `.env` or running server is needed for `npm test`; each test passes its own `DATABASE_URL` to the Prisma CLI.

## 3. Helpers

### `createTestApp()` (`backend/tests/helpers/testApp.ts`)

Creates an isolated environment and returns a `TestCtx`:

```ts
const ctx = await createTestApp();          // temp dir: <tmpdir>/spendguard-test-XXXX/{test.db, logs/}; auth OFF
const authed = await createTestApp({ auth: true });   // real login / CSRF / roles (see backend/tests/auth/helpers.ts)
ctx.app        // fully wired Express app (same buildApp/createDeps as production, no static UI)
ctx.prisma     // PrismaClient bound to the temp DB
ctx.deps       // AppDeps (instr, cost, budgets, config)   config.auth = { enabled: false (or true), sessionTtlHours: 12, cookieSecure: false }, config.security = { rateLimitPerMinute: 0, allowedHosts: [] }
ctx.dir / ctx.dbPath / ctx.databaseUrl
await ctx.restart()   // simulate an app restart: disconnects, then builds a NEW prisma + deps + app on the SAME db file and log dir (keeps the `auth` setting)
await ctx.close()     // disconnect; cleanupTestDir(ctx.dir) removes the temp directory
```

Steps inside: `mkdtemp` -> `prisma migrate deploy` with `DATABASE_URL=file:<tmp>/test.db` (skipped if the file already exists, e.g. on `restart()`) -> `createPrisma(url)` -> `seedCatalog` -> `loadConfig({ databaseUrl, logDir, frontendDist: null, auth: { enabled: <auth option, default false>, ... }, security: { rateLimitPerMinute: 0, allowedHosts: [] } })` -> `buildApp(createDeps(...))`.

Typical test:

```ts
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

it('creates a project', async () => {
  const r = await request(ctx.app).post('/api/projects').send({ name: 'P1' });
  expect(r.status).toBe(201);
});

it('survives a restart', async () => {
  ctx = await ctx.restart();
  expect((await request(ctx.app).get('/api/projects')).body.data).toHaveLength(1);
});
```

### Per-area helpers

| File | Purpose |
|---|---|
| `backend/tests/core/coreHelpers.ts` | `CoreCtx` with a recording instrumentation (records `recordActivity` calls and persists them) for the projects / usage / dashboard suites |
| `backend/tests/budgets/helpers.ts` | recording fake `Instrumentation`, a harness that mounts only the cost + budgets routers, usage-event factories |
| `backend/tests/instrumentation/util.ts` | `readJsonl(logDir)` and `sleep` for SDK tests (failure injection uses the SDK's `onError` hook inside the tests) |
| `backend/tests/observability/helpers.ts` | `makeHarness()` and row factories (`seed.*`) for the read-side suites |
| `backend/tests/providers/helpers.ts` | fake cost / budget services, a recording instrumentation, `makeProject`, `dumpAllTables` (used to prove prompts are never persisted) |
| `backend/tests/auth/helpers.ts` | `newAuthApp()` / `closeAuthApp()`, `setupAdmin(ctx)` (first-run setup, returns a Supertest agent + CSRF token), `login`, `createAndLogin` (admin creates a user, then that user logs in), `cookieHeader`; constants `ADMIN` / `VIEWER` credentials |
| `backend/tests/runtime/helpers.ts` | fixtures for the runtime suites (project + memory items, recording instrumentation, tool / bus harness) |
| `backend/tests/integration/helpers.ts` | `api(ctx)`, regexes for ids / ISO dates / 12-dp money, the **independent price oracle** (`PRICE_MICRO`, `expectedPico`), project and request builders |
| `createNoopInstrumentation()` (`backend/src/contracts/noop.ts`) | no-op SDK for tests that do not care about instrumentation |

## 4. Suites

Last verified run (coordinator, 2026-11-23): 57 test files, 727 tests passed, 0 failed (see [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)); re-run `npm test` for current counts.

| Folder / file | Covers |
|---|---|
| `core/startup.test.ts`, `core/persistence.test.ts` | app boot (migrated DB, seeded catalog, `/api/health`, JSON 404 for unknown API routes), data survives restart |
| `projects/projects.test.ts` | create / read / validation, update, archive / unarchive (idempotence), list filters + search + pagination, usage summaries, delete rules and cascade, activity history, failure isolation when instrumentation throws |
| `providers/mock.test.ts` | determinism, OpenAI / Anthropic response shapes, token and cache invariants, failure modes |
| `providers/pipeline.test.ts` | span order and trace shape, persistence, project checks and validation, simulated agent activity |
| `providers/routes.test.ts` | `/providers`, `/providers/requests`, `/simulations/*` validation and end to end with the real cost engine |
| `providers/seed.test.ts` | seeding determinism, backdating, failure share, agent traces cap, `agent-run` |
| `usage/usage.test.ts` | list, every filter, sort, detail by id / requestId, CSV export and escaping, restart persistence |
| `cost/cost.test.ts` | exact BigInt math, unknown model -> ESTIMATED, pricing version selection and creation, validation |
| `budgets/periods.test.ts`, `budgets/budgets.test.ts` | UTC day / ISO week / month boundaries; threshold alerts at exact 50 / 80 / 100 (sub-cent boundaries), duplicate prevention (sequential, **concurrent**, DB unique backstop), new period -> new alerts, scoping (global vs project), instrumentation, restart, CRUD and utilization REST |
| `dashboard/dashboard.test.ts` | period math, empty database, aggregation from persisted data, zero-filled daily series |
| `instrumentation/sanitize.test.ts` | redaction rules, caps, idempotence, end-to-end "no raw content in DB or JSONL" |
| `instrumentation/sdk.test.ts` | traces / spans, typed rows + ExecutionLog + JSONL per `record*`, background tasks, resilience (failures never crash), persistence |
| `instrumentation/middleware.test.ts` | request-id handling, which requests are logged (mutations and >= 400, not GET 2xx), levels and statuses |
| `logging/logs.test.ts`, `export.test.ts`, `settings.test.ts`, `retention.test.ts` | `/logs` filters, JSONL / CSV exports for every dataset, settings validation (strict, plaintext flag), retention sweep and restart persistence |
| `activity/*`, `traces/*` | activity filters / pagination / validation; traces list and detail, **timeline de-duplication rules** (pure `buildTimeline`), background tasks, empty-DB behaviour |
| `observability/*` | overview, performance (p95, slow ops, buckets), sources honesty (CONNECTED only when a real component is registered; the demo simulator is its own SIMULATED_ONLY entry), errors and groups, event lists, stats helpers, empty database |
| `integration/pipeline.test.ts` | exact BigInt cost vs the oracle, determinism, ACTUAL trace with parent / child spans + logs + JSONL line, activity feed, pricing versions, failure modes, request-failure logging |
| `integration/budgets.test.ts` | one alert per threshold through the real pipeline, multi-threshold jumps, **concurrent requests**, global vs project scope, inactive budgets, delete cascade |
| `integration/observability.test.ts` | agent-activity correlation and SIMULATED labelling, failure timelines, real runtime events labelled ACTUAL vs demo events SIMULATED, overview totals, empty-state honesty |
| `integration/privacy-security.test.ts` | prompt marker absent from every table, the raw SQLite file (incl. free pages) and all JSONL files and API responses; SQL-ish / wildcard / HTML input; malformed JSON; 1 MB body limit (413); CORS allow-list; plaintext capture can never be enabled |
| `integration/totals-exports.test.ts` | dashboard total = usage rows = usage CSV to the last pico-USD; every dataset export (JSONL parses, CSV rectangular, counts match list); CSV formula neutralisation; retention sweep keeps usage |
| `auth/login.test.ts`, `auth/password.test.ts` | first-run setup (race-safe, `409 SETUP_COMPLETE`), login / logout, cookie flags, uniform `INVALID_CREDENTIALS`, scrypt hashing (parameters, constant-time verify, bounded parsing), password and username policy |
| `auth/lockout.test.ts` | (username, IP) locks, progressive per-user delay, known-IP exemption, idle decay, unknown-username parity, per-IP limiter, admin unlock |
| `auth/sessions.test.ts` | absolute / idle expiry, rotation on login, 20-session cap, own-session list and revoke, password change revokes other sessions |
| `auth/access.test.ts` | unauthenticated callers (401 everywhere, public routes), CSRF (missing / wrong / valid), `VIEWER` read-only rule, authenticated downloads |
| `auth/users.test.ts` | admin user management and safety rails (`LAST_ADMIN`, `CANNOT_DELETE_SELF`, own-password rule) |
| `auth/bootstrap.test.ts` | `ADMIN_USERNAME` / `ADMIN_PASSWORD` bootstrap (idempotent, never resets users) and the `user:create` / `unlock` / `reset-password` CLI |
| `auth/audit-privacy.test.ts` | audit trail contents, secrets (passwords, tokens, hashes) never reach activity, logs, JSONL or exports |
| `auth/disabled.test.ts` | `AUTH_ENABLED=false` keeps the legacy open behaviour (`/auth/*` -> `AUTH_DISABLED`, status endpoint) |
| `core/hostguard.test.ts`, `core/clientkey.test.ts` | Host header guard (421), rate-limit client key normalisation (IPv4 / IPv6 /64) |
| `runtime/memory.test.ts` | memory REST API (CRUD, limits, validation, 404s), privacy of memory activity |
| `runtime/injection.test.ts` | real injection into mock requests (token effect, categories, disabled items, `injectMemory: false`), real window truncation and context versions, failed lookup handling |
| `runtime/tools.test.ts` | tool registry + `POST /tools/:name/invoke`, validation, retries with back-off, failure recording, tool calls inside the pipeline |
| `runtime/bus.test.ts` | publish / dispatch / request semantics, subscriber isolation, recorded operations, pipeline over the real bus |
| `runtime/join.test.ts` | HTTP request log <-> trace <-> usage event join by `httpRequestId` |
| `logging/scheduler.test.ts` | retention scheduler (fake and real timers): first-run delay, non-overlap, `retentionDays = 0` skip, failure handling, stop |
| `instrumentation/hardening.test.ts`, `instrumentation/jsonl.test.ts` | log-injection hardening, JSONL rollover, buffered writes and `flushLogs`, directory cap, rate-limited console errors |
| `usage/usage.large.test.ts` | 10,000+ row dataset: streamed CSV with keyset paging (constant memory, exact totals, formula guards), bounded search |

`backend/tests/integration/_probe.test.ts` is a scratch probe written by the QA role (it dumps sample API output) and is not a real assertion suite; do not rely on it.

## 5. Adding tests

1. Put the file in `backend/tests/<module>/<name>.test.ts` (it is picked up by the `tests/**/*.test.ts` glob).
2. Use `createTestApp()` in `beforeAll` and close / clean up in `afterAll`. Do **not** share a database between files. For anything involving login, CSRF or roles use `createTestApp({ auth: true })` and the helpers in `backend/tests/auth/helpers.ts` (a Supertest `agent` keeps the cookie; send `X-CSRF-Token` on writes).
3. Drive the API with Supertest (`request(ctx.app)`), assert the envelope (`body.data`, `body.pagination`, `body.error.code`), and read the DB with `ctx.prisma` for side effects (rows, alerts, JSONL files under `ctx.deps.config.logDir`).
4. For money, compare **strings** (12 fraction digits) or BigInt; never floats. Recompute expected cost independently (see `integration/helpers.ts`).
5. For time-dependent behaviour pass explicit instants (the pipeline and seeder accept `createdAt`; budgets evaluate "as of" the event time) rather than relying on the wall clock near a period boundary.
6. For restart behaviour use `ctx = await ctx.restart()`.
7. To test with a stubbed instrumentation, build the app pieces yourself as `budgets/helpers.ts` and `core/coreHelpers.ts` do.
8. If a suite needs a failing instrumentation write, use the SDK's `onError` hook / a throwing fake `Instrumentation` and assert the host operation still succeeds.

## 6. End-to-end tests (Playwright)

- Setup (once): `npm install` then `npx playwright install chromium`.
- Run: `npm run test:e2e` (= `playwright test`; configuration in `playwright.config.ts`, specs `tests/e2e/*.spec.ts`, helpers in `tests/e2e/support/`).
- **Isolation:** `global-setup` builds `frontend/dist` once, creates a temporary SQLite database (`prisma migrate deploy`) and a temporary `LOG_DIR` under the OS temp directory, and starts `npx tsx backend/src/server.ts` on port **4300** (the backend serves the built UI, so `baseURL` is `http://localhost:4300`). `global-teardown` stops the server and deletes the temp directory. Your development database is never touched.
- **Auth is ON** in the E2E server. It is started with `AUTH_ENABLED=true`, `ADMIN_USERNAME` / `ADMIN_PASSWORD` (so the first admin is bootstrapped from the environment), the general rate limit off and a high per-IP login limit. `global-setup` logs in through the real API as that admin, creates a read-only `VIEWER` account, and saves two Playwright storage states plus their CSRF tokens in the temp directory.
- **The `test` fixture** (`tests/e2e/support/test.ts`) replaces `@playwright/test`'s `test` in the specs: every spec is logged in as the admin by default; `test.use({ auth: 'viewer' })` runs as the read-only account and `test.use({ auth: 'none' })` as an anonymous visitor. The CSRF header is added to both page and `request` fixtures, so API seeding calls work. `support/auth.ts` has login / user-creation helpers.
- **Second server for first-run setup:** `11-auth-setup.spec.ts` starts a separate server and database on port **4301** without `ADMIN_*`, so the app really has zero users, and drives `/setup`.
- Environment knobs: `E2E_PORT`, `E2E_SETUP_PORT`, `E2E_DIR`, `E2E_SKIP_BUILD=1` (reuse an existing `frontend/dist`), `E2E_KEEP=1` (keep the temp directory for inspection).
- Config: one Chromium project, `workers: 1`, `fullyParallel: false`, 60 s test timeout, screenshots on failure, trace on first retry.
- Selectors use the stable `data-testid` attributes present throughout the pages (for example `dashboard-seed`, `simulator-submit`, `trace-row`, `budgets-evaluate`, `user-menu`).
- Output (`test-results/`, `playwright-report/`) is git-ignored.

Specs `01-shell` ... `99-restart-persistence` in `tests/e2e/` (14 files; `10-auth` covers login / logout / redirects, roles and CSRF in the browser, `11-auth-setup` the first-run flow, `12-pricing` the pricing and calculator page). Last verified run (coordinator, 2026-11-23): 89 passed, 0 failed (1.6 min). An earlier run the same day had 1 failure in `10-auth` caused by a racy test step (fixed). No repeat-run stability number exists for this version.

## 7. Coverage notes and known gaps

- Strong: money / cost math, budget thresholds and duplicate prevention, instrumentation privacy and resilience, API validation, exports, retention, and cross-module agreement of totals.
- Frontend: covered only through Playwright e2e (no component / unit tests); TypeScript type-checking guards the API contract. The pricing UI's money math (`components/pricing/math.ts`) has no unit tests of its own.
- Not tested: multi-process safety of the in-process mutexes (budget and pricing creation) and of the in-memory login throttles, TLS / `COOKIE_SECURE=true` behaviour against a real HTTPS proxy, very large databases beyond the 10,000-row suite / performance, browsers other than Chromium, Windows paths.
- The mock providers are tested for determinism and invariants, not for realism.

## 8. Test results

| Item | Value |
|---|---|
| Backend test files | 57 |
| Backend tests passed / failed / skipped | 727 / 0 / 0 |
| Typecheck | clean (backend + frontend) |
| E2E tests passed / failed | 89 / 0 |

Verified by coordinator: **pending** (coordinator fills in the numbers and date after the final run).
