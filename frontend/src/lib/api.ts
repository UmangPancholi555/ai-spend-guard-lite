import type { ApiList, ApiOne, Pagination } from '@shared/types';

export class ApiRequestError extends Error {
  /** `x-request-id` response header, when the server sent one (quote it when reporting a problem) */
  requestId?: string;
  /** seconds from the `Retry-After` header (429/503), when present */
  retryAfterSec?: number;
  constructor(public status: number, public code: string, message: string, public details?: unknown, extra?: { requestId?: string; retryAfterSec?: number }) {
    super(message);
    this.name = 'ApiRequestError';
    this.requestId = extra?.requestId;
    this.retryAfterSec = extra?.retryAfterSec;
  }
  /** true when no HTTP response was received at all (offline / server down / timeout) */
  get isNetwork() { return this.status === 0; }
}

/** every request is aborted after this long (ms) */
export const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 400;

export type Query = Record<string, string | number | boolean | undefined | null>;
export function qs(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---- auth integration (CSRF token is held in memory only; the session itself is an HttpOnly cookie) ----
let csrfToken: string | undefined;
let unauthorizedHandler: (() => void) | undefined;
let unauthorizedFired = false;

export const authBridge = {
  /** set after login/setup//auth/me; pass undefined on logout */
  setCsrfToken(t: string | undefined) { csrfToken = t; if (t) unauthorizedFired = false; },
  /** called (at most once until the next successful login) when any API call answers 401 UNAUTHENTICATED */
  onUnauthorized(fn: (() => void) | undefined) { unauthorizedHandler = fn; },
};

const isUnsafe = (m: string) => m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
/** endpoints that legitimately answer 401/403 as part of the login flow itself */
const AUTH_ENTRY = /^\/auth\/(login|setup|status)(\?|$)/;

/** fetch with a hard timeout; network failures and timeouts become ApiRequestError(status 0) */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) {
      throw new ApiRequestError(0, 'TIMEOUT', `The server took longer than ${REQUEST_TIMEOUT_MS / 1000} seconds to respond. Please retry.`);
    }
    throw new ApiRequestError(0, 'NETWORK_ERROR', 'Cannot reach the local server. Check that it is running, then retry.');
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** parse an error/ok body that may not be JSON (proxy HTML pages, plain text, empty) */
async function readBody(res: Response): Promise<{ json: any; text: string }> {
  let text = '';
  try { text = await res.text(); } catch { /* body unreadable */ }
  if (!text) return { json: null, text };
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
}

function plainMessage(res: Response, text: string): string {
  const t = text.trim();
  // HTML error pages (nginx/vite proxy) are not useful to show; plain short text is
  if (t && !/^</.test(t)) return t.length > 200 ? `${t.slice(0, 200)}...` : t;
  return res.status >= 500 ? `The server returned an error (HTTP ${res.status}).` : res.statusText || `Request failed (HTTP ${res.status}).`;
}

async function request<T>(method: string, path: string, body?: unknown, retriedCsrf = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (isUnsafe(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  // idempotent reads get exactly one automatic retry on a network failure or a 502/503
  const maxAttempts = method === 'GET' ? 2 : 1;
  let res!: Response;
  let parsed!: { json: any; text: string };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      res = await fetchWithTimeout(`/api${path}`, init);
    } catch (e) {
      if (attempt < maxAttempts && e instanceof ApiRequestError && e.code === 'NETWORK_ERROR') { await sleep(RETRY_DELAY_MS); continue; }
      throw e;
    }
    if (res.status === 204) return undefined as T;
    parsed = await readBody(res);
    if (attempt < maxAttempts && (res.status === 502 || res.status === 503)) { await sleep(RETRY_DELAY_MS); continue; }
    break;
  }
  const { json, text } = parsed;
  if (!res.ok) {
    const code: string = json?.error?.code ?? 'HTTP_ERROR';
    if (res.status === 403 && code === 'CSRF_INVALID' && isUnsafe(method) && !retriedCsrf && !AUTH_ENTRY.test(path)) {
      // token went stale (e.g. session rotated in another tab): refresh once from /auth/me, then retry once
      try {
        const me = await request<ApiOne<{ csrfToken: string }>>('GET', '/auth/me');
        csrfToken = me.data.csrfToken;
        return await request<T>(method, path, body, true);
      } catch (e) { if (e instanceof ApiRequestError && e.code !== 'UNAUTHENTICATED' && e.code !== 'CSRF_INVALID') throw e; }
    }
    if (res.status === 401 && code === 'UNAUTHENTICATED' && !AUTH_ENTRY.test(path) && !unauthorizedFired) {
      unauthorizedFired = true;
      csrfToken = undefined;
      unauthorizedHandler?.();
    }
    const ra = Number(res.headers.get('retry-after'));
    throw new ApiRequestError(res.status, code, json?.error?.message ?? plainMessage(res, text), json?.error?.details, {
      requestId: res.headers.get('x-request-id') ?? undefined,
      retryAfterSec: Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : undefined,
    });
  }
  if (json === null) {
    throw new ApiRequestError(res.status, 'BAD_RESPONSE', 'The server sent a response this app cannot read.', undefined, { requestId: res.headers.get('x-request-id') ?? undefined });
  }
  return json as T;
}

export const api = {
  /** GET returning { data } -> data */
  get: async <T>(path: string, q?: Query): Promise<T> => (await request<ApiOne<T>>('GET', path + qs(q))).data,
  /** GET list endpoint -> { data, pagination } */
  list: async <T>(path: string, q?: Query): Promise<{ data: T[]; pagination: Pagination }> => {
    const r = await request<ApiList<T>>('GET', path + qs(q));
    return { data: r.data, pagination: r.pagination };
  },
  post: async <T>(path: string, body?: unknown): Promise<T> => (await request<ApiOne<T>>('POST', path, body ?? {})).data,
  patch: async <T>(path: string, body: unknown): Promise<T> => (await request<ApiOne<T>>('PATCH', path, body)).data,
  put: async <T>(path: string, body: unknown): Promise<T> => (await request<ApiOne<T>>('PUT', path, body)).data,
  del: async (path: string): Promise<void> => { await request<unknown>('DELETE', path); },
  /** URL for browser download endpoints (CSV/JSONL), e.g. href={api.url('/usage/export.csv', filters)} */
  url: (path: string, q?: Query) => `/api${path}${qs(q)}`,
};
