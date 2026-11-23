/**
 * PRIVACY SANITIZER for everything that is persisted by the instrumentation SDK
 * (span attributes, ExecutionLog.attributes, activity metadata, bus/tool inputMeta/outputMeta, task results, JSONL lines).
 *
 * Rules (the app must NEVER store raw prompt / context / memory / secret content):
 *  1. A value whose key matches SENSITIVE_KEY
 *       /(content|prompt|text|body|message|memory|secret|password|authorization|api[-_]?key|token$)/i
 *     is replaced by a marker `{ redacted: true, type, length, sha256_8 }` (type = string|array|object|number|boolean,
 *     length = char length / item count / serialized length, sha256_8 = first 8 hex chars of sha256 of the value).
 *     The marker lets operators correlate equal values without ever seeing them.
 *  2. Exceptions that keep metadata useful:
 *       - numeric / boolean values under content-ish keys are counts or flags (messageCount, promptChars, memory: 3) -> kept;
 *         but numbers/booleans under SECRET keys (secret|password|authorization|api key|token$) are still redacted.
 *       - keys ending in hash|chars|count|length|bytes|size|tokens|type|kind|name|status|id|ids|digest (promptHash, estimatedTokens,
 *         inputTokens, messageId, ...) are metadata by convention: kept (strings > 256 chars are NOT kept - see rule 3).
 *         Note: a bare `token` / `accessToken` key is NOT in this list, so it is redacted; `estimatedTokens` is kept.
 *  3. Any other string is truncated to 256 chars; strings that look like credentials (Bearer ..., sk-..., JWT) are redacted
 *     regardless of their key. Arrays/objects are capped (50 items/keys, depth 6, ~16KB serialized); circular refs, functions and
 *     symbols are dropped; Errors are reduced to their name; Buffers to {type:'binary',length}.
 *  4. Sanitization is deep and idempotent (a marker passes through unchanged).
 */
import { createHash } from 'node:crypto';
import { safeStringify } from '../../utils/serialize';

export const SENSITIVE_KEY = /(content|prompt|text|body|message|memory|secret|password|authorization|api[-_]?key|token$)/i;
export const SECRET_KEY = /(secret|password|authorization|api[-_]?key|token$)/i;
const SAFE_SUFFIX = /(hash|chars|count|length|bytes|size|tokens|type|kind|name|status|id|ids|digest|sha256_8)$/i;
const SECRET_VALUE = /^(bearer\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*)/i;

export const MAX_STRING = 256;
export const MAX_DEPTH = 6;
export const MAX_ITEMS = 50;
export const MAX_SERIALIZED = 16 * 1024;

export interface RedactionMarker { redacted: true; type: string; length: number; sha256_8: string }

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

export function redact(value: unknown): RedactionMarker {
  let length: number;
  let raw: string;
  if (typeof value === 'string') { raw = value; length = value.length; }
  else {
    raw = safeStringify(value) ?? String(value);
    length = Array.isArray(value) ? value.length : raw.length;
  }
  return { redacted: true, type: typeOf(value), length, sha256_8: createHash('sha256').update(raw).digest('hex').slice(0, 8) };
}

export function truncate(s: string, max = MAX_STRING): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function isMarker(v: unknown): v is RedactionMarker {
  return !!v && typeof v === 'object' && (v as { redacted?: unknown }).redacted === true && 'sha256_8' in (v as object);
}

function shouldRedact(key: string | undefined, value: unknown): boolean {
  if (!key || !SENSITIVE_KEY.test(key)) return false;
  if (value === null || value === undefined) return false;
  if (isMarker(value)) return false;
  const t = typeof value;
  if (SAFE_SUFFIX.test(key)) {
    if (t === 'number' || t === 'boolean') return false;
    if (t === 'string') return (value as string).length > MAX_STRING;
    return false; // arrays/objects under a safe-suffix key (e.g. memoryIds) are sanitized recursively instead
  }
  if (t === 'number' || t === 'boolean' || t === 'bigint') return SECRET_KEY.test(key);
  return true;
}

function clean(value: unknown, key: string | undefined, depth: number, seen: WeakSet<object>): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (shouldRedact(key, value)) return redact(value);
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return SECRET_VALUE.test(value) ? redact(value) : truncate(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    default:
  }
  const obj = value as object;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  if (obj instanceof Error) return { error: true, name: obj.name };
  if (ArrayBuffer.isView(obj)) return { type: 'binary', length: (obj as ArrayBufferView).byteLength };
  if (isMarker(obj)) return obj;
  if (seen.has(obj)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const out: unknown[] = obj.slice(0, MAX_ITEMS).map(v => clean(v, undefined, depth + 1, seen) ?? null);
      if (obj.length > MAX_ITEMS) out.push(`[+${obj.length - MAX_ITEMS} more]`);
      return out;
    }
    const entries = Object.entries(obj as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries.slice(0, MAX_ITEMS)) {
      const c = clean(v, k, depth + 1, seen);
      if (c !== undefined) out[k] = c;
    }
    if (entries.length > MAX_ITEMS) out._truncatedKeys = entries.length - MAX_ITEMS;
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Sanitize an arbitrary metadata object. Always returns a plain JSON-safe object (never throws). */
export function sanitizeAttributes(input: unknown): Record<string, unknown> {
  try {
    if (input === null || input === undefined) return {};
    if (typeof input !== 'object' || Array.isArray(input)) {
      const c = clean(input, undefined, 0, new WeakSet());
      return c === undefined ? {} : { value: c };
    }
    const out = clean(input, undefined, 0, new WeakSet()) as Record<string, unknown>;
    const json = JSON.stringify(out);
    if (json.length > MAX_SERIALIZED) {
      return { truncated: true, bytes: json.length, keys: Object.keys(out).slice(0, 20) };
    }
    return out;
  } catch {
    return { sanitizeError: true };
  }
}

/** Free-text error messages / stacks are kept (they describe failures) but bounded. */
export function boundText(s: string | undefined | null, max = 2000): string | undefined {
  if (s === undefined || s === null) return undefined;
  const str = String(s);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}
