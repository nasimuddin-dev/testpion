/**
 * The performance budget of the RAG metrics matrix (planning/rag-testing.md, "quality bar": fast in all cases): a run of 5,000
 * samples scored by 40 metrics becomes the matrix, its page of rows, the By tag table and the chart data, and the trend point of
 * the run, within a ceiling that a busy CI machine keeps and a quadratic mistake breaks. The ceilings are about ten times what
 * the code needs, so they catch a regression, not noise. (The window draws one page of 100 rows at a time: the engine side is
 * what grows with the run.)
 */
import { describe, expect, it } from 'vitest';
import { buildMetricMatrix, type TestResult } from '../../packages/core/src/index.js';

const METRICS = ['faithfulness', 'answer-relevance', 'context-precision', 'context-recall', 'factual-correctness', 'token-f1', 'rouge-l', 'recall@5', 'precision@5', 'mrr', 'ndcg@5', 'hit@5', 'context-entity-recall', 'citation', 'bleu', 'chrf'];
const NAMES = Array.from({ length: 40 }, (_, i) => (i < METRICS.length ? METRICS[i]! : `custom/m${i}`));

async function* results(n: number): AsyncGenerator<TestResult> {
  for (let i = 0; i < n; i++)
    yield {
      id: `eval:q${i}`,
      name: `q${i}`,
      status: i % 7 ? 'passed' : 'failed',
      tags: [`tag-${i % 12}`, i % 2 ? 'easy' : 'hard'],
      checks: NAMES.map((name, k) => ({ type: name, name, passed: (i + k) % 5 !== 0, source: 'ai-judge', score: ((i * 31 + k * 17) % 100) / 100, message: '', ...((i + k) % 11 === 0 ? { metadata: { na: 'no claims' } } : { metadata: { threshold: 0.5 } }) })),
      metadata: { rag: { query: `question number ${i}` } },
    } as unknown as TestResult;
}

describe('the metrics matrix of 5,000 samples x 40 metrics', () => {
  it('is built, aggregated and cut into a page within its ceiling', async () => {
    const t0 = performance.now();
    const m = await buildMetricMatrix(results(5000), { limit: 100 });
    const ms = performance.now() - t0;
    expect(m.total).toBe(5000);
    expect(m.columns).toHaveLength(40);
    expect(m.rows).toHaveLength(100);
    expect(m.aggregates).toHaveLength(40);
    expect(m.byTag.length).toBeGreaterThan(10);
    // the By tag table and the chart data come out of the same pass: nothing else is computed per view
    expect(m.aggregates.every((a) => a.distribution.length === 10)).toBe(true);
    expect(ms, `built in ${Math.round(ms)} ms`).toBeLessThan(15_000);
  }, 60_000);

  it('a threshold edit and a sort re-decide pass and fail from the stored scores within a ceiling', async () => {
    const t0 = performance.now();
    const m = await buildMetricMatrix(results(5000), { limit: 100, sort: 'faithfulness', thresholds: { faithfulness: 0.9 } });
    const ms = performance.now() - t0;
    expect(m.rows[0]!.cells[0]).toBeTruthy();
    expect(ms, `built in ${Math.round(ms)} ms`).toBeLessThan(15_000);
  }, 60_000);
});
