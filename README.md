# AI Spend Guard Lite

A **local, fully simulated** application for tracking AI spend and observing agent-style execution
(requests, traces, memory / bus / tool / context events, logs and errors).

> **DEMO / SIMULATED.** No API keys are needed or read, no vendor SDK is installed, and the app never makes an
> outbound request to any AI provider. All "providers" are deterministic local mocks; all prices are illustrative
> demo numbers, not real price lists. Every simulated record is labelled `DEMO / SIMULATED`.

## Features

- **Projects**: create, edit, archive / unarchive, and delete (test projects only), with per-project usage totals and activity history.
- **Mock providers**: "Mock OpenAI" and "Mock Anthropic" with deterministic token counts, cached tokens, latency, responses and failure modes (`error`, `timeout`, `rate_limit`).
- **Cost engine**: exact integer money math (BigInt pico-USD, never floats), versioned per-model pricing, fallback pricing for unknown models (cost class `ESTIMATED`).
- **Usage management**: searchable / filterable / sortable list, per-request detail with cost breakdown, CSV export.
- **Budgets and alerts**: per-project or global budgets (daily / weekly / monthly, UTC), alerts at 50 / 80 / 100 % of the limit, exactly once per budget + period + threshold.
- **Activity feed, traces and spans**: every request becomes a trace with spans; a merged execution timeline per trace.
- **Observability**: overview, performance (avg / p95 / slow operations), error groups, event explorer for memory / bus / tool / context events, and an honest *instrumentation sources* registry (`ACTUAL` vs `SIMULATED` vs `UNAVAILABLE`).
- **Persistent structured logging**: SQLite rows plus daily JSONL files, JSONL / CSV exports, configurable retention.
- **Privacy by design**: prompt text, context and memory content are never stored. Only hashes, sizes, counts and key names.
- **Dark mode**, responsive layout.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js (>= 20), Express 4, TypeScript, Zod validation |
| Database | SQLite via Prisma 6 (`prisma/schema.prisma`, migrations in `prisma/migrations`) |
| Frontend | React 18, Vite 6, React Router 6, Tailwind CSS 3, Recharts |
| Tests | Vitest + Supertest (backend), Playwright (end-to-end) |
| Monorepo | npm workspaces: `backend`, `frontend` (+ shared types in `shared/`) |

## Quick start

Prerequisites: Node.js 20 or newer and npm.

```bash
cp .env.example .env      # DATABASE_URL, PORT, LOG_DIR (the file is git-ignored)
npm install               # installs both workspaces and generates the Prisma client
npm run db:migrate        # creates prisma/spendguard.db and applies migrations
npm run dev               # API on http://localhost:4000, web UI on http://localhost:5173
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` to the backend.
On first start the server seeds the provider / model / pricing catalog automatically (idempotent).

If the Prisma client is ever missing or stale (for example after changing `schema.prisma`), run `npm run db:generate`.

### Production-style run (single process)

```bash
npm install
npm run db:migrate
npm run build             # type-checks + compiles the backend, type-checks + bundles the frontend
npm start                 # http://localhost:4000 serves the API and the built UI
```

The backend serves `frontend/dist` (if it exists) with an SPA fallback, so the UI and the API share
one origin on port 4000. `npm run setup` runs install + migrate + build in one go.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `file:./spendguard.db` | SQLite URL. A relative path is resolved **relative to `prisma/schema.prisma`**, so the default file is `prisma/spendguard.db`. Required (the Prisma client reads it from `.env`). |
| `PORT` | `4000` | API / production server port. |
| `LOG_DIR` | `./data/logs` | Directory for JSONL execution logs, resolved relative to the repo root. |
| `API_PORT` | `4000` | Dev only: port the Vite dev server proxies `/api` to. |
| `WEB_PORT` | `5173` | Dev only: Vite dev server port. |

### Reset the database

Stop the server first, then:

```bash
rm -f prisma/spendguard.db prisma/spendguard.db-journal   # the SQLite file
rm -rf data/logs                                          # JSONL logs (optional)
npm run db:migrate                                        # recreate schema
```

The catalog (providers, models, pricing) is re-seeded the next time the server starts.
To keep a copy first: `cp prisma/spendguard.db prisma/spendguard.backup.db` (with the server stopped).

### Generate demo data

Any one of:

- UI: on the **Dashboard** (empty state) click **Generate demo data** (200 requests over 14 days, with failures), or use **Request Simulator -> Seed demo data** for custom counts.
- API:
  ```bash
  curl -s -X POST http://localhost:4000/api/simulations/seed \
    -H 'content-type: application/json' \
    -d '{"requests":200,"spreadDays":14,"includeFailures":true,"includeAgentActivity":true}'
  ```
  This creates (or reuses) the test project **"Demo Project (simulated)"** and inserts backdated, deterministic
  simulated requests through the normal request pipeline. See [docs/API.md](docs/API.md).

## Running tests

```bash
npm test                  # backend unit + API tests (Vitest, isolated temp SQLite databases)
npm run typecheck         # TypeScript checks for backend and frontend
npx playwright install chromium   # one-time: download the browser used by e2e tests
npm run test:e2e          # Playwright end-to-end tests (see docs/TESTING.md)
```

