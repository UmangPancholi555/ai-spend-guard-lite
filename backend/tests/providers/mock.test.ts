import { describe, it, expect } from 'vitest';
import { MockOpenAIProvider, MockAnthropicProvider, getMockProvider, estimateTokens } from '../../src/modules/providers/mock';
import { mulberry32 } from '../../src/modules/providers/mock/prng';

const openai = new MockOpenAIProvider();
const anthropic = new MockAnthropicProvider();
const longPrompt = 'Summarize the quarterly spend report. '.repeat(40); // > 200 chars
const shortPrompt = 'Hello there';

describe('mock providers: determinism', () => {
  it('same input yields identical output (content, tokens, cache, finishReason, duration, ids)', () => {
    for (const p of [openai, anthropic]) {
      const model = p.listModels()[0]!.name;
      const a = p.complete({ model, prompt: longPrompt, maxOutputTokens: 300, temperature: 0.5 });
      const b = p.complete({ model, prompt: longPrompt, maxOutputTokens: 300, temperature: 0.5 });
      expect(b).toEqual(a);
    }
  });

  it('different prompt / model / maxOutputTokens / temperature / provider changes the seed', () => {
    const base = openai.complete({ model: 'gpt-4o', prompt: longPrompt, maxOutputTokens: 300, temperature: 0.5 });
    const variants = [
      openai.complete({ model: 'gpt-4o', prompt: longPrompt + 'x', maxOutputTokens: 300, temperature: 0.5 }),
      openai.complete({ model: 'gpt-4o-mini', prompt: longPrompt, maxOutputTokens: 300, temperature: 0.5 }),
      openai.complete({ model: 'gpt-4o', prompt: longPrompt, maxOutputTokens: 301, temperature: 0.5 }),
      openai.complete({ model: 'gpt-4o', prompt: longPrompt, maxOutputTokens: 300, temperature: 0.6 }),
      anthropic.complete({ model: 'gpt-4o', prompt: longPrompt, maxOutputTokens: 300, temperature: 0.5 }),
    ];
    for (const v of variants) expect(v.seed).not.toBe(base.seed);
    expect(new Set(variants.map(v => v.responseId)).size).toBe(variants.length);
    expect(variants.some(v => v.content !== base.content)).toBe(true);
  });

  it('explicit default maxOutputTokens equals omitted', () => {
    const a = openai.complete({ model: 'gpt-4o', prompt: longPrompt });
    const b = openai.complete({ model: 'gpt-4o', prompt: longPrompt, maxOutputTokens: 256 });
    expect(a).toEqual(b);
  });

  it('prng is deterministic', () => {
    const a = mulberry32(42), b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('mock providers: provider-specific shapes', () => {
  it('OpenAI style: chatcmpl id, finish_reason, system_fingerprint, prompt_tokens incl. cached', () => {
    const c = openai.complete({ model: 'gpt-4o', prompt: longPrompt });
    expect(c.responseId).toMatch(/^chatcmpl-[0-9a-f]{29}$/);
    const r = c.providerResponse as any;
    expect(r.system_fingerprint).toMatch(/^fp_/);
    expect(['stop', 'length']).toContain(r.choices[0].finish_reason);
    expect(r.usage.prompt_tokens).toBe(c.inputTokens + c.cachedTokens);
    expect(r.usage.prompt_tokens_details.cached_tokens).toBe(c.cachedTokens);
    expect(JSON.stringify(r)).not.toContain(c.content!.slice(0, 30));
  });

  it('Anthropic style: msg id, stop_reason, cache_read_input_tokens, input_tokens excludes cache', () => {
    const c = anthropic.complete({ model: 'claude-sonnet', prompt: longPrompt });
    expect(c.responseId).toMatch(/^msg_[0-9a-f]{24}$/);
    const r = c.providerResponse as any;
    expect(['end_turn', 'max_tokens']).toContain(r.stop_reason);
    expect(r.usage.input_tokens).toBe(c.inputTokens);
    expect(r.usage.cache_read_input_tokens).toBe(c.cachedTokens);
  });

  it('finishReason maps to provider-specific stop reasons', () => {
    const capped = anthropic.complete({ model: 'claude-opus', prompt: longPrompt, maxOutputTokens: 1 });
    expect(capped.finishReason).toBe('length');
    expect((capped.providerResponse as any).stop_reason).toBe('max_tokens');
    const cappedO = openai.complete({ model: 'gpt-4o', prompt: longPrompt, maxOutputTokens: 1 });
    expect((cappedO.providerResponse as any).choices[0].finish_reason).toBe('length');
  });

  it('listModels returns catalog models per provider', () => {
    expect(openai.listModels().map(m => m.name)).toEqual(expect.arrayContaining(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini']));
    expect(anthropic.listModels().map(m => m.name)).toEqual(expect.arrayContaining(['claude-opus', 'claude-sonnet', 'claude-haiku']));
    expect(getMockProvider('openai').key).toBe('openai');
    expect(getMockProvider('anthropic').key).toBe('anthropic');
  });
});

describe('mock providers: token and cache invariants', () => {
  it('token heuristic ~4 chars/token, min 1', () => {
    expect(estimateTokens(0)).toBe(1);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(1000)).toBe(250);
  });

  it('total prompt tokens = inputTokens + cachedTokens = ceil(chars/4); input >= 1', () => {
    for (let n = 1; n < 3000; n += 97) {
      const prompt = 'a'.repeat(n);
      const c = openai.complete({ model: 'gpt-4o', prompt });
      expect(c.totalPromptTokens).toBe(estimateTokens(n));
      expect(c.inputTokens + c.cachedTokens).toBe(c.totalPromptTokens);
      expect(c.inputTokens).toBeGreaterThanOrEqual(1);
    }
  });

  it('cachedTokens is 0 for prompts <= 200 chars and 0..60% for longer prompts', () => {
    expect(openai.complete({ model: 'gpt-4o', prompt: 'a'.repeat(200) }).cachedTokens).toBe(0);
    let sawCached = false;
    for (let i = 0; i < 60; i++) {
      const prompt = `variant ${i} ` + 'x'.repeat(400 + i * 13);
      const c = anthropic.complete({ model: 'claude-haiku', prompt });
      expect(c.cachedTokens).toBeGreaterThanOrEqual(0);
      expect(c.cachedTokens).toBeLessThanOrEqual(Math.floor(c.totalPromptTokens * 0.6));
      if (c.cachedTokens > 0) sawCached = true;
    }
    expect(sawCached).toBe(true);
    for (let i = 0; i < 30; i++) expect(openai.complete({ model: 'gpt-4o', prompt: `short ${i}` }).cachedTokens).toBe(0);
  });

  it('output tokens never exceed maxOutputTokens; length when capped, stop otherwise; content matches size', () => {
    let sawLength = false, sawStop = false;
    for (let i = 0; i < 80; i++) {
      const maxOutputTokens = [16, 64, 256, 1024, 8192][i % 5]!;
      const c = openai.complete({ model: 'gpt-4o', prompt: `prompt ${i} ` + 'z'.repeat(i * 20), maxOutputTokens });
      expect(c.outputTokens).toBeGreaterThanOrEqual(1);
      expect(c.outputTokens).toBeLessThanOrEqual(maxOutputTokens);
      expect(c.content!.length).toBe(c.outputTokens * 4);
      expect(estimateTokens(c.content!.length)).toBe(c.outputTokens);
      if (c.finishReason === 'length') { sawLength = true; expect(c.outputTokens).toBe(maxOutputTokens); }
      else { sawStop = true; expect(c.finishReason).toBe('stop'); expect(c.outputTokens).toBeLessThan(maxOutputTokens + 1); }
    }
    expect(sawLength && sawStop).toBe(true);
  });

  it('clamps maxOutputTokens to 1..8192 and defaults to 256', () => {
    expect(openai.complete({ model: 'gpt-4o', prompt: 'x' }).maxOutputTokens).toBe(256);
    expect(openai.complete({ model: 'gpt-4o', prompt: 'x', maxOutputTokens: 99999 }).maxOutputTokens).toBe(8192);
    expect(openai.complete({ model: 'gpt-4o', prompt: 'x', maxOutputTokens: 0 }).maxOutputTokens).toBe(1);
  });

  it('simulated duration stays within 20..900ms and grows with output size', () => {
    const ds: number[] = [];
    for (let i = 0; i < 100; i++) {
      const c = anthropic.complete({ model: 'claude-opus', prompt: `d${i}`, maxOutputTokens: 8192 });
      expect(c.durationMs).toBeGreaterThanOrEqual(20);
      expect(c.durationMs).toBeLessThanOrEqual(900);
      ds.push(c.durationMs);
    }
    const small = Array.from({ length: 50 }, (_, i) => openai.complete({ model: 'gpt-4o-mini', prompt: `s${i}`, maxOutputTokens: 16 }).durationMs);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avg(ds)).toBeGreaterThan(avg(small));
  });

  it('content never echoes the prompt and is labelled simulated', () => {
    const secret = 'TOP-SECRET-PROMPT-SENTINEL-12345 '.repeat(10);
    const c = openai.complete({ model: 'gpt-4o', prompt: secret, maxOutputTokens: 1024 });
    expect(c.content).not.toContain('SENTINEL');
    expect(JSON.stringify(c.providerResponse)).not.toContain('SENTINEL');
    expect(c.simulated).toBe(true);
    expect(c.label).toBe('DEMO / SIMULATED');
  });

  it('unknown model names still work with a generic profile', () => {
    const c = openai.complete({ model: 'totally-new-model', prompt: longPrompt });
    expect(c.outputTokens).toBeGreaterThan(0);
    expect(c.failure).toBeNull();
  });
});

describe('mock providers: failure modes', () => {
  const cases = [
    { mode: 'error', code: 'PROVIDER_ERROR', cat: 'PROVIDER' },
    { mode: 'timeout', code: 'PROVIDER_TIMEOUT', cat: 'TIMEOUT' },
    { mode: 'rate_limit', code: 'RATE_LIMITED', cat: 'PROVIDER' },
  ] as const;
  for (const f of cases) {
    for (const p of [openai, anthropic]) {
      it(`${p.key} ${f.mode}: ${f.code}, input consumed, output 0, content null, simulated message`, () => {
        const c = p.complete({ model: p.listModels()[0]!.name, prompt: longPrompt, simulateFailure: f.mode });
        expect(c.failure?.code).toBe(f.code);
        expect(c.failure?.category).toBe(f.cat);
        expect(c.failure?.message).toMatch(/simulated/i);
        expect(c.failure?.message).toContain('DEMO / SIMULATED');
        expect(c.content).toBeNull();
        expect(c.outputTokens).toBe(0);
        expect(c.finishReason).toBe('error');
        expect(c.inputTokens + c.cachedTokens).toBe(estimateTokens(longPrompt.length));
        expect(c.inputTokens).toBeGreaterThan(0);
        expect(c.durationMs).toBeGreaterThanOrEqual(20);
        expect(c.durationMs).toBeLessThanOrEqual(900);
      });
    }
  }
});
