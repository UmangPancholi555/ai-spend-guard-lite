# Security and privacy

AI Spend Guard Lite is a **demo / development tool with login**. It binds to loopback by default, requires an authenticated
session for every API call (except a few public endpoints), and never makes outbound requests. This document describes the
protections that are actually implemented, how to verify them, and what is **not** provided.

Sections: 1 threat model, 2 authentication and sessions, 3 CSRF and the origin guard, 4 roles, 5 lockout and login throttling,
6 password storage and policy, 7 first-run setup and user management, 8 HTTP hardening (headers, CSP, rate limit, CORS),
9 no secrets / no outbound AI calls, 10 privacy and redaction, 11 input validation and injection, 12 audit trail,
13 deployment guidance (`COOKIE_SECURE`, `AUTH_ENABLED=false`), 14 residual risks.

## 1. Threat model

| Item | Assumption |
|---|---|
| Deployment | One machine or a small trusted team. The server is started by the operator (`npm run dev` / `npm start`). Default bind is `127.0.0.1` (`HOST` overrides it). |
| Users | Named accounts with the roles `ADMIN` (read + write) and `VIEWER` (read-only). Every user sees the same data: there is **no multi-tenancy**. |
| Data | Simulated usage, demo cost figures, operational metadata, user-entered project memory text (see section 10) and account records (username, scrypt hash, session hashes). No real provider prompts, customer data or API keys are required or stored. |
| Network | Loopback by default. The app makes **no outbound requests**. TLS is **not terminated by the app** (section 13). |

Assets worth protecting: the integrity of the local database and logs, user sessions (against hostile web pages and
credential guessing), and the guarantee that prompt / context / memory **content** never lands in logs, traces or events.

In scope: credential guessing, cross-site requests from web pages the user visits, session theft via script injection,
malformed or hostile API input, accidental leakage of content or credentials into logs and exports, spreadsheet formula
injection through exports, log injection.
Out of scope: a hostile local user or process, a compromised machine, direct exposure to the public internet without a TLS
reverse proxy, supply-chain compromise of npm dependencies, denial of service by an authenticated user.

## 2. Authentication and sessions

Implementation: `backend/src/modules/auth/*`, `backend/src/utils/password.ts`, `shared/auth.ts`.

- **Login is on by default** (`AUTH_ENABLED=true`). `requireAuth` runs before every module router. The only public endpoints are
  `GET|HEAD /api/health`, `GET|HEAD /api/auth/status`, `POST /api/auth/setup` and `POST /api/auth/login`. Everything else,
  **including unknown paths**, answers `401 UNAUTHENTICATED` without a valid session (so route existence is not disclosed). Path
  matching for the public list is lower-cased, ignores trailing slashes and is never URL-decoded.
- **Session cookie `sg_session`** (named `__Host-sg_session` when `COOKIE_SECURE=true`: the `__Host-` prefix makes browsers require `Secure`, `Path=/` and no `Domain`; both names are accepted when reading and both are cleared on logout, so switching `COOKIE_SECURE` does not strand a session). The value is 32 random bytes (43-character base64url). Only `sha256(token)` is stored in
  `Session.tokenHash`; a database leak does not yield usable cookies. Flags: `HttpOnly`, `SameSite=Strict`, `Path=/`,
  `Secure` when `COOKIE_SECURE=true`, `Max-Age` = the session TTL. A malformed cookie is rejected before any database lookup and cleared.
- **Lifetime.**
  | Rule | Value |
  |---|---|
  | Absolute lifetime | `SESSION_TTL_HOURS` (default 12) |
  | Idle timeout | 30 minutes without a request |
  | `lastSeenAt` refresh | at most once per 60 seconds |
  | Sessions per user | 20 (the oldest are pruned when a new one is created) |
  | Dead-session cleanup | expired / idle sessions are purged lazily when a session is created |
- **Rotation and revocation.** Logging in deletes the session of the cookie that was presented (fixation defence) and issues a
  new token. Logout deletes the session and clears the cookie. A password change revokes **all other sessions** of that user.
  Deleting a user (sessions cascade) or an admin resetting a user's password revokes that user's sessions (an admin resetting their own password keeps the current session). `GET /api/auth/sessions` lists your own sessions
  (id, timestamps, IP, user agent, `current`; never tokens or hashes) and `DELETE /api/auth/sessions/:id` revokes one of them.
