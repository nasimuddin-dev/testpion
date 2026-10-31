/**
 * Which document mattered? (R-11) The bot is asked again for one sample with the documents it retrieved and without each in turn, on the
 * local demo RAG system, which answers from the documents it is given. No judge, no network beyond 127.0.0.1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { MemorySecretStore, WorkspaceStore, ablateSample, ablationInfo, acceptsDocuments, createEngineContext, defaultSettings, runRagEvaluation, runResults, saveRagTarget, type SavedEvaluation } from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { cliData, runCli, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-ablate-');
let server: { httpUrl: string; close(): Promise<void> };
let store: WorkspaceStore;
let runId: string;
let resultId: string;
const ctx = () => createEngineContext({ store, secrets: new MemorySecretStore(), settings: defaultSettings() });

const mapping = { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id' } };
const evaluation = (target: string): SavedEvaluation => ({
  name: `Ablate ${target}`,
  type: 'rag',
  provider: '',
  model: '',
  prompt: '',
  format: 'text',
  datasetFormat: 'jsonl',
  dataset: JSON.stringify({ id: 'hours', question: 'What time does the clinic open?', reference: 'The clinic opens at 8am on weekdays and 9am on Saturdays.', reference_ids: ['doc-1'] }),
  expectedField: 'expected',
  evaluators: [{ type: 'recall@3', threshold: 1 }],
  concurrency: 1,
  retries: 0,
  target,
});

beforeAll(async () => {
  server = await startRagServer({ port: 0, grpcPort: 0 });
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'Ablate');
  saveRagTarget(store, { name: 'Takes documents', target: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${server.httpUrl}/query`, json: { question: '{{question}}', documents: '{{documents}}' } }, mapping } });
  saveRagTarget(store, { name: 'Retrieves its own', target: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${server.httpUrl}/query`, json: { question: '{{question}}' } }, mapping } });
  store.saveLibrary('evaluations', { folders: [], items: [{ id: 'ev-a', name: 'Ablate Takes documents', data: evaluation('Takes documents') }, { id: 'ev-b', name: 'Ablate Retrieves its own', data: evaluation('Retrieves its own') }] });
  const out = await runRagEvaluation({ store, makeContext: ctx, evaluation: { ...evaluation('Takes documents'), name: 'Ablate Takes documents' }, concurrency: 1 });
  runId = out.runId;
  for await (const r of runResults(store, runId)) resultId = r.id;
}, 120_000);
afterAll(async () => {
  await server.close();
  store.close();
  t.cleanup();
});

describe('which document mattered', () => {
  it('knows whether a bot takes documents from its request', () => {
    expect(acceptsDocuments({ step: { json: { question: '{{question}}', documents: '{{documents}}' } } })).toBe(true);
    expect(acceptsDocuments({ step: { json: { docs: '{{ document_texts }}' } } })).toBe(true);
    expect(acceptsDocuments({ step: { json: { question: '{{question}}' } } })).toBe(false);
  });

  it('asks again without each document and names the load-bearing one', async () => {
    const info = await ablationInfo(store, { run: runId, resultId });
    expect(info).toMatchObject({ possible: true, skipped: 0 });
    const calls = info.calls;
    const c = ctx();
    try {
      const a = await ablateSample(store, c, { run: runId, resultId });
      expect(a.calls).toBe(calls);
      expect(a.question).toBe('What time does the clinic open?');
      expect(a.documents.length).toBeGreaterThanOrEqual(1);
      const hours = a.documents.find((d) => d.id === 'doc-1')!;
      expect(hours.loadBearing).toBe(true);
      expect(hours.alike).toBeLessThan(0.8);
      expect(a.documents.filter((d) => d.loadBearing).map((d) => d.id)).toEqual(['doc-1']);
      expect(a.text).toMatch(/^Without doc-1 the answer changes/);
      expect(a.answer).toMatch(/8am/);
      // the answer got farther from the reference without the document that holds it
      expect(hours.towardsReference).toBeLessThan(0);
    } finally {
      await c.dispose();
    }
  }, 120_000);

  it('says what to add when the bot retrieves its own documents', async () => {
    const out = await runRagEvaluation({ store, makeContext: ctx, evaluation: { ...evaluation('Retrieves its own'), name: 'Ablate Retrieves its own' }, concurrency: 1 });
    let id = '';
    for await (const r of runResults(store, out.runId)) id = r.id;
    expect(await ablationInfo(store, { run: out.runId, resultId: id })).toMatchObject({ possible: false, reason: expect.stringMatching(/does not take documents/) });
    const c = ctx();
    try {
      await expect(ablateSample(store, c, { run: out.runId, resultId: id })).rejects.toThrow(/does not take documents.*\{\{documents\}\}/);
    } finally {
      await c.dispose();
    }
  }, 120_000);

  it('is the same from the command line, and refuses a bot that takes no documents', async () => {
    const env = { ...process.env, TESTPION_HOME: join(t.dir, 'home') };
    const ok = await runCli(['rag', 'ablate', runId, '--result', resultId, '-w', store.root, '--json'], { env });
    expect(ok.status).toBe(0);
    const a = cliData<{ documents: Array<{ id: string; loadBearing: boolean }>; text: string }>(ok.out);
    expect(a.documents.filter((d) => d.loadBearing).map((d) => d.id)).toEqual(['doc-1']);
    const words = await runCli(['rag', 'ablate', runId, '--result', resultId, '-w', store.root], { env });
    expect(words.out).toMatch(/calls to the bot/);
    expect(words.out).toMatch(/load-bearing\s+doc-1/);
    const out = await runRagEvaluation({ store, makeContext: ctx, evaluation: { ...evaluation('Retrieves its own'), name: 'Ablate Retrieves its own' }, concurrency: 1 });
    let id = '';
    for await (const r of runResults(store, out.runId)) id = r.id;
    const bad = await runCli(['rag', 'ablate', out.runId, '--result', id, '-w', store.root], { env });
    expect(bad.status).toBe(2);
    expect(bad.err + bad.out).toMatch(/does not take documents/);
  }, 120_000);
});
