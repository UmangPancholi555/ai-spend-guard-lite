# Security and privacy

AI Spend Guard Lite is a **local, single-user demo/development tool**. This document describes the protections that are
actually implemented, how to verify them, and, just as important, what is **not** provided.

## 1. Threat model

| Item | Assumption |
|---|---|
| Deployment | One developer machine; the server is started by the user (`npm run dev` / `npm start`) and used from a local browser. |
| Users | A single trusted user. There is no login, no roles, no multi-tenancy. |
| Data | Only simulated usage, demo cost figures and operational metadata. No real prompts, customer data, credentials or API keys are required, processed or stored. |
| Network | Loopback use. The app makes **no outbound requests**. |

Assets worth protecting even in this setting: the integrity of the local database and logs, the user's browser session (against hostile web pages), and the guarantee that prompt / context / memory **content** never lands on disk.

In scope: malformed or hostile input to the API, cross-site requests from web pages the user visits, accidental leakage of content into logs and exports, spreadsheet formula injection through exports.
Out of scope: a hostile local user or process, a compromised machine, exposure to the public internet or an untrusted LAN, supply-chain compromise of npm dependencies.

## 2. No secrets, no outbound AI calls

- **No API keys.** The app reads exactly three environment variables (`DATABASE_URL`, `PORT`, `LOG_DIR`; plus the dev-only `API_PORT` / `WEB_PORT` in `vite.config.ts`). None is a credential. `.env` only holds local paths and a port, and is git-ignored; `.env.example` is committed.
- **No vendor SDKs.** `backend/package.json` dependencies are `@prisma/client`, `cors`, `express`, `zod`; `frontend/package.json` dependencies are `react`, `react-dom`, `react-router-dom`, `recharts`. The root adds only dev tooling (`prisma`, `typescript`, `concurrently`, `@playwright/test`). Verified by inspecting those manifests and by grepping `package-lock.json` for `openai|anthropic|cohere|mistral|ollama|langchain|llama|gemini|generative-ai|vertex|bedrock|huggingface` (no matches).
- **No outbound HTTP code.** A search of `backend/src` and `frontend/src` finds no `fetch`, `http(s).request`, `axios`, `XMLHttpRequest` or socket code, other than the frontend's relative `/api` calls to its own backend (`frontend/src/lib/api.ts`), and no hard-coded external URLs.
- **Mock providers are pure functions.** `modules/providers/mock/*` derive results from a SHA-256 seed and a PRNG; they import no I/O modules (no `Math.random`, no network, no file access).
- **UI labelling.** API responses, usage rows and the UI carry `simulated: true` / `DEMO / SIMULATED`, so simulated figures cannot be mistaken for billing data. Prices are illustrative.
- The repository's own tests include a check that no prompt text is persisted (`integration/privacy-security.test.ts`).

To re-verify: `grep -rniE "openai|anthropic" backend/package.json frontend/package.json package.json` (only mock provider *names* appear in source code, never SDKs) and `grep -rnE "fetch\(|https?\.request|axios" backend/src`.

## 3. Privacy: what is stored and what is not

**Never stored:** prompt text, context content, memory content, secrets. The prompt is hashed (`sha256`) and measured (`promptChars`); the string is dropped after the mock call.
`UsageEvent.responseText` is the deterministic filler text of the mock provider, not model output and not derived from the prompt text.
Agent-activity events carry only counts, sizes, token estimates, names and hashes (for example tool inputs are `{paramNames, queryChars, queryHash}`).

**Settings:** `captureContentPlaintext` is fixed `false`; `PUT /api/settings` rejects `true` (and any unknown key). The Settings page shows it as permanently OFF.

### Redaction rules (`modules/instrumentation/sanitize.ts`)

Every metadata object that reaches the SDK (span attributes, log attributes, activity metadata, bus / tool `inputMeta` / `outputMeta`, task results, JSONL lines) is sanitised first:

