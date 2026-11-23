import type { MockCompletion, MockCompleteRequest, MockModelInfo, MockProvider } from './types';
import { MOCK_API_VERSION, SIM_LABEL } from './types';
import { GENERIC_PROFILE, runEngine, type ModelProfile } from './engine';

const PROFILES: Record<string, ModelProfile & MockModelInfo> = {
  'claude-opus': { name: 'claude-opus', displayName: 'Claude Opus (mock)', contextWindow: 200000, latency: 1.6, verbosity: 1.2 },
  'claude-sonnet': { name: 'claude-sonnet', displayName: 'Claude Sonnet (mock)', contextWindow: 200000, latency: 1.0, verbosity: 1.0 },
  'claude-haiku': { name: 'claude-haiku', displayName: 'Claude Haiku (mock)', contextWindow: 200000, latency: 0.5, verbosity: 0.8 },
};

/** Local deterministic simulation with an Anthropic-style response envelope. Performs NO network I/O. */
export class MockAnthropicProvider implements MockProvider {
  readonly key = 'anthropic' as const;
  readonly displayName = 'Mock Anthropic';

  listModels(): MockModelInfo[] {
    return Object.values(PROFILES).map(({ name, displayName, contextWindow }) => ({ name, displayName, contextWindow }));
  }

  complete(req: MockCompleteRequest): MockCompletion {
    const r = runEngine(this.key, req, PROFILES[req.model] ?? GENERIC_PROFILE);
    const responseId = `msg_${r.seedHash.slice(0, 24)}`;
    // Anthropic reports input_tokens EXCLUDING cache reads - identical to our normalized convention.
    const usage = { input_tokens: r.inputTokens, output_tokens: r.outputTokens, cache_read_input_tokens: r.cachedTokens, cache_creation_input_tokens: 0 };
    const providerResponse: Record<string, unknown> = r.failure
      ? {
          type: 'error', id: responseId, model: req.model,
          error: { type: r.failure.mode === 'rate_limit' ? 'rate_limit_error' : r.failure.mode === 'timeout' ? 'timeout_error' : 'api_error', code: r.failure.code, http_status: r.failure.httpStatus },
          usage,
        }
      : {
          id: responseId, type: 'message', role: 'assistant', model: req.model,
          stop_reason: r.finishReason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null, usage,
        };
    return {
      provider: this.key, model: req.model, simulated: true, label: SIM_LABEL,
      seed: r.seed, seedHash: r.seedHash, responseId, apiVersion: MOCK_API_VERSION,
      content: r.content, finishReason: r.finishReason,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens, totalPromptTokens: r.totalPromptTokens,
      maxOutputTokens: r.maxOutputTokens, temperature: r.temperature, durationMs: r.durationMs,
      failure: r.failure, providerResponse,
    };
  }
}
