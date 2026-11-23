/** Shared deterministic engine used by both mock providers. Pure function of its inputs. */
import { sha256 } from '../../../utils/ids';
import type { ProviderKey } from '../../../../../shared/types';
import { fillerText, mulberry32, seedFromHex } from './prng';
import {
  DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_LIMIT, SIM_LABEL, MOCK_API_VERSION,
  type MockCompleteRequest, type MockFailure,
} from './types';

export interface ModelProfile { latency: number; verbosity: number }
export const GENERIC_PROFILE: ModelProfile = { latency: 1, verbosity: 1 };

/** ~4 chars per token, min 1 */
export const estimateTokens = (chars: number): number => Math.max(1, Math.ceil(chars / 4));

export const FAILURES: Record<'error' | 'timeout' | 'rate_limit', MockFailure> = {
  error: { mode: 'error', code: 'PROVIDER_ERROR', httpStatus: 500, category: 'PROVIDER', message: 'Simulated provider error (HTTP 500) - DEMO / SIMULATED, no real provider was called' },
  timeout: { mode: 'timeout', code: 'PROVIDER_TIMEOUT', httpStatus: 504, category: 'TIMEOUT', message: 'Simulated provider timeout - DEMO / SIMULATED, no real provider was called' },
  rate_limit: { mode: 'rate_limit', code: 'RATE_LIMITED', httpStatus: 429, category: 'PROVIDER', message: 'Simulated provider rate limit (HTTP 429) - DEMO / SIMULATED, no real provider was called' },
};

export interface EngineResult {
  seed: number; seedHash: string;
  content: string | null;
  finishReason: 'stop' | 'length' | 'error';
  inputTokens: number; outputTokens: number; cachedTokens: number; totalPromptTokens: number;
  maxOutputTokens: number; temperature: number | null; durationMs: number;
  failure: MockFailure | null;
}

export function runEngine(provider: ProviderKey, req: MockCompleteRequest, profile: ModelProfile): EngineResult {
  const maxOut = Math.min(MAX_OUTPUT_TOKENS_LIMIT, Math.max(1, Math.floor(req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)));
  const temperature = req.temperature ?? null;
  const seedHash = sha256([provider, req.model, req.prompt, maxOut, temperature ?? 'default'].join('|'));
  const seed = seedFromHex(seedHash);
  const rng = mulberry32(seed);

  // --- fixed-order draws (stream stays identical regardless of branch) ---
  const totalPrompt = estimateTokens(req.prompt.length);
  const cacheFraction = rng() * 0.6; // 0..60%
  const cachedTokens = req.prompt.length > 200 ? Math.floor(totalPrompt * cacheFraction) : 0;
  const inputTokens = totalPrompt - cachedTokens;

  const scale = 1 + Math.min(totalPrompt, 4000) / 4000;
  const desired = 16 + Math.floor(Math.pow(rng(), 1.5) * 600 * profile.verbosity * scale);
  const capped = desired > maxOut;
  const naturalOut = capped ? maxOut : desired;
  const jitter = 0.8 + rng() * 0.4;
  const baseLatency = 20 + Math.floor(rng() * 60 * profile.latency);
  const naturalDuration = Math.min(900, Math.max(20, baseLatency + Math.floor(naturalOut * 1.1 * profile.latency * jitter)));
  const failDraw = rng();
  const textRng = mulberry32(seed ^ 0x9e3779b9);

  const mode = req.simulateFailure ?? 'none';
  if (mode !== 'none') {
    const failure = FAILURES[mode];
    const durationMs = mode === 'timeout' ? 900 : mode === 'rate_limit' ? 20 + Math.floor(failDraw * 40) : 20 + Math.floor(failDraw * 100);
    return {
      seed, seedHash, content: null, finishReason: 'error', inputTokens, outputTokens: 0, cachedTokens,
      totalPromptTokens: totalPrompt, maxOutputTokens: maxOut, temperature, durationMs, failure,
    };
  }

  const targetChars = naturalOut * 4;
  let content = targetChars >= 40 ? `[${SIM_LABEL}] ` : '';
  content += fillerText(textRng, Math.max(0, targetChars - content.length));
  content = content.slice(0, targetChars);
  if (content.endsWith(' ')) content = content.slice(0, -1) + '.';
  if (!capped && !content.endsWith('.')) content = content.slice(0, -1) + '.';

  return {
    seed, seedHash, content, finishReason: capped ? 'length' : 'stop', inputTokens, outputTokens: naturalOut, cachedTokens,
    totalPromptTokens: totalPrompt, maxOutputTokens: maxOut, temperature, durationMs: naturalDuration, failure: null,
  };
}

export { MOCK_API_VERSION };