1. A value under a key matching `/(content|prompt|text|body|message|memory|secret|password|authorization|api[-_]?key|token$)/i` is replaced by `{ "redacted": true, "type", "length", "sha256_8" }`.
2. Exceptions that keep metadata useful: numeric / boolean values under content-ish keys are counts or flags and are kept (`messageCount`, `promptChars`) unless the key is a *secret* key (`secret|password|authorization|api key|token$`); keys ending in `hash|chars|count|length|bytes|size|tokens|type|kind|name|status|id|ids|digest` are treated as metadata and kept (strings > 256 chars are not).
3. Any other string is truncated to 256 chars; strings that look like credentials (`Bearer ...`, `sk-...`, JWT-shaped) are redacted regardless of key.
4. Caps: 50 items / keys per container, depth 6, ~16 KB serialised; circular references, functions and symbols dropped; `Error` objects reduced to their name; binary values to `{type, length}`.
5. Sanitising is deep and idempotent and never throws (`{sanitizeError: true}` on failure).

### Known limits of the privacy model

- **Free-text fields are not redacted:** log `message`, activity `message`, `operation`, error messages and stacks (bounded to 2,000 / 8,000 chars), project names and descriptions. They are written by the app itself or typed by the user; do not put secrets in project names.
- **Hashes are unsalted.** `promptHash`, the redaction marker's `sha256_8`, `metadata.mockSeed` and the mock response id (`chatcmpl-...` / `msg_...`) derive from SHA-256 of the prompt (and related fields). They do not reveal text but allow someone with a candidate prompt to confirm it.
- **The prompt exists in process memory** for the duration of the request and in the request body that the client sent.
- Operating-system level artefacts (shell history of curl commands, editor swap files) are outside the app's control.

## 4. Input validation and injection

- **Validation:** every endpoint parses body, query and path parameters with **Zod** (`parse()` in `utils/http.ts`), with explicit lengths (names <= 80, descriptions <= 1000, prompts <= 20,000, search <= 200 / 300), enums, integer ranges (page sizes <= 200, `maxOutputTokens` <= 8192, retention 0..3650, ...) and strict decimal formats for money and prices. Invalid input yields `400 VALIDATION_ERROR` with `{path, message}` details; malformed JSON yields `400`; bodies over **1 MB** yield `413 PAYLOAD_TOO_LARGE` (`express.json({ limit: '1mb' })`). `PUT /settings` uses a strict schema.
- **SQL injection:** all data access goes through Prisma Client, which parameterises values. The only raw SQL is two `prisma.$queryRaw` calls in `modules/usage/search.ts`, written with the `Prisma.sql` tagged template (values are bound parameters, never concatenated) and a fixed `ESCAPE '\'` clause; `%`, `_` and `\` in user search text are escaped so they match literally. Sort keys come from fixed enums mapped to column names in code. The `integration/privacy-security` suite sends SQL-ish strings through search parameters and asserts no 5xx and no data change.
- **Export dataset names** are looked up with `hasOwnProperty` in a fixed registry (no path or table name derived from user input); unknown names return 404.
- **XSS:** the React UI renders text through JSX escaping; there is no `dangerouslySetInnerHTML` / `innerHTML` in `frontend/src`. API responses are JSON (`Content-Type: application/json`). A test stores HTML / SQL-looking project names and asserts they round-trip as plain data.
- **CSV / spreadsheet formula injection:** `csvCell()` prefixes `'` to any value starting with `=`, `+`, `-` or `@` that is not a plain number; dataset exports additionally guard a leading TAB or CR. Cells are RFC 4180 quoted. Applies to `/usage/export.csv` and `/export/:dataset?format=csv`. (The usage CSV uses the base guard, without the TAB / CR extension.)
- **Log injection:** JSONL lines are `JSON.stringify` output with CR/LF stripped, one object per line; exports set `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` and use fixed, server-generated filenames.
- **Error handling:** unexpected errors return a generic `500 INTERNAL_ERROR`; stack traces are recorded in the local error log, never sent to the client. `x-powered-by` is disabled.
- **Static files:** served by `express.static` from `frontend/dist` only; the SPA fallback excludes `/api`.

