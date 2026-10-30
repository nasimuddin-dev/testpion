import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, MemorySecretStore, createEngineContext, ensureBotSample, evalReport, findRagTarget, mappingProblems, applyMapping, responseOf, runRagEvaluation, saveRagTarget, BOT_SAMPLE_TARGET } from '../../packages/core/src/index.js';

/** R-6: what is under test. The bot reports its corpus version and top k; the mapping names them; a run records them; the report says when one changed. */
describe('the meta mapping', () => {
  it('reads named values from the response and checks their paths', () => {
    const r = responseOf({ body: { answer: 'a', meta: { corpus: 'v12', top_k: 5 }, long: 'x'.repeat(200) }, text: '' });
    expect(applyMapping(r, { answer: '$.answer', meta: { 'Corpus version': '$.meta.corpus', 'Top k': '$.meta.top_k', Missing: '$.meta.nope' } }).meta).toEqual({ 'Corpus version': 'v12', 'Top k': '5' });
    expect(applyMapping(r, { answer: '$.answer' }).meta).toBeUndefined();
    expect(applyMapping(r, { answer: '$.answer', meta: { Long: '$.long' } }).meta!.Long).toHaveLength(120);
    expect(mappingProblems({ answer: '$.answer', meta: { Bad: 'meta.corpus' } })).toEqual(['meta Bad must be a JSONPath starting with $ (got "meta.corpus").']);
  });
});

describe('the report says what is under test and when it changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-undertest-'));
  const store = WorkspaceStore.create(join(dir, 'ws'), 'UT');
  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const ctx = () => createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never });

  it('records the corpus version of every sample, and flags it when the next run reports another', async () => {
    const made = ensureBotSample(store);
    const file = join(dir, 'ws', 'mocks', 'clinic-bot.mcp-mock.yaml');
    const withCorpus = (v: string) => writeFileSync(file, readFileSync(file, 'utf8').replace(/ {10}meta: \{[^\n]*\}\n/g, '').replace(/( {10}sources:\n)/g, `          meta: { corpus: ${v}, top_k: 4 }\n$1`));
    const target = findRagTarget(store, BOT_SAMPLE_TARGET);
    const { id: _i, name: _n, ...t } = target;
    saveRagTarget(store, { id: target.id, name: BOT_SAMPLE_TARGET, target: { ...t, mapping: { ...t.mapping, meta: { 'Corpus version': '$.meta.corpus', 'Top k': '$.meta.top_k' } } } });
    withCorpus('v1');
    const first = await runRagEvaluation({ store, makeContext: ctx, evaluation: made.evaluation, concurrency: 2 });
    const a = await evalReport(store, { run: first.runId });
    expect(a.underTest).toEqual([{ name: 'Corpus version', values: ['v1'], changed: false }, { name: 'Top k', values: ['4'], changed: false }]);
    expect(a.text).toContain('Under test: Corpus version v1, Top k 4.');
    withCorpus('v2');
    const second = await runRagEvaluation({ store, makeContext: ctx, evaluation: made.evaluation, concurrency: 2 });
    const b = await evalReport(store, { run: second.runId });
    expect(b.underTest).toEqual([{ name: 'Corpus version', values: ['v2'], previous: ['v1'], changed: true }, { name: 'Top k', values: ['4'], previous: ['4'], changed: false }]);
    expect(b.text).toContain('Under test: Corpus version v2 (was v1), Top k 4.');
  }, 120_000);
});
