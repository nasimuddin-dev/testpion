/**
 * `testpion rag metrics|presets|metric|run|rescore|compare|connect|cache` as a script or CI runs them: the CLI process
 * against the local demo RAG system and a mock judge (no key, no network beyond 127.0.0.1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore, type MockRule, type SavedEvaluation } from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { cliData, runCli, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-eval-cli-');
let server: { httpUrl: string; close(): Promise<void> };
let ws: WorkspaceStore;
const home = () => join(t.dir, 'home');
const cli = (args: string[]) => runCli(args, { home: home() });

const RULES: MockRule[] = [
  { match: 'faithfulness-v1[\\s\\S]*Parking is free', response: JSON.stringify({ reasoning: 'no parking document', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }, { text: 'Parking is free.', verdict: false, reason: 'none' }] }) },
  { match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }] }) },
  { match: 'answer-relevance-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'It answers.', verdict: true, reason: 'on topic' }] }) },
];

interface RunData {
  runId: string;
  collectRunId?: string;
  summary: { total: number; passed: number; failed: number; judgeCostUsd?: number };
  metrics: Array<{ key: string; mean?: number; n: number }>;
  failures: Array<{ class: string; count: number }>;
  gates: Array<{ metric: string; passed: boolean; why: string }>;
  comparison?: { regressions: unknown[] };
}

beforeAll(async () => {
  mkdirSync(home(), { recursive: true });
  // a price for the mock judge, so a cost can be estimated and spent
  writeFileSync(join(home(), 'settings.json'), JSON.stringify({ pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'test' }] }));
  server = await startRagServer({ port: 0, grpcPort: 0 });
  ws = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG eval CLI');
  ws.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(RULES) }] }]);
  ws.saveLibrary('rag-targets', {
    folders: [],
    items: [{ id: 'rag-http', name: 'Clinic HTTP', data: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${server.httpUrl}/query`, json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } } } }],
  });
  const dataset = [
    { id: 'hours', question: 'What time does the clinic open?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'] },
    { id: 'parking', question: 'Is there parking at the clinic?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'] },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');
  const evaluation: SavedEvaluation = { name: 'Clinic RAG', type: 'rag', provider: '', model: '', prompt: '', format: 'text', datasetFormat: 'jsonl', dataset, expectedField: 'expected', evaluators: [{ type: 'token-f1', threshold: 0.3 }], concurrency: 2, retries: 0, target: 'rag-http' };
  ws.saveLibrary('evaluations', { folders: [], items: [{ id: 'ev-rag', name: 'Clinic RAG', data: evaluation }] });
});
afterAll(async () => {
  await server.close();
  ws.close();
  t.cleanup();
});

describe('rag metrics, presets, metric', () => {
  it('metrics prints the catalogue as JSON and as groups for people; a Ragas name finds its metric', async () => {
    const all = cliData<{ count: number; metrics: Array<{ id: string; kind: string }> }>((await cli(['rag', 'metrics', '--json'])).out);
    expect(all.count).toBe(134);
    expect(all.metrics.find((m) => m.id === 'faithfulness')).toMatchObject({ kind: 'judged' });
    const free = cliData<{ count: number }>((await cli(['rag', 'metrics', '--kind', 'deterministic', '--json'])).out);
    expect(free.count).toBe(51);
    const ragas = cliData<{ metrics: Array<{ id: string }> }>((await cli(['rag', 'metrics', '--search', 'LLMContextRecall', '--json'])).out);
    expect(ragas.metrics.map((m) => m.id)[0]).toBe('context-recall');
    const text = await cli(['rag', 'metrics', '--group', 'retrieval-ir']);
    expect(text.out).toMatch(/Retrieval, by ids and rank/);
    expect(text.out).toMatch(/recall@k\s+deterministic/);
  });

  it('presets lists both kinds', async () => {
    const p = cliData<{ metricPresets: Array<{ id: string }>; targetPresets: Array<{ id: string }> }>((await cli(['rag', 'presets', '--json'])).out);
    expect(p.metricPresets.map((x) => x.id)).toContain('rag-triad');
    expect(p.targetPresets.map((x) => x.id)).toContain('langserve');
  });

  it('metric show resolves a Ragas name and its options; an unknown name is a configuration error', async () => {
    const m = cliData<{ id: string; options: Record<string, unknown>; resolvedFrom: string }>((await cli(['rag', 'metric', 'show', 'response_relevancy', '--json'])).out);
    expect(m).toMatchObject({ id: 'answer-relevance', resolvedFrom: 'response_relevancy', options: { mode: 'reverse-questions' } });
    const bad = await cli(['rag', 'metric', 'show', 'nope']);
    expect(bad.status).toBe(2);
  });

  it('metric test --dry-run shows the prompt and sends nothing; a free metric scores at once; a missing input is said', async () => {
    const dry = await cli(['rag', 'metric', 'test', 'faithfulness', '-w', ws.root, '--judge', 'judge/mock-model', '--answer', 'The clinic opens at 8am.', '--context', 'The clinic opens at 8am on weekdays.', '--dry-run']);
    expect(dry.status, dry.err).toBe(0);
    expect(dry.out).toMatch(/Would send faithfulness \(faithfulness-v1\) to Mock judge/);
    expect(dry.out).toMatch(/FAITHFULNESS/);
    const free = cliData<{ result: { score: number; passed: boolean } }>((await cli(['rag', 'metric', 'test', 'recall@1', '-w', ws.root, '--context', 'a text', '--reference-id', 'doc-1', '--json'])).out);
    expect(free.result).toMatchObject({ score: 1, passed: true });
    const missing = cliData<{ missing: Array<{ input: string }> }>((await cli(['rag', 'metric', 'test', 'context-recall-ids', '-w', ws.root, '--answer', 'x', '--context', 'c', '--json'])).out);
    expect(missing.missing).toEqual([expect.objectContaining({ input: 'referenceIds' })]);
  });
});

describe('rag run', () => {
  let first: RunData;
  it('--estimate prints the plan and cost and calls nothing', async () => {
    const r = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'faithfulness,answer-relevance,recall@3', '--judge', 'judge/mock-model', '--estimate', '--json']);
    expect(r.status, r.err).toBe(0);
    const e = cliData<{ samples: number; total: { llmCalls: number }; judge: { model: string }; costUsd: { low: number; high: number }; metrics: Array<{ id: string }> }>(r.out);
    expect(e).toMatchObject({ samples: 2, total: { llmCalls: 4 }, judge: { model: 'mock-model' } });
    expect(e.costUsd!.high).toBeGreaterThan(e.costUsd!.low);
    const text = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'faithfulness', '--judge', 'judge/mock-model', '--estimate']);
    expect(text.out).toMatch(/Judge calls 2/);
    expect(text.out).toMatch(/Cost \$0\.\d+ to/);
  });

  it('without a judge it stops before the first question; an unknown metric is a configuration error too', async () => {
    const r = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'faithfulness']);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/needs a judge model/);
    const u = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'nonsense']);
    expect(u.status).toBe(2);
    expect(u.err).toMatch(/No RAG metric called "nonsense"/);
  });

  it('runs the chosen metrics, gates on the mean (--min) and writes JUnit and HTML', async () => {
    const junit = join(t.dir, 'rag.junit.xml');
    const html = join(t.dir, 'rag.html');
    const r = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'recall@3,faithfulness,answer-relevance,token-f1', '--judge', 'judge/mock-model', '--min', 'recall@3=1', '--min', 'faithfulness=0.7', '--junit', junit, '--html', html, '--json']);
    expect(r.status, r.err + r.out.slice(-600)).toBe(0);
    first = cliData<RunData>(r.out);
    expect(first.summary.total).toBe(2);
    expect(first.metrics.map((m) => m.key)).toEqual(['recall@3', 'faithfulness', 'answer-relevance', 'token-f1']);
    expect(first.metrics.find((m) => m.key === 'faithfulness')!.mean).toBe(0.75);
    expect(first.gates.map((g) => [g.metric, g.passed])).toEqual([['recall@3', true], ['faithfulness', true]]);
    expect(first.failures).toEqual([expect.objectContaining({ class: 'unfaithful', count: 1 })]);
    expect(first.summary.judgeCostUsd).toBeGreaterThan(0);
    expect(readFileSync(junit, 'utf8')).toMatch(/<testsuite/);
    expect(readFileSync(html, 'utf8')).toMatch(/<html/);
  });

  it('a gate that the mean misses fails the run (exit 1) and says which', async () => {
    const r = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'faithfulness', '--judge', 'judge/mock-model', '--min', 'faithfulness=0.9', '--limit', '2']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/gate faithfulness mean 0.75 < 0.9/);
    // and a metric that is not in the run fails its gate: it cannot be assumed to pass
    const absent = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'recall@3', '--min', 'ndcg@k=0.5', '--json']);
    expect(absent.status).toBe(1);
    expect(cliData<RunData>(absent.out).gates[0]!.why).toMatch(/no score in this run/);
  });

  it('--two-phase collects the answers with the free metrics, then judges them: the final run is the re-scored one', async () => {
    const r = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'token-f1,faithfulness', '--judge', 'judge/mock-model', '--two-phase', '--min', 'faithfulness=0.5', '--json']);
    expect(r.status, r.err + r.out.slice(-800)).toBe(0);
    const d = cliData<RunData>(r.out);
    expect(d.collectRunId).toMatch(/^run-/);
    expect(d.runId).not.toBe(d.collectRunId);
    expect(d.metrics.map((m) => m.key)).toEqual(['faithfulness', 'token-f1']);
  });

  it('--baseline compares metric by metric; the same run against itself has no regressions', async () => {
    const r = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'recall@3,faithfulness,answer-relevance,token-f1', '--judge', 'judge/mock-model', '--baseline', first.runId, '--json']);
    expect(r.status, r.err).toBe(0);
    expect(cliData<RunData>(r.out).comparison!.regressions).toEqual([]);
  });

  it('rescore re-uses the stored answers: no RAG call, the verdicts from the cache, a new run', async () => {
    await server.close();
    const r = await cli(['rag', 'rescore', first.runId, '-w', ws.root, '--judge', 'judge/mock-model', '--json']);
    server = await startRagServer({ port: 0, grpcPort: 0 });
    expect(r.status, r.err + r.out).toBe(0);
    const d = cliData<{ runId: string; rescored: number; metrics: Array<{ key: string; mean?: number }>; summary: { judgeCostUsd?: number } }>(r.out);
    expect(d.rescored).toBe(2);
    expect(d.runId).not.toBe(first.runId);
    expect(d.metrics.find((m) => m.key === 'faithfulness')!.mean).toBe(0.75);
    // every verdict was cached: nothing was spent
    expect(d.summary.judgeCostUsd ?? 0).toBe(0);
    const est = cliData<{ cache: { hits: number; of: number; exact: boolean } }>((await cli(['rag', 'rescore', first.runId, '-w', ws.root, '--judge', 'judge/mock-model', '--estimate', '--json'])).out);
    expect(est.cache).toMatchObject({ exact: true });
    expect(est.cache.hits).toBe(est.cache.of);
    const cmp = await cli(['rag', 'compare', d.runId, '-b', first.runId, '-w', ws.root, '--json']);
    expect(cmp.status, cmp.err).toBe(0);
  });
});

describe('rag connect, cache, import', () => {
  it('connect saves a target from a preset with the values given; the question variable stays', async () => {
    const r = await cli(['rag', 'connect', 'openai-compatible', '--name', 'Gateway', '--var', 'ragUrl=http://127.0.0.1:9', '--var', 'ragModel=gpt-test', '--concurrency', '2', '--rpm', '60', '-w', ws.root, '--json']);
    expect(r.status, r.err).toBe(0);
    const d = cliData<{ target: { step: { url: string; json: { model: string } }; limits: object } }>(r.out);
    expect(d.target.step.url).toBe('http://127.0.0.1:9/v1/chat/completions');
    expect(d.target.step.json.model).toBe('gpt-test');
    expect(d.target.limits).toEqual({ concurrency: 2, requestsPerMinute: 60 });
    const list = cliData<Array<{ name: string; problems: string[] }>>((await cli(['rag', 'targets', '-w', ws.root, '--json'])).out);
    expect(list.find((x) => x.name === 'Gateway')!.problems).toEqual([]);
    const bad = await cli(['rag', 'connect', 'no-such-preset', '--name', 'X', '-w', ws.root]);
    expect(bad.status).toBe(2);
  });

  it('cache clear empties the judge cache', async () => {
    const r = cliData<{ cleared: number }>((await cli(['rag', 'cache', 'clear', '-w', ws.root, '--json'])).out);
    expect(r.cleared).toBeGreaterThan(0);
    expect(cliData<{ cleared: number }>((await cli(['rag', 'cache', 'clear', '-w', ws.root, '--json'])).out).cleared).toBe(0);
  });

  it('import reads BEIR (queries, qrels, corpus), NVIDIA retriever data and promptfoo tests', async () => {
    writeFileSync(join(t.dir, 'queries.jsonl'), '{"_id":"q1","text":"What time?"}\n');
    writeFileSync(join(t.dir, 'qrels.tsv'), 'query-id\tcorpus-id\tscore\nq1\td1\t1\n');
    writeFileSync(join(t.dir, 'corpus.jsonl'), '{"_id":"d1","title":"Hours","text":"Opens at 8am."}\n');
    const beir = cliData<{ from: string; records: Array<Record<string, unknown>> }>((await cli(['rag', 'import', join(t.dir, 'queries.jsonl'), '--from', 'beir', '--qrels', join(t.dir, 'qrels.tsv'), '--corpus', join(t.dir, 'corpus.jsonl'), '--json'])).out);
    expect(beir.records[0]).toMatchObject({ question: 'What time?', reference_ids: ['d1'], reference_contexts: ['Hours\nOpens at 8am.'] });
    const noQrels = await cli(['rag', 'import', join(t.dir, 'queries.jsonl'), '--from', 'beir']);
    expect(noQrels.status).toBe(2);
    writeFileSync(join(t.dir, 'nv.json'), JSON.stringify([{ query: 'q', pos_doc: [{ id: 'p1', text: 'pos' }] }]));
    expect(cliData<{ from: string; count: number }>((await cli(['rag', 'import', join(t.dir, 'nv.json'), '--json'])).out)).toMatchObject({ from: 'nvidia', count: 1 });
    writeFileSync(join(t.dir, 'promptfooconfig.yaml'), 'tests:\n  - vars: { query: "When?" }\n    assert:\n      - { type: contains, value: "8am" }\n');
    const pf = cliData<{ from: string; records: Array<Record<string, unknown>> }>((await cli(['rag', 'import', join(t.dir, 'promptfooconfig.yaml'), '--json'])).out);
    expect(pf).toMatchObject({ from: 'promptfoo', records: [{ question: 'When?', reference: '8am' }] });
  });
});
