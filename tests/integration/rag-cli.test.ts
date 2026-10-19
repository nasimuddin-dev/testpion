/**
 * `testpion rag targets|probe|import|export` and `eval run` of a RAG evaluation, as a script or CI runs them: the CLI
 * process against the local demo RAG system (examples/servers/rag-server.mjs) and a mock judge. No key, no network
 * beyond 127.0.0.1. (The CLI runs asynchronously: this process serves the demo system.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore, type MockRule, type SavedEvaluation } from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { cliData, runCli, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-cli-');
let server: { httpUrl: string; close(): Promise<void> };
let ws: WorkspaceStore;
const home = () => join(t.dir, 'home');
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { home: home(), env });

const RULES: MockRule[] = [
  { match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1] "opens at 8am"' }] }) },
  { match: 'answer-relevance-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'It answers.', verdict: true, reason: 'on topic' }] }) },
];

beforeAll(async () => {
  mkdirSync(home(), { recursive: true });
  server = await startRagServer({ port: 0, grpcPort: 0 });
  ws = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG CLI');
  ws.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(RULES) }] }]);
  ws.saveLibrary('rag-targets', {
    folders: [],
    items: [
      { id: 'rag-http', name: 'Clinic HTTP', data: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${server.httpUrl}/query`, json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } } } },
      { id: 'rag-bad', name: 'Unmapped', data: { protocol: 'http', step: { type: 'http', url: `${server.httpUrl}/query` }, mapping: { answer: '' } } },
    ],
  });
  const evaluation: SavedEvaluation = {
    name: 'Clinic RAG',
    type: 'rag',
    provider: '',
    model: '',
    prompt: '',
    format: 'text',
    datasetFormat: 'jsonl',
    dataset: '{"id":"hours","question":"What time does the clinic open?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"]}',
    expectedField: 'expected',
    evaluators: [{ type: 'token-f1', threshold: 0.5 }, { type: 'context-recall-ids' }, { type: 'rag-faithfulness' }],
    concurrency: 1,
    retries: 0,
    target: 'rag-http',
  };
  ws.saveLibrary('evaluations', { folders: [], items: [{ id: 'ev-rag', name: 'Clinic RAG', data: evaluation }] });
});
afterAll(async () => {
  await server.close();
  ws.close();
  t.cleanup();
});

describe('testpion rag', () => {
  it('targets lists them with what stops one from being called', async () => {
    const r = await cli(['rag', 'targets', '-w', ws.root, '--json']);
    expect(r.status).toBe(0);
    const list = cliData<Array<{ name: string; protocol: string; problems: string[]; mapped: string }>>(r.out);
    expect(list.map((x) => x.name)).toEqual(['Clinic HTTP', 'Unmapped']);
    expect(list[0]).toMatchObject({ protocol: 'http', problems: [], mapped: 'answer $.answer · contexts $.sources[*]' });
    expect(list[1]!.problems[0]).toMatch(/no answer path/);
  });

  it('probe asks the system one question and prints the sample', async () => {
    const r = await cli(['rag', 'probe', 'Clinic HTTP', 'What time does the clinic open?', '-w', ws.root, '--json']);
    expect(r.status).toBe(0);
    const p = cliData<{ question: string; status: number; sample: { answer: string; contexts: Array<{ id: string; score: number }> }; response: { kind: string; text?: string } }>(r.out);
    expect(p.status).toBe(200);
    expect(p.sample.answer).toBe('The clinic opens at 8am on weekdays and 9am on Saturdays.');
    expect(p.sample.contexts[0]).toMatchObject({ id: 'doc-1' });
    expect(p.response.kind).toBe('json');
    // for people
    const text = await cli(['rag', 'probe', 'Clinic HTTP', 'What time does the clinic open?', '-w', ws.root]);
    expect(text.out).toMatch(/Answer\s+The clinic opens at 8am/);
    expect(text.out).toMatch(/doc-1/);
  });

  it('probe works without a mapping (it is how a mapping is made) and names an unknown target', async () => {
    const r = await cli(['rag', 'probe', 'Unmapped', 'clinic', '-w', ws.root, '--json']);
    expect(r.status).toBe(0);
    expect(cliData<{ sample: { answer: string; warnings: string[] } }>(r.out).sample).toMatchObject({ answer: '' });
    const missing = await cli(['rag', 'probe', 'Nope', 'q', '-w', ws.root]);
    expect(missing.status).toBe(2);
    expect(missing.err).toMatch(/No RAG target "Nope"/);
  });

  it('import reads a Ragas file as data and export writes it back as Ragas or DeepEval', async () => {
    const file = join(t.dir, 'ragas.jsonl');
    writeFileSync(file, '{"user_input":"q1","reference":"a1","reference_context_ids":["d1"],"retrieved_contexts":["c1"],"response":"r1"}\n');
    const imp = await cli(['rag', 'import', file, '--json']);
    expect(imp.status).toBe(0);
    expect(cliData<{ from: string; count: number; records: Array<Record<string, unknown>> }>(imp.out)).toMatchObject({ from: 'ragas', count: 1, records: [{ question: 'q1', reference: 'a1', reference_ids: ['d1'], answer: 'r1' }] });
    const out = join(t.dir, 'own.jsonl');
    await cli(['rag', 'import', file, '-o', out]);
    expect(JSON.parse(readFileSync(out, 'utf8').trim())).toMatchObject({ question: 'q1', reference: 'a1' });
    const exp = await cli(['rag', 'export', out, '--to', 'deepeval', '--json']);
    expect(cliData<{ records: Array<Record<string, unknown>> }>(exp.out).records[0]).toMatchObject({ input: 'q1', expected_output: 'a1', actual_output: 'r1' });
    const bad = await cli(['rag', 'export', 'no-such-file.jsonl', '--to', 'ragas']);
    expect(bad.status).toBe(2);
  });
});

describe('eval run of a RAG evaluation', () => {
  it('without a judge it stops before the first question and says what to configure', async () => {
    const r = await cli(['eval', 'run', 'Clinic RAG', '-w', ws.root, '-q']);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/needs a judge model, and none is set up/);
    expect(r.err).toMatch(/--judge <provider>\/<model>/);
    expect(r.err).toMatch(/TESTPION_AI_PROVIDER/);
  });

  it('with --judge it runs, scores, and a second run is answered from the cache', async () => {
    const first = await cli(['eval', 'run', 'Clinic RAG', '-w', ws.root, '--judge', 'judge/mock-model', '-q', '-r', 'json', '-o', join(t.dir, 'out1')]);
    expect(first.status, first.err + first.out).toBe(0);
    const results = readFileSync(join(t.dir, 'out1', 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { status: string; checks: Array<{ type: string; score?: number; metadata?: { judge?: { cached: boolean } } }> });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.checks.map((c) => c.type)).toEqual(['token-f1', 'context-recall-ids', 'rag-faithfulness']);
    expect(results[0]!.checks[2]!.metadata?.judge?.cached).toBe(false);
    const second = await cli(['eval', 'run', 'Clinic RAG', '-w', ws.root, '--judge', 'judge/mock-model', '-q', '-r', 'json', '-o', join(t.dir, 'out2')]);
    expect(second.status).toBe(0);
    const again = JSON.parse(readFileSync(join(t.dir, 'out2', 'results.jsonl'), 'utf8').trim()) as { checks: Array<{ metadata?: { judge?: { cached: boolean } } }> };
    expect(again.checks[2]!.metadata?.judge?.cached).toBe(true);
    const usage = await cli(['ai', 'usage', '-w', ws.root, '--json']);
    const u = cliData<{ byTask: Array<{ task: string; calls: number }> }>(usage.out);
    expect(u.byTask.find((x) => x.task === 'rag-judge')?.calls).toBe(1);
  });

  it('list shows the target of a RAG evaluation', async () => {
    const r = await cli(['eval', 'list', '-w', ws.root, '--json']);
    expect(cliData<Array<{ name: string; target?: string }>>(r.out)[0]).toMatchObject({ name: 'Clinic RAG', target: 'rag-http' });
  });

});