- **Responses are `Cache-Control: no-store`** on authenticated routes; auth handlers wrap database errors so Prisma errors
  (which could echo column values) never reach the generic error handler.
- **Frontend.** The SPA never sees the session token (HttpOnly). It keeps the CSRF token in memory only, redirects to `/login` on
  the first `401 UNAUTHENTICATED` and refreshes a stale CSRF token once from `GET /api/auth/me`.

## 3. CSRF and the origin guard

Three independent layers protect state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`):

1. **`SameSite=Strict` cookie**: browsers do not attach the session to cross-site requests.
2. **Origin guard** (`backend/src/app.ts`, on `/api`): a non-GET/HEAD/OPTIONS request that carries an `Origin` header which is not
   `http(s)://localhost`, `127.0.0.1` or `[::1]` (any port) is rejected with `403 FORBIDDEN_ORIGIN` before the body is parsed.
   Requests without an `Origin` header (curl, scripts, same-origin navigation without the header) are not affected by this layer.
3. **CSRF token** (`X-CSRF-Token`) on every unsafe method. The token is `HMAC-SHA256(sessionToken, "spendguard:csrf:v1")`
   (base64url); only its sha256 is stored (`Session.csrfHash`) and it is compared in constant time. `POST /auth/login`,
   `POST /auth/setup` and `GET /auth/me` return it as `data.csrfToken`. Missing or wrong token: `403 CSRF_INVALID`.
   The CSRF check runs for **all** authenticated unsafe requests, including multipart or form-encoded ones, so the old
   "cross-site simple request" gap (form-encoded `POST` without preflight) is closed.

CSRF is not enforced on `POST /auth/login` and `POST /auth/setup` (there is no session yet); login CSRF is mitigated by the
`SameSite=Strict` cookie and the origin guard.

## 4. Roles

| Role | May do |
|---|---|
| `ADMIN` | Everything, including user management (`/api/auth/users*`) and unlocking accounts. |
| `VIEWER` | Every `GET`. Non-GET calls are limited to `POST /auth/logout`, `POST /auth/password`, `POST /cost/calculate` (a pure calculator) and `DELETE /auth/sessions/:id` (own sessions). All other non-GET calls: `403 FORBIDDEN`. This includes `POST /providers/requests`, `/simulations/*`, `/tools/:name/invoke`, memory edits, budgets, settings and retention. |

Safety rails (`409 LAST_ADMIN`, `409 CANNOT_DELETE_SELF`): the last remaining `ADMIN` cannot be demoted or deleted, and a user
cannot delete their own account. Every `/auth/users*` route requires `ADMIN` (`403 FORBIDDEN` otherwise).

The UI hides write controls for `VIEWER` and shows a read-only banner, but enforcement is in the API.

## 5. Lockout and login throttling

Brute-force defence is layered so that an attacker cannot lock a legitimate user out of their usual location, and so that responses never reveal whether a username exists.

| Control | Behaviour |
|---|---|
| Per (username, IP) lock | 5 consecutive failures for one username **from one address** lock that pair for 15 minutes: `429 ACCOUNT_LOCKED` with `Retry-After`. In memory, identical for real and unknown usernames. The same keying protects the "current password" check of `POST /auth/password`. |
| Global per-username progressive delay | After 10 failures for one username from **any** address, further failures lock the username for a growing delay (15 s, 30 s, 60 s ... capped at 15 min). For real users this is stored in `User.failedAttempts` / `lockedUntil`; unknown usernames use an in-memory tracker with the same maths. An address that has logged in successfully for that user before (a live session or a retained `auth.login.success` audit event from the same IP) is exempt, so a distributed guessing attack cannot lock the owner out of their normal location. |
| Idle decay | Failure counters reset after 15 minutes without a failure; a success resets them at once. |
| Unlock / reset | An ADMIN can unlock (`PATCH /auth/users/:id {"unlock": true}`) or reset the password; both also clear that user's in-memory (username, IP) locks. |
| Uniform responses and timing | Failures answer `401 INVALID_CREDENTIALS` for unknown and known users alike; a dummy scrypt verification equalises response time. |
| Per-IP login limiter | `AUTH_LOGIN_IP_LIMIT_PER_MINUTE` (default 10) **unsuccessful** attempts per IP per minute, plus a cap of 6x that value on total attempts; successful logins refund their slot. Exceeding it: `429 RATE_LIMITED` with `Retry-After`. |
| General API rate limit | Section 8. |

