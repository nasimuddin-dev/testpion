/** Evaluation authoring, the deterministic parts: which inputs a dataset and a target supply, which metrics can run, and how a plan becomes an evaluation. */
import { describe, expect, it } from 'vitest';
import { buildEvaluation, catalogueContext, catalogueFor, freeName, sampleOfRecord, sliceRecords, suppliedInputs, type AuthorLocal, type AuthorPlan } from '../../packages/core/src/index.js';

const TARGET = { id: 'rag-1', name: 'Clinic', protocol: 'http' as const, step: {}, mapping: { answer: '$.a', contexts: '$.s', context: { text: '$.t', id: '$.id' } } };
const local = (records: Array<Record<string, unknown>>, over: Partial<AuthorLocal> = {}): AuthorLocal => ({
  target: TARGET,
  dataset: { name: 'd.jsonl', records, total: records.length },
  existing: [],
  inputs: suppliedInputs(records, TARGET),
  ...over,
});

describe('what the data supplies', () => {
  it('reads the spellings of TestPion, Ragas and DeepEval records', () => {
    expect(sampleOfRecord({ user_input: 'q', reference: 'r', reference_context_ids: ['a'], retrieved_contexts: ['t'], response: 'x' })).toMatchObject({ question: 'q', reference: 'r', referenceIds: ['a'], answer: 'x', contexts: [{ id: 'doc-1', text: 't' }] });
    expect(sampleOfRecord({ input: 'q', expected_output: 'r', actual_output: 'x' })).toMatchObject({ question: 'q', reference: 'r', answer: 'x' });
  });

  it('the dataset supplies what its records hold; the target supplies the answer, latency and (when mapped) contexts', () => {
    const s = suppliedInputs([{ question: 'q', reference: 'r' }], TARGET);
    expect(s).toMatchObject({ question: 'dataset', reference: 'dataset', answer: 'target', contexts: 'target', latency: 'target' });
    expect(s.referenceIds).toBeUndefined();
    expect(s.scores).toBeUndefined();
    // a target that maps no contexts supplies none
    expect(suppliedInputs([{ question: 'q' }], { mapping: { answer: '$.a' } }).contexts).toBeUndefined();
  });

  it('a metric is runnable only with all its inputs, and the catalogue says what is missing', () => {
    const rows = catalogueFor(suppliedInputs([{ question: 'q', reference: 'r' }], TARGET));
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by('token-f1')).toMatchObject({ runnable: true });
    expect(by('recall@k')).toMatchObject({ runnable: false });
    expect(by('recall@k').missing!.join(' ')).toMatch(/gold chunk ids/);
    const ctx = catalogueContext(rows);
    expect(ctx.metrics.every((m) => m.runnable)).toBe(true);
    expect(ctx.notRunnable.find((m) => m.id === 'recall@k')).toBeTruthy();
  });
});

describe('the slice', () => {
  const records = Array.from({ length: 10 }, (_, i) => ({ id: String(i), question: `q${i}`, tags: i % 2 ? ['odd'] : ['even'] }));
  it('tags, every n-th and the limit, in that order; an empty tag match falls back to everything, with a note', () => {
    const notes: string[] = [];
    expect(sliceRecords(records, { tags: ['odd'], limit: 2 }, notes).map((r) => r.id)).toEqual(['1', '3']);
    expect(sliceRecords(records, { every: 3 }, notes).map((r) => r.id)).toEqual(['0', '3', '6', '9']);
    expect(sliceRecords(records, { tags: ['none'], limit: 1 }, notes).map((r) => r.id)).toEqual(['0']);
    expect(notes.join(' ')).toMatch(/No record has the tag/);
  });
  it('caps what is stored inside the evaluation', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ id: String(i), question: 'q' }));
    const notes: string[] = [];
    expect(sliceRecords(many, { limit: 1000 }, notes)).toHaveLength(300);
    expect(notes[0]).toMatch(/at most 300/);
  });
});

describe('a plan becomes an evaluation', () => {
  const rows = [{ id: 'a', question: 'q', reference: 'r', reference_ids: ['d1'], tags: ['x'] }];
  const plan = (p: Partial<AuthorPlan>): AuthorPlan => ({ name: 'N', metrics: [{ id: 'token-f1' }], ...p });

  it('uses the metric’s own default mark when the plan gives none, and puts options and the @k column name in the evaluator', () => {
    const b = buildEvaluation(plan({ metrics: [{ id: 'token-f1' }, { id: 'recall@k', options: { k: 5 }, threshold: 0.6 }] }), local(rows), { supplied: local(rows).inputs });
    expect(b.evaluation.evaluators).toMatchObject([{ type: 'token-f1', threshold: 0.5 }, { type: 'recall@k', k: 5, threshold: 0.6, name: 'recall@5' }]);
    expect(b.notes).toEqual([]);
  });

  it('two modes of one metric are two columns; the same column twice is dropped', () => {
    const b = buildEvaluation(plan({ metrics: [{ id: 'recall@k', options: { k: 3 } }, { id: 'recall@k', options: { k: 5 } }, { id: 'recall@k', options: { k: 3 } }] }), local(rows), { supplied: local(rows).inputs });
    expect(b.evaluation.evaluators.map((e) => e.name)).toEqual(['recall@3', 'recall@5']);
    expect(b.notes.join(' ')).toMatch(/second recall@3/);
  });

  it('judge options map onto the saved evaluation; the person’s judge wins; a share outside 0..1 is refused with a note', () => {
    const b = buildEvaluation(plan({ judge: { provider: 'a', model: 'm', samplingShare: 1.5, shortCircuit: true, maxCostUsd: 2, maxCalls: 50 } }), local(rows, { judge: { provider: 'mine', model: 'big' } }), { supplied: local(rows).inputs });
    expect(b.evaluation.judge).toEqual({ provider: 'mine', model: 'big', shortCircuit: true });
    expect(b.evaluation).toMatchObject({ maxJudgeCostUsd: 2, maxJudgeCalls: 50 });
    expect(b.notes.join(' ')).toMatch(/judged share 1.5/);
  });

  it('gates survive only for metrics the evaluation runs, on a sane scale; they come back as --min flags', () => {
    const b = buildEvaluation(plan({ metrics: [{ id: 'token-f1' }], gates: { 'token-f1': 0.4, faithfulness: 0.8, rouge: 0.5, nope: 1, exactmatch: 2 }, baseline: 'previous' }), local(rows), { supplied: local(rows).inputs });
    expect(b.gates).toEqual({ 'token-f1': 0.4 });
    expect(b.gateFlags).toEqual(['--min token-f1=0.4']);
    expect(b.baseline).toBe('previous');
    expect(b.yaml).toContain('--min token-f1=0.4');
    expect(b.notes.filter((n) => /gate/.test(n))).toHaveLength(4);
  });

  it('the name is the plan’s unless asked, and never one a saved evaluation has', () => {
    expect(freeName('A', ['a', 'A (2)'])).toBe('A (3)');
    expect(buildEvaluation(plan({ name: 'A' }), local(rows, { existing: ['A'] }), { supplied: {} }).evaluation.name).toBe('A (2)');
    expect(buildEvaluation(plan({ name: undefined }), local(rows, { name: 'Mine' }), { supplied: {} }).evaluation.name).toBe('Mine');
  });

  it('control characters in a name never reach the library', () => {
    expect(buildEvaluation(plan({ name: 'Bad\u0007\nname' }), local(rows), { supplied: local(rows).inputs }).evaluation.name).toBe('Bad name');
  });
});
