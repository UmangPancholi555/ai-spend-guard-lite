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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  let json: any = null;
  try { json = await res.json(); } catch { /* non-json */ }
  if (!res.ok) {
    throw new ApiRequestError(res.status, json?.error?.code ?? 'HTTP_ERROR', json?.error?.message ?? res.statusText, json?.error?.details);
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
