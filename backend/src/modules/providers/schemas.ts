import { z } from 'zod';

export const providerKeySchema = z.enum(['openai', 'anthropic']);
export const simulatedFailureSchema = z.enum(['none', 'error', 'timeout', 'rate_limit']);

export const mockProviderRequestSchema = z.object({
  projectId: z.string().min(1),
  provider: providerKeySchema,
  model: z.string().min(1).max(100),
  prompt: z.string().min(1).max(20000),
  maxOutputTokens: z.number().int().min(1).max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
  simulateFailure: simulatedFailureSchema.default('none'),
  simulateAgentActivity: z.boolean().default(false),
  injectMemory: z.boolean().optional(),
});
export type MockProviderRequestInput = z.input<typeof mockProviderRequestSchema>;

export const seedRequestSchema = z.object({
  projectId: z.string().min(1).optional(),
  requests: z.number().int().min(1).max(2000),
  spreadDays: z.number().int().min(1).max(365),
  includeFailures: z.boolean().default(true),
  includeAgentActivity: z.boolean().default(false),
  /** optional PRNG seed to vary the generated batch; default derives from the other parameters */
  seed: z.union([z.string().min(1).max(100), z.number().int()]).optional(),
});
export type SeedRequestInput = z.input<typeof seedRequestSchema>;

export const agentRunSchema = z.object({
  projectId: z.string().min(1),
  simulateFailure: simulatedFailureSchema.default('none'),
});
export type AgentRunInput = z.input<typeof agentRunSchema>;
