/**
 * The judged RAG metrics of R1b with the offline mock provider (never a real model): context-relevance in its four modes,
 * the shared claim pass, Ragas' reverse-question answer relevance, juries, swap, repeat, shortCircuit, the estimate, "Try
 * on one sample", the failure class, the prompts' pins. Every judge answer is scripted by the prompt's version string.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_RELEVANCE_ON_CLAIMS,
  CLAIMS,
  CONTEXT_RELEVANCE_CHUNKS,
  CONTEXT_RELEVANCE_NVIDIA,
  CONTEXT_RELEVANCE_SENTENCES,
  CONTEXT_RELEVANCE_STATEMENTS,
  FAITHFULNESS_ON_CLAIMS,
  ProviderRegistry,
  REVERSE_QUESTIONS,
  createRagJudgeHost,
  contextOfSample,
  dryHost,
  estimateRagRun,
  estimateRagRunExact,
  scoreRagSample,
  tryMetric,
  type AppSettings,
  type CheckConfig,
  type MockRule,
  type ProviderConfig,
  type RagJudgeSetup,
  type TrySample,
} from '../../packages/core/src/index.js';
import { harness, mockProvider } from './harness.js';

const verdict = (items: Array<[string, boolean, number?]>, reasoning = 'checked') => JSON.stringify({ reasoning, items: items.map(([text, v, rating]) => ({ text, verdict: v, reason: `[doc-1] ${text}`, ...(rating !== undefined ? { rating } : {}) })) });

const SAMPLE: TrySample = {
  question: 'What time does the clinic open?',
  answer: 'The clinic opens at 8am. Parking is free.',
  contexts: [
    { id: 'doc-1', text: 'The clinic opens at 8am on weekdays.' },
    { id: 'doc-2', text: 'Appointments can be cancelled up to 24 hours before.' },
    { id: 'doc-3', text: 'Parking is behind the building.' },
  ],
  reference: 'The clinic opens at 8am on weekdays.',
  referenceIds: ['doc-1'],
};

function setup(rules: MockRule[], judge?: RagJudgeSetup, extra?: ProviderConfig[]) {
  const h = harness({ rules });
  const providers = extra ? new ProviderRegistry([mockProvider(rules), ...extra], h.vars, h.redactor) : h.deps.providers;
  const host = createRagJudgeHost({ store: h.store, providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
  const score = (configs: CheckConfig[], sample: TrySample = SAMPLE, j: RagJudgeSetup | undefined = judge) => scoreRagSample(configs, contextOfSample(sample, { judge: j, providers, ragJudge: host }));
  return { h, host, providers, score };
}

describe('the prompts are pinned: a change to a wording must bump its version', () => {
  it('claims-v1, the claim verdicts, context relevance in four modes, reverse questions', () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
    const all = [CLAIMS, FAITHFULNESS_ON_CLAIMS, ANSWER_RELEVANCE_ON_CLAIMS, CONTEXT_RELEVANCE_STATEMENTS, CONTEXT_RELEVANCE_SENTENCES, CONTEXT_RELEVANCE_CHUNKS, ...CONTEXT_RELEVANCE_NVIDIA, REVERSE_QUESTIONS];
    expect(Object.fromEntries(all.map((m) => [m.version, sha(m.instruction)]))).toMatchSnapshot();
    expect(new Set(all.map((m) => m.version)).size).toBe(all.length);
    for (const m of all) expect(m.instruction, m.version).toContain(m.version);
  });
});

describe('context-relevance', () => {
  it('nvidia (default): two prompts rate the whole context 0-2, the score is their mean / 2 (ratings 2 and 1 → 0.75)', async () => {
    const { h, score } = setup([
      { match: 'context-relevance-nvidia-a-v1', response: verdict([['What time does the clinic open?', true, 2]]) },
      { match: 'context-relevance-nvidia-b-v1', response: verdict([['What time does the clinic open?', true, 1]]) },
    ]);
    try {
      const { checks } = await score([{ type: 'context-relevance' }]);
      expect(checks[0]).toMatchObject({ score: 0.75, passed: true, source: 'ai-judge' });
      expect(checks[0]!.message).toMatch(/ratings 2 and 1 of 2/);
      expect(h.rec.requests).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('nothing retrieved, or a context that is only the question, is 0 without asking anyone (NVIDIA’s pre-check)', async () => {
    const { h, score } = setup([]);
    try {
      const { checks, failure } = await score([{ type: 'context-relevance' }], { ...SAMPLE, contexts: [] });
      expect(checks[0]).toMatchObject({ score: 0, passed: false });
      expect(failure?.class).toBe('retrieval-miss');
      const same = await score([{ type: 'context-relevance' }], { ...SAMPLE, contexts: [{ id: 'q', text: 'What time does the clinic open?' }] });
      expect(same.checks[0]!.score).toBe(0);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('statements (DeepEval): 10 statements, 4 relevant → 0.4', async () => {
    const items: Array<[string, boolean]> = Array.from({ length: 10 }, (_, i) => [`statement ${i}`, i < 4]);
    const { h, score } = setup([{ match: 'context-relevance-statements-v1', response: verdict(items) }]);
    try {
      const { checks } = await score([{ type: 'context-relevance', mode: 'statements' }]);
      expect(checks[0]).toMatchObject({ score: 0.4, passed: false });
      expect(checks[0]!.message).toMatch(/4 of 10 statements relevant; irrelevant: "statement 4"/);
    } finally {
      h.cleanup();
    }
  });

  it('chunks (TruLens): each chunk rated 0-3, the mean over 3; sentences (promptfoo): needed / sentences', async () => {
    const { h, score } = setup([
      { match: 'context-relevance-chunks-v1', response: verdict([['doc-1', true, 3], ['doc-2', true, 1], ['doc-3', false, 0]]) },
      { match: 'context-relevance-sentences-v1', response: verdict([['s1', true], ['s2', false], ['s3', false], ['s4', false]]) },
    ]);
    try {
      const { checks } = await score([{ type: 'context-relevance', mode: 'chunks' }, { type: 'context-relevance', mode: 'sentences', name: 's' }]);
      expect(checks[0]!.score).toBe(0.444);
      expect(checks[1]!.score).toBe(0.25);
    } finally {
      h.cleanup();
    }
  });

  it('a rating outside the scale is a judge error, not a score', async () => {
    const { h, score } = setup([{ match: 'context-relevance-chunks-v1', response: verdict([['doc-1', true, 9]]) }]);
    try {
      const { checks, failure } = await score([{ type: 'context-relevance', mode: 'chunks' }]);
      expect(checks[0]!.passed).toBe(false);
      expect(checks[0]!.message).toMatch(/judge failed:.*verdict format/);
      expect(failure?.class).toBe('judge-error');
    } finally {
      h.cleanup();
    }
  });

  it('an unknown mode is refused with the modes there are', async () => {
    const { h, score } = setup([]);
    try {
      expect((await score([{ type: 'context-relevance', mode: 'nope' }])).checks[0]!.message).toMatch(/nvidia, statements, chunks or sentences/);
    } finally {
      h.cleanup();
    }
  });
});

describe('the triad and the shared claim pass', () => {
  const rules: MockRule[] = [
    { match: 'version claims-v1', response: verdict([['The clinic opens at 8am.', true], ['Parking is free.', true]]) },
    { match: 'faithfulness-claims-v1', response: verdict([['The clinic opens at 8am.', true], ['Parking is free.', false]]) },
    { match: 'answer-relevance-claims-v1', response: verdict([['The clinic opens at 8am.', true], ['Parking is free.', false]]) },
    { match: 'faithfulness-v1', response: verdict([['The clinic opens at 8am.', true], ['Parking is free.', false]]) },
    { match: 'answer-relevance-v1', response: verdict([['It opens at 8am.', true], ['Parking is free.', false]]) },
  ];
  const triad: CheckConfig[] = [{ type: 'faithfulness' }, { type: 'answer-relevance' }];

  it('by default two readers of the claims each make their one call (splitting once would cost more)', async () => {
    const { h, score } = setup(rules);
    try {
      const { checks } = await score(triad);
      expect(checks.map((c) => c.score)).toEqual([0.5, 0.5]);
      expect(h.rec.requests).toHaveLength(2);
      expect(checks[0]!.metadata).not.toHaveProperty('shared');
    } finally {
      h.cleanup();
    }
  });

  it('shareClaims: the answer is split once, each metric judges those claims; run again it is all cached', async () => {
    const { h, host, score } = setup(rules, { shareClaims: true });
    try {
      const { checks } = await score(triad);
      expect(h.rec.requests).toHaveLength(3);
      expect(checks[0]).toMatchObject({ score: 0.5, metadata: { shared: 'claims-v1', claims: 2, promptVersion: 'faithfulness-claims-v1', judgeUsage: { calls: 2 } } });
      expect(checks[1]).toMatchObject({ score: 0.5, metadata: { shared: 'claims-v1', promptVersion: 'answer-relevance-claims-v1' } });
      // the judge cost is the sum of what each metric used, the claims pass counted by the one that asked it
      expect(host.budget.calls).toBe(3);
      const again = await score(triad);
      expect(h.rec.requests).toHaveLength(3);
      expect(again.checks[0]!.metadata).toMatchObject({ judgeUsage: { calls: 0, cached: true } });
    } finally {
      h.cleanup();
    }
  });

  it('three readers of the claims share by default', async () => {
    const { h, score } = setup(rules);
    try {
      await score([...triad, { type: 'answer-relevance', name: 'second' }]);
      expect(h.rec.requests.filter((r) => /claims-v1/.test(r.messages.map((m) => m.content).join(''))).length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it('an answer with no claims (a refusal) is n/a for faithfulness, and answer relevance falls back to its own prompt', async () => {
    const { h, score } = setup([{ match: 'version claims-v1', response: verdict([]) }, { match: 'faithfulness-v1', response: verdict([]) }, { match: 'answer-relevance-v1', response: verdict([["I don't know.", false]]) }], { shareClaims: true });
    try {
      const { checks } = await score(triad, { ...SAMPLE, answer: "I don't know." });
      expect(checks[0]!.metadata).toMatchObject({ na: 'the answer makes no factual claims' });
      expect(checks[1]).toMatchObject({ score: 0, passed: false });
    } finally {
      h.cleanup();
    }
  });

  it('answer relevance by reverse questions (Ragas): the mean similarity of the generated questions to the real one; a noncommittal answer is 0', async () => {
    const q = 'What time does the clinic open?';
    const { h, score } = setup([{ match: 'answer-relevance-questions-v1', response: verdict([[q, true], ['When does the clinic open?', true], ['What time is the clinic open at?', true]]) }]);
    try {
      const { checks } = await score([{ type: 'response_relevancy', threshold: 0.5 }]);
      expect(checks[0]!.type).toBe('answer-relevance');
      expect(checks[0]!.score).toBeGreaterThan(0.6);
      expect(checks[0]!.passed).toBe(true);
      expect(checks[0]!.metadata).toMatchObject({ mode: 'reverse-questions', similarities: expect.any(Array) });
    } finally {
      h.cleanup();
    }
    const evasive = setup([{ match: 'answer-relevance-questions-v1', response: verdict([['What is it?', false], ['Who knows?', false], ['Why?', false]]) }]);
    try {
      const { checks } = await evasive.score([{ type: 'answer-relevance', mode: 'reverse-questions' }], { ...SAMPLE, answer: 'I do not know.' });
      expect(checks[0]).toMatchObject({ score: 0, passed: false });
      expect(checks[0]!.message).toMatch(/noncommittal/);
    } finally {
      evasive.h.cleanup();
    }
  });
});

describe('the judge panel', () => {
  it('swap: the documents are judged in both orders; when they disagree on pass or fail it is a tie, which is not a pass', async () => {
    const { h, score } = setup(
      [{ match: 'faithfulness-v1', responses: [verdict([['The clinic opens at 8am.', true]]), verdict([['The clinic opens at 8am.', false]])] }],
      { swap: true },
    );
    try {
      const { checks } = await score([{ type: 'faithfulness', threshold: 0.5 }]);
      expect(checks[0]).toMatchObject({ score: 0.5, passed: false, metadata: { panel: { swap: { scores: [1, 0], tie: true } } } });
      expect(checks[0]!.message).toMatch(/a tie/);
      // the second order really had the documents the other way round
      const sent = h.rec.requests.map((r) => r.messages.map((m) => m.content).join(''));
      expect(sent[0]!.indexOf('doc-1')).toBeLessThan(sent[0]!.indexOf('doc-3'));
      expect(sent[1]!.indexOf('doc-3')).toBeLessThan(sent[1]!.indexOf('doc-1'));
    } finally {
      h.cleanup();
    }
  });

  it('repeat: n answers per judge, the first from the cache and the rest asked again; the result has the mean, the sd and the flip rate', async () => {
    const two = (a: boolean) => verdict([['claim one', true], ['claim two', a]]);
    const { h, score } = setup([{ match: 'faithfulness-v1', responses: [two(true), two(false)] }], { repeat: 2 });
    try {
      const { checks } = await score([{ type: 'faithfulness' }]);
      expect(checks[0]!.score).toBe(0.75);
      expect(checks[0]!.metadata).toMatchObject({ panel: { repeat: { n: 2, scores: [1, 0.5], mean: 0.75, flipRate: 0.5 } } });
      expect(h.rec.requests).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('a jury: each judge scores, the aggregate is majority (default), mean or min', async () => {
    const j = (id: string, ok: boolean): ProviderConfig => ({ ...mockProvider([{ match: 'faithfulness-v1', response: verdict([['c', ok]]) }], id), name: id });
    const extra = [j('judge-a', true), j('judge-b', true), j('judge-c', false)];
    const { h, score } = setup([], undefined, extra);
    try {
      const judges = [{ provider: 'judge-a' }, { provider: 'judge-b' }, { provider: 'judge-c' }];
      const majority = await score([{ type: 'faithfulness' }], SAMPLE, { judges });
      expect(majority.checks[0]).toMatchObject({ score: 1, passed: true, metadata: { panel: { aggregate: 'majority' } } });
      expect((majority.checks[0]!.metadata as { panel: { judges: unknown[] } }).panel.judges).toHaveLength(3);
      const min = await score([{ type: 'faithfulness' }], SAMPLE, { judges, aggregate: 'min' });
      expect(min.checks[0]).toMatchObject({ score: 0, passed: false });
      const mean = await score([{ type: 'faithfulness' }], SAMPLE, { judges, aggregate: 'mean' });
      expect(mean.checks[0]!.score).toBe(0.667);
    } finally {
      h.cleanup();
    }
  });

  it('shortCircuit: a retrieval gate that failed spares the judged answer metrics (no call), and the sample is a retrieval miss', async () => {
    const { h, score } = setup([{ match: 'faithfulness-v1', response: verdict([['c', true]]) }], { shortCircuit: true });
    try {
      const { checks, failure } = await score([{ type: 'faithfulness' }, { type: 'recall@k', k: 3 }], { ...SAMPLE, referenceIds: ['doc-9'] });
      expect(checks.map((c) => c.type)).toEqual(['faithfulness', 'recall@k']);
      expect(checks[0]!.metadata).toMatchObject({ na: 'short-circuit' });
      expect(checks[0]!.passed).toBe(true);
      expect(failure?.class).toBe('retrieval-miss');
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('strict inside a RAG run, the older names outside it', () => {
  it('without a judge the strict metric is an error with what to configure; the old heuristic still answers a static rag test', async () => {
    const { h, host } = setup([]);
    const noJudge = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: { pricing: [] } as never, surface: 'cli' });
    try {
      const ctx = contextOfSample(SAMPLE, { ragJudge: noJudge });
      const { runChecks } = await import('../../packages/core/src/index.js');
      // outside a target run (no ragRun): the heuristic of checks.ts, no judge needed
      const [legacy] = await runChecks([{ type: 'faithfulness' }], ctx);
      expect(legacy!.source).toBe('heuristic');
      // inside one: strict
      const strict = await scoreRagSample([{ type: 'faithfulness' }], ctx);
      expect(strict.checks[0]!.message).toMatch(/judge failed:.*needs a judge model/);
      expect(h.rec.requests).toHaveLength(0);
      expect(host).toBeDefined();
    } finally {
      h.cleanup();
    }
  });
});

describe('Try on one sample', () => {
  it('a dry run lists the exact prompts that would be sent, and sends nothing', async () => {
    const { h, host, providers } = setup([{ match: 'faithfulness-v1', response: verdict([['c', true]]) }]);
    try {
      const r = await tryMetric({ ragJudge: host, providers }, { metric: 'Faithfulness', sample: SAMPLE, dryRun: true });
      expect(r.metric).toMatchObject({ id: 'faithfulness', kind: 'judged' });
      expect(r.willSend).toHaveLength(1);
      expect(r.willSend![0]).toMatchObject({ version: 'faithfulness-v1', cached: false });
      expect(r.willSend![0]!.preview.messages[1]!.content).toContain('Parking is free');
      expect(h.rec.requests).toHaveLength(0);
      expect(r.missing).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a real run returns the result with its items and the usage; the dry run then says the verdict is cached', async () => {
    const { h, host, providers } = setup([{ match: 'faithfulness-v1', response: verdict([['The clinic opens at 8am.', true], ['Parking is free.', false]]) }]);
    try {
      const r = await tryMetric({ ragJudge: host, providers }, { metric: 'faithfulness', sample: SAMPLE });
      expect(r.result).toMatchObject({ score: 0.5, passed: false });
      expect(r.usage).toMatchObject({ calls: 1, cached: false });
      expect(r.usage!.costUsd).toBeGreaterThan(0);
      const dry = await tryMetric({ ragJudge: host, providers }, { metric: 'faithfulness', sample: SAMPLE, dryRun: true });
      expect(dry.willSend![0]!.cached).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('says what the sample lacks, and a metric that does not exist', async () => {
    const { h, host, providers } = setup([]);
    try {
      const r = await tryMetric({ ragJudge: host, providers }, { metric: 'context-recall-ids', sample: { question: 'q', answer: 'a', contexts: [{ text: 't' }] } });
      expect(r.missing).toEqual([{ input: 'referenceIds', message: expect.stringContaining('gold chunk ids') }]);
      expect(r.result!.passed).toBe(false);
      await expect(tryMetric({ ragJudge: host, providers }, { metric: 'nope', sample: SAMPLE })).rejects.toThrow(/No RAG metric called "nope"/);
    } finally {
      h.cleanup();
    }
  });

  it('a free metric answers at once', async () => {
    const { h, host, providers } = setup([]);
    try {
      const r = await tryMetric({ ragJudge: host, providers }, { metric: 'recall@1', sample: SAMPLE });
      expect(r.result).toMatchObject({ score: 1, passed: true });
      expect((await tryMetric({ ragJudge: host, providers }, { metric: 'recall@1', sample: SAMPLE, dryRun: true })).willSend).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe('the estimate', () => {
  const evaluators: CheckConfig[] = [{ type: 'faithfulness' }, { type: 'context-relevance' }, { type: 'recall@k', k: 5 }, { type: 'token-f1' }];

  it('counts calls per sample and for the dataset, with tokens and a cost range from the price table', () => {
    const { h, host } = setup([]);
    try {
      const e = estimateRagRun(host, h.store, { evaluators, samples: 100 });
      expect(e.metrics.map((m) => [m.id, m.llmCalls])).toEqual([['faithfulness', 1], ['context-relevance', 2], ['recall@k', 0], ['token-f1', 0]]);
      expect(e.total.llmCalls).toBe(300);
      expect(e.total.inputTokens).toBeGreaterThan(300 * 300);
      expect(e.judge).toMatchObject({ provider: 'Mock AI', model: 'mock-model', local: true, priceKnown: true });
      expect(e.costUsd!.low).toBeGreaterThan(0);
      expect(e.costUsd!.high).toBeGreaterThan(e.costUsd!.low);
      expect(e.basis).toBe('default');
    } finally {
      h.cleanup();
    }
  });

  it('a jury, swap and repeat multiply the calls', () => {
    const { h, host } = setup([]);
    try {
      const e = estimateRagRun(host, h.store, { evaluators: [{ type: 'faithfulness' }], samples: 10, judge: { judges: [{ provider: 'mock' }, { provider: 'mock' }], swap: true, repeat: 2 } });
      expect(e.total.llmCalls).toBe(10 * 8);
      expect(e.metrics[0]!.note).toMatch(/2 judges, swap, repeat 2/);
    } finally {
      h.cleanup();
    }
  });

  it('a run that would break a limit says which, before it starts', () => {
    const { h, host } = setup([]);
    try {
      const e = estimateRagRun(host, h.store, { evaluators, samples: 100, judge: { maxCalls: 50, maxCostUsd: 0.0000001 } });
      expect(e.caps.exceeds.join('\n')).toMatch(/judge call limit \(50\)/);
      expect(e.caps.exceeds.join('\n')).toMatch(/judge cost limit/);
    } finally {
      h.cleanup();
    }
  });

  it('with no judge it says why instead of guessing, and a metric that needs none costs nothing', () => {
    const h = harness({ rules: [], settings: { pricing: [] } as never });
    try {
      const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
      const e = estimateRagRun(host, h.store, { evaluators, samples: 5 });
      expect(e.judgeProblem).toMatch(/needs a judge model/);
      expect(e.costUsd).toBeUndefined();
      expect(estimateRagRun(host, h.store, { evaluators: [{ type: 'recall@k' }], samples: 5 }).total).toEqual({ llmCalls: 0, embedCalls: 0, inputTokens: 0, outputTokens: 0 });
    } finally {
      h.cleanup();
    }
  });

  it('with stored samples every prompt is built for real: exact calls, tokens and the cache hits of an earlier run', async () => {
    const { h, host, providers, score } = setup([{ match: 'faithfulness-v1', response: verdict([['c', true]]) }]);
    try {
      const second: TrySample = { ...SAMPLE, answer: 'Appointments can be cancelled 24 hours before.' };
      const cold = await estimateRagRunExact(host, h.store, { evaluators: [{ type: 'faithfulness' }], samples: 2, stored: [SAMPLE, second] });
      expect(cold.cache).toEqual({ hits: 0, of: 2, exact: true });
      expect(cold.total.llmCalls).toBe(2);
      expect(h.rec.requests).toHaveLength(0);
      await score([{ type: 'faithfulness' }], SAMPLE);
      const warm = await estimateRagRunExact(host, h.store, { evaluators: [{ type: 'faithfulness' }], samples: 2, stored: [SAMPLE, second] });
      expect(warm.cache).toEqual({ hits: 1, of: 2, exact: true });
      expect(warm.costUsd!.high).toBeLessThan(cold.costUsd!.high);
      expect(dryHost(host).dry).toEqual([]);
      expect(providers).toBeDefined();
    } finally {
      h.cleanup();
    }
  });
});
