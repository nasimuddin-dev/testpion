/**
 * A RAG evaluation as a monitor: the saved evaluation runs on a schedule against the local demo RAG system (mock judge, no
 * model, no network beyond 127.0.0.1); it fails on its gates with a reason that names the metric, judges only a share of its
 * samples when asked, and stops judging at the day's budget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  MemorySecretStore,
  WorkspaceStore,
  createEngineContext,
  defaultSettings,
  executeMonitor,
  monitorResults,
  runResults,
  saveMonitor,
  saveRagTarget,
  type Monitor,
  type MockRule,
  type SavedEvaluation,
  type TestResult,
} from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { tempDir } from '../helpers.js';

const t = tempDir('tp-rag-monitor-');
let server: { httpUrl: string; close(): Promise<void> };
let store: WorkspaceStore;

const RULES: MockRule[] = [
  { match: 'faithfulness-v1[\\s\\S]*Parking is free', response: JSON.stringify({ reasoning: 'no parking document', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }, { text: 'Parking is free.', verdict: false, reason: 'none' }] }) },
  { match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }] }) },
];

const run = (m: Monitor) =>
  executeMonitor({
    store,
    monitor: m,
    trigger: 'manual',
    context: (o) => createEngineContext({ store, secrets: new MemorySecretStore(), settings: { ...defaultSettings(), assistantProvider: 'judge', assistantModel: 'mock-model', pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'test' }] }, environment: o.environment, aiSurface: 'cli' }),
  });

const base = (over: Partial<Monitor> = {}): Monitor => ({ id: 'mon-rag', name: 'Clinic RAG health', evaluation: 'Clinic monitor eval', everyMinutes: 60, enabled: true, ...over });

beforeAll(async () => {
  server = await startRagServer({ port: 0, grpcPort: 0 });
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG monitor');
  store.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(RULES) }] }]);
  saveRagTarget(store, { name: 'Clinic', target: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${server.httpUrl}/query`, json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id' } } } });
  const dataset = [
    { id: 'hours', question: 'What time does the clinic open?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'] },
    { id: 'parking', question: 'Is there parking at the clinic?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'] },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');
  const evaluation: SavedEvaluation = { name: 'Clinic monitor eval', type: 'rag', provider: '', model: '', prompt: '', format: 'text', datasetFormat: 'jsonl', dataset, expectedField: 'expected', evaluators: [{ type: 'faithfulness', threshold: 0.8 }, { type: 'recall@3', threshold: 1 }], concurrency: 2, retries: 0, target: 'Clinic', judge: { provider: 'judge', model: 'mock-model' } };
  store.saveLibrary('evaluations', { folders: [], items: [{ id: 'ev-1', name: 'Clinic monitor eval', data: evaluation }, { id: 'ev-2', name: 'Plain LLM eval', data: { ...evaluation, type: 'llm' } }] });
});
afterAll(async () => {
  await server.close();
  store.close();
  t.cleanup();
});

describe('a monitor that runs a RAG evaluation', () => {
  it('is validated: one target, a RAG evaluation, a sane judged share, known metrics', () => {
    expect(() => saveMonitor(store, base({ collectionId: 'c1' }))).toThrow(/not both/);
    expect(() => saveMonitor(store, base({ evaluation: 'Nope' }))).toThrow(/No saved evaluation/);
    expect(() => saveMonitor(store, base({ evaluation: 'Plain LLM eval', gates: { faithfulness: 0.8 } }))).toThrow(/for a bot with sources/);
    expect(() => saveMonitor(store, base({ judgeSample: 0 }))).toThrow(/more than 0/);
    expect(() => saveMonitor(store, base({ gates: { nonsense: 1 } }))).toThrow(/not a metric name/);
    expect(saveMonitor(store, base({ gates: { faithfulness: 0.7, 'recall@3': 1 }, judgeSample: 1 })).evaluation).toBe('Clinic monitor eval');
  });

  it('passes when its gates hold, and the result points at the recorded run', async () => {
    const r = await run(base({ gates: { faithfulness: 0.7, 'recall@3': 1 } }));
    expect(r).toMatchObject({ status: 'passed', total: 2 });
    expect(monitorResults(store, 'mon-rag')[0]!.runId).toBe(r.runId);
    const results: TestResult[] = [];
    for await (const x of runResults(store, r.runId)) results.push(x);
    expect(results).toHaveLength(2);
  }, 60_000);

  it('fails below a gate, and the reason names the metric', async () => {
    const r = await run(base({ gates: { faithfulness: 0.9 } }));
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('faithfulness mean 0.75 < 0.9');
  }, 60_000);

  it('without gates a sample that fails fails the run', async () => {
    const r = await run(base());
    expect(r.status).toBe('failed');
    expect(r.failed).toBe(1);
  }, 60_000);

  it('judges a share of its samples: the others are n/a, never guessed', async () => {
    store.meta.clearJudgeCache();
    const r = await run(base({ judgeSample: 0.0000001, gates: { 'recall@3': 1 } }));
    expect(r.status).toBe('passed');
    const results: TestResult[] = [];
    for await (const x of runResults(store, r.runId)) results.push(x);
    const faithfulness = results.flatMap((x) => x.checks.filter((c) => c.type === 'faithfulness'));
    expect(faithfulness.every((c) => (c.metadata as { na?: string }).na === 'sampled')).toBe(true);
    // the free metrics always run
    expect(results.every((x) => x.checks.some((c) => c.type === 'recall@k' && c.score === 1))).toBe(true);
  }, 60_000);

  it('stops judging at the day’s budget', async () => {
    store.meta.clearJudgeCache();
    const r = await run(base({ judgeBudgetUsdPerDay: 0, gates: { 'recall@3': 1 } }));
    const results: TestResult[] = [];
    for await (const x of runResults(store, r.runId)) results.push(x);
    expect(results.flatMap((x) => x.checks.filter((c) => c.type === 'faithfulness')).every((c) => (c.metadata as { na?: string }).na === 'budget')).toBe(true);
  }, 60_000);
});

describe('nightly RAG monitor options', () => {
  const allTrue: MockRule[] = [{ match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }] }) }];
  const setRules = (rules: MockRule[]) => store.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] }]);

  it('a rotating sample scores only `limit` records and the result says which day it was', async () => {
    const r = await run(base({ rotate: true, limit: 1, gates: { 'recall@3': 1 } }));
    expect(r.total).toBe(1);
    expect(r.rag?.sample).toMatch(/^day \d+: 1 of 2 records$/);
  }, 60_000);

  it('a budget stop is n/a with a note in the result, not a failed gate', async () => {
    store.meta.clearJudgeCache();
    const r = await run(base({ maxCostUsd: 0, gates: { 'recall@3': 1 } }));
    expect(r.status).toBe('passed');
    expect(r.rag?.budget).toMatch(/stopped at its budget: 2 scores are n\/a/);
    expect(r.reason).toMatch(/^note: the judge stopped/);
  }, 60_000);

  it('a regression against the previous run fails with the metric, before and after; the alert text carries the means', async () => {
    store.meta.clearJudgeCache();
    setRules(allTrue);
    const a = await run(base({ gates: { 'recall@3': 1 } }));
    expect(a.rag?.means.join(' ')).toContain('faithfulness 1');
    store.meta.clearJudgeCache();
    setRules(RULES);
    const b = await run(base({ gates: { 'recall@3': 1 }, baseline: a.runId, maxDrop: 0.05 }));
    expect(b.status).toBe('failed');
    expect(b.rag?.regressions?.[0]).toMatch(/^faithfulness 1 to 0\.75 \(-0\.25/);
    expect(b.reason).toContain(`regressed against ${a.runId}: faithfulness`);
    expect(b.rag?.table).toContain('### Against');
    // 'previous' finds the run before it; the first run of a monitor has none yet
    const c = await run(base({ id: 'mon-rag-2', name: 'Another night', gates: { 'recall@3': 1 }, baseline: 'previous' }));
    expect(c.rag?.baseline).toMatch(/none yet/);
    expect(c.status).toBe('passed');
  }, 120_000);
});