The per-pair locks, the unknown-username tracker and the per-IP limiters live **in process memory** (section 14); the per-user progressive lock for real accounts is in the database.

## 6. Password storage and policy

- **Algorithm:** scrypt (`node:crypto`), `N = 2^15`, `r = 8`, `p = 1`, 16-byte random salt, 64-byte derived key. Stored as
  `scrypt$N$r$p$saltB64$hashB64` in `User.passwordHash`. Verification is constant-time (`timingSafeEqual`); parameters read
  back from the stored string are bounded (N a power of two in 2^14..2^20, r <= 16, p <= 4) so a tampered row cannot force huge memory use.
- **Policy** (`shared/auth.ts`, `utils/password.ts`): 12 to 128 characters; must not contain the username; rejected if it is on the
  built-in common-password list, is a single repeated character or is a plain sequence (for example `123456789012`).
- **Usernames:** 3 to 32 characters of `a-z 0-9 . _ -`, stored lower-case and unique.
- Passwords are never logged, returned, or written to activity metadata. The sanitizer also redacts password-hash formats
  (`scrypt$...`, bcrypt, argon2, `salt:hash` hex) and any key matching `password|passwd|secret|token|cookie|session|csrf|credential|private`, regardless of the caller.

## 7. First-run setup and user management

There are three ways to create the first administrator; the first two only work while **zero users exist** (the CLI has no such limit):

1. **`/setup` page / `POST /api/auth/setup`**: creates the first `ADMIN` and logs them in. An atomic
   `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM "User")` makes concurrent setup calls race-safe: exactly one wins, the others get `409 SETUP_COMPLETE`.
   While no user exists the server prints a reminder at startup. Anyone who can reach the port can claim the account on a fresh
   database: complete setup before exposing the port, or use method 2.
2. **`ADMIN_USERNAME` / `ADMIN_PASSWORD` environment variables**: `bootstrapAdmin` creates the first admin at startup only when no
   users exist. It is idempotent and never resets, re-creates or overwrites an existing user. The password must satisfy the policy.
   Remove the password from the environment afterwards (it is not needed again).
3. **CLI** (talks to the database directly: no HTTP, no session; works with or without a running server; never echoes secrets):
   - `USERNAME=alice PASSWORD='...' [ROLE=ADMIN|VIEWER] npm run user:create` (or `npm run user:create -- --username alice --role VIEWER --password-stdin`);
   - `USERNAME=alice npm run user:unlock` clears failed-attempt counters and the lock;
   - `USERNAME=alice NEW_PASSWORD='...' npm run user:reset-password` sets a new password (policy-checked), clears the lock and revokes all of that user's sessions. This is the recovery path when the only admin forgot their password or is locked out.
   Each command writes an audit activity event with `via: "cli"`. `--password` / `--new-password` also work but are discouraged (visible in shell history and process listings). Access to a shell on the host is therefore equivalent to administrator access. A running server also keeps (username, IP) locks in memory; they expire on their own after 15 minutes or on restart. `USERNAME` is also a variable that Windows sets to the OS account name: pass `--username` explicitly there.

Afterwards ADMINs manage accounts under **Account** (`/account`) or through `/api/auth/users` (create, change role, reset another user's password,
unlock, delete; an admin changes their own password only via `POST /auth/password`, which requires the current password). There is no self-service registration and no password-reset-by-email; a forgotten admin password is recovered with `npm run user:reset-password` (or through another admin).

## 8. HTTP hardening

