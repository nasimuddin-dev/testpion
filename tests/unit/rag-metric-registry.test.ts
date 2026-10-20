/**
 * The metric registry (R1b): one table for every RAG metric. Proves that every metric is computed by a registered check,
 * that ids and aliases never collide, that Ragas names resolve to the right metric with the right options, that the
 * presets only name metrics that exist, and that the counts of the catalogue are what the docs say.
 */
import { describe, expect, it } from 'vitest';
import { METRIC_PRESETS, canonicalMetricId, checkTypes, metricCatalogue, metricCatalogueRows, metricToCheck, presetChecks, presetUnknown, resolveMetric, runChecks } from '../../packages/core/src/index.js';

describe('the catalogue', () => {
  it('every metric is computed by a registered check', () => {
    const types = new Set(checkTypes());
    for (const m of metricCatalogue()) expect(types.has(m.check), `${m.id} → ${m.check}`).toBe(true);
  });

  it('has the counts the docs state (changing them is a docs change: docs/ai-testing/rag-metrics.md is generated from this)', () => {
    const rows = metricCatalogue();
    const by = (k: string) => rows.filter((m) => m.kind === k).length;
    expect({ total: rows.length, deterministic: by('deterministic'), judged: by('judged'), embedding: by('embedding'), sql: by('sql') }).toEqual({ total: 30, deterministic: 23, judged: 6, embedding: 1, sql: 0 });
    expect(new Set(rows.map((m) => m.id)).size).toBe(rows.length);
  });

  it('describes every metric: what, how, a worked example, its inputs, its direction and its sources', () => {
    for (const m of metricCatalogue()) {
      expect(m.what.length, m.id).toBeGreaterThan(20);
      expect(m.how.length, m.id).toBeGreaterThan(10);
      expect(m.example.length, m.id).toBeGreaterThan(10);
      expect(['higher', 'lower']).toContain(m.direction);
      if (m.kind === 'judged' && m.judge === 'service') expect(m.prompts?.length, m.id).toBeGreaterThan(0);
      if (m.kind !== 'deterministic' || m.requires.length) expect(m.version, m.id).toMatch(/-v\d+$/);
    }
  });

  it('the rows are plain data (no functions) for the picker and the MCP tool', () => {
    expect(() => JSON.stringify(metricCatalogueRows())).not.toThrow();
    expect(metricCatalogueRows().every((r) => !('estimate' in r))).toBe(true);
  });
});

describe('names', () => {
  it('the canonical ids, the aliases and the older check names all resolve to one metric', () => {
    expect(resolveMetric('faithfulness')!.def.id).toBe('faithfulness');
    for (const n of ['rag-faithfulness', 'groundedness', 'Faithfulness', 'faithful']) expect(resolveMetric(n)!.def.id, n).toBe('faithfulness');
    expect(resolveMetric('answer-correctness')!.def.id).toBe('factual-correctness');
    expect(resolveMetric('rag-answer-relevance')!.def.id).toBe('answer-relevance');
    expect(resolveMetric('hallucination')).toBeUndefined();
    expect(canonicalMetricId('LLMContextRecall')).toBe('context-recall');
    expect(canonicalMetricId('not a metric')).toBe('not a metric');
  });

  it('Ragas names (snake_case, class, legacy class) resolve; the ones that mean something else carry their parity options', () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['context_precision', 'context-precision', {}],
      ['LLMContextPrecisionWithReference', 'context-precision', {}],
      ['llm_context_recall', 'context-recall', {}],
      ['ContextEntityRecall', 'context-entity-recall', {}],
      ['context_entities_recall', 'context-entity-recall', {}],
      ['id_based_context_precision', 'context-precision-ids', {}],
      ['NonLLMContextRecall', 'context-recall-lexical', {}],
      ['response_relevancy', 'answer-relevance', { mode: 'reverse-questions' }],
      ['AnswerRelevancy', 'answer-relevance', { mode: 'reverse-questions' }],
      ['nv_context_relevance', 'context-relevance', { mode: 'nvidia' }],
      ['context_relevance', 'context-relevance', {}],
      ['FactualCorrectness', 'factual-correctness', {}],
      ['semantic_similarity', 'semantic-similarity', {}],
      ['AnswerSimilarity', 'semantic-similarity', { method: 'embedding' }],
      ['non_llm_string_similarity', 'string-similarity', {}],
      ['rouge_score', 'rouge', { rouge: 'rougeL', mode: 'fmeasure' }],
      ['string_presence', 'contains', {}],
      ['exact_match', 'exact-match', {}],
    ];
    for (const [name, id, options] of cases) {
      const r = resolveMetric(name);
      expect(r?.def.id, name).toBe(id);
      expect(r?.options, name).toEqual(options);
    }
  });

  it('the canonical id of a Ragas snake_case name keeps Ragas’ meaning by default; the bare id of answer relevance keeps the statement mode', () => {
    expect(resolveMetric('faithfulness')!.options).toEqual({});
    expect(resolveMetric('answer-relevance')!.options).toEqual({});
    expect(resolveMetric('answer-relevance')!.def.options!.mode!.default).toBe('statements');
    // the ragas: prefix always applies the parity options, even to an id
    expect(resolveMetric('ragas:answer-relevance')!.options).toEqual({ mode: 'reverse-questions' });
    expect(resolveMetric('ragas:ContextRecall')!.def.id).toBe('context-recall');
  });

  it('@k names carry k', () => {
    expect(resolveMetric('recall@5')).toMatchObject({ def: { id: 'recall@k' }, options: { k: 5 } });
    expect(resolveMetric('NDCG@10')).toMatchObject({ def: { id: 'ndcg@k' }, options: { k: 10 } });
    expect(resolveMetric('success@3')).toMatchObject({ def: { id: 'hit-rate@k' }, options: { k: 3 } });
    expect(metricToCheck('recall@5')).toMatchObject({ type: 'recall@k', k: 5, name: 'recall@5' });
    expect(metricToCheck('recall@k')).toEqual({ type: 'recall@k' });
  });

  it('a name that is not a registered check type still runs as a check (YAML may say response_relevancy or recall@5)', async () => {
    const [r] = await runChecks([{ type: 'recall@3', threshold: 0.5 }], { testType: 'rag', body: '', text: 'x', contexts: [{ id: 'a', text: '' }, { id: 'b', text: '' }, { id: 'c', text: '' }], referenceIds: ['c', 'z'] });
    expect(r).toMatchObject({ type: 'recall@k', name: 'recall@3', passed: true, score: 0.5 });
    const [u] = await runChecks([{ type: 'no-such-metric' }], { testType: 'rag', body: '', text: '' });
    expect(u!.message).toMatch(/unknown check type/);
  });
});

describe('presets', () => {
  it('every metric a preset names exists, and a preset builds checks that run', () => {
    for (const p of METRIC_PRESETS) {
      expect(presetUnknown(p), p.id).toEqual([]);
      const checks = presetChecks(p.metrics);
      expect(checks.length).toBe(p.metrics.length);
      for (const c of checks) expect(checkTypes()).toContain(c.type);
    }
  });

  it('the same metric twice gets two columns (recall@5 and recall@10)', () => {
    const names = presetChecks(METRIC_PRESETS.find((p) => p.id === 'nvidia-rag')!.metrics).map((c) => c.name ?? c.type);
    expect(names).toEqual(['context-relevance', 'recall@5', 'recall@10', 'ndcg@5', 'ndcg@10']);
  });
});
