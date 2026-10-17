import { describe, it, expect } from 'vitest';
import {
  Redactor,
  redactForAi,
  maskSensitiveText,
  buildAiContext,
  applyPrivacy,
  sampleArray,
  shareBudget,
  extractJson,
  chatStructured,
  chatText,
  isTruncated,
  resolveAiRoute,
  assertLocalAllowed,
  aiLocalOnly,
  checkAiCaps,
  aiUsageSummary,
  ProviderRegistry,
  VariableScope,
  staysOnThisComputer,
  type ChatRequest,
  type ChatResponse,
  type LlmProvider,
} from '../../packages/core/src/index.js';
import { harness, mockProvider } from '../ai/harness.js';

/** A provider answering in turn from a script (text, finish reason). */
function scripted(answers: Array<{ text: string; finish?: string }>, kind: 'openai-compatible' | 'anthropic' = 'anthropic'): LlmProvider & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  let i = 0;
  return {
    seen,
    config: { id: 'p', name: 'P', kind, baseUrl: 'https://x' },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      seen.push(req);
      const a = answers[Math.min(i++, answers.length - 1)]!;
      return { text: a.text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, finishReason: a.finish ?? 'stop', model: 'm', timing: { startedAt: 0, totalMs: 1 } };
    },
  };
}

describe('AI redaction detectors (AIB-2)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

  it('masks credentials by their shape in any field and any text', () => {
    const r = new Redactor();
    const { value, redactions } = redactForAi(
      {
        t: jwt,
        note: `call with Authorization: Bearer abcDEF123456789xyz and ?api_key=sk-1234567890abcdefghijklmn&page=2`,
        aws: 'AKIAABCDEFGHIJKLMNOP',
        gh: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        prose: 'Token validation failed for the user',
      },
      r,
    );
    const text = JSON.stringify(value);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('abcDEF123456789xyz');
    expect(text).not.toContain('sk-1234567890');
    expect(text).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(text).not.toContain('ghp_abc');
    expect(text).toContain('Bearer [REDACTED:bearer]');
    expect(text).toContain('page=2');
    expect((value as { prose: string }).prose).toBe('Token validation failed for the user');
    expect(redactions.map((x) => x.kind)).toEqual(expect.arrayContaining(['jwt', 'bearer', 'api-key']));
    expect(redactions.find((x) => x.kind === 'jwt')?.path).toBe('t');
  });

  it('masks personal data (emails, phones, Luhn-valid cards, IBANs) unless turned off, and leaves dates and ids', () => {
    const s = 'mail ann@example.org, call +1 415 555 0134, card 4111 1111 1111 1111, not 4111 1111 1111 1112, IBAN GB82 WEST 1234 5698 7654 32, at 2026-10-16T10:00:00Z id 1234567890';
    const out = maskSensitiveText(s);
    expect(out).toContain('[REDACTED:email]');
    expect(out).toContain('[REDACTED:phone]');
    expect(out).toContain('[REDACTED:card-number]');
    expect(out).toContain('4111 1111 1111 1112');
    expect(out).toContain('[REDACTED:iban]');
    expect(out).toContain('2026-10-16T10:00:00Z');
    expect(out).toContain('id 1234567890');
    expect(maskSensitiveText(s, { pii: false })).toContain('ann@example.org');
  });

  it('masks secret variable values, sensitive field names and JSON inside strings', () => {
    const r = new Redactor();
    r.addSecret('s3cr3t-value-42');
    const { value, redactions } = redactForAi(
      { body: JSON.stringify({ password: 'hunter2!!', user: 'x', echo: 's3cr3t-value-42' }), headers: [['Authorization', 'abc']], q: 'it is s3cr3t-value-42' },
      r,
    );
    const text = JSON.stringify(value);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('s3cr3t-value-42');
    expect(redactions.map((x) => x.kind)).toEqual(expect.arrayContaining(['field', 'secret-value']));
  });
});

