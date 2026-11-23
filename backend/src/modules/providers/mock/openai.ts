import type { MockCompletion, MockCompleteRequest, MockModelInfo, MockProvider } from './types';
import { MOCK_API_VERSION, SIM_LABEL } from './types';
import { GENERIC_PROFILE, runEngine, type ModelProfile } from './engine';

const PROFILES: Record<string, ModelProfile & MockModelInfo> = {
  'gpt-4o': { name: 'gpt-4o', displayName: 'GPT-4o (mock)', contextWindow: 128000, latency: 1.0, verbosity: 1.0 },
  'gpt-4o-mini': { name: 'gpt-4o-mini', displayName: 'GPT-4o mini (mock)', contextWindow: 128000, latency: 0.6, verbosity: 0.9 },
  'gpt-4.1': { name: 'gpt-4.1', displayName: 'GPT-4.1 (mock)', contextWindow: 1000000, latency: 1.1, verbosity: 1.1 },
  'o3-mini': { name: 'o3-mini', displayName: 'o3-mini (mock)', contextWindow: 200000, latency: 1.5, verbosity: 1.2 },
};

/** Local deterministic simulation with an OpenAI-style response envelope. Performs NO network I/O. */
export class MockOpenAIProvider implements MockProvider {
  readonly key = 'openai' as const;
  readonly displayName = 'Mock OpenAI';

  listModels(): MockModelInfo[] {
    return Object.values(PROFILES).map(({ name, displayName, contextWindow }) => ({ name, displayName, contextWindow }));
  }

  complete(req: MockCompleteRequest): MockCompletion {
    const r = runEngine(this.key, req, PROFILES[req.model] ?? GENERIC_PROFILE);
    const responseId = `chatcmpl-${r.seedHash.slice(0, 29)}`;
    const providerResponse: Record<string, unknown> = r.failure
      ? {
          id: responseId, object: 'chat.completion', model: req.model, choices: [],
          error: { type: r.failure.mode === 'rate_limit' ? 'rate_limit_exceeded' : r.failure.mode === 'timeout' ? 'timeout' : 'server_error', code: r.failure.code, http_status: r.failure.httpStatus },
          usage: { prompt_tokens: r.totalPromptTokens, completion_tokens: 0, total_tokens: r.totalPromptTokens, prompt_tokens_details: { cached_tokens: r.cachedTokens } },
        }
      : {
          id: responseId, object: 'chat.completion', model: req.model,
          system_fingerprint: `fp_${r.seedHash.slice(30, 40)}`,
          choices: [{ index: 0, finish_reason: r.finishReason, message_role: 'assistant' }],
          usage: {
            prompt_tokens: r.totalPromptTokens, completion_tokens: r.outputTokens,
            total_tokens: r.totalPromptTokens + r.outputTokens,
            prompt_tokens_details: { cached_tokens: r.cachedTokens },
          },
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