Implemented in `backend/src/middleware/security.ts` and `backend/src/app.ts` (a dependency-free subset of what `helmet` provides).
Middleware order: Host guard -> `securityHeaders` -> CORS allow-list -> `/api` origin guard -> `/api` rate limiter -> `express.json` (1 MB) ->
request-lifecycle logging -> `/api/health` -> auth router -> `requireAuth` -> module routers -> `notFound` -> error handler.

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `no-referrer` |
| `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

Notes: `style-src 'unsafe-inline'` is required by the bundled UI (Recharts / inline styles); scripts are restricted to same-origin files, so
injected inline script does not execute. There is **no `Strict-Transport-Security`** header because the app does not speak TLS itself (add it at your TLS proxy). `x-powered-by` is disabled. These headers apply to the
production-style server (static UI + API); the Vite dev server (`:5173`) serves the UI with its own headers.

**Host guard (DNS-rebinding defence):** the `Host` header must be `localhost`, `127.0.0.1` or `[::1]` (any port) or a name listed in `ALLOWED_HOSTS` (comma-separated, hostnames only); otherwise `421 MISDIRECTED_REQUEST`. It runs first and also covers the static UI. Set `ALLOWED_HOSTS` when the app is reached through a real host name (reverse proxy, LAN name).

**Client IP:** `req.ip` is the socket address unless `TRUST_PROXY` is set (a hop count such as `1`, or `loopback`; opt-in so that a client cannot spoof `X-Forwarded-For`). The general rate limiter keys IPv6 clients by their /64 prefix because attackers rotate addresses inside it.

**General rate limit:** fixed 60-second window per client IP on `/api`, default **600 requests/minute**
(`RATE_LIMIT_PER_MINUTE`, `0` disables). Responses carry `RateLimit-Limit` and `RateLimit-Remaining`; when exceeded: `429 RATE_LIMITED` with `Retry-After`. State is in memory (see section 14).

**CORS:** `cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] })`. Other origins get no `Access-Control-Allow-Origin`.
Credentialed cross-origin reads are not enabled (no `Access-Control-Allow-Credentials`); the dev UI works because the Vite proxy makes `/api` same-origin.

**Request body:** `express.json({ limit: '1mb' })` -> `413 PAYLOAD_TOO_LARGE`; malformed JSON -> `400`.

**Request-log flood protection:** the request-lifecycle middleware sits in front of authentication, so unauthenticated noise is not written row by row: `401`, `429` and unmatched-route `404` responses are only counted and flushed as one aggregated `request.rejected.summary` log per minute (counts by status, no client-controlled strings); other detailed request rows are capped at 1,200 per minute (the excess is counted in the summary) and the logged path is truncated to 120 characters. A client-supplied `x-request-id` is honoured only if it matches `[A-Za-z0-9._-]{8,64}`.

**Log volume:** JSONL files roll over at 50 MB, and the whole `LOG_DIR` is capped at 500 MB (`LOG_DIR_MAX_MB`): the oldest day files are deleted first and, if still over, JSONL appends are suspended with one warning (the SQLite rows keep being written). Lines are written in batches (about every 250 ms) and flushed on exit.

**Exports:** CSV / JSONL downloads are authenticated like any other route, set `Content-Disposition: attachment`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and server-generated filenames. `/export/:dataset` refuses filters matching more than 250,000 rows (`EXPORT_MAX_ROWS`) before streaming; `/usage/export.csv` streams in keyset batches of 500.

## 9. No secrets, no outbound AI calls

- **No API keys.** The app reads: `DATABASE_URL`, `PORT`, `HOST`, `LOG_DIR`, `LOG_DIR_MAX_MB`, `AUTH_ENABLED`, `SESSION_TTL_HOURS`, `COOKIE_SECURE`,
  `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `AUTH_LOGIN_IP_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_MINUTE`, `ALLOWED_HOSTS`, `TRUST_PROXY`, `EXPORT_MAX_ROWS` (plus the dev-only
  `API_PORT` / `WEB_PORT` in `vite.config.ts`). The only credential among them is `ADMIN_PASSWORD` (bootstrap only). `.env` is git-ignored; `.env.example` is committed with empty placeholders.
- **No vendor SDKs.** `backend/package.json` dependencies are `@prisma/client`, `cors`, `express`, `zod` (no cookie / session / hashing
  libraries: sessions use `node:crypto`); the frontend uses `react`, `react-dom`, `react-router-dom`, `recharts`. Verified by reading the manifests and grepping `package-lock.json` for `openai|anthropic|cohere|mistral|ollama|langchain|llama|gemini|generative-ai|vertex|bedrock|huggingface` (no matches).