describe('AI context builder (AIB-2)', () => {
  it('fits a large context into its budget by sampling, never cutting JSON', () => {
    const results = Array.from({ length: 400 }, (_, i) => ({ name: `test ${i}`, passed: i !== 237, message: i === 237 ? 'expected 200, got 500' : 'ok', body: 'x'.repeat(300) }));
    const ctx = buildAiContext({ results, run: { total: 400 } }, { privacy: 'full', redactor: new Redactor(), budgetTokens: 1500 });
    expect(ctx.tokens).toBeLessThanOrEqual(1600);
    const parsed = JSON.parse(ctx.text) as { results: unknown[]; run: { total: number } };
    expect(parsed.run.total).toBe(400);
    // the failed one is kept by the sampling, and the cut is said
    expect(ctx.text).toContain('expected 200, got 500');
    expect(ctx.text).toMatch(/more items not sent/);
    expect(ctx.sections.find((s) => s.name === 'results')!.notes.join(' ')).toMatch(/sampled/);
  });

  it('privacy levels: metadata keeps names and shapes, names keeps names only', () => {
    const input = { request: { method: 'POST', url: 'https://api.example.com/orders?token=abc&page=2', body: '{"id":7,"items":[{"sku":"A"},{"sku":"B"}]}' }, status: 201, message: 'Created' };
    const meta = applyPrivacy(input, 'metadata') as { request: { url: string; body: unknown; method: string } };
    expect(meta.request.method).toBe('POST');
    expect(meta.request.url).toBe('https://api.example.com/orders?token=…&page=…');
    expect(JSON.stringify(meta.request.body)).toContain('"sku":"string');
    expect(JSON.stringify(meta)).not.toContain('"A"');
    const names = applyPrivacy(input, 'names') as { request: { url: string }; status: number };
    expect(names.request.url).toBe('/orders');
    expect(names.status).toBe(201);
  });

  it('sampling keeps the first, the last, failures and one of each shape; budgets are shared', () => {
    const arr = [{ a: 1 }, { a: 2 }, { b: 1 }, { a: 3, passed: false }, { a: 4 }, { a: 5 }];
    expect(sampleArray(arr, 4).picked).toEqual([0, 2, 3, 5]);
    const share = shareBudget({ small: 100, big: 5000, mid: 900 }, 2000);
    expect(share.small).toBe(100);
    expect(share.small! + share.big! + share.mid!).toBeLessThanOrEqual(2000);
    expect(shareBudget({ body: 9000, x: 50 }, 4000, { body: 3000 }).body).toBe(3000);
  });
});

describe('structured output and repair (AIB-3)', () => {
  const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };

  it('extracts JSON from fences and prose', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('The answer is {"a":{"b":"}"}} done')).toEqual({ ok: true, value: { a: { b: '}' } } });
    expect(extractJson('nothing').ok).toBe(false);
  });

  it('repairs an invalid answer by sending the problem back', async () => {
    const p = scripted([{ text: 'not json' }, { text: '{"nope":1}' }, { text: '{"name":"ok"}' }]);
    const r = await chatStructured({ provider: p, model: 'm', messages: [{ role: 'user', content: 'go' }], schema });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ name: 'ok' });
    expect(r.repairs).toBe(2);
    expect(r.usage.totalTokens).toBe(45);
    expect(p.seen[1]!.messages.at(-1)!.content).toMatch(/problems/);
  });

  it('gives the best attempt with its problems after maxRepairs', async () => {
    const p = scripted([{ text: '{"nope":1}' }]);
    const r = await chatStructured({ provider: p, model: 'm', messages: [{ role: 'user', content: 'go' }], schema, maxRepairs: 1 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.problems.join(' ')).toMatch(/name/);
  });

  it('uses the JSON-schema mode of OpenAI-compatible providers', async () => {
    const p = scripted([{ text: '{"name":"x"}' }], 'openai-compatible');
    await chatStructured({ provider: p, model: 'm', messages: [{ role: 'user', content: 'go' }], schema });
    expect(p.seen[0]!.responseFormat).toMatchObject({ type: 'json_schema' });
  });

  it('continues a truncated answer, and fails clearly when it stays cut', async () => {
    expect(isTruncated('length')).toBe(true);
    expect(isTruncated('max_tokens')).toBe(true);
    const cont = scripted([{ text: '{"na', finish: 'length' }, { text: 'me":"joined"}' }]);
    const r = await chatStructured({ provider: cont, model: 'm', messages: [{ role: 'user', content: 'go' }], schema });
    expect(r.value).toEqual({ name: 'joined' });
    const cut = scripted([{ text: '{"na', finish: 'length' }]);
    await expect(chatStructured({ provider: cut, model: 'm', messages: [{ role: 'user', content: 'go' }], schema, maxTokens: 50 })).rejects.toThrow(/cut at the output limit/);
    const text = await chatText({ provider: scripted([{ text: 'part one', finish: 'length' }]), model: 'm', messages: [{ role: 'user', content: 'go' }], maxContinuations: 1 });
    expect(text.truncated).toBe(true);
    expect(text.text).toBe('part onepart one');
  });
});

