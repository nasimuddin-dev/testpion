/**
 * The gates of a saved RAG evaluation: `gates:` in the evaluation, read by `testpion rag run` (a `--min` for the same metric
 * wins), by a monitor of the evaluation and by the authoring that now writes them. Free metrics only, against the local demo
 * RAG system: no model, no key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemorySecretStore, WorkspaceStore, createEngineContext, defaultSettings, executeMonitor, mergeGates, type Monitor, type SavedEvaluation } from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { cliData, runCli, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-gates-');
let server: { httpUrl: string; close(): Promise<void> };
let ws: WorkspaceStore;
const home = () => join(t.dir, 'home');
const cli = (args: string[]) => runCli(args, { home: home() });

const evaluation = (gates?: Record<string, number>): SavedEvaluation => ({
  name: 'Clinic gates',
  type: 'rag',
  provider: '',
  model: '',
  prompt: '{{question}}',
  format: 'text',
  datasetFormat: 'jsonl',
  dataset: [{ id: 'hours', question: 'What time does the clinic open?', reference: 'The clinic opens at 8am on weekdays.' }].map((r) => JSON.stringify(r)).join('\n'),
  expectedField: 'reference',
  evaluators: [{ type: 'token-f1', threshold: 0.01 }],
  concurrency: 1,
  retries: 0,
  target: 'rag-http',
  ...(gates ? { gates } : {}),
});

beforeAll(async () => {
  mkdirSync(home(), { recursive: true });
  server = await startRagServer({ port: 0, grpcPort: 0 });
  ws = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG gates');
  ws.saveLibrary('rag-targets', {
    folders: [],
    items: [{ id: 'rag-http', name: 'Clinic HTTP', data: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${server.httpUrl}/query`, json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } } } }],
  });
  ws.saveLibrary('evaluations', { folders: [], items: [{ id: 'ev-open', name: 'Clinic gates', data: evaluation() }, { id: 'ev-gated', name: 'Clinic gated', data: { ...evaluation({ 'token-f1': 0.999 }), name: 'Clinic gated' } }] });
}, 60_000);
afterAll(async () => {
  await server.close();
  ws.close();
  t.cleanup();
});

describe('mergeGates', () => {
  it('a caller’s mark for the same metric replaces the evaluation’s, whatever name it is given by', () => {
    expect(mergeGates({ faithfulness: 0.8, 'recall@k': 0.7 }, { 'recall@k': 0.5 })).toEqual({ faithfulness: 0.8, 'recall@k': 0.5 });
    // faithfulness and its Ragas-style alias are one metric
    expect(mergeGates({ faithfulness: 0.8 }, { groundedness: 0.6 })).toEqual({ groundedness: 0.6 });
    expect(mergeGates(undefined, { 'token-f1': 0.4 })).toEqual({ 'token-f1': 0.4 });
    expect(mergeGates({ a: 1, b: Number.NaN as unknown as number }, undefined)).toEqual({ a: 1 });
  });
});

describe('testpion rag run with the evaluation’s gates', () => {
  it('an evaluation without gates passes; with a gate the mean has to reach, the run exits 1 and the JSON says which gate', async () => {
    const open = await cli(['rag', 'run', 'Clinic gates', '-w', ws.root, '--json']);
    expect(open.status, open.err).toBe(0);
    const gated = await cli(['rag', 'run', 'Clinic gated', '-w', ws.root, '--json']);
    expect(gated.status, gated.err).toBe(1);
    const out = cliData<{ gates: Array<{ metric: string; min: number; passed: boolean }> }>(gated.out);
    expect(out.gates).toMatchObject([{ metric: 'token-f1', min: 0.999, passed: false }]);
  });

  it('a --min for the same metric replaces the saved mark', async () => {
    const r = await cli(['rag', 'run', 'Clinic gated', '-w', ws.root, '--min', 'token-f1=0.01', '--json']);
    expect(r.status, r.err).toBe(0);
    expect(cliData<{ gates: Array<{ min: number; passed: boolean }> }>(r.out).gates).toMatchObject([{ min: 0.01, passed: true }]);
  });
});

describe('a monitor of the evaluation', () => {
  const run = (m: Monitor) =>
    executeMonitor({
      store: ws,
      monitor: m,
      trigger: 'manual',
      context: (o) => createEngineContext({ store: ws, secrets: new MemorySecretStore(), settings: defaultSettings(), environment: o.environment, aiSurface: 'cli' }),
    });
  const base = (over: Partial<Monitor> = {}): Monitor => ({ id: 'mon-gates', name: 'Clinic gates monitor', evaluation: 'Clinic gated', everyMinutes: 60, enabled: true, ...over });

  it('is judged by the evaluation’s gates when it has none of its own', async () => {
    const r = await run(base());
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/token-f1 mean [\d.]+ < 0.999/);
  }, 60_000);

  it('the monitor’s own mark for the same metric wins', async () => {
    const r = await run(base({ gates: { 'token-f1': 0.01 } }));
    expect(r.status).toBe('passed');
  }, 60_000);

  it('an evaluation without gates and a monitor without gates judge the samples, as before', async () => {
    const r = await run(base({ evaluation: 'Clinic gates' }));
    expect(r.status).toBe('passed');
  }, 60_000);
});
