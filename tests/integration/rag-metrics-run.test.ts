/**
 * A RAG run with the R1b metrics against the local demo RAG system (mock judge, no model, no network beyond 127.0.0.1):
 * the failure class of every sample, the judge cost apart from the system's, the samples × metrics matrix with its
 * aggregates and gates, and a re-score of the stored run (no call to the RAG system, the verdicts from the cache).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  MemorySecretStore,
  WorkspaceStore,
  buildMetricMatrix,
  checkGates,
  createEngineContext,
  defaultSettings,
  evaluationTests,
  parseGates,
  recordRun,
  rescoreRun,
  runResults,
  runTests,
  saveRagTarget,
  type EngineContext,
  type MockRule,
  type RagTarget,
  type RunSummary,
  type SavedEvaluation,
  type TestResult,
} from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { tempDir } from '../helpers.js';

const t = tempDir('tp-rag-metrics-');
let server: { httpUrl: string; close(): Promise<void> };
let store: WorkspaceStore;

const RULES: MockRule[] = [
  { match: 'faithfulness-v1[\\s\\S]*Parking is free', response: JSON.stringify({ reasoning: 'no document mentions parking', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }, { text: 'Parking is free for two hours.', verdict: false, reason: 'no document' }] }) },
  { match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }] }) },
  { match: 'answer-relevance-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'It opens at 8am.', verdict: true, reason: 'answers' }] }) },
];

function context(): EngineContext {
  store.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(RULES) }] }]);
  const settings = { ...defaultSettings(), assistantProvider: 'judge', assistantModel: 'mock-model', pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'test' }] };
  return createEngineContext({ store, secrets: new MemorySecretStore(), settings, aiSurface: 'cli' });
}

const target = (): RagTarget => ({
  protocol: 'http',
  step: { type: 'http', method: 'POST', url: `${server.httpUrl}/query`, headers: { 'Content-Type': 'application/json' }, json: { question: '{{question}}' } },
  mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } },
  limits: { concurrency: 2, retries: 1 },
});

const dataset = [
  { id: 'hours', question: 'What time does the clinic open?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'], tags: ['hours'] },
  { id: 'parking', question: 'Is there parking at the clinic?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'], tags: ['parking'] },
  { id: 'weather', question: 'What is the weather like today?', reference: 'The clinic opens at 8am.', reference_ids: ['doc-1'], tags: ['weather'] },
]
  .map((r) => JSON.stringify(r))
  .join('\n');

const evaluation = (): SavedEvaluation => ({
  name: 'Clinic metrics',
  type: 'rag',
  provider: '',
  model: '',
  prompt: '',
  format: 'text',
  datasetFormat: 'jsonl',
  dataset,
  expectedField: 'expected',
  evaluators: [{ type: 'recall@5', threshold: 1 }, { type: 'context-recall-ids' }, { type: 'LLMContextRecall' }, { type: 'faithfulness', threshold: 0.8 }, { type: 'rag-answer-relevance' }, { type: 'token-f1', threshold: 0.3 }, { type: 'latency', max: 5000 }],
  concurrency: 3,
  retries: 0,
  target: 'Clinic',
  judge: { provider: 'judge', model: 'mock-model' },
});

let firstRun: { id: string; summary: RunSummary; results: TestResult[] };

beforeAll(async () => {
  server = await startRagServer({ port: 0, grpcPort: 0 });
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG metrics');
  saveRagTarget(store, { name: 'Clinic', target: target() });
});
afterAll(async () => {
  await server.close();
  store.close();
  t.cleanup();
});

describe('a RAG run with the R1b metrics', () => {
  it('scores every sample, classifies why it failed, and reports what the judge cost apart from the system', async () => {
    const ctx = context();
    try {
      const results: TestResult[] = [];
      const id = 'run-metrics-1';
      const dir = store.runDir(id);
      const summary = await runTests({ name: 'Clinic metrics', runId: id, tests: evaluationTests(evaluation(), { store }), services: ctx.services, concurrency: 3, resultsFile: join(dir, 'results.jsonl'), onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
      await recordRun(store, summary, dir);
      firstRun = { id, summary, results: results.sort((a, b) => a.id.localeCompare(b.id)) };
      const by = (name: string) => firstRun.results.find((r) => r.id.endsWith(name))!;
      expect(by('hours').status).toBe('passed');
      expect((by('hours').metadata as { rag: { failure?: unknown } }).rag.failure).toBeUndefined();
      expect((by('parking').metadata as { rag: { failure: { class: string } } }).rag.failure.class).toBe('unfaithful');
      expect((by('weather').metadata as { rag: { failure: { class: string; metrics: string[] } } }).rag.failure).toMatchObject({ class: 'retrieval-miss' });
      // an alias runs as the metric it stands for
      expect(by('hours').checks.find((c) => c.name === 'LLMContextRecall')).toBeDefined();
      // the judge's cost is its own number
      expect(summary.judgeCostUsd).toBeGreaterThan(0);
      expect(summary.costUsd).toBeLessThan(summary.judgeCostUsd!);
      // what a sample needs to be scored again is stored with it
      expect(by('hours').metadata).toMatchObject({ rag: { reference: 'The clinic opens at 8am on weekdays.', referenceIds: ['doc-1'] } });
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('the samples × metrics matrix: each cell is that metric’s own score, with the aggregates and the failure classes', async () => {
    const m = await buildMetricMatrix(runResults(store, firstRun.id), { runId: firstRun.id });
    expect(m.total).toBe(3);
    const keys = m.columns.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['recall@5', 'context-recall-ids', 'LLMContextRecall', 'faithfulness', 'rag-answer-relevance', 'token-f1', 'latency']));
    // grouped by type: the retrieval metrics before the generation ones
    expect(m.groups.map((g) => g.id)).toEqual(['retrieval-judged', 'retrieval-ir', 'generation', 'reference', 'operational']);
    const faith = m.aggregates.find((a) => a.key === 'faithfulness')!;
    expect(faith).toMatchObject({ n: 2, naCount: 0 });
    expect(faith.mean).toBe(0.75);
    expect(faith.ci).toBeUndefined();
    expect(faith.distribution.reduce((a, b) => a + b, 0)).toBe(2);
    const rows = Object.fromEntries(m.rows.map((r) => [r.id.split(':')[1], r]));
    expect(rows.hours!.cells[keys.indexOf('faithfulness')]).toMatchObject({ score: 1, passed: true });
    expect(rows.parking!.cells[keys.indexOf('faithfulness')]).toMatchObject({ score: 0.5, passed: false });
    // the weather question retrieved nothing: recall@5 is 0 (a retriever failure), faithfulness has no contexts to judge
    expect(rows.weather!.cells[keys.indexOf('recall@5')]).toMatchObject({ score: 0, passed: false });
    expect(m.failures).toEqual([expect.objectContaining({ class: 'retrieval-miss', count: 1 }), expect.objectContaining({ class: 'unfaithful', count: 1 })]);
    // filter by failure class, sort, search
    expect((await buildMetricMatrix(runResults(store, firstRun.id), { failure: 'unfaithful' })).rows.map((r) => r.id)).toEqual(['clinic-metrics:parking']);
    expect((await buildMetricMatrix(runResults(store, firstRun.id), { failure: 'passed' })).rows.map((r) => r.id)).toEqual(['clinic-metrics:hours']);
    expect((await buildMetricMatrix(runResults(store, firstRun.id), { sort: 'faithfulness', limit: 1 })).rows[0]!.id).toBe('clinic-metrics:parking');
    expect((await buildMetricMatrix(runResults(store, firstRun.id), { query: 'weather' })).total).toBe(1);
  });

  it('a threshold edited after the run decides pass and fail again from the stored scores', async () => {
    const m = await buildMetricMatrix(runResults(store, firstRun.id), { thresholds: { faithfulness: 0.4 } });
    const parking = m.rows.find((r) => r.id.endsWith('parking'))!;
    expect(parking.cells[m.columns.findIndex((c) => c.key === 'faithfulness')]).toMatchObject({ score: 0.5, passed: true });
    expect(m.aggregates.find((a) => a.key === 'faithfulness')!.passRate).toBe(1);
  });

  it('gates: --min faithfulness=0.8 fails on a mean of 0.75; a metric the run does not have fails its gate', async () => {
    const m = await buildMetricMatrix(runResults(store, firstRun.id));
    const gates = checkGates(m, parseGates(['faithfulness=0.8', 'recall@5=0.2,token-f1=0.3', 'ndcg@k=0.5']));
    expect(gates.map((g) => [g.metric, g.passed])).toEqual([['faithfulness', false], ['recall@5', true], ['token-f1', true], ['ndcg@k', false]]);
    expect(gates[0]!.why).toMatch(/mean 0.75 < 0.8/);
    expect(gates[3]!.why).toMatch(/no score in this run/);
    expect(() => parseGates('faithfulness')).toThrow(/metric=value/);
  });

  it('a re-score reads the stored samples: no call to the RAG system, the verdicts come from the cache, a new run is recorded', async () => {
    const ctx = context();
    try {
      await server.close();
      const r = await rescoreRun(store, { runId: firstRun.id, providers: ctx.services.providers, ragJudge: ctx.services.ragJudge!, judge: { provider: 'judge', model: 'mock-model' } });
      server = await startRagServer({ port: 0, grpcPort: 0 });
      expect(r.runId).not.toBe(firstRun.id);
      expect(r.rescored).toBe(3);
      expect(r.skipped).toBe(0);
      expect(ctx.services.ragJudge!.budget.calls).toBe(0);
      expect(ctx.services.ragJudge!.budget.cached).toBeGreaterThan(0);
      expect(r.summary.name).toBe('Clinic metrics (re-scored)');
      const again = await buildMetricMatrix(runResults(store, r.runId));
      expect(again.aggregates.find((a) => a.key === 'faithfulness')!.mean).toBe(0.75);
      expect(again.failures.map((f) => f.class)).toContain('unfaithful');
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('re-scored with other metrics, only those are in the new run', async () => {
    const ctx = context();
    try {
      const r = await rescoreRun(store, { runId: firstRun.id, evaluators: [{ type: 'string-similarity', threshold: 0.2 }], providers: ctx.services.providers, ragJudge: ctx.services.ragJudge! });
      const m = await buildMetricMatrix(runResults(store, r.runId));
      expect(m.columns.map((c) => c.key)).toEqual(['string-similarity']);
    } finally {
      await ctx.dispose();
    }
  });
});