describe('routing, local only and caps (AIB-6, AIB-7)', () => {
  it('routes by tier, then the assistant; environment and overrides win', () => {
    const settings = { assistantProvider: 'claude-app', assistantModel: 'opus', ai: { small: { provider: 'ollama', model: 'llama3.2' } } };
    expect(resolveAiRoute({ settings, tier: 'small' })).toMatchObject({ provider: 'ollama', model: 'llama3.2', source: 'tier' });
    expect(resolveAiRoute({ settings, tier: 'large' })).toMatchObject({ provider: 'claude-app', model: 'opus', source: 'assistant' });
    expect(resolveAiRoute({ settings, tier: 'large', env: { TESTPION_AI_PROVIDER: 'mock', TESTPION_AI_MODEL_LARGE: 'big' } })).toMatchObject({ provider: 'mock', model: 'big', source: 'env' });
    expect(resolveAiRoute({ settings, tier: 'small', override: { provider: 'x', model: 'y' } })).toMatchObject({ provider: 'x', source: 'override' });
    expect(() => resolveAiRoute({ settings: {}, tier: 'small' })).toThrow(/assistant is off/);
  });

  it('local only allows loopback servers and the mock, and refuses cloud providers before sending', () => {
    expect(staysOnThisComputer({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' })).toBe(true);
    expect(staysOnThisComputer({ kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })).toBe(true);
    expect(staysOnThisComputer({ kind: 'ollama', baseUrl: 'https://ollama.com/v1' })).toBe(false);
    expect(staysOnThisComputer({ kind: 'anthropic', baseUrl: 'http://127.0.0.1' })).toBe(false);
    expect(() => assertLocalAllowed({ id: 'a', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }, true)).toThrow(/Local only is on/);
    expect(aiLocalOnly({}, { TESTPION_AI_LOCAL_ONLY: '1' })).toBe(true);
    expect(aiLocalOnly({ ai: { localOnly: true } }, { TESTPION_AI_LOCAL_ONLY: '0' })).toBe(false);
  });

  it('refuses a call over the per-call cap, and over the daily caps from the ledger', () => {
    const h = harness();
    try {
      expect(() => checkAiCaps(h.store, { maxTokensPerCall: 1000 }, { tokens: 1500 })).toThrow(/over the cap/);
      h.store.meta.addAiCall({
        id: 'a1',
        at: new Date().toISOString(),
        surface: 'cli',
        task: 'explain-error',
        provider: 'P',
        model: 'm',
        inputTokens: 900,
        outputTokens: 50,
        costUsd: 0.4,
        ms: 5,
        outcome: 'ok',
      });
      expect(() => checkAiCaps(h.store, { dailyTokens: 1000 }, { tokens: 100 })).toThrow(/used 950 of 1,000 tokens today/);
      expect(() => checkAiCaps(h.store, { dailyBudgetUsd: 0.5 }, { tokens: 10, costUsd: 0.2 })).toThrow(/per-day budget/);
      expect(() => checkAiCaps(h.store, { dailyTokens: 5000, dailyBudgetUsd: 1 }, { tokens: 100, costUsd: 0.01 })).not.toThrow();
      const s = aiUsageSummary(h.store, { settings: { dailyTokens: 5000 } });
      expect(s.today.calls).toBe(1);
      expect(s.caps.tokensLeftToday).toBe(4050);
      expect(s.byTask[0]).toMatchObject({ task: 'explain-error', calls: 1 });
    } finally {
      h.cleanup();
    }
  });

  it('a missing key names the provider (the app offers Add the key)', () => {
    const reg = new ProviderRegistry(
      [{ id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: '{{$secret.provider.openai.apiKey}}' }],
      new VariableScope(),
    );
    try {
      reg.get('openai');
      expect.unreachable();
    } catch (e) {
      expect((e as { details?: { setup?: { provider?: string } } }).details?.setup?.provider).toBe('openai');
    }
    expect(mockProvider([]).kind).toBe('mock');
  });
});
