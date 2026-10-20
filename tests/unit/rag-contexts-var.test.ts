/**
 * `contexts: "{{var}}"` in a rag test: the retrieved contexts come from a variable (a dataset column holding a list, a JSON
 * array or lines of text) when the test runs, and a CSV cell with a list works as a contexts column.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { MemorySecretStore, WorkspaceStore, createEngineContext, defaultSettings, docsOf, evaluationTests, normalizeTest, runTests, type SavedEvaluation, type TestResult } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

describe('docsOf', () => {
  it('a list of texts or objects, a JSON array as text, lines, semicolons', () => {
    expect(docsOf(['a', 'b'])).toEqual([{ id: 'doc-1', text: 'a' }, { id: 'doc-2', text: 'b' }]);
    expect(docsOf([{ id: 'x', text: 'a', score: 0.5 }])).toEqual([{ id: 'x', text: 'a', score: 0.5, source: undefined }]);
    expect(docsOf('[{"id":"k","content":"c"},"plain"]')).toMatchObject([{ id: 'k', text: 'c' }, { id: 'doc-2', text: 'plain' }]);
    expect(docsOf('line one\nline two')).toHaveLength(2);
    expect(docsOf('a;b;c')).toHaveLength(3);
    expect(docsOf(undefined)).toEqual([]);
    expect(docsOf('')).toEqual([]);
  });
});

describe('the loader', () => {
  it('a {{variable}} is kept to fill when the test runs; a plain string or a list is read now', () => {
    expect(normalizeTest({ type: 'rag', question: 'q', contexts: '{{docs}}' })).toMatchObject({ contexts: [], contextsFrom: '{{docs}}' });
    expect(normalizeTest({ type: 'rag', question: 'q', contexts: 'one\ntwo' })).toMatchObject({ contexts: [{ id: 'doc-1', text: 'one' }, { id: 'doc-2', text: 'two' }] });
    expect(normalizeTest({ type: 'rag', question: 'q', contexts: [{ id: 'a', text: 'A' }] })).not.toHaveProperty('contextsFrom');
  });
});

describe('a run', () => {
  const t = tempDir('tp-ctx-');
  const store = WorkspaceStore.create(join(t.dir, 'ws'), 'ctx');
  const evaluation = (dataset: string, format: SavedEvaluation['datasetFormat']): SavedEvaluation => ({
    name: 'Ctx',
    type: 'rag',
    provider: '',
    model: '',
    prompt: '',
    format: 'text',
    datasetFormat: format,
    dataset,
    expectedField: 'expected',
    evaluators: [{ type: 'citation', required: false }],
    concurrency: 1,
    retries: 0,
  });

  it('contexts from a dataset column reach the metrics (a list in JSONL, a JSON array in a CSV cell)', async () => {
    const ctx = createEngineContext({ store, secrets: new MemorySecretStore(), settings: defaultSettings() });
    try {
      for (const [dataset, format] of [
        ['{"question":"q","answer":"A [doc-1]","contexts":[{"id":"doc-1","text":"first"},{"id":"doc-2","text":"second"}]}', 'jsonl'],
        ['question,answer,contexts\nq,A [doc-1],"[{""id"":""doc-1"",""text"":""first""},{""id"":""doc-2"",""text"":""second""}]"', 'csv'],
      ] as const) {
        const results: TestResult[] = [];
        await runTests({ name: 'ctx', tests: evaluationTests(evaluation(dataset, format)), services: ctx.services, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
        expect(results[0]!.metadata).toMatchObject({ rag: { documentIds: ['doc-1', 'doc-2'] } });
        expect(results[0]!.checks[0]).toMatchObject({ type: 'citation', passed: true });
      }
    } finally {
      await ctx.dispose();
      store.close();
      t.cleanup();
    }
  });
});