- **No outbound HTTP code** in `backend/src` or `frontend/src` other than the frontend's relative `/api` calls to its own backend.
- **Mock providers are pure functions** (SHA-256 seed + PRNG, no I/O). The local tools (`pricing.lookup`, `budget.status`, `usage.summary`) only read the local database.
- **UI labelling.** Responses, usage rows and the UI carry `simulated: true` / `DEMO / SIMULATED`.

To re-verify: `grep -rnE "fetch\(|https?\.request|axios" backend/src` (no hits) and `grep -rniE "openai|anthropic" backend/package.json frontend/package.json package.json` (no hits).

## 10. Privacy: what is stored and what is not

**Prompt text is never stored.** It is hashed (`promptHash = sha256`) and measured (`promptChars`); the string is dropped after the mock call.
`UsageEvent.responseText` is the deterministic filler text of the mock provider, not model output.
`UsageEvent.metadata` includes `effectivePromptChars` (prompt + injected memory length) but not the text.

**Project memory is user data kept on purpose.** The runtime memory store (`ProjectMemoryItem`: title, category, content) holds text
the user typed, because injecting it into mock requests is its job. It is readable through `GET /api/projects/:id/memory` by any
authenticated user, and stored in plain text in the SQLite file. It is **never** written to logs, spans, events, activity or exports: the memory
routes and the injection step record only item ids, category, size in bytes, token estimates, counts and an 8-character sha256 prefix of the content (`contentHash`).
Context content (prompt + memory + response) exists only in process memory for the duration of one request. Tool `inputMeta` holds
parameter names, types, sizes and a short hash, never values.
Do not store secrets in project memory, project names or descriptions.

**Settings:** `captureContentPlaintext` is fixed `false`; `PUT /api/settings` rejects `true` and unknown keys.

### Redaction rules (`modules/instrumentation/sanitize.ts`)

Every metadata object that reaches the SDK (span attributes, log attributes, activity metadata, bus / tool `inputMeta` / `outputMeta`, task results, JSONL lines) is sanitised first:

1. A value under a key matching `/(content|prompt|text|body|message|memory|secret|password|passwd|authorization|api[-_]?key|token$|cookie|session|csrf|credential|private)/i` is replaced by `{ "redacted": true, "type", "length", "sha256_8" }`.
2. Exceptions that keep metadata useful: numbers / booleans under content-ish keys are counts or flags and are kept, but **not** under credential keys (`secret|password|passwd|authorization|api key|token$|cookie|session|csrf|credential|private`). Keys ending in `hash|chars|count|length|bytes|size|tokens|digest` are metadata under any sensitive key (`promptHash`, `sessionCount`); keys ending in `type|kind|name|status|id|ids` are kept only under non-credential keys (`toolName` yes, `sessionId` / `tokenId` no).
3. Any other string is truncated to 256 chars. Strings that look like credentials are redacted regardless of key: `Bearer ...`, `Basic ...`, `sk-...`, GitHub / AWS / Slack token shapes, JWTs, scrypt / bcrypt / argon2 / pbkdf2 hashes, `salt:hash` hex, PEM private keys.
4. Caps: 50 items / keys per container, depth 6, ~16 KB serialised; circular references, functions and symbols dropped; `Error` objects reduced to their name; binary values to `{type, length}`.
5. Free-text messages, stacks and operation names are kept (they describe failures) but ANSI escape sequences and control characters are stripped, credential-looking substrings become `[REDACTED]`, and length is bounded (2,000 / 8,000 chars for messages / stacks).
6. Sanitising is deep and idempotent and never throws.

### Known limits of the privacy model

- **Free-text fields are only pattern-redacted:** log / activity `message`, `operation`, error messages and stacks, project names and descriptions. A secret with no recognisable shape typed into a project name would be stored and shown.
- **Hashes are unsalted.** `promptHash`, `sha256_8`, `contentHash`, `metadata.mockSeed` and the mock response id derive from SHA-256 of the prompt / content. They do not reveal text but let someone holding a candidate confirm it.
- **Memory content is plain text in the database file** (section 10 above). There is no encryption at rest.
- Prompt and memory text exist in process memory while a request runs and in the HTTP request the client sent. OS-level artefacts (shell history of curl commands, editor swap files) are outside the app's control.

