# Testing

## 1. Strategy

| Layer | Tooling | Where | What it proves |
|---|---|---|---|
| Unit | Vitest | `backend/tests/**` (pure functions) | money math, period math, PRNG / mock determinism, sanitizer, timeline builder, stats helpers |
| API / module | Vitest + Supertest against the **real Express app** and a **real temporary SQLite database** | `backend/tests/<module>/` | each router: validation, status codes, filters, pagination, persistence, instrumentation side effects |
| Integration (cross-module) | same | `backend/tests/integration/` | full pipeline end to end with an independent cost oracle, privacy (no prompt text anywhere on disk), security / robustness, totals agreement dashboard = usage = CSV, exports, retention |
| End-to-end (browser) | Playwright (Chromium) | `tests/e2e/` | the built UI driving the real backend (owned by the QA role) |
| Type checks | `tsc` | `npm run typecheck`, also part of `npm run build` | contract between backend, frontend and `shared/types.ts` |

Design rules used throughout:

- **No mocks of the database.** Every test app gets its own SQLite file with all migrations applied (`prisma migrate deploy`) and the catalog seeded, so SQL, constraints (for example the alert unique index) and BigInt handling are tested for real.
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
const ctx = await createTestApp();          // temp dir: <tmpdir>/spendguard-test-XXXX/{test.db, logs/}
ctx.app        // fully wired Express app (same buildApp/createDeps as production, no static UI)
ctx.prisma     // PrismaClient bound to the temp DB
ctx.deps       // AppDeps (instr, cost, budgets, config)
ctx.dir / ctx.dbPath / ctx.databaseUrl
await ctx.restart()   // simulate an app restart: disconnects, then builds a NEW prisma + deps + app on the SAME db file and log dir
await ctx.close()     // disconnect; cleanupTestDir(ctx.dir) removes the temp directory
```

Steps inside: `mkdtemp` -> `prisma migrate deploy` with `DATABASE_URL=file:<tmp>/test.db` (skipped if the file already exists, e.g. on `restart()`) -> `createPrisma(url)` -> `seedCatalog` -> `loadConfig({ databaseUrl, logDir, frontendDist: null })` -> `buildApp(createDeps(...))`.

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
| `backend/tests/integration/helpers.ts` | `api(ctx)`, regexes for ids / ISO dates / 12-dp money, the **independent price oracle** (`PRICE_MICRO`, `expectedPico`), project and request builders |
| `createNoopInstrumentation()` (`backend/src/contracts/noop.ts`) | no-op SDK for tests that do not care about instrumentation |

## 4. Suites

Counts are intentionally not hard-coded here. TODO-COUNTS: run `npm test` to see current counts (coordinator records them in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)).

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
| `observability/*` | overview, performance (p95, slow ops, buckets), sources honesty (never CONNECTED for memory / tool / context), errors and groups, event lists, stats helpers, empty database |
| `integration/pipeline.test.ts` | exact BigInt cost vs the oracle, determinism, ACTUAL trace with parent / child spans + logs + JSONL line, activity feed, pricing versions, failure modes, request-failure logging |
| `integration/budgets.test.ts` | one alert per threshold through the real pipeline, multi-threshold jumps, **concurrent requests**, global vs project scope, inactive budgets, delete cascade |
| `integration/observability.test.ts` | agent-activity correlation and SIMULATED labelling, failure timelines, "no ACTUAL memory / tool / context events", overview totals, empty-state honesty |
| `integration/privacy-security.test.ts` | prompt marker absent from every table, the raw SQLite file (incl. free pages) and all JSONL files and API responses; SQL-ish / wildcard / HTML input; malformed JSON; 1 MB body limit (413); CORS allow-list; plaintext capture can never be enabled |
| `integration/totals-exports.test.ts` | dashboard total = usage rows = usage CSV to the last pico-USD; every dataset export (JSONL parses, CSV rectangular, counts match list); CSV formula neutralisation; retention sweep keeps usage |

`backend/tests/integration/_probe.test.ts` is a scratch probe written by the QA role (it dumps sample API output) and is not a real assertion suite; do not rely on it.

## 5. Adding tests

1. Put the file in `backend/tests/<module>/<name>.test.ts` (it is picked up by the `tests/**/*.test.ts` glob).
2. Use `createTestApp()` in `beforeAll` and close / clean up in `afterAll`. Do **not** share a database between files.
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
- Environment knobs: `E2E_PORT`, `E2E_DIR`, `E2E_SKIP_BUILD=1` (reuse an existing `frontend/dist`), `E2E_KEEP=1` (keep the temp directory for inspection).
- Config: one Chromium project, `workers: 1`, `fullyParallel: false`, 60 s test timeout, screenshots on failure, trace on first retry.
- Selectors use the stable `data-testid` attributes present throughout the pages (for example `dashboard-seed`, `simulator-submit`, `trace-row`, `budgets-evaluate`).
- Output (`test-results/`, `playwright-report/`) is git-ignored.

TODO-COUNTS: at the time of writing only a smoke spec (`tests/e2e/00-smoke.spec.ts`) is present; the QA role is adding the feature specs. Run `npm run test:e2e` for the current list and results.

## 7. Coverage notes and known gaps

- Strong: money / cost math, budget thresholds and duplicate prevention, instrumentation privacy and resilience, API validation, exports, retention, and cross-module agreement of totals.
- Frontend: covered only through Playwright e2e (no component / unit tests); TypeScript type-checking guards the API contract.
- Not tested: multi-process safety of the in-process mutexes (budget creation, pricing creation), very large databases / performance, browsers other than Chromium, Windows paths.
- The mock providers are tested for determinism and invariants, not for realism.

## 8. Test results

| Item | Value |
|---|---|
| Backend test files | TODO-COUNTS (run `npm test`) |
| Backend tests passed / failed / skipped | TODO-COUNTS (run `npm test`) |
| Typecheck | TODO-COUNTS (run `npm run typecheck`) |
| E2E tests passed / failed | TODO-COUNTS (run `npm run test:e2e`) |

Verified by coordinator: **pending** (coordinator fills in the numbers and date after the final run).
