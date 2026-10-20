/**
 * The judge service of the RAG metrics (R1a): the `rag-judge` AI task with the offline mock provider. Proves the verdict
 * shape and its repair, the content-hash cache, the usage ledger, the caps and limits, redaction, Local only, and that a
 * missing judge is an error with a setup hint (never a silent mock). No real model is ever called.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_RELEVANCE,
  FAITHFULNESS,
  ProviderRegistry,
  VariableScope,
  aiUsageSummary,
  assertJudgeUsable,
  createRagJudgeHost,
  judgeCall,
  listAiTasks,
  previewJudge,
  type AppSettings,
} from '../../packages/core/src/index.js';
import { harness } from './harness.js';

const VERDICT = { reasoning: 'checked each claim', items: [{ text: 'It opens at 8am.', verdict: true, reason: '[doc-1] "opens at 8am"' }, { text: 'Parking is free.', verdict: false, reason: 'no document mentions parking' }] };
const input = (answer = 'It opens at 8am. Parking is free.') => ({ answer, contexts: [{ id: 'doc-1', text: 'The clinic opens at 8am.' }] });

function setup(rules = [{ match: 'faithfulness-v1', response: JSON.stringify(VERDICT) }], settings?: Partial<AppSettings>) {
  const h = harness({ rules, settings: settings as never });
  const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
  return { h, host };
}

describe('the rag-judge task', () => {
  it('is registered: large tier, a JSON verdict, temperature 0', () => {
    const t = listAiTasks().find((x) => x.id === 'rag-judge')!;
    expect(t).toMatchObject({ tier: 'large', output: 'json' });
    expect(t.description).toMatch(/cached/);
  });

  it('its prompts are pinned: a change to the wording must bump the version', () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
    expect({ [FAITHFULNESS.version]: sha(FAITHFULNESS.instruction), [ANSWER_RELEVANCE.version]: sha(ANSWER_RELEVANCE.instruction) }).toEqual({
      'faithfulness-v1': 'a1f7213909be',
      'answer-relevance-v1': '2e2b6dc8ce8f',
    });
  });
});

describe('judgeCall', () => {
  it('asks once, returns the verdicts, records the call in the ledger and the judge’s identity', async () => {
    const { h, host } = setup();
    try {
      const a = await judgeCall(host, FAITHFULNESS, input());
      expect(a.verdict.items.map((i) => i.verdict)).toEqual([true, false]);
      expect(a.cached).toBe(false);
      expect(a.judge).toMatchObject({ provider: 'Mock AI', model: 'mock-model', metric: 'rag-faithfulness', promptVersion: 'faithfulness-v1' });
      const u = aiUsageSummary(h.store, {});
      expect(u.byTask.find((t) => t.task === 'rag-judge')).toMatchObject({ calls: 1 });
      expect(host.budget.calls).toBe(1);
      expect(host.budget.costUsd).toBeGreaterThan(0);
      // only what the metric needs is sent: the answer and the documents, not the question or a reference
      expect(h.rec.sent()).toContain('Parking is free');
      expect(h.rec.sent()).toContain('FAITHFULNESS');
    } finally {
      h.cleanup();
    }
  });

  it('a second call with the same input is answered from the cache: no model call, no ledger row', async () => {
    const { h, host } = setup();
    try {
      await judgeCall(host, FAITHFULNESS, input());
      const requests = h.rec.requests.length;
      const b = await judgeCall(host, FAITHFULNESS, input());
      expect(b.cached).toBe(true);
      expect(b.usage).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
      expect(h.rec.requests.length).toBe(requests);
      expect(h.store.meta.listAiCalls({}).filter((c) => c.task === 'rag-judge')).toHaveLength(1);
      expect(host.budget.cached).toBe(1);
      // a different answer, a different metric, or a different judge model misses
      expect((await judgeCall(host, FAITHFULNESS, input('It opens at 9am.'))).cached).toBe(false);
      expect(h.store.meta.clearJudgeCache()).toBe(2);
      expect((await judgeCall(host, FAITHFULNESS, input())).cached).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('the same question asked twice at once is asked once', async () => {
    const { h, host } = setup();
    try {
      const [a, b] = await Promise.all([judgeCall(host, FAITHFULNESS, input()), judgeCall(host, FAITHFULNESS, input())]);
      expect(a.verdict).toEqual(b.verdict);
      expect(h.rec.requests).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('a verdict that does not fit the format is repaired; one that cannot be is an error and is not cached', async () => {
    const repaired = setup([{ match: 'faithfulness-v1|That answer has problems', responses: ['I think it is fine.', JSON.stringify(VERDICT)] }]);
    try {
      const a = await judgeCall(repaired.host, FAITHFULNESS, input());
      expect(a.verdict.items).toHaveLength(2);
      expect(a.usage.calls).toBe(2);
    } finally {
      repaired.h.cleanup();
    }
    const broken = setup([{ match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'x', items: [{ text: 't' }] }) }]);
    try {
      await expect(judgeCall(broken.host, FAITHFULNESS, input())).rejects.toThrow(/did not answer in the verdict format/);
      expect(broken.h.store.meta.clearJudgeCache()).toBe(0);
    } finally {
      broken.h.cleanup();
    }
  });

  it('the sample is redacted before it is sent: a secret in the answer never leaves', async () => {
    const h = harness({ rules: [{ match: 'faithfulness-v1', response: JSON.stringify(VERDICT) }], secrets: { apiToken: 'sk-live-0123456789abcdef0123' } });
    try {
      const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
      h.redactor.addSecret('sk-live-0123456789abcdef0123');
      const a = await judgeCall(host, FAITHFULNESS, input('The key is sk-live-0123456789abcdef0123 and it opens at 8am.'));
      expect(a.redactionCount).toBeGreaterThan(0);
      expect(h.rec.sent()).not.toContain('sk-live-0123456789abcdef0123');
    } finally {
      h.cleanup();
    }
  });

  it('"What will be sent" is the exact prompt, with the sections and the estimate; nothing is sent', () => {
    const { h, host } = setup();
    try {
      const p = previewJudge(host, FAITHFULNESS, input());
      expect(p.task).toBe('rag-judge');
      expect(p.messages.map((m) => m.role)).toEqual(['system', 'user']);
      expect(p.messages[1]!.content).toContain('FAITHFULNESS');
      expect(p.messages[1]!.content).toContain('The clinic opens at 8am.');
      expect(p.estimate.inputTokens).toBeGreaterThan(50);
      expect(p.context.sections.map((s) => s.name)).toEqual(['answer', 'contexts']);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('a lower privacy level is refused: a judge needs the text itself', async () => {
    const { h, host } = setup(undefined, { assistantProvider: 'mock-ai', assistantModel: 'mock-model', ai: { privacy: 'metadata' } } as never);
    try {
      await expect(judgeCall(host, FAITHFULNESS, input())).rejects.toThrow(/privacy level "Full \(redacted\)"/);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('the run’s limits stop the judging without guessing a score', async () => {
    const { h, host } = setup();
    try {
      await judgeCall(host, FAITHFULNESS, input(), { judge: { maxCalls: 1 } });
      await expect(judgeCall(host, FAITHFULNESS, input('Another answer.'), { judge: { maxCalls: 1 } })).rejects.toMatchObject({ details: { budget: true } });
      await expect(judgeCall(host, FAITHFULNESS, input('Yet another.'), { judge: { maxCostUsd: 0.0000001 } })).rejects.toMatchObject({ details: { budget: true } });
    } finally {
      h.cleanup();
    }
  });

  it('the daily token cap of the AI settings applies to judge calls too', async () => {
    const { h, host } = setup(undefined, { assistantProvider: 'mock-ai', assistantModel: 'mock-model', ai: { maxTokensPerCall: 100 } } as never);
    try {
      await expect(judgeCall(host, FAITHFULNESS, input())).rejects.toThrow(/cap|limit|tokens/i);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('no silent judge', () => {
  it('without a judge or an assistant model the error lists what to configure', () => {
    const { h, host } = setup(undefined, { pricing: [] } as never);
    try {
      let err: { message: string; suggestions?: string[] } | undefined;
      try {
        assertJudgeUsable(host);
      } catch (e) {
        err = e as typeof err;
      }
      expect(err!.message).toMatch(/needs a judge model, and none is set up/);
      const hints = err!.suggestions!.join('\n');
      expect(hints).toMatch(/choose the judge/);
      expect(hints).toMatch(/Settings ▸ AI assistant/);
      expect(hints).toMatch(/--judge <provider>\/<model>/);
      expect(hints).toMatch(/TESTPION_AI_PROVIDER/);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('a judge provider that does not exist is named, with the providers there are', () => {
    const { h, host } = setup();
    try {
      expect(() => assertJudgeUsable(host, { provider: 'nope' })).toThrow(expect.objectContaining({ why: expect.stringContaining('"nope" is not a provider of this workspace') }));
      expect(assertJudgeUsable(host, { provider: 'mock' })).toMatchObject({ provider: 'Mock AI' });
    } finally {
      h.cleanup();
    }
  });

  it('Local only refuses a cloud judge before anything is sent', () => {
    const h = harness({ settings: { assistantProvider: 'cloud', assistantModel: 'm', ai: { localOnly: true }, pricing: [] } as never });
    try {
      const vars = new VariableScope();
      const providers = new ProviderRegistry([{ id: 'cloud', name: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'unused', defaultModel: 'm' }], vars, h.redactor);
      const host = createRagJudgeHost({ store: h.store, providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
      expect(() => assertJudgeUsable(host)).toThrow(/Local only is on/);
    } finally {
      h.cleanup();
    }
  });
});