## 11. Input validation and injection

- **Validation:** every endpoint parses body, query and path parameters with **Zod** (`parse()` in `utils/http.ts`) with explicit lengths (project names <= 80 and free of control characters, descriptions <= 1000, prompts <= 20,000, memory titles <= 120 / content <= 8,000 / 200 items per project, search <= 200), enums, integer ranges (page <= 10,000 on the main lists, page sizes <= 200, retention 0..3650, ...) and strict decimal formats for money and prices. Invalid input yields `400 VALIDATION_ERROR`; repeated or array query parameters are rejected on `/usage` and `/projects`.
- **SQL injection:** data access goes through Prisma Client (parameterised). Raw SQL is limited to `Prisma.sql` tagged templates (bound parameters, fixed `ESCAPE '\'`, whitelisted sort columns) in `modules/usage/{query,search}.ts`, the dashboard daily bucket query and the first-admin insert. Literal `%`, `_` and `\` in search text are escaped.
- **Export datasets** are looked up in a fixed registry (no table or path from user input).
- **XSS:** React escapes text; there is no `dangerouslySetInnerHTML` / `innerHTML` in `frontend/src`; the CSP forbids inline and third-party scripts. API responses are JSON.
- **CSV formula injection:** `csvCell()` prefixes `'` to non-numeric cells starting with `=`, `+`, `-`, `@`, TAB or CR, with RFC 4180 quoting. Applies to `/usage/export.csv` and `/export/:dataset?format=csv`.
- **Log injection:** every JSONL record is exactly one physical line (JSON escapes CR/LF/ESC and other control characters; U+2028, U+2029 and U+0085 are additionally escaped). JSONL files roll over at 50 MB (`execution-<day>.<n>.jsonl`). Console write-failure messages are rate limited.
- **Error handling:** unexpected errors return a generic `500 INTERNAL_ERROR`; stacks are recorded in the local error log, never sent to clients.
- **Static files:** served by `express.static` from `frontend/dist` only; the SPA fallback excludes `/api`.

## 12. Audit trail

Security-relevant events are recorded as activity events (`source: ACTUAL`) with metadata that never contains passwords, tokens or hashes:
`auth.setup`, `auth.login.success`, `auth.login.failure`, `auth.login.locked`, `auth.logout`, `auth.password.changed`,
`auth.user.created`, `auth.user.updated`, `auth.user.deleted`. Failed logins for **unknown** usernames log only a hash prefix and
the length of the supplied name. Project memory changes are recorded as `project.memory.created|updated|deleted` (ids, sizes, hash prefix only). The HTTP request log records every mutation and error with the `x-request-id`.
Auth events (`auth.*` activity events, their mirrored log rows and the request logs of `/api/auth/*`) are visible to `ADMIN` sessions only: they are filtered out for `VIEWER` accounts in `/activity`, the dashboard's recent activity, `/logs` and the `activity` / `logs` / `errors` exports (`modules/auth/visibility.ts`), because they contain client IPs and failed-login details. With `AUTH_ENABLED=false` nothing is hidden. Activity events are not swept by retention. The audit trail is useful for review but is not tamper-evident: an ADMIN with file access can edit the database.

## 13. Deployment guidance

| Situation | Guidance |
|---|---|
| Local use (default) | `HOST=127.0.0.1`, `COOKIE_SECURE=false` (browsers do not accept `Secure` cookies over plain `http://localhost` in every setup). Complete `/setup` right after the first start. |
| Behind HTTPS (reverse proxy, any non-loopback exposure) | Set `COOKIE_SECURE=true`. Terminate TLS at the proxy (nginx, Caddy, cloud LB) and add HSTS there. Bind the app to loopback and let only the proxy reach it. The server prints a warning when `HOST` is non-loopback and `COOKIE_SECURE=false`. |
| Behind a proxy | Set `ALLOWED_HOSTS` to the public host name (otherwise `421`) and `TRUST_PROXY` to the number of proxy hops so `req.ip` is the real client; without it every user shares the proxy's address and the per-IP rate limit, login throttle and (username, IP) locks count all users together. Make sure the proxy overwrites (not appends to) a client-supplied `X-Forwarded-For`, and rate-limit at the proxy as well. |
| `AUTH_ENABLED=false` | **Disables authentication, CSRF and roles entirely.** `/api/auth/*` returns `404 AUTH_DISABLED` (except `/auth/status`, which reports `authEnabled: false`) and every API call is open to anyone who can reach the port. It exists for isolated local experiments and for the legacy test suites. The server prints a loud multi-line warning at startup, with an extra exposure warning when `HOST` is not loopback. Never use it on a shared machine or network. |
| Secrets in env | `ADMIN_PASSWORD` is only needed for the first start; remove it afterwards. `.env` is git-ignored. |
| Files | Keep `prisma/spendguard.db*` and `data/logs/` private (for example `chmod 700 data`); they hold plain-text memory items, hashed credentials and session hashes. |

