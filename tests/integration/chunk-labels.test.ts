import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, MemorySecretStore, createEngineContext, ensureBotSample, runRagEvaluation, addRightDocuments, chunkLabels, setChunkLabel, exportChunkLabels, EVALUATIONS_LIBRARY, type SavedEvaluation } from '../../packages/core/src/index.js';

/** R-4: your verdict on each retrieved document, and the relevant ones added to the right documents of the question. */
const dir = mkdtempSync(join(tmpdir(), 'tp-chunk-labels-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'CL');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const ctx = () => createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never });

describe('chunk labels', () => {
  it('are kept with the run, change, clear, and export', async () => {
    const made = ensureBotSample(store);
    const out = await runRagEvaluation({ store, makeContext: ctx, evaluation: made.evaluation, concurrency: 2 });
    const hours = `${made.evaluation.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}:hours`;
    expect(chunkLabels(store, out.runId)).toEqual({});
    setChunkLabel(store, { run: out.runId, resultId: hours, doc: 'doc-4', label: 'relevant' });
    setChunkLabel(store, { run: out.runId, resultId: hours, doc: 'doc-1', label: 'partly' });
    setChunkLabel(store, { run: out.runId, resultId: hours, doc: 'doc-1', label: 'not' });
    expect(Object.fromEntries(Object.entries(chunkLabels(store, out.runId)[hours]!).map(([d, e]) => [d, e.label]))).toEqual({ 'doc-4': 'relevant', 'doc-1': 'not' });
    expect(() => setChunkLabel(store, { run: out.runId, resultId: hours, doc: 'x', label: 'maybe' as never })).toThrow(/relevant, partly or not/);
    expect(await exportChunkLabels(store, out.runId)).toEqual([{ case: 'hours', relevant: ['doc-4'], partly: [], not: ['doc-1'] }]);
    setChunkLabel(store, { run: out.runId, resultId: hours, doc: 'doc-1', label: null });
    expect(Object.keys(chunkLabels(store, out.runId)[hours]!)).toEqual(['doc-4']);

    // the relevant document is added to the right documents of its question in the saved test cases
    const added = await addRightDocuments(store, { run: out.runId, resultId: hours });
    expect(added).toMatchObject({ evaluation: made.evaluation.name, record: 'hours', added: ['doc-4'], already: [] });
    const rec = (name: string) => JSON.parse(store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY).items.find((i) => i.name === made.evaluation.name)!.data.dataset.split('\n').find((l) => JSON.parse(l).id === name)!);
    expect(rec('hours').reference_ids).toEqual(['doc-1', 'doc-4']);
    // again: nothing more to add
    expect((await addRightDocuments(store, { run: out.runId, resultId: hours })).text).toBe('doc-4 is already among the right documents of "hours".');
    // a question with nothing marked relevant says so
    await expect(addRightDocuments(store, { run: out.runId, resultId: hours.replace('hours', 'cancel') })).rejects.toThrow(/No document is marked relevant/);
    // clearing every label removes the result's entry
    setChunkLabel(store, { run: out.runId, resultId: hours, doc: 'doc-4', label: null });
    expect(chunkLabels(store, out.runId)[hours]).toBeUndefined();
  }, 120_000);
});
