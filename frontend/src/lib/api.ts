import type { ApiList, ApiOne, Pagination } from '@shared/types';

export class ApiRequestError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

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

async function request<T>(method: string, path: string, body?: unknown, retriedCsrf = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (isUnsafe(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  let json: any = null;
  try { json = await res.json(); } catch { /* non-json */ }
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
    throw new ApiRequestError(res.status, code, json?.error?.message ?? res.statusText, json?.error?.details);
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