## 5. CORS and browser-facing behaviour

Implemented policy (`backend/src/app.ts`): `cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] })`.

- Browsers on `http://localhost:<port>` and `http://127.0.0.1:<port>` (for example the Vite dev server) may read responses; other origins receive no `Access-Control-Allow-Origin` header, so their scripts cannot read API responses, and non-simple requests (JSON `POST`, `PATCH`, `PUT`, `DELETE`) fail the preflight.
- Requests without an `Origin` header (curl, scripts, same-origin production UI) are unaffected.
- No cookies or credentials are used, so there is no session to steal.
- **Cross-site "simple" requests are still delivered.** CORS controls what a page can *read*, not what the server *receives*. A hostile web page could submit a form-encoded `POST` to a few endpoints that need no body: `POST /api/logging/retention/run` (deletes log rows older than the retention setting), `POST /api/budgets/evaluate`, and `POST /api/projects/<id>/archive|unarchive` (requires a known id). Other write endpoints require a JSON body and therefore a preflight, which is refused. Impact is limited to local log / state changes; mitigations if this matters to you are listed in section 7.
- No `Host` header validation (DNS-rebinding protection) and no security headers such as CSP (no `helmet`).

## 6. What is NOT provided

| Area | Status |
|---|---|
| Authentication / authorisation | **None.** Anyone who can reach the port can read and change everything. |
| Multi-user / multi-tenant isolation | **None.** Single shared database. |
| TLS | **None.** Plain HTTP only. |
| Network binding control | The server calls `app.listen(PORT)` without a host, so it listens on **all interfaces** (reachable from your LAN), and there is no `HOST` setting. |
| Rate limiting / abuse protection | **None.** For example `POST /simulations/seed` (up to 2,000 requests, executed inline) and `GET /usage/export.csv` (loads all matching rows into memory) can tie up the process. `/export/:dataset` streams in batches of 500. |
| Audit trail of who did what | Activity events exist, but without identity. |
| Encryption at rest | None; the SQLite file and JSONL logs are plain files protected only by OS permissions. |
| Security headers / CSP | None beyond `x-powered-by` removal and the export headers above. |
| Dependency audit | Not run as part of this project's verification; run `npm audit` before any wider use. |
| Multi-process safety | In-process mutexes serialise budget and pricing creation; running several server processes against one database can bypass the application-level "one budget per scope + period" rule (alert dedupe is DB-enforced and remains safe). |

## 7. Recommendations

1. Run it on a trusted, single-user machine and keep it off shared networks. Block the port in your host firewall, or put the process behind a loopback-only proxy, because the default bind is all interfaces.
2. If it must ever be reachable by others: add authentication, TLS termination (reverse proxy), a `HOST` bind option, Host-header validation, rate limiting and `helmet`; restrict CORS to the exact UI origin; consider requiring `Content-Type: application/json` (or a custom header) on every mutating route to close the simple-request gap in section 5.
3. Keep the file permissions of `prisma/spendguard.db*` and `data/logs/` private (for example `chmod 700 data`).
4. Do not type secrets into project names, descriptions or other free-text fields.
5. Treat the exported CSV / JSONL files as local operational data; open CSVs in a spreadsheet only from a trusted source (the formula guard is defence in depth, not a guarantee).
6. Run `npm audit` periodically and pin versions (`package-lock.json` is committed).
7. If the app is ever adapted to call real providers: keep keys in a secret store, never in `.env` committed files, never in logs; extend the sanitizer key list for provider-specific fields; and revisit this document, because the "no outbound calls" guarantees above would no longer hold.
