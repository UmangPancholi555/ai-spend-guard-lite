# AI Spend Guard Lite

A **local** application for tracking AI spend and observing agent-style execution (requests, traces, memory / bus / tool /
context events, logs and errors), with login, roles and a real project-memory runtime around **simulated** AI providers.

> **DEMO / SIMULATED providers.** No API keys are needed or read, no vendor SDK is installed, and the app never makes an
> outbound request to any AI provider. All "providers" are deterministic local mocks; all prices are illustrative
> demo numbers, not real price lists. Every simulated record is labelled `DEMO / SIMULATED`.
> The app itself is real: accounts and sessions, the project memory store, the request context manager, three local tools
> and the in-process event bus all run on every mock request and are recorded as `ACTUAL` events. See
> [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) for exactly what is real and what is simulated.

## Features

- **Authentication and roles**: login with HttpOnly session cookies, CSRF protection, brute-force lockout, `ADMIN` and read-only `VIEWER` accounts, first-run setup, session list / revoke, password change. See [docs/SECURITY.md](docs/SECURITY.md).
- **Projects**: create, edit, archive / unarchive, and delete (test projects only), with per-project usage totals, activity history and **project memory** (text items injected into that project's mock requests).
- **Mock providers**: "Mock OpenAI" and "Mock Anthropic" with deterministic token counts, cached tokens, latency, responses and failure modes (`error`, `timeout`, `rate_limit`).
- **Real in-app runtime**: memory store injection with real context-window truncation, a per-request context manager, three local tools (`pricing.lookup`, `budget.status`, `usage.summary`) and an in-process event bus, all instrumented as `ACTUAL`.
- **Cost engine**: exact integer money math (BigInt pico-USD, never floats), versioned per-model pricing, fallback pricing for unknown models (cost class `ESTIMATED`).
- **Pricing and calculator UI**: calculate costs, compare models, browse the catalog and its history, add a new price version.
- **Usage management**: searchable / filterable / sortable list, per-request detail with cost breakdown, streamed CSV export.
- **Budgets and alerts**: per-project or global budgets (daily / weekly / monthly, UTC), alerts at 50 / 80 / 100 % of the limit, exactly once per budget + period + threshold.
- **Activity feed, traces and spans**: every request becomes a trace with spans; a merged execution timeline per trace.
- **Observability**: overview, performance (avg / p95 / slow operations), error groups, event explorer for memory / bus / tool / context events, and an honest *instrumentation sources* registry (`ACTUAL` vs `SIMULATED` vs `UNAVAILABLE`).
- **Persistent structured logging**: SQLite rows plus daily JSONL files (size-capped), JSONL / CSV exports, configurable retention with an automatic scheduler.
- **Privacy by design**: prompt text and context are never stored; project memory text lives only in its own table and is never logged. Only hashes, sizes, counts and key names reach logs.
- **Dark mode**, responsive layout.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js (>= 20), Express 4, TypeScript, Zod validation, scrypt (`node:crypto`) for passwords |
| Database | SQLite via Prisma 6 (`prisma/schema.prisma`, migrations in `prisma/migrations`) |
| Frontend | React 18, Vite 6, React Router 6, Tailwind CSS 3, Recharts |
| Tests | Vitest + Supertest (backend), Playwright (end-to-end) |
| Monorepo | npm workspaces: `backend`, `frontend` (+ shared types in `shared/`) |

## Quick start

Prerequisites: Node.js 20 or newer and npm.

```bash
cp .env.example .env      # DATABASE_URL, PORT, LOG_DIR, auth settings (the file is git-ignored)
npm install               # installs both workspaces and generates the Prisma client
npm run db:migrate        # creates prisma/spendguard.db and applies migrations
npm run dev               # API on http://localhost:4000, web UI on http://localhost:5173
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` to the backend.
On first start the server seeds the provider / model / pricing catalog automatically (idempotent).

If the Prisma client is ever missing or stale (for example after changing `schema.prisma`), run `npm run db:generate`.

### First run: create the first administrator

Login is **on by default**, and a fresh database has no users. Pick one:

1. **Setup page.** Open the app: with no users it redirects to **`/setup`**. Choose a username (3-32 characters of `a-z 0-9 . _ -`) and a password (12-128 characters, not common, not containing the username). You are logged in as `ADMIN` immediately. Whoever reaches the port first can claim the account, so do this before exposing the server.
2. **Environment.** Put `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` before the first start. The server creates that admin at startup **only when no users exist** (it never changes or re-creates existing users). Remove the password from `.env` afterwards.
3. **CLI.**
   ```bash
   USERNAME=alice PASSWORD='a-long-unique-passphrase' npm run user:create            # ROLE=VIEWER for a read-only account
   USERNAME=alice npm run user:unlock                                                 # clear a lockout
   USERNAME=alice NEW_PASSWORD='another-long-passphrase' npm run user:reset-password  # recovery; signs the user out everywhere
   ```
   (`--password-stdin` reads the secret from stdin; avoid `--password` because it shows up in shell history.)

Afterwards sign in at **`/login`**. Admins add `VIEWER` (read-only) or further `ADMIN` accounts on the **Account** page; everyone can change their password and revoke their own sessions there.
Sessions last 12 hours (`SESSION_TTL_HOURS`) and end after 30 minutes of inactivity. 5 wrong passwords in a row for one username from one address lock that combination for 15 minutes.

> `AUTH_ENABLED=false` switches authentication, CSRF protection and roles **off** for the whole API. It is only for isolated local experiments; the server prints a loud warning at startup. Never use it on a shared machine or network.

### Production-style run (single process)

```bash
npm install
npm run db:migrate
npm run build             # type-checks + compiles the backend, type-checks + bundles the frontend
npm start                 # http://localhost:4000 serves the API and the built UI
```

The backend serves `frontend/dist` (if it exists) with an SPA fallback, so the UI and the API share
one origin on port 4000. `npm run setup` runs install + migrate + build in one go.
The server binds to **`127.0.0.1`** by default. If you expose it beyond loopback (`HOST=0.0.0.0`, a reverse proxy), terminate TLS in front of it, set
`COOKIE_SECURE=true`, `ALLOWED_HOSTS` and `TRUST_PROXY`, and read the deployment guidance in [docs/SECURITY.md](docs/SECURITY.md#13-deployment-guidance). The app does not terminate TLS itself.

### Environment variables

Copy `.env.example` to `.env`; defaults apply when a variable is unset. `.env` is git-ignored.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `file:./spendguard.db` | SQLite URL. A relative path is resolved **relative to `prisma/schema.prisma`**, so the default file is `prisma/spendguard.db`. Required (the Prisma client reads it from `.env`). |
| `PORT` | `4000` | API / production server port. |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback values print a warning (and an extra one when `COOKIE_SECURE=false`). |
| `LOG_DIR` | `./data/logs` | Directory for JSONL execution logs, resolved relative to the repo root. |
| `LOG_DIR_MAX_MB` | `500` | Cap on the total size of the JSONL directory (oldest day files are dropped first). |
| `AUTH_ENABLED` | `true` | `false` disables login, CSRF and roles entirely (see the warning above). |
| `SESSION_TTL_HOURS` | `12` | Absolute session lifetime. Sessions also expire after 30 minutes idle. |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS: adds `Secure` and uses the `__Host-sg_session` cookie name. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | empty | Optional: create the first admin at startup when no users exist. |
| `AUTH_LOGIN_IP_LIMIT_PER_MINUTE` | `10` | Unsuccessful login attempts allowed per client IP per minute. |
| `RATE_LIMIT_PER_MINUTE` | `600` | General API requests per minute per client IP (`0` disables). |
| `ALLOWED_HOSTS` | empty | Extra `Host` header names accepted besides localhost / 127.0.0.1 / `[::1]` (comma-separated); other hosts get `421`. |
| `TRUST_PROXY` | off | Opt-in: number of reverse-proxy hops (or `loopback`) whose `X-Forwarded-For` is trusted. |
| `EXPORT_MAX_ROWS` | `250000` | Largest export accepted without `limit=`; larger filters are rejected with 400. |
| `API_PORT` | `4000` | Dev only: port the Vite dev server proxies `/api` to. |
| `WEB_PORT` | `5173` | Dev only: Vite dev server port. |

### Reset the database

Stop the server first, then:

```bash
rm -f prisma/spendguard.db prisma/spendguard.db-journal   # the SQLite file (this also deletes all users, sessions and project memory)
rm -rf data/logs                                          # JSONL logs (optional)
npm run db:migrate                                        # recreate schema
```

The catalog (providers, models, pricing) is re-seeded the next time the server starts, and you create the first admin again (see above).
To keep a copy first: `cp prisma/spendguard.db prisma/spendguard.backup.db` (with the server stopped).

### Generate demo data

Any one of (log in as an `ADMIN`; `VIEWER` accounts are read-only):

- UI: on the **Dashboard** (empty state) click **Generate demo data** (200 requests over 14 days, with failures), or use **Request Simulator -> Seed demo data** for custom counts.
- API (authenticated; see [docs/API.md](docs/API.md) for the cookie / CSRF helper used here):
  ```bash
  c -X POST http://localhost:4000/api/simulations/seed \
    -H 'content-type: application/json' \
    -d '{"requests":200,"spreadDays":14,"includeFailures":true,"includeAgentActivity":true}'
  ```
  This creates (or reuses) the test project **"Demo Project (simulated)"** and inserts backdated, deterministic
  simulated requests through the normal request pipeline (without runtime events, so bulk demo data does not fabricate memory / tool / bus activity). See [docs/API.md](docs/API.md).

### Try the memory runtime

Open a project (**Projects -> project**), add a memory item (for example category `instructions`), then send a request from **Request Simulator** for that project. The response and the request drawer show the injected memory, the context versions and the tool calls; **Observability** shows the matching `ACTUAL` memory / context / tool / bus events.

## Running tests

```bash
npm test                  # backend unit + API tests (Vitest, isolated temp SQLite databases)
npm run typecheck         # TypeScript checks for backend and frontend
npx playwright install chromium   # one-time: download the browser used by e2e tests
npm run test:e2e          # Playwright end-to-end tests (see docs/TESTING.md)
```

Test counts and the latest results are recorded in [docs/TESTING.md](docs/TESTING.md) and
[docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) (last verified: 727 backend tests, 89 Playwright E2E tests passing).

## Tour of the UI

| Route | Page | What it does |
|---|---|---|
| `/login`, `/setup` | **Login**, **First-run setup** | Public pages: sign in; create the first administrator while no user exists. |
| `/` | **Dashboard** | Range selector, KPI cards (spend, requests, tokens, success rate), daily spend and success/failure charts, provider and model breakdown, current-period budget utilization, recent activity, failed requests and budget alerts. Empty state offers **Generate demo data**. |
| `/projects` | **Projects** | Searchable, filterable list with usage totals; create / edit / archive / unarchive; delete is enabled only for test projects. |
| `/projects/:id` | **Project detail** | Project summary, budgets and utilization, recent usage, paged activity history, and the **project memory** panel (add / edit / enable / delete memory items). |
| `/usage` | **Usage** | Filter by search text, provider, model, project, status, date range; sort by time / cost / duration; click a row for the request drawer (tokens, cost breakdown, pricing version, prompt hash, memory / context / tool summary, metadata). **Export CSV** respects the filters. |
| `/simulator` | **Request Simulator** | Send one mock provider request (provider, model or custom model, prompt, max tokens, temperature, simulated failure, memory injection on / off, optional simulated agent activity); seed demo data; run a simulated agent execution (optionally failing) and jump to its trace. |
| `/pricing` | **Pricing & Calculator** | Cost calculator, model comparison, price catalog with version history, and creation of a new price version. |
| `/budgets` | **Budgets & Alerts** | Create / edit / delete budgets, utilization bars, per-budget utilization history chart, alert history, **Evaluate now**. |
| `/activity` | **Activity** | Persistent feed of recorded events, filter by type, level, source (ACTUAL / SIMULATED), project, text and dates. |
| `/traces` | **Traces** | Trace list (status, source, search, dates; exports) and a background-tasks panel (seed, budget evaluation, retention sweep). |
| `/traces/:traceId` | **Trace detail** | Span waterfall, merged execution timeline, correlated events, error and stack for failed traces. |
| `/observability` | **Observability** | Overview KPIs with an actual-vs-simulated split, recent errors and traces, instrumentation sources panel, performance panel, event explorer (Memory, Bus, Tool calls, Context) with exports. |
| `/errors` | **Error Log** | Error-group chart, failed operations with category, trace link and stack; filters and exports. |
| `/logs` | **Execution Logs** | Structured execution log with filters and exports. |
| `/settings` | **Settings** | Retention days, slow-operation threshold, **Run retention sweep now**; plaintext content capture is shown as permanently OFF. |
| `/account` | **Account** | Your profile, password change, your sessions (revoke), and for admins user management (create, change role, reset password, unlock, delete). |

`VIEWER` accounts can open every page but all change actions are disabled (and rejected by the API). Page layouts are still being polished; the route and page names above are stable.

## Project layout

```
ai-spend-guard-lite/
├── package.json              npm workspaces + root scripts (incl. user:create / user:unlock / user:reset-password)
├── .env.example              every environment variable with defaults
├── prisma/
│   ├── schema.prisma         data model (SQLite, 20 models)
│   └── migrations/           SQL migrations (applied with `npm run db:migrate`)
├── shared/                   types.ts (API contract), auth.ts, runtime.ts: DTOs shared by backend and frontend
├── backend/
│   ├── src/
│   │   ├── server.ts         process entry: config, catalog seed, admin bootstrap, retention scheduler, listen
│   │   ├── app.ts            Express app wiring (host guard, headers, CORS, origin guard, rate limit, JSON, auth, routers, static UI)
│   │   ├── config.ts         env -> AppConfig
│   │   ├── contracts/        service + instrumentation interfaces
│   │   ├── database/         Prisma client factory, catalog seed
│   │   ├── middleware/       security (headers, rate limit, host guard), error handler
│   │   ├── utils/            money (BigInt pico-USD), password (scrypt), http/zod helpers, ids, errors
│   │   └── modules/
│   │       ├── auth/ projects/ providers/ usage/ cost/ budgets/ dashboard/
│   │       ├── runtime/      real memory store, context manager, tool executor, event bus
│   │       ├── activity/ traces/ observability/
│   │       └── instrumentation/ logging/ (incl. retention scheduler)
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
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modular monolith, HTTP layer, auth architecture, request pipeline, real runtime, instrumentation, logging, money model, pricing, budgets, privacy |
| [docs/DATABASE.md](docs/DATABASE.md) | Every model, column, index and relationship; migrations, backup, reset, retention |
| [docs/API.md](docs/API.md) | Every REST endpoint with parameters, responses, errors and authenticated curl examples |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy, helpers (including auth-enabled test apps), suites, e2e setup |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth model, sessions, CSRF, lockout, roles, headers, rate limits, privacy and redaction, deployment guidance, residual risks |
| [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) | Requirement-by-requirement status, evidence, known limitations |
| [docs/QA-REPORT.md](docs/QA-REPORT.md) | QA findings (written by the QA agent) |
| [docs/CONTRACT.md](docs/CONTRACT.md) | Build contract used while implementing the modules |

## Known limitations (summary)

- Mock providers only: no real AI vendor is called, token counts and latencies are simulated, and the agent-run / seeded "agent activity" generator produces scripted `SIMULATED` events. The memory store, context manager, tools and bus are real, but they serve this app's own mock pipeline; there is no external agent runtime attached to instrument.
- No TLS termination, no multi-factor authentication or SSO, no multi-tenancy (every user sees all projects). Login throttles are in memory and per process. See [docs/SECURITY.md](docs/SECURITY.md).
- Project memory text is stored in plain text in the SQLite file.
- Successful `GET` requests are not written to the execution log (to avoid flooding); mutations and 4xx/5xx responses are (unauthenticated rejections are aggregated).
- Prices are illustrative and live only in the local database.

Full list: [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md).
