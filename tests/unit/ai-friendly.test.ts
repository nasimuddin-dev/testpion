import { describe, expect, it } from 'vitest';
import { estimateCost, missingKeyError, ProviderRegistry, runChecks, VariableScope, type ProviderConfig } from '../../packages/core/src/index.js';
import { providerAdvice } from '../../packages/core/src/ai/http.js';

// The AI features, friendlier: a missing key is named before anything is sent, a provider's error says what to do,
// a price for a model also prices its dated versions, and a test can check the time to the first token.
const openai: ProviderConfig = {
  id: 'openai',
  name: 'OpenAI',
  kind: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  apiKey: '{{$secret.provider.openai.apiKey}}',
};

describe('a missing API key', () => {
  it('is named, with where to add it, before anything is sent', () => {
    const registry = new ProviderRegistry([openai], new VariableScope());
    let error: unknown;
    try {
      registry.get('openai');
    } catch (e) {
      error = e;
    }
    const e = error as { kind: string; message: string; why: string; suggestions: string[] };
    expect(e.kind).toBe('ConfigurationError');
    expect(e.message).toBe('No API key for OpenAI');
    expect(e.suggestions.join(' ')).toMatch(/AI Lab ▸ Providers ▸ OpenAI ▸ API key/);
    expect(e.suggestions.join(' ')).toMatch(/TESTPION_SECRET_PROVIDER_OPENAI_APIKEY/);
  });

  it('an environment variable reference names that variable', () => {
    const e = missingKeyError({ ...openai, apiKey: '{{$env.OPENAI_API_KEY}}' });
    expect(e.suggestions.join(' ')).toMatch(/environment variable OPENAI_API_KEY/);
  });

  it('a provider without a key reference (a local server) is not stopped', () => {
    const local: ProviderConfig = { id: 'lm', name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' };
    expect(() => new ProviderRegistry([local], new VariableScope()).get('lm')).not.toThrow();
  });
});

describe("a provider's errors", () => {
  it('say what to do, by status', () => {
    expect(providerAdvice('OpenAI', 401, 'Incorrect API key provided')!.suggestions[0]).toMatch(/AI Lab ▸ Providers ▸ OpenAI ▸ API key/);
    expect(providerAdvice('OpenAI', 429, 'You exceeded your current quota, please check your plan and billing details.')!.why).toMatch(/no credit left/);
    expect(providerAdvice('OpenAI', 429, 'Rate limit reached for requests')!.suggestions.join(' ')).toMatch(/Run fewer tests at once/);
    expect(providerAdvice('OpenAI', 404, 'The model `gpt-9` does not exist')!.suggestions[0]).toMatch(/refresh button/);
    expect(providerAdvice('OpenAI', 503, 'overloaded')!.suggestions[0]).toMatch(/status page/);
    expect(providerAdvice('OpenAI', 400, 'bad request')).toBeUndefined();
  });
});

describe('prices', () => {
  const pricing = [{ provider: 'openai', model: 'gpt-4o-mini', inputPerMillion: 0.15, outputPerMillion: 0.6, version: '2026-10' }];
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
  it("a model's price applies to its dated versions", () => {
    expect(estimateCost(pricing, openai, 'gpt-4o-mini', usage)).toEqual({ cost: 0.75, priceVersion: '2026-10' });
    expect(estimateCost(pricing, openai, 'gpt-4o-mini-2024-07-18', usage)).toEqual({ cost: 0.75, priceVersion: '2026-10' });
    expect(estimateCost([{ ...pricing[0]!, provider: '*', model: 'claude-3-5-sonnet' }], openai, 'claude-3-5-sonnet-20240620', usage).cost).toBe(0.75);
    // a different model is not priced by a near name
    expect(estimateCost(pricing, openai, 'gpt-4o', usage)).toEqual({});
  });
});

describe('the time to the first token', () => {
  it('is a check of its own (ttft is the same)', async () => {
    const ctx = { testType: 'llm' as const, body: 'hi', text: 'hi', latencyMs: 900, firstTokenMs: 300 };
    const [a] = await runChecks([{ type: 'first-token', max: 500 }], ctx);
    const [b] = await runChecks([{ type: 'ttft', max: 200 }], ctx);
    expect(a!.passed).toBe(true);
    expect(b!.passed).toBe(false);
    expect(b!.message).toMatch(/time to first token/);
  });
});
