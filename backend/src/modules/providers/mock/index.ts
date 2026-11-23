import type { ProviderKey } from '../../../../../shared/types';
import type { MockProvider } from './types';
import { MockOpenAIProvider } from './openai';
import { MockAnthropicProvider } from './anthropic';

export * from './types';
export { MockOpenAIProvider, MockAnthropicProvider };
export { estimateTokens } from './engine';
export { mulberry32, seedFromString } from './prng';

const REGISTRY: Record<ProviderKey, MockProvider> = {
  openai: new MockOpenAIProvider(),
  anthropic: new MockAnthropicProvider(),
};

export function getMockProvider(key: ProviderKey): MockProvider {
  return REGISTRY[key];
}
export const MOCK_PROVIDER_KEYS = Object.keys(REGISTRY) as ProviderKey[];