## 14. Residual risks and what is NOT provided

| Area | Status |
|---|---|
| **In-memory throttles** | The per-IP login limiter, the (username, IP) locks, the unknown-username tracker and the general rate limiter are per process and reset on restart. Running several server processes multiplies the allowed attempts. Only the progressive per-user lock (`User.failedAttempts` / `lockedUntil`) of existing accounts is stored in the database and is shared and persistent. |
| **No TLS termination** | Plain HTTP only. Without a TLS proxy, credentials and session cookies cross the network in clear text; keep the default loopback bind, or terminate TLS in front and set `COOKIE_SECURE=true`. |
| **`AUTH_ENABLED=false`** | Removes all access control (section 13). |
| **First-run claim** | Until the first admin exists, anyone who can reach the port can create it through `/setup`. Use `ADMIN_USERNAME` / `ADMIN_PASSWORD` or `npm run user:create` before exposing the port. |
| Multi-factor authentication, SSO, password reset by email, password expiry, breach-list checks beyond the built-in common list | Not provided. |
| Multi-tenant isolation | None: all authenticated users see all projects. `VIEWER` limits writes, not visibility. |
| Encryption at rest | None. Memory content, hashes and logs are plain files protected only by OS permissions. |
| Session cookie theft | `HttpOnly`, `SameSite=Strict` and the CSP reduce it, but a compromised browser or a network attacker (without TLS) can still steal it. The CSRF token is derivable from the session token, so it does not add protection after a cookie theft. |
| Proxy IP handling | `TRUST_PROXY` is opt-in and must match the real number of hops; a wrong value lets clients spoof their IP (section 13). |
| DNS rebinding | Mitigated by the Host guard; a name added to `ALLOWED_HOSTS` is trusted. |
| Account enumeration | Login responses and timing are uniform, but `POST /auth/users` and `/auth/setup` naturally report an existing username to an ADMIN / during setup. |
| Dependency audit | Not run as part of this project's verification; run `npm audit` before wider use. |
| Multi-process safety of application locks | In-process mutexes serialise budget and pricing creation; several server processes against one database can bypass "one budget per scope + period" (alert de-duplication is DB-enforced and stays safe). |
| Audit trail integrity | Activity events are not tamper-evident (section 12). |
| Free-text secrets | Pattern-based redaction only (section 10). |

### Recommendations

1. Keep the default loopback bind unless you need remote access. If you do: TLS proxy, `COOKIE_SECURE=true`, a bootstrapped admin, `VIEWER` accounts for read-only users, and proxy-level rate limiting.
2. Complete first-run setup immediately, use a long unique password, and give day-to-day readers `VIEWER` accounts.
3. Keep `package-lock.json` committed, run `npm audit` periodically.
4. Do not type secrets into project names, descriptions or memory items.
5. Treat exported CSV / JSONL files as local operational data; open CSVs in a spreadsheet only from a trusted source (the formula guard is defence in depth).
6. If the app is ever adapted to call real providers: keep keys in a secret store, never in committed files or logs; extend the sanitizer key list for provider-specific fields; and revisit this document, because the "no outbound calls" guarantees would no longer hold.

How to verify the controls: `backend/tests/auth/*` (login, lockout, sessions, CSRF, roles, password, bootstrap / CLI, audit privacy, `AUTH_ENABLED=false`),
`backend/tests/instrumentation/{sanitize,hardening}.test.ts`, `backend/tests/integration/privacy-security.test.ts`. See [TESTING.md](TESTING.md).