Test counts and the latest results are recorded in [docs/TESTING.md](docs/TESTING.md) and
[docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) (last verified: 439 backend tests + 53 Playwright E2E tests passing).

## Tour of the UI

| Route | Page | What it does |
|---|---|---|
| `/` | **Dashboard** | Range selector (7 / 14 / 30 / 90 days), KPI cards (spend, requests, input / output / cached tokens, success rate), daily spend and success/failure charts, provider and model breakdown, current-period budget utilization, recent activity, failed requests and budget alerts. Empty state offers **Generate demo data**. |
| `/projects` | **Projects** | Searchable, filterable list with usage totals; create / edit / archive / unarchive; delete is enabled only for test projects. |
| `/projects/:id` | **Project detail** | Project summary, budgets and utilization, recent usage, paged activity history. |
| `/usage` | **Usage** | Filter by search text, provider, model, project, status, date range; sort by time / cost / duration; click a row for the request drawer (tokens, cost breakdown, pricing version, prompt hash, metadata). **Export CSV** respects the filters. |
| `/simulator` | **Request Simulator** | Send one mock provider request (provider, model or custom model, prompt, max tokens, temperature, simulated failure, optional agent activity); seed demo data; run a simulated agent execution (optionally failing) and jump to its trace. |
| `/budgets` | **Budgets & Alerts** | Create / edit / delete budgets, utilization bars colour-coded at 50 / 80 / 100 %, per-budget utilization history chart, alert history, **Evaluate now**. |
| `/activity` | **Activity** | Persistent feed of recorded events, filter by type, level, source (ACTUAL / SIMULATED), project, text and dates. |
| `/traces` | **Traces** | Trace list (status, source, search, dates; exports) and a background-tasks panel (seed, budget evaluation, retention sweep). |
| `/traces/:traceId` | **Trace detail** | Span waterfall, merged execution timeline, correlated events, error and stack for failed traces. |
| `/observability` | **Observability** | Overview KPIs with an actual-vs-simulated split, recent errors and traces, instrumentation sources panel, performance panel (avg / p95 latency, per-category counts, slow operations), event explorer (Memory, Bus, Tool calls, Context) with exports. |
| `/errors` | **Error Log** | Error-group chart (click a category to filter), failed operations with category, trace link and stack; filters and exports. |
| `/logs` | **Execution Logs** | Structured execution log with filters (event type, category, status, level, source, trace, operation, dates) and exports. |
| `/settings` | **Settings** | Retention days, slow-operation threshold, **Run retention sweep now**; plaintext content capture is shown as permanently OFF. |

The pricing catalog and the cost calculator are exposed through the REST API only (`/api/cost/*`); they have no dedicated page.

## Project layout

```
ai-spend-guard-lite/
├── package.json              npm workspaces + root scripts
├── .env.example              DATABASE_URL, PORT, LOG_DIR
├── prisma/
│   ├── schema.prisma         data model (SQLite)
│   └── migrations/           SQL migrations (applied with `npm run db:migrate`)
├── shared/types.ts           DTOs shared by backend and frontend (API contract types)
├── backend/
│   ├── src/
│   │   ├── server.ts         process entry: config, catalog seed, listen
│   │   ├── app.ts            Express app wiring (CORS, JSON, middleware, routers, static UI)
│   │   ├── config.ts         env -> AppConfig
│   │   ├── contracts/        service + instrumentation interfaces
│   │   ├── database/         Prisma client factory, catalog seed
│   │   ├── middleware/       error handler
│   │   ├── utils/            money (BigInt pico-USD), http/zod helpers, ids, errors
│   │   └── modules/
│   │       ├── projects/ providers/ usage/ cost/ budgets/ dashboard/
│   │       ├── activity/ traces/ observability/
│   │       └── instrumentation/ logging/
│   └── tests/                Vitest suites, one folder per module (+ helpers/testApp.ts)
├── frontend/
│   └── src/ pages/ components/ lib/   React app (see docs/ARCHITECTURE.md)
├── tests/e2e/                Playwright end-to-end specs
├── data/logs/                JSONL execution logs (git-ignored, created at runtime)
└── docs/                     documentation (below)
```

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modular monolith, request flow, instrumentation, logging, money model, pricing, budgets, privacy |
| [docs/DATABASE.md](docs/DATABASE.md) | Every model, column, index and relationship; migrations, backup, reset, retention |
| [docs/API.md](docs/API.md) | Every REST endpoint with parameters, responses, errors and curl examples |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy, helpers, suites, e2e setup |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, privacy and redaction rules, what is not provided |
| [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) | Requirement-by-requirement status, evidence, known limitations |
| [docs/QA-REPORT.md](docs/QA-REPORT.md) | QA findings (written by the QA agent) |
| [docs/CONTRACT.md](docs/CONTRACT.md) | Build contract used while implementing the modules |

## Known limitations (summary)

- Single user, no authentication, no TLS. Intended for local use on a trusted machine (see [docs/SECURITY.md](docs/SECURITY.md)).
- Mock providers only. Memory, tool and context events exist **only** as `SIMULATED` demo events; this app has no real memory / tool / context runtime and says so in the UI and API.
- Successful `GET` requests are not written to the execution log (to avoid flooding); mutations and any 4xx/5xx response are.
- Prices are illustrative and live only in the local database.

Full list: [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md).
