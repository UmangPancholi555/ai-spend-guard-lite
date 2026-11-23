import type { ProviderKey, SimulatedFailure } from '../../../../../shared/types';

export const DEFAULT_MAX_OUTPUT_TOKENS = 256;
export const MAX_OUTPUT_TOKENS_LIMIT = 8192;
export const SIM_LABEL = 'DEMO / SIMULATED' as const;
export const MOCK_API_VERSION = 'mock-2025-01-demo';

export interface MockCompleteRequest {
  model: string;
  prompt: string; // used transiently to derive deterministic numbers; NEVER persisted or echoed
  maxOutputTokens?: number;
  temperature?: number;
  simulateFailure?: SimulatedFailure;
}

export interface MockModelInfo { name: string; displayName: string; contextWindow: number }

export interface MockFailure {
  mode: Exclude<SimulatedFailure, 'none'>;
  code: 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT' | 'RATE_LIMITED';
  message: string;
  httpStatus: number;
  category: 'PROVIDER' | 'TIMEOUT';
}

/**
 * Provider-agnostic result. TOKEN CONVENTION (matches the cost service):
 *   inputTokens  = NON-cached prompt tokens (billed at the input rate)
 *   cachedTokens = cached prompt tokens (billed at the cached rate)
 *   total prompt tokens = inputTokens + cachedTokens
 */
export interface MockCompletion {
  provider: ProviderKey;
  model: string;
  simulated: true;
  label: typeof SIM_LABEL;
  seed: number;               // 32-bit PRNG seed derived from sha256(provider|model|prompt|maxOutputTokens|temperature)
  seedHash: string;           // full hex digest (not reversible to the prompt)
  responseId: string;         // chatcmpl-<id> | msg_<id>
  apiVersion: string;
  content: string | null;
  finishReason: 'stop' | 'length' | 'error';
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalPromptTokens: number;
  maxOutputTokens: number;
  temperature: number | null;
  durationMs: number;         // SIMULATED latency 20..900
  failure: MockFailure | null;
  /** provider-specific response envelope (OpenAI / Anthropic style), metadata only - no content */
  providerResponse: Record<string, unknown>;
}

export interface MockProvider {
  readonly key: ProviderKey;
  readonly displayName: string;
  listModels(): MockModelInfo[];
  complete(req: MockCompleteRequest): MockCompletion;
}
