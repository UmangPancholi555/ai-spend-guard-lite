import { ApiRequestError } from '../../lib/api';

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Human-readable message for an API error, including Zod-style details when present. */
export function errMessage(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const d = e.details;
    if (Array.isArray(d) && d.length) {
      const parts = d.map((x: any) => (x && typeof x === 'object' ? [x.path, x.message].filter(Boolean).join(': ') : String(x))).filter(Boolean);
      if (parts.length) return `${e.message} (${parts.join('; ')})`;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
