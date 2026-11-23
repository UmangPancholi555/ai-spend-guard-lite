import { ApiRequestError } from './api';

/** A friendly, code-specific explanation for an error, or null to fall back to the raw message. */
export function describeError(e: unknown): { title?: string; message: string; requestId?: string; retryAfterSec?: number; retryable: boolean } {
  if (e instanceof ApiRequestError) {
    const base = { requestId: e.requestId, retryAfterSec: e.retryAfterSec };
    if (e.status === 0) return { ...base, message: e.message, retryable: true };
    if (e.status === 403 && e.code === 'FORBIDDEN') {
      return /read-only/i.test(e.message)
        ? { ...base, title: 'Read-only access', message: 'You have read-only access, so this action is not allowed for your account. Ask an administrator if you need to make changes.', retryable: false }
        : { ...base, title: 'Not permitted', message: e.message, retryable: false };
    }
    if (e.status === 413) return { ...base, title: 'Request too large', message: 'The request was too large for the server to accept. Reduce the size of what you are sending and try again.', retryable: false };
    if (e.status === 429) {
      const wait = e.retryAfterSec ? ` Try again in ${e.retryAfterSec} second${e.retryAfterSec === 1 ? '' : 's'}.` : ' Wait a moment and try again.';
      return { ...base, title: 'Slow down', message: `Too many requests in a short time.${wait}`, retryable: true };
    }
    if (e.status === 502 || e.status === 503 || e.status === 504) return { ...base, title: 'Server unavailable', message: 'The local server is temporarily unavailable. Please retry in a moment.', retryable: true };
    if (e.status >= 500) return { ...base, title: 'Server error', message: e.message, retryable: true };
    return { ...base, message: e.message, retryable: false };
  }
  return { message: e instanceof Error ? e.message : String(e), retryable: true };
}
